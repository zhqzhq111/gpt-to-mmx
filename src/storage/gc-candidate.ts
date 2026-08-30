import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

import type { StateDatabase } from "../projection/database.js";
import type { TaskEvent } from "../events/events.js";
import { EventStore, verifyChain } from "../events/store.js";
import { reduce } from "../events/reducer.js";
import { FingerprintRegistry } from "../execution/fingerprint.js";
import { isTerminal, type TaskState } from "../execution/state-machine.js";
import {
  assertDirectChild,
  assertDirectExecutionChild,
  assertSafeDeletionTarget,
} from "./tombstone.js";
import { readStorageManifest } from "./usage.js";
import { readLeaseOwnerSync, scanLeaseOwnersSync } from "../workspace/lock.js";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GcCandidate {
  readonly executionId: string;
  readonly taskId: string;
  readonly finalState: TaskState;
  readonly retentionClass: string;
  readonly gcEligibleAt: number | null;
  readonly terminalAt: number | null;
  readonly artifactPath: string;
  readonly worktreePath: string | null;
  readonly artifactBytes: number;
  readonly worktreeBytes: number;
  readonly workspaceId: string | null;
  readonly manifestGeneration: number | null;
  readonly manifestHash: string | null;
  readonly decision: "ELIGIBLE" | "BLOCKED";
  readonly reasons: readonly string[];
}

export interface GcPlannerWorkspace {
  readonly workspaceId: string;
  readonly canonicalPath: string;
}

export interface GcPlannerOptions {
  readonly stateRoot: string;
  readonly artifactRoot: string;
  readonly worktreeRoot: string;
  readonly eventStore: EventStore;
  readonly database: StateDatabase;
  readonly nowMs: number;
  readonly completedRetentionDays?: number;
  readonly workspaces?: readonly GcPlannerWorkspace[];
  readonly validateWorktreeBinding?: (input: {
    readonly worktreePath: string;
    readonly repositoryPath: string;
  }) => Promise<boolean>;
}

interface TerminalReplay {
  readonly state: TaskState | null;
  readonly terminalAt: number | null;
  readonly error?: string;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function taskIdFor(events: readonly TaskEvent[], row: Record<string, unknown> | undefined): string {
  return events[0]?.taskId ?? (typeof row?.task_id === "string" ? row.task_id : "");
}

function replayTerminal(events: readonly TaskEvent[]): TerminalReplay {
  if (events.length === 0) return { state: null, terminalAt: null, error: "empty journal" };
  if (events[0]?.type !== "task.created") return { state: null, terminalAt: null, error: "journal does not begin with task.created" };
  let state: TaskState | null = null;
  let terminalAt: number | null = null;
  const registry = new FingerprintRegistry();
  try {
    for (const event of events) {
      state = reduce(state, event, { fingerprintRegistry: registry });
      if (terminalAt === null && state !== null && isTerminal(state)) terminalAt = event.timestampMs;
    }
  } catch (error) {
    return { state, terminalAt, error: error instanceof Error ? error.message : String(error) };
  }
  return { state, terminalAt };
}

function retentionFor(state: TaskState | null): string | null {
  if (state === "ACCEPTED" || state === "BLOCKED" || state === "FAILED" || state === "CANCELLED" || state === "TIMED_OUT") return "NORMAL";
  if (state === "REVIEW_PENDING" || state === "REVISION_REQUESTED") return "RETAINED";
  if (state === "RECOVERY_REQUIRED") return "RECOVERY_CRITICAL";
  return null;
}

function directExecutionDirectories(stateRoot: string): string[] {
  try {
    return readdirSync(join(stateRoot, "executions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function defaultWorktreeBinding(input: { readonly worktreePath: string; readonly repositoryPath: string }): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: input.repositoryPath,
      windowsHide: true,
      timeout: 30_000,
    });
    const expected = resolve(input.worktreePath);
    const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    return stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .some((line) => normalize(resolve(line.slice("worktree ".length).trim())) === normalize(expected));
  } catch {
    return false;
  }
}

function activeReservationFromFiles(options: GcPlannerOptions, executionId: string, events: readonly TaskEvent[]): boolean {
  const statusEvents = new Set(
    events.filter((event) => [
      "storage.reservation.released", "storage.reservation.expired", "storage.reservation.abandoned",
    ].includes(event.type)).map((event) => String(event.payload["reservation_set_id"] ?? "")),
  );
  try {
    const names = readdirSync(join(options.stateRoot, "reservations"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    for (const entry of names) {
      try {
        const value = JSON.parse(readFileSync(join(options.stateRoot, "reservations", entry.name), "utf8")) as Record<string, unknown>;
        if (value.execution_id !== executionId) continue;
        if (value.schema_version !== 1 || !Array.isArray(value.reservations) || typeof value.reservation_set_id !== "string") return true;
        if (!statusEvents.has(value.reservation_set_id)) return true;
      } catch {
        return true;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  return false;
}

function leaseBlocks(options: GcPlannerOptions, executionId: string, workspaceId: string | null): boolean {
  if (scanLeaseOwnersSync(options.stateRoot).some((owner) => owner.execution_id === executionId || (workspaceId !== null && owner.workspace_id === workspaceId))) return true;
  try {
    return readdirSync(join(options.stateRoot, "locks"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".lock"))
      .some((entry) => {
        const owner = readLeaseOwnerSync(join(options.stateRoot, "locks", entry.name));
        return owner === "MALFORMED" || owner === "INCOMPLETE";
      });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function planOne(options: GcPlannerOptions, executionId: string): Promise<GcCandidate> {
  const row = options.database.prepare("SELECT * FROM executions WHERE execution_id = ?").get(executionId) as Record<string, unknown> | undefined;
  const reasons: string[] = [];
  const events = options.eventStore.getByAttemptId(executionId);
  const storeIssue = options.eventStore.recoveryIssues().find((issue) => issue.executionId === executionId);
  const replayed = replayTerminal(events);
  const finalState = replayed.state ?? (typeof row?.state === "string" ? row.state as TaskState : "RECOVERY_REQUIRED");
  const retentionClass = retentionFor(replayed.state) ?? (typeof row?.retention_class === "string" ? row.retention_class : "UNKNOWN");
  const taskId = taskIdFor(events, row);
  const artifactPath = resolve(options.artifactRoot, executionId);
  let worktreePath: string | null = null;
  let artifactBytes = 0;
  let worktreeBytes = 0;
  let manifestGeneration: number | null = null;
  let manifestHash: string | null = null;
  let manifestEligibleAt: number | null = null;
  let manifestRetention: string | null = null;

  if (storeIssue !== undefined || !verifyChain(events).valid || replayed.error !== undefined) reasons.push("GC_JOURNAL_INVALID");
  if (events.some((event) => event.type === "gc.marked") && !events.some((event) => event.type === "gc.completed")) reasons.push("GC_INTERRUPTED");
  if (events.some((event) => event.type === "gc.completed")) reasons.push("GC_CLEANUP_PENDING");
  if (replayed.state === null || !isTerminal(replayed.state) || retentionClass !== "NORMAL") reasons.push("GC_STATE_NOT_ELIGIBLE");
  const expectedEligibleAt = replayed.terminalAt === null || retentionClass !== "NORMAL"
    ? null
    : replayed.terminalAt + (options.completedRetentionDays ?? 30) * DAY_MS;
  if (expectedEligibleAt === null || options.nowMs < expectedEligibleAt) reasons.push("GC_RETENTION_NOT_EXPIRED");

  try {
    assertDirectExecutionChild(options.artifactRoot, artifactPath, executionId);
    const manifestPath = join(options.stateRoot, "executions", executionId, "storage-manifest.json");
    const manifest = await readStorageManifest(manifestPath);
    if (manifest === undefined || manifest.executionId !== executionId) throw new Error("manifest missing or execution binding mismatch");
    manifestGeneration = manifest.generation;
    manifestHash = hashBytes(readFileSync(manifestPath));
    manifestEligibleAt = manifest.gcEligibleAt;
    manifestRetention = manifest.retentionClass;
    artifactBytes = manifest.artifactBytes;
    worktreeBytes = manifest.worktreeBytes;
    if (manifestRetention !== retentionClass || manifestEligibleAt !== expectedEligibleAt) reasons.push("GC_PROJECTION_DISAGREEMENT");
    if (resolve(manifest.artifactPath) !== artifactPath) reasons.push("GC_MANIFEST_INVALID");
    try {
      const artifactState = await assertSafeDeletionTarget(artifactPath);
      if (artifactState !== "DIRECTORY") reasons.push("GC_MANIFEST_INVALID");
    } catch { reasons.push("GC_PATH_UNSAFE"); }
    try {
      worktreePath = assertDirectChild(options.worktreeRoot, manifest.worktreePath);
      const targetState = await assertSafeDeletionTarget(worktreePath);
      if (targetState === "DIRECTORY") {
        const workspaceId = typeof row?.workspace_id === "string" ? row.workspace_id : null;
        const workspace = options.workspaces?.find((candidate) => candidate.workspaceId === workspaceId);
        if (workspace === undefined) reasons.push("GC_WORKTREE_BINDING_UNCERTAIN");
        else if (!(await (options.validateWorktreeBinding ?? defaultWorktreeBinding)({ worktreePath, repositoryPath: workspace.canonicalPath }))) reasons.push("GC_WORKTREE_BINDING_UNCERTAIN");
      }
    } catch { reasons.push("GC_PATH_UNSAFE"); }
  } catch { reasons.push("GC_MANIFEST_INVALID"); }

  const workspaceId = typeof row?.workspace_id === "string" ? row.workspace_id : null;
  if (leaseBlocks(options, executionId, workspaceId)) reasons.push("GC_ACTIVE_LEASE");
  const activeRow = Number((options.database.prepare("SELECT COUNT(*) AS count FROM storage_reservations WHERE execution_id = ? AND state = 'ACTIVE'").get(executionId) as { count: number | bigint }).count);
  if (activeRow > 0 || activeReservationFromFiles(options, executionId, events)) reasons.push("GC_ACTIVE_RESERVATION");
  if (row === undefined || row.state !== finalState || row.retention_class !== retentionClass || Number(row.gc_eligible_at ?? -1) !== expectedEligibleAt) reasons.push("GC_PROJECTION_DISAGREEMENT");

  const uniqueReasons = [...new Set(reasons)].sort();
  return Object.freeze({
    executionId,
    taskId,
    finalState,
    retentionClass,
    gcEligibleAt: expectedEligibleAt,
    terminalAt: replayed.terminalAt,
    artifactPath,
    worktreePath,
    artifactBytes,
    worktreeBytes,
    workspaceId,
    manifestGeneration,
    manifestHash,
    decision: uniqueReasons.length === 0 ? "ELIGIBLE" : "BLOCKED",
    reasons: Object.freeze(uniqueReasons),
  });
}

export async function planGcCandidates(options: GcPlannerOptions): Promise<readonly GcCandidate[]> {
  const candidates: GcCandidate[] = [];
  for (const executionId of directExecutionDirectories(options.stateRoot)) candidates.push(await planOne(options, executionId));
  return Object.freeze(candidates);
}
