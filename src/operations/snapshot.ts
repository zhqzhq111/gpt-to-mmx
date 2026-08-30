import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import type { G2MLocalConfig } from "../cli/config.js";
import { FingerprintRegistry } from "../execution/fingerprint.js";
import { isTerminal, type TaskState } from "../execution/state-machine.js";
import { EventStore, verifyChain } from "../events/store.js";
import { reduce } from "../events/reducer.js";
import { StateDatabase } from "../projection/database.js";
import { scanRecovery, type RecoveryIssue, type RecoveryScanReport } from "../recovery/scanner.js";
import { planGcCandidates, type GcCandidate } from "../storage/gc-candidate.js";
import { readStorageManifestSync, type StorageManifest } from "../storage/usage.js";
import { nodeFreeSpaceProvider } from "../storage/free-space.js";
import { readTombstoneSync } from "../storage/tombstone.js";
import { volumeIdForPath } from "../storage/volume.js";
import {
  classifyLeasePolicy,
  scanLeaseOwnersSync,
  WorkspaceLock,
  type LeaseDisposition,
  type LeaseJournalState,
  type ValidLeaseOwner,
} from "../workspace/lock.js";
import type { TaskEvent } from "../events/events.js";

export type JournalStatus = "OK" | "TRUNCATED_TAIL" | "LOAD_ERROR" | "MISSING" | "GCED";
export type ProjectionState = "OK" | "MISSING" | "UNREADABLE";
export type ReservationStatus = "NONE" | "ACTIVE" | "RELEASED" | "INVALID" | "UNKNOWN";
export type ExecutionRecoveryStatus = "NONE" | "REQUIRED" | "REPORT_ONLY";
export type GcStatus = "NONE" | "ELIGIBLE" | "BLOCKED" | "INTERRUPTED" | "CLEANUP_PENDING" | "GCED";

export interface StateRootStatus {
  readonly stateRootExists: boolean;
  readonly executionsDirectoryExists: boolean;
  readonly locksDirectoryExists: boolean;
  readonly reservationsDirectoryExists: boolean;
  readonly tombstonesDirectoryExists: boolean;
  readonly projectionDatabaseExists: boolean;
}

export interface WorkspaceStatus {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly canonicalPathExists: boolean;
  readonly lease: {
    readonly status: LeaseDisposition | "NONE";
    readonly executionId: string | null;
    readonly leaseId: string | null;
    readonly hostname: string | null;
    readonly pid: number | null;
    readonly heartbeatAgeMs: number | null;
  };
}

export interface ExecutionStatus {
  readonly executionId: string;
  readonly taskId: string | null;
  readonly workspaceId: string | null;
  readonly state: TaskState | null;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly journalStatus: JournalStatus;
  readonly lastEventType: string | null;
  readonly lastEventSeq: number | null;
  readonly retentionClass: string | null;
  readonly gcEligibleAt: number | null;
  readonly artifactBytes: number;
  readonly worktreeBytes: number;
  readonly leaseStatus: LeaseDisposition | "NONE";
  readonly reservationStatus: ReservationStatus;
  readonly recoveryStatus: ExecutionRecoveryStatus;
  readonly gcStatus: GcStatus;
}

export interface ProjectionStatus {
  readonly status: ProjectionState;
  readonly databaseExists: boolean;
  readonly databaseReadable: boolean;
  readonly schemaVersion: number | null;
  readonly rebuildStatus: string | null;
  readonly rebuildAt: number | null;
  readonly staleExecutionCount: number;
  readonly projectionStaleEventCount: number;
}

export interface StorageVolumeStatus {
  readonly volumeId: string;
  readonly physicalFreeBytes: number | null;
  readonly activeReservedBytes: number;
  readonly effectiveAvailableBytes: number | null;
  readonly policyAvailableBytes: number | null;
  readonly minFreeBytes: number;
  readonly safetyMarginBytes: number;
}

export interface StorageStatus {
  readonly managedArtifactBytes: number;
  readonly managedWorktreeBytes: number;
  readonly managedTotalBytes: number;
  readonly activeReservedBytes: number;
  readonly maxTotalBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxWorktreeBytes: number;
  readonly volumes: readonly StorageVolumeStatus[];
}

export interface RecoveryStatus {
  readonly openRecoveryCases: number;
  readonly executionsRequiringRecovery: readonly string[];
  readonly issuesByKind: Readonly<Record<string, number>>;
  readonly safeHoldCount: number;
  readonly reportOnlyCount: number;
}

export interface GcStatusSummary {
  readonly eligibleCount: number;
  readonly estimatedReclaimBytes: number;
  readonly interruptedCount: number;
  readonly cleanupPendingCount: number;
  readonly tombstoneCount: number;
  readonly invalidTombstoneCount: number;
}

export interface OperationalSnapshot {
  readonly schemaVersion: "g2m.status.v1";
  readonly generatedAt: number;
  readonly stateRoot: StateRootStatus;
  readonly executions: readonly ExecutionStatus[];
  readonly workspaces: readonly WorkspaceStatus[];
  readonly projection: ProjectionStatus;
  readonly storage: StorageStatus;
  readonly recovery: RecoveryStatus;
  readonly gc: GcStatusSummary;
}

export interface OperationalOptions {
  readonly config: G2MLocalConfig;
  readonly executionId?: string;
  readonly nowMs?: number;
}

interface DbExecutionRow {
  execution_id: string;
  task_id: string;
  workspace_id: string | null;
  state: string;
  created_at: number;
  updated_at: number;
  retention_class: string | null;
  gc_eligible_at: number | null;
}

interface ReservationRecord {
  readonly schema_version?: number;
  readonly execution_id?: string;
  readonly reservations?: readonly { readonly reserved_bytes?: number }[];
}

function directNames(path: string, directories: boolean): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => directories ? entry.isDirectory() : entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function exists(path: string): boolean {
  try { return statSync(path).isDirectory() || statSync(path).isFile(); } catch { return false; }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function replayState(events: readonly TaskEvent[]): { state: TaskState | null; valid: boolean } {
  let state: TaskState | null = null;
  try {
    for (const event of events) state = reduce(state, event, { fingerprintRegistry: new FingerprintRegistry() });
    return { state, valid: verifyChain(events).valid };
  } catch {
    return { state, valid: false };
  }
}

function taskDetails(events: readonly TaskEvent[]): { taskId: string | null; workspaceId: string | null } {
  const created = events.find((event) => event.type === "task.created");
  const task = created?.payload["task"];
  if (task === null || typeof task !== "object") return { taskId: events[0]?.taskId ?? null, workspaceId: null };
  const value = task as Record<string, unknown>;
  const scope = value["workspace_scope"];
  return {
    taskId: typeof value["task_id"] === "string" ? value["task_id"] : events[0]?.taskId ?? null,
    workspaceId: scope !== null && typeof scope === "object" && typeof (scope as Record<string, unknown>)["workspace_id"] === "string"
      ? (scope as Record<string, string>)["workspace_id"]! : null,
  };
}

function journalState(state: TaskState | null, status: JournalStatus): LeaseJournalState {
  if (status === "LOAD_ERROR" || status === "MISSING") return "CORRUPT";
  if (state === "RECOVERY_REQUIRED") return "RECOVERY_REQUIRED";
  if (state !== null && isTerminal(state)) return "TERMINAL";
  if (state !== null) return "ACTIVE";
  return "MISSING";
}

function reservationInfo(stateRoot: string, executionId: string, events: readonly TaskEvent[]): { status: ReservationStatus; bytes: number } {
  const records = directNames(join(stateRoot, "reservations"), false);
  let found = false;
  let invalid = false;
  let bytes = 0;
  for (const name of records) {
    try {
      const record = JSON.parse(readFileSync(join(stateRoot, "reservations", name), "utf8")) as ReservationRecord;
      if (record.schema_version !== 1 || record.execution_id !== executionId || !Array.isArray(record.reservations)) continue;
      found = true;
      for (const reservation of record.reservations) if (typeof reservation.reserved_bytes === "number") bytes += reservation.reserved_bytes;
    } catch { invalid = true; }
  }
  if (invalid && found) return { status: "INVALID", bytes };
  if (!found) return { status: "NONE", bytes: 0 };
  const released = [...events].reverse().some((event) => [
    "storage.reservation.released", "storage.reservation.expired", "storage.reservation.abandoned",
  ].includes(event.type));
  return { status: released ? "RELEASED" : "ACTIVE", bytes };
}

function projectionStatus(path: string, database: StateDatabase | undefined, staleEventCount: number): ProjectionStatus {
  if (!exists(path)) return {
    status: "MISSING", databaseExists: false, databaseReadable: false, schemaVersion: null,
    rebuildStatus: null, rebuildAt: null, staleExecutionCount: 0, projectionStaleEventCount: staleEventCount,
  };
  if (database === undefined) return {
    status: "UNREADABLE", databaseExists: true, databaseReadable: false, schemaVersion: null,
    rebuildStatus: null, rebuildAt: null, staleExecutionCount: 0, projectionStaleEventCount: staleEventCount,
  };
  try {
    const stale = Number((database.prepare("SELECT COUNT(*) AS count FROM projection_meta WHERE key LIKE 'execution:%:stale' AND value = 'true'").get() as { count: number | bigint }).count);
    return {
      status: "OK", databaseExists: true, databaseReadable: true,
      schemaVersion: numberOrNull(Number(database.getMeta("schema_version") ?? NaN)),
      rebuildStatus: database.getMeta("rebuild_status") ?? null,
      rebuildAt: numberOrNull(Number(database.getMeta("rebuild_at") ?? NaN)),
      staleExecutionCount: stale,
      projectionStaleEventCount: staleEventCount,
    };
  } catch {
    return {
      status: "UNREADABLE", databaseExists: true, databaseReadable: false, schemaVersion: null,
      rebuildStatus: null, rebuildAt: null, staleExecutionCount: 0, projectionStaleEventCount: staleEventCount,
    };
  }
}

function validTombstoneIds(stateRoot: string): { ids: Set<string>; invalid: number } {
  const ids = new Set<string>();
  let invalid = 0;
  for (const name of directNames(join(stateRoot, "tombstones"), false)) {
    if (!name.endsWith(".json")) continue;
    try {
      const tombstone = readTombstoneSync(join(stateRoot, "tombstones", name));
      if (tombstone === undefined || name !== `${tombstone.executionId}.json`) throw new Error("tombstone binding");
      ids.add(tombstone.executionId);
    } catch { invalid += 1; }
  }
  return { ids, invalid };
}

function activeReservationsByVolume(stateRoot: string, eventStore: EventStore): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const name of directNames(join(stateRoot, "reservations"), false)) {
    try {
      const record = JSON.parse(readFileSync(join(stateRoot, "reservations", name), "utf8")) as ReservationRecord & { readonly reservation_set_id?: string };
      if (record.schema_version !== 1 || typeof record.execution_id !== "string" || !Array.isArray(record.reservations)) continue;
      const events = eventStore.getByAttemptId(record.execution_id);
      const released = ["storage.reservation.released", "storage.reservation.expired", "storage.reservation.abandoned"].some((type) => [...events].reverse().some((event) => event.type === type && (event.payload["reservation_set_id"] === undefined || event.payload["reservation_set_id"] === record.reservation_set_id)));
      if (released) continue;
      for (const reservation of record.reservations) {
        const value = reservation as { readonly volume_id?: unknown; readonly reserved_bytes?: unknown };
        if (typeof value.volume_id !== "string" || typeof value.reserved_bytes !== "number") continue;
        totals.set(value.volume_id, (totals.get(value.volume_id) ?? 0) + value.reserved_bytes);
      }
    } catch { /* invalid records are reported through execution/doctor sources */ }
  }
  return totals;
}

async function storageVolumes(config: G2MLocalConfig, stateRoot: string, activeReservedByVolume: ReadonlyMap<string, number>): Promise<readonly StorageVolumeStatus[]> {
  const paths = [stateRoot, config.artifact_root, config.worktree_root, ...config.workspaces.map((workspace) => workspace.path)];
  const result = new Map<string, StorageVolumeStatus>();
  for (const path of paths) {
    try {
      const free = await nodeFreeSpaceProvider.freeBytes(path);
      const volumeId = volumeIdForPath(path);
      const previous = result.get(volumeId);
      const reserved = activeReservedByVolume.get(volumeId) ?? 0;
      const physical = previous?.physicalFreeBytes === undefined || previous.physicalFreeBytes === null ? free : Math.max(previous.physicalFreeBytes, free);
      result.set(volumeId, {
        volumeId,
        physicalFreeBytes: physical,
        activeReservedBytes: reserved,
        effectiveAvailableBytes: physical - reserved,
        policyAvailableBytes: physical - reserved - config.storage.min_free_bytes - config.storage.safety_margin_bytes,
        minFreeBytes: config.storage.min_free_bytes,
        safetyMarginBytes: config.storage.safety_margin_bytes,
      });
    } catch { /* unavailable volume is represented by the other sources */ }
  }
  return [...result.values()].sort((a, b) => a.volumeId.localeCompare(b.volumeId));
}

export async function buildOperationalSnapshot(options: OperationalOptions): Promise<OperationalSnapshot> {
  const generatedAt = options.nowMs ?? Date.now();
  const config = options.config;
  const stateRoot = config.state_root ?? resolve(config.artifact_root, "state");
  const projectionPath = join(stateRoot, "g2m-state.sqlite");
  const stateRootStatus: StateRootStatus = {
    stateRootExists: exists(stateRoot),
    executionsDirectoryExists: exists(join(stateRoot, "executions")),
    locksDirectoryExists: exists(join(stateRoot, "locks")),
    reservationsDirectoryExists: exists(join(stateRoot, "reservations")),
    tombstonesDirectoryExists: exists(join(stateRoot, "tombstones")),
    projectionDatabaseExists: exists(projectionPath),
  };
  const eventStore = new EventStore({ executionDirectory: join(stateRoot, "executions"), tolerateLoadErrors: true, readOnly: true });
  let database: StateDatabase | undefined;
  try {
    if (stateRootStatus.projectionDatabaseExists) {
      try { database = new StateDatabase(projectionPath, { readOnly: true }); } catch { database = undefined; }
    }
    const rows = database === undefined ? [] : (() => {
      try { return database!.prepare("SELECT execution_id, task_id, workspace_id, state, created_at, updated_at, retention_class, gc_eligible_at FROM executions ORDER BY execution_id").all() as unknown as DbExecutionRow[]; }
      catch { return []; }
    })();
    const tombstones = validTombstoneIds(stateRoot);
    const executionIds = new Set<string>([
      ...directNames(join(stateRoot, "executions"), true),
      ...rows.map((row) => row.execution_id),
      ...eventStore.list().map((event) => event.attemptId),
      ...tombstones.ids,
    ]);
    const owners = scanLeaseOwnersSync(stateRoot);
    const ownerByWorkspace = new Map(owners.map((owner) => [owner.workspace_id, owner]));
    const recovery: RecoveryScanReport = database === undefined ? { issues: [], executions: [] } : scanRecovery({
      stateRoot,
      artifactRoot: config.artifact_root,
      worktreeRoot: config.worktree_root,
      eventStore,
      database,
      workspaces: config.workspaces.map((workspace) => ({ workspaceId: workspace.workspace_id, canonicalPath: workspace.path })),
    });
    const issuesByExecution = new Map<string, RecoveryIssue[]>();
    for (const issue of recovery.issues) if (issue.executionId !== undefined) issuesByExecution.set(issue.executionId, [...(issuesByExecution.get(issue.executionId) ?? []), issue]);
    const staleEventCount = recovery.issues.filter((issue) => issue.kind === "PROJECTION_STALE").length;
    const projection = projectionStatus(projectionPath, database, staleEventCount);
    const leaseLock = new WorkspaceLock({
      stateRoot,
      ...(config.workspace_lease?.stale_after_ms !== undefined ? { staleAfterMs: config.workspace_lease.stale_after_ms } : {}),
    });
    const workspaces: WorkspaceStatus[] = config.workspaces.map((workspace) => {
      const owner = ownerByWorkspace.get(workspace.workspace_id);
      if (owner === undefined) return { workspaceId: workspace.workspace_id, canonicalPath: workspace.path, canonicalPathExists: exists(workspace.path), lease: { status: "NONE", executionId: null, leaseId: null, hostname: null, pid: null, heartbeatAgeMs: null } };
      let disposition: LeaseDisposition = "UNKNOWN";
      let heartbeatAgeMs: number | null = null;
      try {
        const inspection = leaseLock.inspectWorkspaceLeaseSync({ workspaceKey: owner.workspace_key });
        heartbeatAgeMs = inspection.heartbeatAgeMs ?? inspection.ageMs ?? null;
        const execution = eventStore.getByAttemptId(owner.execution_id);
        const stateResult = replayState(execution);
        const issue = issuesByExecution.get(owner.execution_id)?.some((item) => item.severity === "SAFE_HOLD");
        disposition = classifyLeasePolicy({ inspection, journalState: issue ? "RECOVERY_REQUIRED" : journalState(stateResult.state, "OK"), staleAfterMs: leaseLock.staleAfter, currentHostname: hostname() });
      } catch { disposition = "UNKNOWN"; }
      return { workspaceId: workspace.workspace_id, canonicalPath: workspace.path, canonicalPathExists: exists(workspace.path), lease: { status: disposition, executionId: owner.execution_id, leaseId: owner.lease_id, hostname: owner.hostname, pid: owner.pid, heartbeatAgeMs } };
    });
    const candidates: readonly GcCandidate[] = database === undefined ? [] : await planGcCandidates({
      stateRoot, artifactRoot: config.artifact_root, worktreeRoot: config.worktree_root, eventStore, database, nowMs: generatedAt,
      completedRetentionDays: config.storage.completed_retention_days,
      workspaces: config.workspaces.map((workspace) => ({ workspaceId: workspace.workspace_id, canonicalPath: workspace.path })),
    }).catch(() => []);
    const manifests = new Map<string, StorageManifest>();
    for (const executionId of executionIds) {
      try {
        const manifest = readStorageManifestSync(join(stateRoot, "executions", executionId, "storage-manifest.json"));
        if (manifest !== undefined) manifests.set(executionId, manifest);
      } catch { /* counted by doctor through recovery/artifact checks */ }
    }
    const executions = [...executionIds].sort((a, b) => a.localeCompare(b)).map((executionId): ExecutionStatus => {
      const events = eventStore.getByAttemptId(executionId);
      const issue = eventStore.recoveryIssues().find((item) => item.executionId === executionId);
      const replayed = replayState(events);
      const tombstone = tombstones.ids.has(executionId);
      const journalStatus: JournalStatus = issue?.kind === "TRUNCATED_TAIL" ? "TRUNCATED_TAIL" : issue !== undefined || !replayed.valid ? "LOAD_ERROR" : events.length === 0 ? (tombstone ? "GCED" : "MISSING") : "OK";
      const row = rows.find((candidate) => candidate.execution_id === executionId);
      const details = taskDetails(events);
      const reservation = reservationInfo(stateRoot, executionId, events);
      const issues = issuesByExecution.get(executionId) ?? [];
      const lease = workspaces.find((workspace) => workspace.workspaceId === details.workspaceId)?.lease;
      const candidate = candidates.find((item) => item.executionId === executionId);
      const manifest = manifests.get(executionId);
      const recoveryStatus: ExecutionRecoveryStatus = replayed.state === "RECOVERY_REQUIRED" || issues.some((item) => item.severity === "SAFE_HOLD") ? "REQUIRED" : issues.length > 0 ? "REPORT_ONLY" : "NONE";
      return {
        executionId, taskId: details.taskId ?? row?.task_id ?? null, workspaceId: details.workspaceId ?? row?.workspace_id ?? null,
        state: replayed.state ?? (typeof row?.state === "string" ? row.state as TaskState : null), createdAt: events[0]?.timestampMs ?? row?.created_at ?? null,
        updatedAt: events.at(-1)?.timestampMs ?? row?.updated_at ?? null, journalStatus, lastEventType: events.at(-1)?.type ?? null, lastEventSeq: events.at(-1)?.seq ?? null,
        retentionClass: manifest?.retentionClass ?? row?.retention_class ?? null, gcEligibleAt: manifest?.gcEligibleAt ?? row?.gc_eligible_at ?? null,
        artifactBytes: manifest?.artifactBytes ?? 0, worktreeBytes: manifest?.worktreeBytes ?? 0,
        leaseStatus: lease?.status ?? "NONE", reservationStatus: reservation.status, recoveryStatus,
        gcStatus: tombstone ? "GCED" : issues.some((item) => item.kind === "GC_INTERRUPTED") ? "INTERRUPTED" : issues.some((item) => item.kind === "GC_CLEANUP_PENDING") ? "CLEANUP_PENDING" : candidate?.decision === "ELIGIBLE" ? "ELIGIBLE" : candidate === undefined ? "NONE" : "BLOCKED",
      };
    }).filter((execution) => options.executionId === undefined || execution.executionId === options.executionId);
    const activeReservedByVolume = activeReservationsByVolume(stateRoot, eventStore);
    const managedArtifactBytes = [...manifests.values()].reduce((sum, manifest) => sum + manifest.artifactBytes, 0);
    const managedWorktreeBytes = [...manifests.values()].reduce((sum, manifest) => sum + manifest.worktreeBytes, 0);
    const activeReservedBytes = executions.reduce((sum, execution) => sum + (execution.reservationStatus === "ACTIVE" ? reservationInfo(stateRoot, execution.executionId, eventStore.getByAttemptId(execution.executionId)).bytes : 0), 0);
    const issuesByKind: Record<string, number> = {};
    for (const issue of recovery.issues) issuesByKind[issue.kind] = (issuesByKind[issue.kind] ?? 0) + 1;
    return {
      schemaVersion: "g2m.status.v1", generatedAt, stateRoot: stateRootStatus, executions, workspaces,
      projection, storage: { managedArtifactBytes, managedWorktreeBytes, managedTotalBytes: managedArtifactBytes + managedWorktreeBytes, activeReservedBytes, maxTotalBytes: config.storage.max_total_bytes, maxArtifactBytes: config.storage.max_artifact_bytes, maxWorktreeBytes: config.storage.max_worktree_bytes, volumes: await storageVolumes(config, stateRoot, activeReservedByVolume) },
      recovery: { openRecoveryCases: recovery.issues.filter((issue) => issue.severity === "SAFE_HOLD").length, executionsRequiringRecovery: executions.filter((execution) => execution.recoveryStatus === "REQUIRED").map((execution) => execution.executionId), issuesByKind, safeHoldCount: recovery.issues.filter((issue) => issue.severity === "SAFE_HOLD").length, reportOnlyCount: recovery.issues.filter((issue) => issue.severity === "REPORT_ONLY").length },
      gc: { eligibleCount: candidates.filter((candidate) => candidate.decision === "ELIGIBLE").length, estimatedReclaimBytes: candidates.filter((candidate) => candidate.decision === "ELIGIBLE").reduce((sum, candidate) => sum + candidate.artifactBytes + candidate.worktreeBytes, 0), interruptedCount: recovery.issues.filter((issue) => issue.kind === "GC_INTERRUPTED").length, cleanupPendingCount: recovery.issues.filter((issue) => issue.kind === "GC_CLEANUP_PENDING").length, tombstoneCount: tombstones.ids.size, invalidTombstoneCount: tombstones.invalid },
    };
  } finally {
    eventStore.close();
    database?.close();
  }
}
