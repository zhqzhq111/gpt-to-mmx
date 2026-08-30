import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { hostname as localHostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { FingerprintRegistry } from "../execution/fingerprint.js";
import { isActive, isTerminal, type TaskState } from "../execution/state-machine.js";
import type { TaskEvent } from "../events/events.js";
import { EventStore, type JournalRecoveryIssue } from "../events/store.js";
import { replay } from "../events/replay.js";
import { computeReviewBundleHash } from "../review/bundle.js";
import { StateDatabase } from "../projection/database.js";
import {
  classifyLeasePolicy,
  scanLeaseOwnersSync,
  WorkspaceLock,
  type LeaseJournalState,
} from "../workspace/lock.js";

export type RecoveryIssueKind =
  | "JOURNAL_LOAD_ERROR"
  | "JOURNAL_TRUNCATED_TAIL"
  | "NON_TERMINAL_EXECUTION"
  | "UNKNOWN_WORKER"
  | "PROJECTION_STALE"
  | "MISSING_COMMITTED_ARTIFACT"
  | "ARTIFACT_HASH_MISMATCH"
  | "MISSING_OUTCOME"
  | "PARTIAL_ACCEPT_PREPARED"
  | "PARTIAL_ACCEPT_APPLY_STARTED"
  | "PARTIAL_ACCEPT_APPLIED"
  | "RETAINED_WORKTREE_CANDIDATE"
  | "LEASE_INCOMPLETE"
  | "LEASE_MALFORMED"
  | "LEASE_FOREIGN_HOST"
  | "LEASE_HEARTBEAT_MISMATCH"
  | "LEASE_STALE"
  | "LEASE_RECOVERY_BLOCKED"
  | "ORPHAN_HEARTBEAT"
  | "LOCK_REQUIRES_VALIDATION";

export type RecoveryIssueSeverity = "SAFE_HOLD" | "REPORT_ONLY";

export interface RecoveryIssue {
  readonly kind: RecoveryIssueKind;
  readonly severity: RecoveryIssueSeverity;
  readonly executionId?: string;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface RecoveryExecutionSummary {
  readonly executionId: string;
  readonly taskId: string | null;
  readonly state: TaskState | null;
  readonly events: readonly TaskEvent[];
  readonly appendable: boolean;
}

export interface RecoveryScanOptions {
  readonly stateRoot: string;
  readonly artifactRoot: string;
  readonly worktreeRoot: string;
  readonly eventStore: EventStore;
  readonly database?: StateDatabase;
  readonly stateDatabase?: StateDatabase;
  readonly workspaces?: readonly { readonly workspaceId: string; readonly canonicalPath: string }[];
}

export interface RecoveryScanReport {
  readonly issues: readonly RecoveryIssue[];
  readonly executions: readonly RecoveryExecutionSummary[];
}

const ISSUE_PRIORITY: Readonly<Record<RecoveryIssueKind, number>> = {
  JOURNAL_LOAD_ERROR: 10,
  JOURNAL_TRUNCATED_TAIL: 11,
  NON_TERMINAL_EXECUTION: 20,
  UNKNOWN_WORKER: 30,
  PROJECTION_STALE: 40,
  MISSING_COMMITTED_ARTIFACT: 50,
  ARTIFACT_HASH_MISMATCH: 60,
  MISSING_OUTCOME: 70,
  PARTIAL_ACCEPT_PREPARED: 80,
  PARTIAL_ACCEPT_APPLY_STARTED: 85,
  PARTIAL_ACCEPT_APPLIED: 90,
  RETAINED_WORKTREE_CANDIDATE: 100,
  LEASE_INCOMPLETE: 110,
  LEASE_MALFORMED: 111,
  LEASE_FOREIGN_HOST: 112,
  LEASE_HEARTBEAT_MISMATCH: 113,
  LEASE_RECOVERY_BLOCKED: 114,
  LEASE_STALE: 115,
  ORPHAN_HEARTBEAT: 116,
  LOCK_REQUIRES_VALIDATION: 120,
};

function payloadString(event: TaskEvent, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = event.payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function payloadNumber(event: TaskEvent, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = event.payload[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function eventEvidence(executionId: string, event: TaskEvent): string {
  return `journal:${executionId}:event:${event.seq}`;
}

function severityFor(state: TaskState | null): RecoveryIssueSeverity {
  return state !== null && isActive(state) ? "SAFE_HOLD" : "REPORT_ONLY";
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactReference(executionId: string, artifactPath: string): string {
  return `artifact:${executionId}/${artifactPath.replaceAll("\\", "/")}`;
}

function containedArtifactPath(
  artifactRoot: string,
  executionId: string,
  artifactPath: string,
): string | undefined {
  const executionRoot = resolve(artifactRoot, executionId);
  const candidate = resolve(executionRoot, artifactPath);
  const lexicalRelative = relative(executionRoot, candidate);
  if (
    lexicalRelative.length === 0 ||
    isAbsolute(lexicalRelative) ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith("..\\") ||
    lexicalRelative.startsWith("../")
  ) {
    return undefined;
  }
  if (!existsSync(candidate)) return candidate;
  try {
    const realRelative = relative(realpathSync(executionRoot), realpathSync(candidate));
    if (
      isAbsolute(realRelative) ||
      realRelative === ".." ||
      realRelative.startsWith("..\\") ||
      realRelative.startsWith("../")
    ) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

function addIssue(issues: RecoveryIssue[], issue: RecoveryIssue): void {
  issues.push(issue);
}

function validateFrozenPatch(
  issues: RecoveryIssue[],
  event: TaskEvent,
  artifactRoot: string,
  state: TaskState,
): void {
  const artifactPath = payloadString(event, "artifact_path", "artifactPath");
  const expectedHash = payloadString(event, "patch_blob_hash", "patchBlobHash");
  const expectedBytes = payloadNumber(event, "patch_bytes", "patchBytes");
  const evidence = eventEvidence(event.attemptId, event);
  if (artifactPath === undefined || expectedHash === undefined || expectedBytes === undefined) {
    addIssue(issues, {
      kind: "ARTIFACT_HASH_MISMATCH",
      severity: severityFor(state),
      executionId: event.attemptId,
      reason: "patch.frozen has incomplete artifact binding",
      evidence: [evidence],
    });
    return;
  }
  const reference = artifactReference(event.attemptId, artifactPath);
  const path = containedArtifactPath(artifactRoot, event.attemptId, artifactPath);
  if (path === undefined || !existsSync(path)) {
    addIssue(issues, {
      kind: path === undefined ? "ARTIFACT_HASH_MISMATCH" : "MISSING_COMMITTED_ARTIFACT",
      severity: severityFor(state),
      executionId: event.attemptId,
      reason: path === undefined ? "patch artifact path escapes artifact root" : "frozen patch artifact is missing",
      evidence: [evidence, reference],
    });
    return;
  }
  try {
    const bytes = readFileSync(path);
    if (bytes.length !== expectedBytes || sha256Bytes(bytes) !== expectedHash) {
      addIssue(issues, {
        kind: "ARTIFACT_HASH_MISMATCH",
        severity: severityFor(state),
        executionId: event.attemptId,
        reason: "frozen patch bytes or hash do not match the event binding",
        evidence: [evidence, reference],
      });
    }
  } catch {
    addIssue(issues, {
      kind: "ARTIFACT_HASH_MISMATCH",
      severity: severityFor(state),
      executionId: event.attemptId,
      reason: "frozen patch could not be read for validation",
      evidence: [evidence, reference],
    });
  }
}

function validateReviewBundle(
  issues: RecoveryIssue[],
  event: TaskEvent,
  artifactRoot: string,
  state: TaskState,
): void {
  const path = resolve(artifactRoot, event.attemptId, "review-bundle.json");
  const evidence = eventEvidence(event.attemptId, event);
  const reference = artifactReference(event.attemptId, "review-bundle.json");
  if (!existsSync(path)) {
    addIssue(issues, {
      kind: "MISSING_COMMITTED_ARTIFACT",
      severity: severityFor(state),
      executionId: event.attemptId,
      reason: "review bundle artifact is missing",
      evidence: [evidence, reference],
    });
    return;
  }
  try {
    const bundle = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const expectedHash = payloadString(event, "review_bundle_hash", "reviewBundleHash");
    const actualHash = bundle["reviewBundleHash"];
    if (expectedHash === undefined || actualHash !== expectedHash) throw new Error("binding");
    const { reviewBundleHash: ignored, ...withoutHash } = bundle;
    void ignored;
    if (computeReviewBundleHash(withoutHash as never) !== actualHash) throw new Error("self-hash");
  } catch {
    addIssue(issues, {
      kind: "ARTIFACT_HASH_MISMATCH",
      severity: severityFor(state),
      executionId: event.attemptId,
      reason: "review bundle hash or binding does not match review.requested",
      evidence: [evidence, reference],
    });
  }
}

function validateApplyEvidence(
  issues: RecoveryIssue[],
  event: TaskEvent,
  artifactRoot: string,
  state: TaskState,
): void {
  const path = resolve(artifactRoot, event.attemptId, "apply-evidence.json");
  const evidence = eventEvidence(event.attemptId, event);
  const reference = artifactReference(event.attemptId, "apply-evidence.json");
  const expectedHash = payloadString(event, "apply_evidence_hash", "applyEvidenceHash");
  if (!existsSync(path)) {
    addIssue(issues, {
      kind: "MISSING_COMMITTED_ARTIFACT",
      severity: severityFor(state),
      executionId: event.attemptId,
      reason: "apply evidence artifact is missing",
      evidence: [evidence, reference],
    });
    return;
  }
  try {
    if (expectedHash === undefined || sha256Bytes(readFileSync(path)) !== expectedHash) throw new Error("hash");
  } catch {
    addIssue(issues, {
      kind: "ARTIFACT_HASH_MISMATCH",
      severity: severityFor(state),
      executionId: event.attemptId,
      reason: "apply evidence bytes do not match patch.applied binding",
      evidence: [evidence, reference],
    });
  }
}

function directDirectories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function directFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function issueSort(left: RecoveryIssue, right: RecoveryIssue): number {
  const leftExecution = left.executionId ?? "~";
  const rightExecution = right.executionId ?? "~";
  return leftExecution.localeCompare(rightExecution)
    || ISSUE_PRIORITY[left.kind] - ISSUE_PRIORITY[right.kind]
    || left.reason.localeCompare(right.reason)
    || left.evidence.join("|").localeCompare(right.evidence.join("|"));
}

function databaseFor(options: RecoveryScanOptions): StateDatabase {
  const database = options.database ?? options.stateDatabase;
  if (database === undefined) throw new Error("scanRecovery requires a StateDatabase");
  return database;
}

function addProjectionIssues(
  issues: RecoveryIssue[],
  database: StateDatabase,
  executionId: string,
  events: readonly TaskEvent[],
): void {
  const last = events.at(-1);
  if (last === undefined) return;
  if (database.getMeta(`execution:${executionId}:stale`) !== undefined) {
    addIssue(issues, {
      kind: "PROJECTION_STALE",
      severity: "REPORT_ONLY",
      executionId,
      reason: "projection stale marker exists",
      evidence: [`projection:${executionId}:stale`],
    });
  }
  if (
    database.getMeta(`execution:${executionId}:last_event_hash`) !== last.hash ||
    database.getMeta(`execution:${executionId}:last_event_seq`) !== String(last.seq)
  ) {
    addIssue(issues, {
      kind: "PROJECTION_STALE",
      severity: "REPORT_ONLY",
      executionId,
      reason: "projection cursor does not match the journal",
      evidence: [`projection:${executionId}:cursor`, eventEvidence(executionId, last)],
    });
  }
}

function journalStateFor(summary: RecoveryExecutionSummary | undefined): LeaseJournalState {
  if (summary?.state === "RECOVERY_REQUIRED") return "RECOVERY_REQUIRED";
  if (summary?.state !== null && summary?.state !== undefined && isActive(summary.state)) return "ACTIVE";
  if (summary?.state !== null && summary?.state !== undefined && isTerminal(summary.state)) return "TERMINAL";
  return "MISSING";
}

function addLeaseIssue(
  issues: RecoveryIssue[],
  disposition: ReturnType<typeof classifyLeasePolicy>,
  executionId: string | undefined,
  workspaceKey: string,
): void {
  const map: Partial<Record<ReturnType<typeof classifyLeasePolicy>, RecoveryIssueKind>> = {
    INCOMPLETE: "LEASE_INCOMPLETE",
    MALFORMED: "LEASE_MALFORMED",
    FOREIGN_HOST: "LEASE_FOREIGN_HOST",
    HEARTBEAT_MISMATCH: "LEASE_HEARTBEAT_MISMATCH",
    STALE_TERMINAL_RECLAIMABLE: "LEASE_STALE",
    ACTIVE_EXECUTION_STALE_OWNER: "LEASE_STALE",
    RECOVERY_CRITICAL: "LEASE_RECOVERY_BLOCKED",
  };
  const kind = map[disposition];
  if (kind === undefined) return;
  const safeHold = disposition === "ACTIVE_EXECUTION_STALE_OWNER";
  addIssue(issues, {
    kind,
    severity: safeHold ? "SAFE_HOLD" : "REPORT_ONLY",
    ...(executionId !== undefined ? { executionId } : {}),
    reason: `lease ${workspaceKey} classified as ${disposition}`,
    evidence: [`lock:${workspaceKey}`],
  });
}

function addLeaseClassificationIssues(
  issues: RecoveryIssue[],
  stateRoot: string,
  summaries: ReadonlyMap<string, RecoveryExecutionSummary>,
): void {
  const lock = new WorkspaceLock({ stateRoot });
  const locksRoot = join(stateRoot, "locks");
  const lockNames = directFiles(locksRoot).filter((name) => name.endsWith(".lock"));
  const knownOwnerNames = new Set<string>();
  for (const owner of scanLeaseOwnersSync(stateRoot)) {
    const summary = summaries.get(owner.execution_id);
    const inspection = lock.inspectWorkspaceLeaseSync({ workspaceKey: owner.workspace_key });
    const disposition = classifyLeasePolicy({
      inspection,
      journalState: journalStateFor(summary),
      staleAfterMs: lock.staleAfter,
      currentHostname: localHostname(),
    });
    addLeaseIssue(issues, disposition, owner.execution_id, owner.workspace_key);
    knownOwnerNames.add(`${owner.workspace_key}.lock`);
  }
  for (const name of lockNames) {
    if (knownOwnerNames.has(name)) continue;
    const workspaceKey = name.slice(0, -".lock".length);
    const inspection = lock.inspectWorkspaceLeaseSync({ workspaceKey });
    addLeaseIssue(issues, inspection.owner === "INCOMPLETE" ? "INCOMPLETE" : "MALFORMED", undefined, workspaceKey);
    if (!/^[0-9a-f]{64}$/i.test(workspaceKey)) {
      addIssue(issues, {
        kind: "LOCK_REQUIRES_VALIDATION",
        severity: "REPORT_ONLY",
        reason: "legacy lock filename is not a Phase 7 workspace key",
        evidence: [`lock:${name}`],
      });
    }
  }
  for (const name of directFiles(locksRoot).filter((entry) => entry.endsWith(".heartbeat"))) {
    const stem = name.slice(0, -".heartbeat".length);
    const separator = stem.lastIndexOf(".");
    const workspaceKey = separator > 0 ? stem.slice(0, separator) : stem;
    const owner = lock.inspectWorkspaceLeaseSync({ workspaceKey }).owner;
    if (owner === "MISSING") {
      addIssue(issues, {
        kind: "ORPHAN_HEARTBEAT",
        severity: "REPORT_ONLY",
        reason: "heartbeat sidecar has no owner file",
        evidence: [`lock:${name}`],
      });
    }
  }
}

export function scanRecovery(options: RecoveryScanOptions): RecoveryScanReport {
  const database = databaseFor(options);
  const executionIds = directDirectories(join(options.stateRoot, "executions"));
  const storeIssues = new Map<string, JournalRecoveryIssue>();
  for (const issue of options.eventStore.recoveryIssues()) storeIssues.set(issue.executionId, issue);
  const issues: RecoveryIssue[] = [];
  const executions: RecoveryExecutionSummary[] = [];

  for (const executionId of executionIds) {
    const storeIssue = storeIssues.get(executionId);
    const events = options.eventStore.getByAttemptId(executionId);
    let state: TaskState | null = null;
    let replayed = true;
    if (storeIssue === undefined && events.length > 0) {
      try {
        state = replay(events, { fingerprintRegistry: new FingerprintRegistry() }).state;
      } catch {
        replayed = false;
        addIssue(issues, {
          kind: "JOURNAL_LOAD_ERROR",
          severity: "REPORT_ONLY",
          executionId,
          reason: "journal replay failed",
          evidence: [`journal:${executionId}`],
        });
      }
    }
    const row = database.prepare("SELECT task_id FROM executions WHERE execution_id = ?").get(executionId) as { task_id?: string } | undefined;
    executions.push({
      executionId,
      taskId: events[0]?.taskId ?? row?.task_id ?? null,
      state,
      events: events.slice(),
      appendable: storeIssue === undefined && replayed,
    });
    if (storeIssue !== undefined) {
      addIssue(issues, {
        kind: storeIssue.kind === "LOAD_ERROR" ? "JOURNAL_LOAD_ERROR" : "JOURNAL_TRUNCATED_TAIL",
        severity: "REPORT_ONLY",
        executionId,
        reason: storeIssue.kind === "LOAD_ERROR" ? "journal could not be loaded" : "journal has an unterminated tail",
        evidence: [`journal:${executionId}`],
      });
      continue;
    }
    if (state === null) continue;
    const severity = severityFor(state);
    if (isActive(state)) {
      const last = events.at(-1);
      addIssue(issues, {
        kind: "NON_TERMINAL_EXECUTION",
        severity: "SAFE_HOLD",
        executionId,
        reason: `execution remains in active state ${state}`,
        evidence: [last === undefined ? `journal:${executionId}` : eventEvidence(executionId, last)],
      });
    }
    if (
      events.some((event) => event.type === "agent.spawn.started") &&
      !events.some((event) => ["agent.completed", "agent.failed", "agent.timed_out", "agent.cancelled"].includes(event.type))
    ) {
      addIssue(issues, {
        kind: "UNKNOWN_WORKER",
        severity: "SAFE_HOLD",
        executionId,
        reason: "agent spawn has no terminal worker event",
        evidence: events.filter((event) => event.type === "agent.spawn.started").map((event) => eventEvidence(executionId, event)),
      });
    }
    addProjectionIssues(issues, database, executionId, events);
    for (const event of events) {
      if (event.type === "patch.frozen") validateFrozenPatch(issues, event, options.artifactRoot, state);
      if (event.type === "review.requested") validateReviewBundle(issues, event, options.artifactRoot, state);
      if (event.type === "patch.applied") validateApplyEvidence(issues, event, options.artifactRoot, state);
    }
    if (isTerminal(state) && !existsSync(resolve(options.artifactRoot, executionId, "outcome.json"))) {
      addIssue(issues, {
        kind: "MISSING_OUTCOME",
        severity: "REPORT_ONLY",
        executionId,
        reason: "terminal execution outcome artifact is missing",
        evidence: [`artifact:${executionId}/outcome.json`],
      });
    }
    const prepared = events.some((event) => event.type === "review.accept.prepared");
    const applyStarted = events.some((event) => event.type === "patch.apply.started");
    const applied = events.some((event) => event.type === "patch.applied");
    const completed = events.some((event) => event.type === "review.accept.completed");
    if (prepared && !applyStarted && !applied) {
      addIssue(issues, {
        kind: "PARTIAL_ACCEPT_PREPARED",
        severity,
        executionId,
        reason: "review.accept.prepared has no patch.apply.started event",
        evidence: events.filter((event) => event.type === "review.accept.prepared").map((event) => eventEvidence(executionId, event)),
      });
    } else if (applyStarted && !applied) {
      addIssue(issues, {
        kind: "PARTIAL_ACCEPT_APPLY_STARTED",
        severity,
        executionId,
        reason: "patch.apply.started has no patch.applied event",
        evidence: events.filter((event) => event.type === "patch.apply.started").map((event) => eventEvidence(executionId, event)),
      });
    } else if (applied && !completed) {
      addIssue(issues, {
        kind: "PARTIAL_ACCEPT_APPLIED",
        severity,
        executionId,
        reason: "patch.applied has no review.accept.completed event",
        evidence: events.filter((event) => event.type === "patch.applied").map((event) => eventEvidence(executionId, event)),
      });
    }
  }

  const summaries = new Map(executions.map((summary) => [summary.executionId, summary]));
  addLeaseClassificationIssues(issues, options.stateRoot, summaries);

  for (const name of directDirectories(options.worktreeRoot)) {
    addIssue(issues, {
      kind: "RETAINED_WORKTREE_CANDIDATE",
      severity: "REPORT_ONLY",
      reason: "direct worktree candidate requires binding validation",
      evidence: [`worktree:${name}`],
    });
  }
  issues.sort(issueSort);
  executions.sort((left, right) => left.executionId.localeCompare(right.executionId));
  return { issues, executions };
}
