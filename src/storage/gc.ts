import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, relative, resolve } from "node:path";

import type { StateDatabase } from "../projection/database.js";
import type { EventStore } from "../events/store.js";
import type { LockHandle, WorkspaceLock } from "../workspace/lock.js";
import { reduce } from "../events/reducer.js";
import { FingerprintRegistry } from "../execution/fingerprint.js";
import { isTerminal } from "../execution/state-machine.js";
import { acquireGcRunLock, type GcRunLockHandle } from "./gc-lock.js";
import { planGcCandidates, type GcCandidate, type GcPlannerOptions } from "./gc-candidate.js";
import { assertDirectChild, assertDirectExecutionChild, assertSafeDeletionTarget, prepareTombstone, readTombstone, writePreparedTombstone } from "./tombstone.js";

const execFileAsync = promisify(execFile);

export type GcFaultPoint =
  | "after_gc_marked"
  | "after_worktree_removed"
  | "after_artifacts_removed"
  | "after_tombstone_prepared"
  | "after_tombstone_written"
  | "after_gc_completed"
  | "before_execution_dir_removed";

export class GcFaultError extends Error {
  readonly code = "GC_INTERRUPTED";
  constructor(readonly point: GcFaultPoint) {
    super("injected GC interruption at " + point);
    this.name = "GcFaultError";
  }
}

export type GcExecutionErrorCode =
  | "GC_NOT_ELIGIBLE"
  | "GC_INTERRUPTED"
  | "GC_CLEANUP_PENDING"
  | "GC_DELETE_FAILED"
  | "GC_TOMBSTONE_INVALID";

export class GcExecutionError extends Error {
  override readonly cause?: unknown;
  constructor(readonly code: GcExecutionErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "GcExecutionError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface GcExecutorOptions extends GcPlannerOptions {
  readonly executionId?: string;
  readonly workspaceLock?: WorkspaceLock;
  readonly acquireMaintenanceLease?: (candidate: GcCandidate) => Promise<LockHandle>;
  readonly releaseMaintenanceLease?: (handle: LockHandle) => Promise<void> | void;
  readonly removeWorktree?: (candidate: GcCandidate) => Promise<void>;
  readonly removeArtifact?: (path: string) => Promise<void>;
  readonly fault?: (point: GcFaultPoint) => Promise<void> | void;
}

export interface GcExecutionReport {
  readonly planned: number;
  readonly completed: number;
  readonly blocked: readonly GcCandidate[];
  readonly failures: readonly { readonly executionId: string; readonly reason: string }[];
}

async function inject(options: GcExecutorOptions, point: GcFaultPoint): Promise<void> {
  await options.fault?.(point);
}

async function defaultRemoveWorktree(options: GcExecutorOptions, candidate: GcCandidate): Promise<void> {
  if (candidate.worktreePath === null || !existsSync(candidate.worktreePath)) return;
  const workspace = options.workspaces?.find((entry) => entry.workspaceId === candidate.workspaceId);
  if (workspace === undefined) throw new GcExecutionError("GC_DELETE_FAILED", "worktree repository binding is unavailable");
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", candidate.worktreePath], { cwd: resolve(workspace.canonicalPath), windowsHide: true, timeout: 30_000 });
    await execFileAsync("git", ["worktree", "prune"], { cwd: resolve(workspace.canonicalPath), windowsHide: true, timeout: 30_000 });
  } catch (error) {
    throw new GcExecutionError("GC_DELETE_FAILED", "repository-bound worktree removal failed", error);
  }
}

async function defaultRemoveArtifact(path: string): Promise<void> {
  const state = await assertSafeDeletionTarget(path);
  if (state === "MISSING") return;
  try {
    await rm(path, { recursive: true, force: false });
  } catch (error) {
    throw new GcExecutionError("GC_DELETE_FAILED", "artifact directory removal failed", error);
  }
}

function markPayload(options: GcExecutorOptions, candidate: GcCandidate, runId: string): Record<string, unknown> {
  return {
    gc_run_id: runId,
    final_state: candidate.finalState,
    retention_class: candidate.retentionClass,
    gc_eligible_at: candidate.gcEligibleAt,
    manifest_generation: candidate.manifestGeneration,
    manifest_hash: candidate.manifestHash,
    artifact_bytes: candidate.artifactBytes,
    worktree_bytes: candidate.worktreeBytes,
    artifact_target: candidate.executionId,
    worktree_target: candidate.worktreePath === null ? null : relative(resolve(options.worktreeRoot), resolve(candidate.worktreePath)),
  };
}

function createdTimestamp(options: GcExecutorOptions, executionId: string): number {
  return options.eventStore.getByAttemptId(executionId).find((event) => event.type === "task.created")?.timestampMs ?? options.nowMs;
}

function cleanupProjection(database: StateDatabase, executionId: string): void {
  database.transaction(() => {
    for (const table of ["artifacts", "reviews", "recovery_cases", "storage_usage", "storage_reservations"]) {
      database.prepare("DELETE FROM " + table + " WHERE execution_id = ?").run(executionId);
    }
    database.prepare("UPDATE executions SET artifact_path = NULL, worktree_path = NULL, gc_eligible_at = NULL WHERE execution_id = ?").run(executionId);
  });
}

async function maintenanceLease(options: GcExecutorOptions, candidate: GcCandidate): Promise<{ readonly handle: LockHandle | undefined; readonly release: () => Promise<void> }> {
  if (candidate.worktreePath === null || !existsSync(candidate.worktreePath)) return { handle: undefined, release: async () => undefined };
  if (options.acquireMaintenanceLease !== undefined) {
    const handle = await options.acquireMaintenanceLease(candidate);
    return { handle, release: async () => { await options.releaseMaintenanceLease?.(handle); } };
  }
  const lock = options.workspaceLock;
  const workspace = options.workspaces?.find((entry) => entry.workspaceId === candidate.workspaceId);
  if (lock === undefined || workspace === undefined || candidate.workspaceId === null) {
    throw new GcExecutionError("GC_NOT_ELIGIBLE", "worktree maintenance lease binding is unavailable");
  }
  const handle = await lock.acquire({ workspaceId: candidate.workspaceId, canonicalPath: workspace.canonicalPath, executionId: candidate.executionId });
  return { handle, release: async () => { lock.release(handle); } };
}

async function executeOne(options: GcExecutorOptions, candidate: GcCandidate, runLock: GcRunLockHandle): Promise<void> {
  const fresh = (await planGcCandidates(options)).find((entry) => entry.executionId === candidate.executionId);
  if (fresh === undefined || fresh.decision !== "ELIGIBLE") throw new GcExecutionError("GC_NOT_ELIGIBLE", "candidate failed eligibility revalidation");
  const leased = await maintenanceLease(options, fresh);
  try {
    const marked = options.eventStore.append({
      taskId: fresh.taskId,
      attemptId: fresh.executionId,
      type: "gc.marked",
      payload: markPayload(options, fresh, runLock.runId),
    });
    await inject(options, "after_gc_marked");
    try {
      await (options.removeWorktree ?? ((entry) => defaultRemoveWorktree(options, entry)))(fresh);
    } catch (error) {
      if (error instanceof GcExecutionError) throw error;
      throw new GcExecutionError("GC_DELETE_FAILED", "worktree deletion failed", error);
    }
    await inject(options, "after_worktree_removed");
    try {
      await (options.removeArtifact ?? defaultRemoveArtifact)(fresh.artifactPath);
    } catch (error) {
      if (error instanceof GcExecutionError) throw error;
      throw new GcExecutionError("GC_DELETE_FAILED", "artifact deletion failed", error);
    }
    await inject(options, "after_artifacts_removed");
    const completedAt = options.nowMs;
    const preparedTombstone = prepareTombstone({
      executionId: fresh.executionId,
      taskId: fresh.taskId,
      workspaceId: fresh.workspaceId,
      finalState: fresh.finalState,
      createdAt: createdTimestamp(options, fresh.executionId),
      terminalAt: fresh.terminalAt ?? completedAt,
      retentionClass: fresh.retentionClass,
      gcMarkedEventId: marked.eventId,
      gcMarkedEventHash: marked.hash,
      gcCompletedAt: completedAt,
      artifactBytesBeforeGc: fresh.artifactBytes,
      worktreeBytesBeforeGc: fresh.worktreeBytes,
    });
    await inject(options, "after_tombstone_prepared");
    options.eventStore.append({
      taskId: fresh.taskId,
      attemptId: fresh.executionId,
      type: "gc.completed",
      payload: { gc_run_id: runLock.runId, tombstone_hash: preparedTombstone.selfHash, gc_completed_at: completedAt },
    });
    await inject(options, "after_gc_completed");
    await writePreparedTombstone(join(options.stateRoot, "tombstones", fresh.executionId + ".json"), preparedTombstone);
    await inject(options, "after_tombstone_written");
    options.eventStore.closeExecution(fresh.executionId);
    await inject(options, "before_execution_dir_removed");
    try {
      await rm(join(options.stateRoot, "executions", fresh.executionId), { recursive: true, force: false });
    } catch (error) {
      throw new GcExecutionError("GC_CLEANUP_PENDING", "execution state directory cleanup is pending", error);
    }
    cleanupProjection(options.database, fresh.executionId);
  } catch (error) {
    if (error instanceof GcFaultError) throw error;
    if (error instanceof GcExecutionError) throw error;
    throw new GcExecutionError("GC_INTERRUPTED", "GC stopped before completion", error);
  } finally {
    await leased.release().catch(() => undefined);
  }
}

function payloadNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function markedCandidate(options: GcExecutorOptions, executionId: string, markedIndex: number, marked: import("../events/events.js").TaskEvent): GcCandidate {
  const events = options.eventStore.getByAttemptId(executionId);
  let state: import("../execution/state-machine.js").TaskState | null = null;
  let terminalAt: number | null = null;
  const registry = new FingerprintRegistry();
  for (const event of events.slice(0, markedIndex)) {
    state = reduce(state, event, { fingerprintRegistry: registry });
    if (terminalAt === null && state !== null && isTerminal(state)) terminalAt = event.timestampMs;
  }
  const finalState = marked.payload["final_state"];
  const retentionClass = marked.payload["retention_class"];
  const artifactTarget = marked.payload["artifact_target"];
  if (typeof finalState !== "string" || !isTerminal(finalState as import("../execution/state-machine.js").TaskState) || typeof retentionClass !== "string" || artifactTarget !== executionId) {
    throw new GcExecutionError("GC_INTERRUPTED", "gc.marked payload is invalid");
  }
  const worktreeTarget = marked.payload["worktree_target"];
  const worktreePath = worktreeTarget === null || worktreeTarget === undefined
    ? null
    : assertDirectChild(options.worktreeRoot, resolve(options.worktreeRoot, String(worktreeTarget)));
  const row = options.database.prepare("SELECT workspace_id FROM executions WHERE execution_id = ?").get(executionId) as { workspace_id?: string | null } | undefined;
  return {
    executionId,
    taskId: marked.taskId,
    finalState: finalState as import("../execution/state-machine.js").TaskState,
    retentionClass,
    gcEligibleAt: payloadNumber(marked.payload["gc_eligible_at"]),
    terminalAt,
    artifactPath: resolve(options.artifactRoot, executionId),
    worktreePath,
    artifactBytes: payloadNumber(marked.payload["artifact_bytes"]) ?? 0,
    worktreeBytes: payloadNumber(marked.payload["worktree_bytes"]) ?? 0,
    workspaceId: row?.workspace_id ?? null,
    manifestGeneration: payloadNumber(marked.payload["manifest_generation"]),
    manifestHash: typeof marked.payload["manifest_hash"] === "string" ? marked.payload["manifest_hash"] : null,
    decision: "ELIGIBLE",
    reasons: [],
  };
}

async function cleanupReleasedReservationRecords(options: GcExecutorOptions, executionId: string): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(join(options.stateRoot, "reservations")).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const events = options.eventStore.getByAttemptId(executionId);
  for (const name of names) {
    const path = join(options.stateRoot, "reservations", name);
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (record.execution_id !== executionId || typeof record.reservation_set_id !== "string") continue;
      const released = events.some((event) =>
        ["storage.reservation.released", "storage.reservation.expired", "storage.reservation.abandoned"].includes(event.type) &&
        event.payload["reservation_set_id"] === record.reservation_set_id,
      );
      if (released) await rm(path, { force: true });
    } catch {
      // An invalid or unbound record is retained for operator inspection.
    }
  }
}

async function finalizeStateDirectory(options: GcExecutorOptions, executionId: string): Promise<void> {
  options.eventStore.closeExecution(executionId);
  try {
    await rm(join(options.stateRoot, "executions", executionId), { recursive: true, force: true });
  } catch (error) {
    throw new GcExecutionError("GC_CLEANUP_PENDING", "execution state directory cleanup is pending", error);
  }
  await cleanupReleasedReservationRecords(options, executionId);
  cleanupProjection(options.database, executionId);
}

async function resumeOne(options: GcExecutorOptions, executionId: string, runLock: GcRunLockHandle): Promise<void> {
  const events = options.eventStore.getByAttemptId(executionId);
  const markedIndex = events.findIndex((event) => event.type === "gc.marked");
  if (markedIndex < 0) return;
  const marked = events[markedIndex]!;
  const completed = events.find((event) => event.type === "gc.completed");
  for (const event of events.slice(markedIndex + 1)) {
    if (event.type !== "gc.completed" && (event.domain === "lifecycle" || event.domain === "recovery")) {
      throw new GcExecutionError("GC_INTERRUPTED", "GC_STATE_CHANGED_AFTER_MARK");
    }
  }
  const candidate = markedCandidate(options, executionId, markedIndex, marked);
  assertDirectExecutionChild(options.artifactRoot, candidate.artifactPath, executionId);
  if (candidate.worktreePath !== null && existsSync(candidate.worktreePath)) await assertSafeDeletionTarget(candidate.worktreePath);
  if (existsSync(candidate.artifactPath)) await assertSafeDeletionTarget(candidate.artifactPath);
  const tombstonePath = join(options.stateRoot, "tombstones", executionId + ".json");
  if (completed !== undefined) {
    const completedAt = payloadNumber(completed.payload["gc_completed_at"]);
    const preparedTombstone = prepareTombstone({
      executionId,
      taskId: candidate.taskId,
      workspaceId: candidate.workspaceId,
      finalState: candidate.finalState,
      createdAt: events.find((event) => event.type === "task.created")?.timestampMs ?? marked.timestampMs,
      terminalAt: candidate.terminalAt ?? marked.timestampMs,
      retentionClass: candidate.retentionClass,
      gcMarkedEventId: marked.eventId,
      gcMarkedEventHash: marked.hash,
      gcCompletedAt: completedAt ?? options.nowMs,
      artifactBytesBeforeGc: candidate.artifactBytes,
      worktreeBytesBeforeGc: candidate.worktreeBytes,
    });
    if (completed.payload["tombstone_hash"] !== preparedTombstone.selfHash) throw new GcExecutionError("GC_TOMBSTONE_INVALID", "gc.completed tombstone hash does not match deterministic reconstruction");
    const tombstone = await readTombstone(tombstonePath);
    if (tombstone === undefined) await writePreparedTombstone(tombstonePath, preparedTombstone);
    else if (tombstone.selfHash !== preparedTombstone.selfHash) throw new GcExecutionError("GC_TOMBSTONE_INVALID", "existing tombstone does not match gc.completed");
    await finalizeStateDirectory(options, executionId);
    return;
  }
  const leased = await maintenanceLease(options, candidate);
  try {
    await (options.removeWorktree ?? ((entry) => defaultRemoveWorktree(options, entry)))(candidate);
    await (options.removeArtifact ?? defaultRemoveArtifact)(candidate.artifactPath);
    const existing = await readTombstone(tombstonePath);
    if (existing !== undefined) {
      if (existing.gcMarkedEventId !== marked.eventId || existing.gcMarkedEventHash !== marked.hash) throw new GcExecutionError("GC_TOMBSTONE_INVALID", "pre-completed tombstone is not bound to gc.marked");
      // This is a legacy Phase 10 tombstone written before gc.completed. It
      // cannot remain as completion authority under the fixed protocol.
      await rm(tombstonePath, { force: false });
    }
    const preparedTombstone = prepareTombstone({
      executionId,
      taskId: candidate.taskId,
      workspaceId: candidate.workspaceId,
      finalState: candidate.finalState,
      createdAt: events.find((event) => event.type === "task.created")?.timestampMs ?? marked.timestampMs,
      terminalAt: candidate.terminalAt ?? marked.timestampMs,
      retentionClass: candidate.retentionClass,
      gcMarkedEventId: marked.eventId,
      gcMarkedEventHash: marked.hash,
      gcCompletedAt: options.nowMs,
      artifactBytesBeforeGc: candidate.artifactBytes,
      worktreeBytesBeforeGc: candidate.worktreeBytes,
    });
    await inject(options, "after_tombstone_prepared");
    options.eventStore.append({ taskId: candidate.taskId, attemptId: executionId, type: "gc.completed", payload: { gc_run_id: String(marked.payload["gc_run_id"] ?? runLock.runId), tombstone_hash: preparedTombstone.selfHash, gc_completed_at: preparedTombstone.gcCompletedAt } });
    await writePreparedTombstone(tombstonePath, preparedTombstone);
    await finalizeStateDirectory(options, executionId);
  } finally {
    await leased.release().catch(() => undefined);
  }
}

export interface GcResumeReport {
  readonly scanned: number;
  readonly completed: number;
  readonly failures: readonly { readonly executionId: string; readonly reason: string }[];
}

export interface SafeOrphanCleanupReport {
  readonly scanned: number;
  readonly removed: number;
  readonly invalid: number;
  readonly skipped: number;
}

export async function cleanupSafeOrphans(options: GcExecutorOptions): Promise<SafeOrphanCleanupReport> {
  let names: string[] = [];
  try {
    names = readdirSync(join(options.stateRoot, "tombstones"))
      .filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { scanned: 0, removed: 0, invalid: 0, skipped: 0 };
  }
  let invalid = 0;
  const validTombstones = new Map<string, NonNullable<Awaited<ReturnType<typeof readTombstone>>>>();
  for (const name of names) {
    try {
      const tombstone = await readTombstone(join(options.stateRoot, "tombstones", name));
      if (tombstone === undefined || name !== tombstone.executionId + ".json") throw new Error("tombstone binding");
      assertDirectExecutionChild(options.artifactRoot, resolve(options.artifactRoot, tombstone.executionId), tombstone.executionId);
      validTombstones.set(tombstone.executionId, tombstone);
    } catch {
      invalid += 1;
    }
  }
  if (validTombstones.size === 0) return { scanned: names.length, removed: 0, invalid, skipped: 0 };
  const lock = await acquireGcRunLock({ stateRoot: options.stateRoot });
  let removed = 0;
  let skipped = 0;
  try {
    for (const [executionId, tombstone] of validTombstones) {
      const artifactPath = resolve(options.artifactRoot, executionId);
      assertDirectExecutionChild(options.artifactRoot, artifactPath, executionId);
      const statePath = join(options.stateRoot, "executions", executionId);
      const stateExists = existsSync(statePath);
      const completed = options.eventStore.getByAttemptId(executionId).find((event) => event.type === "gc.completed" && event.payload["tombstone_hash"] === tombstone.selfHash);
      if (stateExists && completed === undefined) {
        skipped += 1;
        continue;
      }
      try {
        if ((await assertSafeDeletionTarget(artifactPath)) === "DIRECTORY") {
          await rm(artifactPath, { recursive: true, force: false });
          removed += 1;
        }
      } catch { skipped += 1; }
      if (existsSync(statePath)) {
        try {
          options.eventStore.closeExecution(executionId);
          await rm(statePath, { recursive: true, force: false });
          removed += 1;
        } catch { skipped += 1; }
      }
    }
  } finally {
    await lock.release().catch(() => undefined);
  }
  return { scanned: names.length, removed, invalid, skipped };
}

export async function resumeInterrupted(options: GcExecutorOptions): Promise<GcResumeReport> {
  let executionIds: string[] = [];
  try {
    executionIds = readdirSync(join(options.stateRoot, "executions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const markedIds = executionIds
    .filter((id) => options.executionId === undefined || id === options.executionId)
    .filter((id) => options.eventStore.getByAttemptId(id).some((event) => event.type === "gc.marked"));
  if (markedIds.length === 0) return { scanned: 0, completed: 0, failures: [] };
  const lock = await acquireGcRunLock({ stateRoot: options.stateRoot });
  const failures: { executionId: string; reason: string }[] = [];
  let completed = 0;
  try {
    for (const executionId of markedIds) {
      try {
        await resumeOne(options, executionId, lock);
        completed += 1;
      } catch (error) {
        failures.push({ executionId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    await lock.release().catch(() => undefined);
  }
  return { scanned: markedIds.length, completed, failures };
}

export async function executeGc(options: GcExecutorOptions): Promise<GcExecutionReport> {
  const plannedAll = await planGcCandidates(options);
  const planned = options.executionId === undefined
    ? plannedAll
    : plannedAll.filter((candidate) => candidate.executionId === options.executionId);
  const eligible = planned.filter((candidate) => candidate.decision === "ELIGIBLE");
  const blocked = planned.filter((candidate) => candidate.decision === "BLOCKED");
  if (eligible.length === 0) return { planned: 0, completed: 0, blocked, failures: [] };
  let lock: GcRunLockHandle | undefined;
  try {
    lock = await acquireGcRunLock({ stateRoot: options.stateRoot });
    const failures: { executionId: string; reason: string }[] = [];
    let completed = 0;
    for (const candidate of eligible) {
      try {
        await executeOne(options, candidate, lock);
        completed += 1;
      } catch (error) {
        failures.push({ executionId: candidate.executionId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { planned: eligible.length, completed, blocked, failures };
  } finally {
    await lock?.release().catch(() => undefined);
  }
}
