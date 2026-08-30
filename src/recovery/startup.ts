import { fingerprintHash, FingerprintRegistry } from "../execution/fingerprint.js";
import { isActive, type TaskState } from "../execution/state-machine.js";
import { reduce } from "../events/reducer.js";
import { EventStore } from "../events/store.js";
import type { TaskEvent } from "../events/events.js";
import { EvidenceStore, type Evidence } from "../evidence/store.js";
import { StateDatabase } from "../projection/database.js";
import {
  ExecutionProjector,
  type ExecutionProjection,
} from "../projection/execution-projector.js";
import {
  appendRecoveryTransition,
  resolveRecovery,
} from "./resolver.js";
import type { RecoveryExecutionSummary, RecoveryIssue, RecoveryScanReport } from "./scanner.js";

export class StartupRecoveryError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "StartupRecoveryError";
    this.cause = cause;
  }
}

export interface StartupRecoveryOptions {
  readonly report: RecoveryScanReport;
  readonly eventStore: EventStore;
  readonly evidenceStore: EvidenceStore;
  readonly fingerprintRegistry: FingerprintRegistry;
  readonly database?: StateDatabase;
  readonly projector?: ExecutionProjection;
  readonly excludeExecutionIds?: readonly string[] | ReadonlySet<string>;
}

export interface ProjectionFailure {
  readonly executionId: string;
  readonly eventId: string;
  readonly eventHash: string;
  readonly reason: string;
}

/**
 * Plan §35 / §40. Partial ACCEPT executions are intentionally deferred to
 * the Accept Reconciler instead of being auto-transitioned to
 * RECOVERY_REQUIRED. The startup report carries the affected workspaces so
 * the CLI can refuse new runs on the same workspace.
 */
export type PartialAcceptKind = "PREPARED" | "APPLY_STARTED" | "APPLIED";

export interface AcceptRecoveryBlockedWorkspace {
  readonly workspaceId: string;
  readonly executionId: string;
  readonly partialAcceptKind: PartialAcceptKind;
}

export interface StartupRecoveryReport {
  readonly detectedCases: number;
  /** Execution IDs intentionally left for explicit recovery handling. */
  readonly excludedExecutionIds: readonly string[];
  readonly transitionedExecutionIds: readonly string[];
  readonly alreadyHeldExecutionIds: readonly string[];
  readonly reportOnlyIssues: readonly RecoveryIssue[];
  readonly projectionFailures: readonly ProjectionFailure[];
  /**
   * Workspaces blocked by an unresolved partial ACCEPT execution. New G2M
   * runs against one of these workspaces must refuse with
   * `WORKSPACE_ACCEPT_RECOVERY_REQUIRED` until the operator runs
   * `g2m recover --execution-id ...`.
   */
  readonly acceptRecoveryBlockedWorkspaces: readonly AcceptRecoveryBlockedWorkspace[];
}

function issueSort(left: RecoveryIssue, right: RecoveryIssue): number {
  return (left.executionId ?? "~").localeCompare(right.executionId ?? "~")
    || left.kind.localeCompare(right.kind)
    || left.reason.localeCompare(right.reason)
    || left.evidence.join("|").localeCompare(right.evidence.join("|"));
}

function latestEvidence<T extends Evidence>(
  evidence: readonly Evidence[],
  type: T["type"],
): T | undefined {
  return evidence
    .filter((entry): entry is T => entry.type === type)
    .sort((left, right) => left.createdAt - right.createdAt || left.evidenceId.localeCompare(right.evidenceId))
    .at(-1);
}

function projectorFor(options: StartupRecoveryOptions): ExecutionProjection {
  if (options.projector !== undefined) return options.projector;
  if (options.database !== undefined) return new ExecutionProjector(options.database);
  throw new StartupRecoveryError("startup recovery requires an ExecutionProjector or StateDatabase");
}

function summaryMap(report: RecoveryScanReport): ReadonlyMap<string, RecoveryExecutionSummary> {
  const summaries = new Map<string, RecoveryExecutionSummary>();
  for (const summary of report.executions) {
    if (summaries.has(summary.executionId)) {
      throw new StartupRecoveryError(`startup recovery report contains duplicate execution ${summary.executionId}`);
    }
    summaries.set(summary.executionId, summary);
  }
  return summaries;
}

function safeHoldGroups(report: RecoveryScanReport): ReadonlyMap<string, readonly RecoveryIssue[]> {
  const groups = new Map<string, RecoveryIssue[]>();
  for (const issue of report.issues) {
    if (issue.severity !== "SAFE_HOLD" || issue.executionId === undefined) continue;
    const existing = groups.get(issue.executionId);
    if (existing === undefined) groups.set(issue.executionId, [issue]);
    else existing.push(issue);
  }
  return groups;
}

function normalizedExecutionIds(
  ids: readonly string[] | ReadonlySet<string> | undefined,
): readonly string[] {
  return [...(ids ?? [])].sort((left, right) => left.localeCompare(right));
}

function stableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasRecoveryRequired(events: readonly TaskEvent[]): boolean {
  return events.some((event) => event.type === "recovery.required");
}

function derivePartialAcceptKind(
  state: TaskState,
  events: readonly TaskEvent[],
): PartialAcceptKind {
  if (state === "ACCEPT_PREPARED") {
    return events.some((event) => event.type === "patch.apply.started")
      ? "APPLY_STARTED"
      : "PREPARED";
  }
  if (state === "PATCH_APPLIED") return "APPLIED";
  throw new Error(`derivePartialAcceptKind called with non-partial state: ${state}`);
}

function workspaceIdFromEvents(
  events: readonly TaskEvent[],
): string | undefined {
  const taskEvent = events.find((event) => event.type === "task.created");
  if (taskEvent === undefined) return undefined;
  const task = taskEvent.payload["task"];
  if (!task || typeof task !== "object") return undefined;
  const scope = (task as { workspace_scope?: { workspace_id?: unknown } }).workspace_scope;
  if (scope === undefined) return undefined;
  return typeof scope.workspace_id === "string" ? scope.workspace_id : undefined;
}

function fingerprintMatches(
  summary: RecoveryExecutionSummary,
  fingerprintRegistry: FingerprintRegistry,
): boolean {
  const eventFingerprint = summary.events.at(-1)?.fingerprint;
  const taskId = summary.taskId ?? summary.events[0]?.taskId;
  const supplied = taskId === undefined ? undefined : fingerprintRegistry.get(taskId);
  return eventFingerprint !== undefined
    && supplied !== undefined
    && fingerprintHash(eventFingerprint) === fingerprintHash(supplied);
}

/**
 * Apply only the safe startup recovery transition discovered by the scanner.
 * Journal append is deliberately completed before reducer/projector work.
 */
export function runStartupRecovery(options: StartupRecoveryOptions): StartupRecoveryReport {
  const projector = projectorFor(options);
  const summaries = summaryMap(options.report);
  const groups = safeHoldGroups(options.report);
  const executionIds = [...groups.keys()].sort((left, right) => left.localeCompare(right));
  const excludedExecutionIds = normalizedExecutionIds(options.excludeExecutionIds);
  const excluded = new Set(excludedExecutionIds);
  const transitionedExecutionIds: string[] = [];
  const alreadyHeldExecutionIds: string[] = [];
  const projectionFailures: ProjectionFailure[] = [];
  const blockedWorkspaces: AcceptRecoveryBlockedWorkspace[] = [];

  for (const executionId of executionIds) {
    if (excluded.has(executionId)) continue;
    const summary = summaries.get(executionId);
    if (summary === undefined) {
      throw new StartupRecoveryError(`startup recovery issue has no execution summary: ${executionId}`);
    }

    const persistedEvents = options.eventStore.getByAttemptId(executionId);
    if (hasRecoveryRequired([...summary.events, ...persistedEvents])) {
      alreadyHeldExecutionIds.push(executionId);
      continue;
    }
    if (!summary.appendable || summary.state === null || !isActive(summary.state)) continue;

    // Phase 6 §36-§37: defer partial ACCEPT to the Accept Reconciler.
    // Do NOT append `recovery.required` — the reconciler will reconcile
    // (or refuse) once the operator proves the previous process is gone.
    if (summary.state === "ACCEPT_PREPARED" || summary.state === "PATCH_APPLIED") {
      const workspaceId = workspaceIdFromEvents([...summary.events, ...persistedEvents]);
      if (workspaceId !== undefined) {
        blockedWorkspaces.push({
          workspaceId,
          executionId,
          partialAcceptKind: derivePartialAcceptKind(summary.state, [
            ...summary.events,
            ...persistedEvents,
          ]),
        });
      }
      continue;
    }

    const taskId = summary.taskId ?? summary.events[0]?.taskId;
    if (taskId === undefined) {
      throw new StartupRecoveryError(`active recovery execution has no task id: ${executionId}`);
    }

    const evidence = options.evidenceStore.getByExecution(executionId);
    const worker = latestEvidence<Extract<Evidence, { type: "worker" }>>(evidence, "worker");
    const workspace = latestEvidence<Extract<Evidence, { type: "workspace" }>>(evidence, "workspace");
    const resolution = resolveRecovery({
      currentState: summary.state,
      events: summary.events,
      processStatus: "unknown",
      workerResult: worker?.workerResult ?? null,
      diff: workspace?.diff ?? null,
      fingerprintMatch: fingerprintMatches(summary, options.fingerprintRegistry),
      workspaceDirty: true,
    });
    if (resolution.verdict !== "UNKNOWN") {
      throw new StartupRecoveryError(
        `startup recovery resolver did not return UNKNOWN for ${executionId}: ${resolution.verdict}`,
      );
    }

    const issueKinds = [...(groups.get(executionId) ?? [])]
      .map((issue) => issue.kind)
      .sort((left, right) => left.localeCompare(right));
    const recoveryEvent = appendRecoveryTransition(resolution, {
      taskId,
      attemptId: executionId,
      currentState: summary.state,
      eventStore: options.eventStore,
    });
    if (recoveryEvent === null) {
      throw new StartupRecoveryError(`startup recovery could not append recovery.required for ${executionId}`);
    }
    // EventStore append above is the durable Journal barrier for CRITICAL
    // recovery.required. Only now reduce and project the event.
    const nextState = reduce(summary.state, recoveryEvent, {
      fingerprintRegistry: options.fingerprintRegistry,
    });
    transitionedExecutionIds.push(executionId);
    try {
      projector.project(recoveryEvent, nextState);
    } catch (error) {
      const reason = stableError(error);
      projectionFailures.push({
        executionId,
        eventId: recoveryEvent.eventId,
        eventHash: recoveryEvent.hash,
        reason,
      });
      options.eventStore.append({
        taskId,
        attemptId: executionId,
        type: "projection.stale",
        payload: {
          failedEventId: recoveryEvent.eventId,
          failedEventHash: recoveryEvent.hash,
          reason,
          issueKinds,
        },
      });
    }
  }

  return {
    detectedCases: executionIds.length,
    excludedExecutionIds,
    transitionedExecutionIds,
    alreadyHeldExecutionIds,
    reportOnlyIssues: options.report.issues.filter((issue) => issue.severity === "REPORT_ONLY").slice().sort(issueSort),
    projectionFailures,
    acceptRecoveryBlockedWorkspaces: blockedWorkspaces.slice().sort((left, right) =>
      left.workspaceId.localeCompare(right.workspaceId) || left.executionId.localeCompare(right.executionId),
    ),
  };
}
