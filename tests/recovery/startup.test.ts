import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EvidenceStore } from "../../src/evidence/store.js";
import { EventStore } from "../../src/events/store.js";
import type { TaskEvent } from "../../src/events/events.js";
import { reduce } from "../../src/events/reducer.js";
import { FingerprintRegistry, type TaskFingerprint } from "../../src/execution/fingerprint.js";
import type { TaskState } from "../../src/execution/state-machine.js";
import { StateDatabase } from "../../src/projection/database.js";
import {
  ExecutionProjector,
  type ExecutionProjection,
} from "../../src/projection/execution-projector.js";
import { scanRecovery, type RecoveryExecutionSummary, type RecoveryScanReport } from "../../src/recovery/scanner.js";
import { runStartupRecovery } from "../../src/recovery/startup.js";

const roots: string[] = [];
const databases: StateDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fingerprint(): TaskFingerprint {
  return {
    taskHash: "t".repeat(64),
    workspaceId: "workspace-1",
    baseRevision: "HEAD",
    mcodeVersion: "0.2.7",
    model: "minimax/MiniMax-M3",
    permissionProfile: "coding_standard",
    maxSteps: 30,
    timeoutMs: 60_000,
    adapterContractVersion: "g2m.worker.v1",
    runtimeCapabilitySnapshotHash: "runtime-1",
  };
}

async function activeFixture(endState: "RUNNING" | "REVIEW_PENDING"): Promise<{
  readonly root: string;
  readonly stateRoot: string;
  readonly artifactRoot: string;
  readonly worktreeRoot: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly store: EventStore;
  readonly database: StateDatabase;
  readonly projector: ExecutionProjector;
  readonly fingerprints: FingerprintRegistry;
  readonly summary: RecoveryExecutionSummary;
}> {
  const root = await mkdtemp(join(tmpdir(), "g2m-startup-recovery-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  const artifactRoot = join(root, "artifacts");
  const worktreeRoot = join(root, "worktrees");
  const executionId = endState === "RUNNING" ? "execution-running" : "execution-review";
  const taskId = `${executionId}-task`;
  const store = new EventStore({
    executionDirectory: join(stateRoot, "executions"),
    tolerateLoadErrors: true,
  });
  const fp = fingerprint();
  const append = (type: Parameters<EventStore["append"]>[0]["type"], payload: Record<string, unknown> = {}) =>
    store.append({ taskId, attemptId: executionId, type, payload, ...(type === "agent.spawn.started" ? { fingerprint: fp } : {}) });

  append("task.created", { task: { task_id: taskId } });
  append("task.validation.started");
  append("task.validation.passed");
  append("workspace.lock.requested");
  append("workspace.lock.acquired");
  append("agent.spawn.started");
  if (endState === "REVIEW_PENDING") {
    append("agent.completed");
    append("evidence.diff.collected");
    append("verification.completed");
    append("review.requested");
  }
  store.flush();

  const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
  databases.push(database);
  const projector = new ExecutionProjector(database);
  let state: TaskState | null = null;
  const replayFingerprints = new FingerprintRegistry();
  for (const event of store.getByAttemptId(executionId)) {
    state = reduce(state, event, { fingerprintRegistry: replayFingerprints });
    projector.project(event, state);
  }
  const fingerprints = new FingerprintRegistry();
  fingerprints.freeze(taskId, fp);
  const summary: RecoveryExecutionSummary = {
    executionId,
    taskId,
    state,
    events: store.getByAttemptId(executionId),
    appendable: true,
  };
  return {
    root,
    stateRoot,
    artifactRoot,
    worktreeRoot,
    executionId,
    taskId,
    store,
    database,
    projector,
    fingerprints,
    summary,
  };
}

function safeHoldReport(summary: RecoveryExecutionSummary): RecoveryScanReport {
  return {
    executions: [summary],
    issues: [{
      kind: "NON_TERMINAL_EXECUTION",
      severity: "SAFE_HOLD",
      executionId: summary.executionId,
      reason: `execution remains in active state ${summary.state}`,
      evidence: [`journal:${summary.executionId}`],
    }],
  };
}

function runningSummary(
  store: EventStore,
  executionId: string,
  taskId: string,
  fingerprints: FingerprintRegistry,
): RecoveryExecutionSummary {
  const fp = fingerprint();
  store.append({ taskId, attemptId: executionId, type: "task.created", payload: {} });
  store.append({ taskId, attemptId: executionId, type: "task.validation.started", payload: {} });
  store.append({ taskId, attemptId: executionId, type: "task.validation.passed", payload: {} });
  store.append({ taskId, attemptId: executionId, type: "workspace.lock.requested", payload: {} });
  store.append({ taskId, attemptId: executionId, type: "workspace.lock.acquired", payload: {} });
  store.append({ taskId, attemptId: executionId, type: "agent.spawn.started", payload: {}, fingerprint: fp });
  fingerprints.freeze(taskId, fp);
  return {
    executionId,
    taskId,
    state: "RUNNING",
    events: store.getByAttemptId(executionId),
    appendable: true,
  };
}

function coordinatorOptions(fixture: Awaited<ReturnType<typeof activeFixture>>, report: RecoveryScanReport) {
  return {
    report,
    eventStore: fixture.store,
    database: fixture.database,
    projector: fixture.projector,
    evidenceStore: new EvidenceStore(),
    fingerprintRegistry: fixture.fingerprints,
  };
}

describe("runStartupRecovery", () => {
  it("excludes the target deterministically while transitioning other active executions", () => {
    const store = new EventStore();
    const fingerprints = new FingerprintRegistry();
    const target = runningSummary(store, "z-target", "task-target", fingerprints);
    const other = runningSummary(store, "a-other", "task-other", fingerprints);
    const report = runStartupRecovery({
      report: {
        executions: [target, other],
        issues: [
          ...safeHoldReport(target).issues,
          ...safeHoldReport(other).issues,
        ],
      },
      eventStore: store,
      projector: { project() {} },
      evidenceStore: new EvidenceStore(),
      fingerprintRegistry: fingerprints,
      excludeExecutionIds: ["z-target"],
    });

    expect(report.excludedExecutionIds).toEqual(["z-target"]);
    expect(report.transitionedExecutionIds).toEqual(["a-other"]);
    expect(store.getByAttemptId("z-target").some((event) => event.type === "recovery.required")).toBe(false);
    expect(store.getByAttemptId("a-other").filter((event) => event.type === "recovery.required")).toHaveLength(1);
  });

  it("holds active RUNNING with exactly one critical recovery.required and projects RECOVERY_REQUIRED", async () => {
    const fixture = await activeFixture("RUNNING");
    const report = runStartupRecovery(coordinatorOptions(fixture, safeHoldReport(fixture.summary)));

    expect(report).toMatchObject({
      detectedCases: 1,
      transitionedExecutionIds: [fixture.executionId],
      alreadyHeldExecutionIds: [],
      projectionFailures: [],
    });
    const recoveryEvents = fixture.store.getByAttemptId(fixture.executionId)
      .filter((event) => event.type === "recovery.required");
    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents[0]?.durability).toBe("CRITICAL");
    expect(recoveryEvents[0]?.payload).toMatchObject({ reason: "process status is unknown; recovery must not assume the worker has exited" });
    expect(fixture.projector.execution(fixture.executionId)?.state).toBe("RECOVERY_REQUIRED");
  });

  it("safe-holds REVIEW_PENDING without attempting automatic review continuation", async () => {
    const fixture = await activeFixture("REVIEW_PENDING");
    const report = runStartupRecovery(coordinatorOptions(fixture, safeHoldReport(fixture.summary)));

    expect(report.transitionedExecutionIds).toEqual([fixture.executionId]);
    expect(fixture.store.getByAttemptId(fixture.executionId).at(-1)?.type).toBe("recovery.required");
    expect(fixture.projector.execution(fixture.executionId)?.state).toBe("RECOVERY_REQUIRED");
  });

  it("is idempotent when invoked again against the original scan snapshot", async () => {
    const fixture = await activeFixture("RUNNING");
    const report = safeHoldReport(fixture.summary);

    runStartupRecovery(coordinatorOptions(fixture, report));
    const second = runStartupRecovery(coordinatorOptions(fixture, report));

    expect(second).toMatchObject({
      detectedCases: 1,
      transitionedExecutionIds: [],
      alreadyHeldExecutionIds: [fixture.executionId],
      excludedExecutionIds: [],
      projectionFailures: [],
    });
    expect(fixture.store.getByAttemptId(fixture.executionId).filter((event) => event.type === "recovery.required"))
      .toHaveLength(1);
  });

  it("keeps recovery.required after projection failure and appends projection.stale with its binding", async () => {
    const fixture = await activeFixture("RUNNING");
    const projectedTypes: string[] = [];
    const failingProjector: ExecutionProjection = {
      project(event) {
        projectedTypes.push(event.type);
        throw new Error("injected projection failure");
      },
    };

    const report = runStartupRecovery({
      ...coordinatorOptions(fixture, safeHoldReport(fixture.summary)),
      projector: failingProjector,
    });
    const events = fixture.store.getByAttemptId(fixture.executionId);
    const recovery = events.find((event) => event.type === "recovery.required");
    const stale = events.find((event) => event.type === "projection.stale");

    expect(projectedTypes).toEqual(["recovery.required"]);
    expect(recovery).toBeDefined();
    expect(stale).toMatchObject({
      type: "projection.stale",
      durability: "CRITICAL",
      payload: {
        failedEventId: recovery?.eventId,
        failedEventHash: recovery?.hash,
        reason: "injected projection failure",
      },
    });
    expect(report.projectionFailures).toEqual([{
      executionId: fixture.executionId,
      eventId: recovery?.eventId,
      eventHash: recovery?.hash,
      reason: "injected projection failure",
    }]);
  });

  it("leaves terminal missing-outcome Journals unchanged as report-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-startup-terminal-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const executionId = "execution-terminal";
    const taskId = "task-terminal";
    const store = new EventStore({ executionDirectory: join(stateRoot, "executions"), tolerateLoadErrors: true });
    store.append({ taskId, attemptId: executionId, type: "task.created", payload: {} });
    store.append({ taskId, attemptId: executionId, type: "task.validation.started", payload: {} });
    store.append({ taskId, attemptId: executionId, type: "task.validation.failed", payload: {} });
    store.flush();
    const journalPath = join(stateRoot, "executions", executionId, "state-events.ndjson");
    const before = await readFile(journalPath);
    const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
    databases.push(database);
    const projector = new ExecutionProjector(database);
    const scan = scanRecovery({
      stateRoot,
      artifactRoot: join(root, "artifacts"),
      worktreeRoot: join(root, "worktrees"),
      eventStore: store,
      database,
    });

    const result = runStartupRecovery({
      report: scan,
      eventStore: store,
      database,
      projector,
      evidenceStore: new EvidenceStore(),
      fingerprintRegistry: new FingerprintRegistry(),
    });

    expect(scan.issues).toContainEqual(expect.objectContaining({
      kind: "MISSING_OUTCOME",
      severity: "REPORT_ONLY",
      executionId,
    }));
    expect(result.transitionedExecutionIds).toEqual([]);
    expect(result.reportOnlyIssues).toContainEqual(expect.objectContaining({ kind: "MISSING_OUTCOME", executionId }));
    expect(await readFile(journalPath)).toEqual(before);
  });

  it("leaves truncated and corrupt quarantined Journals unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-startup-quarantine-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const executionsRoot = join(stateRoot, "executions");
    await mkdir(join(executionsRoot, "execution-corrupt"), { recursive: true });
    await writeFile(join(executionsRoot, "execution-corrupt", "state-events.ndjson"), "not-json\n", "utf8");
    const truncatedStore = new EventStore({ executionDirectory: executionsRoot, tolerateLoadErrors: true });
    truncatedStore.append({ taskId: "task-truncated", attemptId: "execution-truncated", type: "task.created", payload: {} });
    truncatedStore.close();
    const truncatedPath = join(executionsRoot, "execution-truncated", "state-events.ndjson");
    await appendFile(truncatedPath, "{", "utf8");
    const store = new EventStore({ executionDirectory: executionsRoot, tolerateLoadErrors: true });
    const corruptBefore = await readFile(join(executionsRoot, "execution-corrupt", "state-events.ndjson"));
    const truncatedBefore = await readFile(truncatedPath);
    const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
    databases.push(database);
    const scan = scanRecovery({
      stateRoot,
      artifactRoot: join(root, "artifacts"),
      worktreeRoot: join(root, "worktrees"),
      eventStore: store,
      database,
    });

    const result = runStartupRecovery({
      report: scan,
      eventStore: store,
      database,
      projector: new ExecutionProjector(database),
      evidenceStore: new EvidenceStore(),
      fingerprintRegistry: new FingerprintRegistry(),
    });

    expect(result.transitionedExecutionIds).toEqual([]);
    expect(result.reportOnlyIssues.map((issue) => issue.kind)).toEqual([
      "JOURNAL_LOAD_ERROR",
      "JOURNAL_TRUNCATED_TAIL",
    ]);
    expect(await readFile(join(executionsRoot, "execution-corrupt", "state-events.ndjson"))).toEqual(corruptBefore);
    expect(await readFile(truncatedPath)).toEqual(truncatedBefore);
  });
});
