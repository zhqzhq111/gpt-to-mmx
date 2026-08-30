import { randomUUID, createHash } from "node:crypto";
import { hostname as localHostname } from "node:os";
import { mkdir, open, readFile, readdir, rm, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TaskEvent } from "../events/events.js";
import { EventStore } from "../events/store.js";
import { StateDatabase } from "../projection/database.js";
import { reduce } from "../events/reducer.js";
import { FingerprintRegistry } from "../execution/fingerprint.js";
import type { TaskState } from "../execution/state-machine.js";
import { DEFAULT_STORAGE_POLICY, type StoragePolicy } from "./policy.js";
import { nodeFreeSpaceProvider, type FreeSpaceProvider } from "./free-space.js";
import { volumeIdForPath, type VolumeInfo } from "./volume.js";
import { scanExecutionUsage, upsertStorageUsage, writeStorageManifestAtomic, type StorageManifest, type StorageUsage } from "./usage.js";

export type StorageErrorCode =
  | "STORAGE_ADMISSION_DENIED"
  | "STORAGE_LIMIT_EXCEEDED"
  | "STORAGE_SCAN_FAILED"
  | "STORAGE_RESERVATION_FAILED"
  | "STORAGE_STATE_INCONSISTENT";

export class StorageAdmissionError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "StorageAdmissionError";
  }
}

export interface ReservationRoot {
  readonly rootPath: string;
  readonly roles: readonly string[];
  readonly reservedBytes?: number;
}

export interface ReservationRow {
  readonly reservationId: string;
  readonly reservationSetId: string;
  readonly executionId: string;
  readonly volumeId: string;
  readonly reservedBytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly roles: readonly string[];
}

export interface StorageReservationRecord {
  readonly schema_version: 1;
  readonly reservation_set_id: string;
  readonly execution_id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly reservations: ReadonlyArray<{
    readonly reservation_id: string;
    readonly volume_id: string;
    readonly reserved_bytes: number;
    readonly roles: readonly string[];
  }>;
}

export interface StorageReservationHandle {
  readonly reservationSetId: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly recordPath: string;
  readonly recordHash: string;
  readonly reservations: readonly ReservationRow[];
}

export interface StorageManagerOptions {
  readonly database: StateDatabase;
  readonly eventStore?: EventStore;
  readonly stateRoot: string;
  readonly policy?: StoragePolicy;
  readonly freeSpaceProvider?: FreeSpaceProvider;
  readonly volumeResolver?: (path: string) => VolumeInfo;
  readonly hostname?: string;
  readonly pid?: number;
  readonly now?: () => number;
}

interface GroupedReservation {
  readonly volumeId: string;
  readonly roots: ReservationRoot[];
  freeBytes: number;
}

function recordHash(record: StorageReservationRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

async function writeRecord(path: string, record: StorageReservationRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const reread = JSON.parse(await readFile(path, "utf8")) as StorageReservationRecord;
    if (recordHash(reread) !== recordHash(record)) {
      throw new Error("reservation record hash verification failed after rename");
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function activeReservationTotal(database: StateDatabase): number {
  const row = database.prepare("SELECT COALESCE(SUM(reserved_bytes), 0) AS total FROM storage_reservations WHERE state = 'ACTIVE'").get() as { total: number | bigint };
  return Number(row.total);
}

function managedUsageTotal(database: StateDatabase): number {
  const row = database.prepare("SELECT COALESCE(SUM(artifact_bytes + worktree_bytes), 0) AS total FROM storage_usage").get() as { total: number | bigint };
  return Number(row.total);
}

export class StorageManager {
  private readonly policy: StoragePolicy;
  private readonly freeSpace: FreeSpaceProvider;
  private readonly resolveVolume: (path: string) => VolumeInfo;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly now: () => number;

  constructor(private readonly options: StorageManagerOptions) {
    this.policy = options.policy ?? DEFAULT_STORAGE_POLICY;
    this.freeSpace = options.freeSpaceProvider ?? nodeFreeSpaceProvider;
    this.resolveVolume = options.volumeResolver ?? ((path) => ({
      volumeId: volumeIdForPath(path),
      rootPath: path,
      freeBytes: 0,
    }));
    this.hostname = options.hostname ?? localHostname();
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
  }

  get storagePolicy(): StoragePolicy {
    return this.policy;
  }

  assertUsageWithinLimits(
    executionId: string,
    usage: StorageUsage,
    additionalArtifactBytes = 0,
  ): void {
    const existing = this.options.database.prepare(
      "SELECT COALESCE(artifact_bytes + worktree_bytes, 0) AS total FROM storage_usage WHERE execution_id = ?",
    ).get(executionId) as { total: number | bigint } | undefined;
    const projectedTotal = managedUsageTotal(this.options.database) - Number(existing?.total ?? 0) + usage.totalBytes + additionalArtifactBytes;
    if (this.policy.max_worktree_bytes > 0 && usage.worktreeBytes > this.policy.max_worktree_bytes) {
      throw new StorageAdmissionError("STORAGE_LIMIT_EXCEEDED", "worktree usage exceeds max_worktree_bytes");
    }
    if (this.policy.max_artifact_bytes > 0 && usage.artifactBytes + additionalArtifactBytes > this.policy.max_artifact_bytes) {
      throw new StorageAdmissionError("STORAGE_LIMIT_EXCEEDED", "artifact usage exceeds max_artifact_bytes");
    }
    if (this.policy.max_total_bytes > 0 && projectedTotal > this.policy.max_total_bytes) {
      throw new StorageAdmissionError("STORAGE_LIMIT_EXCEEDED", "managed storage usage exceeds max_total_bytes");
    }
  }

  async assertExecutionLimits(input: {
    readonly executionId: string;
    readonly artifactPath: string;
    readonly worktreePath: string;
    readonly additionalArtifactBytes?: number;
  }): Promise<void> {
    const usage = await scanExecutionUsage(input);
    this.assertUsageWithinLimits(input.executionId, usage, input.additionalArtifactBytes ?? 0);
  }

  async reserveExecution(input: {
    readonly executionId: string;
    readonly taskId: string;
    readonly roots: readonly ReservationRoot[];
  }): Promise<StorageReservationHandle> {
    if (input.roots.length === 0) throw new StorageAdmissionError("STORAGE_ADMISSION_DENIED", "no storage roots supplied");
    await mkdir(this.options.stateRoot, { recursive: true });
    const stateFreeBytes = await this.freeSpace.freeBytes(this.options.stateRoot);
    if (stateFreeBytes < this.policy.min_free_bytes + this.policy.safety_margin_bytes) {
      throw new StorageAdmissionError("STORAGE_ADMISSION_DENIED", "state root is below the storage safety floor");
    }
    const createdAt = this.now();
    const expiresAt = createdAt + this.policy.reservation_ttl_ms;
    const grouped = new Map<string, GroupedReservation>();
    for (const root of input.roots) {
      const info = this.resolveVolume(root.rootPath);
      const existing = grouped.get(info.volumeId);
      if (existing === undefined) grouped.set(info.volumeId, { volumeId: info.volumeId, roots: [root], freeBytes: info.freeBytes });
      else existing.roots.push(root);
    }
    for (const group of grouped.values()) {
      if (group.freeBytes === 0) group.freeBytes = await this.freeSpace.freeBytes(group.roots[0]!.rootPath);
    }
    const rows: ReservationRow[] = [...grouped.values()].map((group) => {
      const reservedBytes = Math.max(...group.roots.map((root) => root.reservedBytes ?? this.policy.default_execution_reservation_bytes));
      const roles = [...new Set(group.roots.flatMap((root) => root.roles))];
      if (roles.includes("worktree") && this.policy.max_worktree_bytes > 0 && reservedBytes > this.policy.max_worktree_bytes) {
        throw new StorageAdmissionError("STORAGE_LIMIT_EXCEEDED", "worktree reservation exceeds max_worktree_bytes");
      }
      if (roles.includes("artifact") && this.policy.max_artifact_bytes > 0 && reservedBytes > this.policy.max_artifact_bytes) {
        throw new StorageAdmissionError("STORAGE_LIMIT_EXCEEDED", "artifact reservation exceeds max_artifact_bytes");
      }
      return {
        reservationId: randomUUID(),
        reservationSetId: randomUUID(),
        executionId: input.executionId,
        volumeId: group.volumeId,
        reservedBytes,
        createdAt,
        expiresAt,
        roles,
      };
    });
    const reservationSetId = rows[0]!.reservationSetId;
    const normalizedRows = rows.map((row) => ({ ...row, reservationSetId }));
    const record: StorageReservationRecord = {
      schema_version: 1,
      reservation_set_id: reservationSetId,
      execution_id: input.executionId,
      pid: this.pid,
      hostname: this.hostname,
      created_at: createdAt,
      expires_at: expiresAt,
      reservations: normalizedRows.map((row) => ({
        reservation_id: row.reservationId,
        volume_id: row.volumeId,
        reserved_bytes: row.reservedBytes,
        roles: row.roles,
      })),
    };
    const recordPath = join(this.options.stateRoot, "reservations", `${reservationSetId}.json`);
    const hash = recordHash(record);
    await writeRecord(recordPath, record);
    try {
      this.options.database.transaction(() => {
        const active = activeReservationTotal(this.options.database);
        const managed = managedUsageTotal(this.options.database);
        const requested = normalizedRows.reduce((sum, row) => sum + row.reservedBytes, 0);
        if (this.policy.max_total_bytes > 0 && managed + active + requested > this.policy.max_total_bytes) {
          throw new StorageAdmissionError("STORAGE_ADMISSION_DENIED", "managed storage max_total_bytes exceeded");
        }
        for (const row of normalizedRows) {
          const activeOnVolume = Number((this.options.database.prepare("SELECT COALESCE(SUM(reserved_bytes), 0) AS total FROM storage_reservations WHERE volume_id = ? AND state = 'ACTIVE'").get(row.volumeId) as { total: number | bigint }).total);
          const group = grouped.get(row.volumeId)!;
          if (row.reservedBytes > group.freeBytes - this.policy.min_free_bytes - this.policy.safety_margin_bytes - activeOnVolume) {
            throw new StorageAdmissionError("STORAGE_ADMISSION_DENIED", `insufficient free space on ${row.volumeId}`);
          }
          this.options.database.run(`
            INSERT INTO storage_reservations(
              reservation_id, reservation_set_id, execution_id, volume_id,
              reserved_bytes, created_at, expires_at, state, pid, hostname,
              roles_json, record_path, record_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
          `, row.reservationId, row.reservationSetId, row.executionId, row.volumeId,
            row.reservedBytes, row.createdAt, row.expiresAt, this.pid, this.hostname,
            JSON.stringify(row.roles), recordPath, hash);
        }
      });
    } catch (error) {
      await rm(recordPath, { force: true });
      if (error instanceof StorageAdmissionError) throw error;
      throw new StorageAdmissionError("STORAGE_RESERVATION_FAILED", "reservation transaction failed", error);
    }
    try {
      this.options.eventStore?.append({
        taskId: input.taskId,
        attemptId: input.executionId,
        type: "storage.reservation.created",
        payload: {
          reservation_set_id: reservationSetId,
          record_path: recordPath,
          record_hash: hash,
          reservations: normalizedRows.map((row) => ({ reservation_id: row.reservationId, volume_id: row.volumeId, reserved_bytes: row.reservedBytes, roles: row.roles })),
        },
      });
    } catch (error) {
      throw new StorageAdmissionError("STORAGE_RESERVATION_FAILED", "reservation journal append failed", error);
    }
    return { reservationSetId, executionId: input.executionId, taskId: input.taskId, recordPath, recordHash: hash, reservations: normalizedRows };
  }

  async releaseReservation(handle: StorageReservationHandle, reason: string): Promise<void> {
    const ids = handle.reservations.map((row) => row.reservationId);
    try {
      this.options.eventStore?.append({
        taskId: handle.taskId,
        attemptId: handle.executionId,
        type: "storage.reservation.released",
        payload: { reservation_set_id: handle.reservationSetId, reservation_ids: ids, reason },
      });
    } catch (error) {
      throw new StorageAdmissionError("STORAGE_RESERVATION_FAILED", "reservation release journal append failed", error);
    }
    this.options.database.transaction(() => {
      const statement = this.options.database.prepare("UPDATE storage_reservations SET state = 'RELEASED' WHERE reservation_id = ? AND state = 'ACTIVE'");
      for (const id of ids) statement.run(id);
    });
  }

  async snapshotExecution(input: {
    readonly executionId: string;
    readonly artifactPath: string;
    readonly worktreePath: string;
    readonly retentionClass?: string | null;
    readonly gcEligibleAt?: number | null;
    readonly updatedAt?: number;
  }): Promise<StorageManifest> {
    const usage = await scanExecutionUsage(input);
    this.assertUsageWithinLimits(input.executionId, usage);
    const manifest = await writeStorageManifestAtomic(
      join(this.options.stateRoot, "executions", input.executionId, "storage-manifest.json"),
      {
        executionId: input.executionId,
        artifactBytes: usage.artifactBytes,
        worktreeBytes: usage.worktreeBytes,
        artifactPath: input.artifactPath,
        worktreePath: input.worktreePath,
        retentionClass: input.retentionClass ?? null,
        gcEligibleAt: input.gcEligibleAt ?? null,
        updatedAt: input.updatedAt ?? this.now(),
      },
    );
    upsertStorageUsage(this.options.database, input.executionId, usage, manifest.updatedAt);
    return manifest;
  }
}

export interface StorageReconcileReport {
  readonly rebuiltReservations: number;
  readonly releasedReservations: number;
  readonly retainedReservations: number;
  readonly invalidRecords: number;
  readonly preCommitOrphans: number;
}

function terminalState(events: readonly TaskEvent[]): TaskState | null {
  let state: TaskState | null = null;
  const fingerprintRegistry = new FingerprintRegistry();
  try {
    for (const event of events) state = reduce(state, event, { fingerprintRegistry });
    return state;
  } catch {
    return null;
  }
}

export async function reconcileStorageReservations(options: {
  readonly stateRoot: string;
  readonly database: StateDatabase;
  readonly eventStore: EventStore;
  readonly nowMs: number;
  readonly releaseTerminal?: boolean;
}): Promise<StorageReconcileReport> {
  const root = join(options.stateRoot, "reservations");
  await mkdir(root, { recursive: true });
  const names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
  let rebuiltReservations = 0;
  let releasedReservations = 0;
  let retainedReservations = 0;
  let invalidRecords = 0;
  let preCommitOrphans = 0;
  for (const name of names) {
    let record: StorageReservationRecord;
    try {
      record = JSON.parse(await readFile(join(root, name), "utf8")) as StorageReservationRecord;
      if (record.schema_version !== 1 || !Array.isArray(record.reservations)) throw new Error("invalid reservation record");
    } catch {
      invalidRecords += 1;
      continue;
    }
    const events = options.eventStore.getByAttemptId(record.execution_id);
    const created = events.find((event) => event.type === "storage.reservation.created");
    const statusEvent = [...events].reverse().find((event) => [
      "storage.reservation.released",
      "storage.reservation.expired",
      "storage.reservation.abandoned",
    ].includes(event.type) && (event.payload["reservation_set_id"] === undefined || event.payload["reservation_set_id"] === record.reservation_set_id));
    const expectedHash = created?.payload["record_hash"];
    if (created !== undefined && (typeof expectedHash !== "string" || expectedHash !== recordHash(record))) {
      invalidRecords += 1;
      continue;
    }
    if (created === undefined && statusEvent === undefined) {
      // A record is written before the transaction and Journal commit.  Do
      // not turn an uncommitted record into a permanent ACTIVE reservation.
      // A later startup can safely retry the execution and write a new set.
      preCommitOrphans += 1;
      continue;
    }
    const terminal = terminalState(events);
    options.database.transaction(() => {
      for (const reservation of record.reservations) {
        const state = statusEvent?.type === "storage.reservation.released"
          ? "RELEASED"
          : statusEvent?.type === "storage.reservation.expired"
            ? "EXPIRED"
            : statusEvent?.type === "storage.reservation.abandoned"
              ? "ABANDONED"
              : "ACTIVE";
        options.database.run(`
          INSERT INTO storage_reservations(
            reservation_id, reservation_set_id, execution_id, volume_id,
            reserved_bytes, created_at, expires_at, state, pid, hostname,
            roles_json, record_path, record_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(reservation_id) DO UPDATE SET
            state = CASE WHEN storage_reservations.state = 'ACTIVE' THEN excluded.state ELSE storage_reservations.state END
        `, reservation.reservation_id, record.reservation_set_id, record.execution_id,
          reservation.volume_id, reservation.reserved_bytes, record.created_at, record.expires_at,
          state, record.pid, record.hostname, JSON.stringify(reservation.roles), join(root, name),
          typeof created?.payload["record_hash"] === "string" ? created.payload["record_hash"] : null);
        rebuiltReservations += 1;
      }
    });
    const activeRows = options.database.prepare("SELECT reservation_id FROM storage_reservations WHERE reservation_set_id = ? AND state = 'ACTIVE'").all(record.reservation_set_id) as Array<{ reservation_id: string }>;
    if (options.releaseTerminal !== false && terminal !== null && ["ACCEPTED", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT", "REVISION_REQUESTED"].includes(terminal) && statusEvent === undefined && activeRows.length > 0) {
      const taskId = events[0]?.taskId ?? record.execution_id;
      options.eventStore.append({ taskId, attemptId: record.execution_id, type: "storage.reservation.released", payload: { reservation_set_id: record.reservation_set_id, reservation_ids: activeRows.map((row) => row.reservation_id), reason: "startup-terminal-reconciliation" } });
      options.database.transaction(() => {
        for (const row of activeRows) options.database.run("UPDATE storage_reservations SET state = 'RELEASED' WHERE reservation_id = ? AND state = 'ACTIVE'", row.reservation_id);
      });
      releasedReservations += activeRows.length;
    } else if (activeRows.length > 0) {
      retainedReservations += activeRows.length;
    }
  }
  return { rebuiltReservations, releasedReservations, retainedReservations, invalidRecords, preCommitOrphans };
}
