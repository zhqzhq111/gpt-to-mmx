import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import type { TaskEvent } from "../../src/events/events.js";
import { FingerprintRegistry, type TaskFingerprint } from "../../src/execution/fingerprint.js";
import { isActive, type TaskState } from "../../src/execution/state-machine.js";
import { reduce } from "../../src/events/reducer.js";
import { StateDatabase } from "../../src/projection/database.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";
import {
  computeReviewBundleHash,
  type ReviewBundle,
} from "../../src/review/bundle.js";
import {
  scanRecovery,
  type RecoveryIssue,
  type RecoveryScanOptions,
} from "../../src/recovery/scanner.js";
import { executeGc, GcFaultError, type GcExecutorOptions } from "../../src/storage/gc.js";
import { writeStorageManifestAtomic } from "../../src/storage/usage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  readonly root: string;
  readonly stateRoot: string;
  readonly executionRoot: string;
  readonly artifactRoot: string;
  readonly worktreeRoot: string;
  readonly database: StateDatabase;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "g2m-recovery-scanner-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  const executionRoot = join(stateRoot, "executions");
  const artifactRoot = join(root, "artifacts");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(executionRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  return {
    root,
    stateRoot,
    executionRoot,
    artifactRoot,
    worktreeRoot,
    database: new StateDatabase(join(stateRoot, "g2m-state.sqlite")),
  };
}

function fingerprint(): TaskFingerprint {
  return {
    taskHash: "task-hash",
    workspaceId: "workspace-1",
    baseRevision: "base-revision",
    mcodeVersion: "0.2.7",
    model: "minimax/MiniMax-M3",
    permissionProfile: "coding_standard",
    maxSteps: 30,
    timeoutMs: 600_000,
    adapterContractVersion: "g2m.worker.v1",
    runtimeCapabilitySnapshotHash: "runtime-hash",
  };
}

function append(store: EventStore, executionId: string, taskId: string, type: TaskEvent["type"], payload: Record<string, unknown> = {}): TaskEvent {
  return store.append({ taskId, attemptId: executionId, type, payload });
}

function appendToRunning(store: EventStore, executionId: string, taskId = `${executionId}-task`): void {
  append(store, executionId, taskId, "task.created", {
    task: { task_id: taskId, workspace_scope: { workspace_id: "workspace-1", base_revision: "base-revision" } },
  });
  append(store, executionId, taskId, "task.validation.started");
  append(store, executionId, taskId, "task.validation.passed");
  append(store, executionId, taskId, "workspace.lock.requested");
  append(store, executionId, taskId, "workspace.lock.acquired");
  append(store, executionId, taskId, "agent.spawn.started", {},);
  const events = store.getByAttemptId(executionId);
  const started = events.at(-1);
  if (started === undefined) throw new Error("spawn event was not appended");
  // Replace the event is not possible through EventStore; the running fixture
  // uses the explicit fingerprint overload below when it needs reducer replay.
}

function appendToRunningWithFingerprint(store: EventStore, executionId: string, taskId = `${executionId}-task`): void {
  append(store, executionId, taskId, "task.created", {
    task: { task_id: taskId, workspace_scope: { workspace_id: "workspace-1", base_revision: "base-revision" } },
  });
  append(store, executionId, taskId, "task.validation.started");
  append(store, executionId, taskId, "task.validation.passed");
  append(store, executionId, taskId, "workspace.lock.requested");
  append(store, executionId, taskId, "workspace.lock.acquired");
  store.append({ taskId, attemptId: executionId, type: "agent.spawn.started", payload: {}, fingerprint: fingerprint() });
}

function appendToSucceeded(store: EventStore, executionId: string, taskId = `${executionId}-task`): void {
  appendToRunningWithFingerprint(store, executionId, taskId);
  append(store, executionId, taskId, "agent.completed");
  append(store, executionId, taskId, "evidence.diff.collected");
  append(store, executionId, taskId, "verification.completed");
}

function appendToReviewPending(store: EventStore, executionId: string, taskId = `${executionId}-task`, reviewBundleHash = "r".repeat(64)): void {
  appendToSucceeded(store, executionId, taskId);
  append(store, executionId, taskId, "review.requested", {
    review_bundle_id: `${executionId}-bundle`,
    review_bundle_hash: reviewBundleHash,
    task_hash: "t".repeat(64),
    result_hash: "q".repeat(64),
  });
}

function replayAndProject(database: StateDatabase, events: readonly TaskEvent[]): TaskState | null {
  const projector = new ExecutionProjector(database);
  const registry = new FingerprintRegistry();
  let state: TaskState | null = null;
  for (const event of events) {
    state = reduce(state, event, { fingerprintRegistry: registry });
    projector.project(event, state);
  }
  return state;
}

function scannerOptions(f: Fixture, eventStore: EventStore): RecoveryScanOptions {
  return {
    stateRoot: f.stateRoot,
    artifactRoot: f.artifactRoot,
    worktreeRoot: f.worktreeRoot,
    database: f.database,
    eventStore,
  };
}

function issueKinds(report: { issues: readonly RecoveryIssue[] }, executionId: string): string[] {
  return report.issues.filter((issue) => issue.executionId === executionId).map((issue) => issue.kind);
}

async function writeReviewBundle(artifactRoot: string, executionId: string, reviewBundleHashOverride?: string): Promise<string> {
  const partial = {
    protocolVersion: "g2m.code-review-bundle.v1",
    bundleId: `${executionId}-bundle`,
    taskId: `${executionId}-task`,
    executionId,
    taskHash: "t".repeat(64),
    resultHash: "q".repeat(64),
    createdAt: 1,
    originalTask: {},
    workerRuntime: { runtime: "fake", version: "1", model: "test" },
    workerSummary: {},
    workspaceEvidence: { diff: {}, baseline: {}, patch: {} },
    verificationEvidence: { verification: {} },
    warnings: [],
    remainingRisks: [],
  } as unknown as Omit<ReviewBundle, "reviewBundleHash">;
  const hash = computeReviewBundleHash(partial);
  const bundle = { ...partial, reviewBundleHash: reviewBundleHashOverride ?? hash };
  await mkdir(join(artifactRoot, executionId), { recursive: true });
  await writeFile(join(artifactRoot, executionId, "review-bundle.json"), `${JSON.stringify(bundle)}\n`, "utf8");
  return hash;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("scanRecovery", () => {
  it("reports every active execution and an unfinished worker as SAFE_HOLD", async () => {
    const f = await fixture();
    const seed = new EventStore({ executionDirectory: f.executionRoot });
    appendToRunningWithFingerprint(seed, "active-running");
    seed.close();
    const events = new EventStore({ executionDirectory: f.executionRoot, tolerateLoadErrors: true });
    const active = events.getByAttemptId("active-running");
    expect(replayAndProject(f.database, active)).toBe("RUNNING");

    const report = scanRecovery(scannerOptions(f, events));

    expect(issueKinds(report, "active-running")).toEqual(expect.arrayContaining([
      "NON_TERMINAL_EXECUTION",
      "UNKNOWN_WORKER",
    ]));
    expect(report.issues.filter((issue) => issue.executionId === "active-running")
      .filter((issue) => issue.kind === "NON_TERMINAL_EXECUTION" || issue.kind === "UNKNOWN_WORKER")
      .every((issue) => issue.severity === "SAFE_HOLD")).toBe(true);
    expect(report.executions).toContainEqual(expect.objectContaining({
      executionId: "active-running",
      taskId: "active-running-task",
      state: "RUNNING",
      appendable: true,
    }));
    events.close();
    f.database.close();
  });

  it("reports missing outcome for a terminal execution without a safe hold", async () => {
    const f = await fixture();
    const seed = new EventStore({ executionDirectory: f.executionRoot });
    appendToRunningWithFingerprint(seed, "terminal-failed");
    append(seed, "terminal-failed", "terminal-failed-task", "agent.failed");
    seed.close();
    const events = new EventStore({ executionDirectory: f.executionRoot, tolerateLoadErrors: true });
    replayAndProject(f.database, events.getByAttemptId("terminal-failed"));

    const report = scanRecovery(scannerOptions(f, events));

    expect(issueKinds(report, "terminal-failed")).toContain("MISSING_OUTCOME");
    expect(report.issues.find((issue) => issue.executionId === "terminal-failed" && issue.kind === "MISSING_OUTCOME")?.severity)
      .toBe("REPORT_ONLY");
    events.close();
    f.database.close();
  });

  it("detects both partial ACCEPT boundaries as active safe holds", async () => {
    const f = await fixture();
    const seed = new EventStore({ executionDirectory: f.executionRoot });
    appendToReviewPending(seed, "prepared-only");
    append(seed, "prepared-only", "prepared-only-task", "review.accept.prepared", {
      reviewId: "review-1", reviewBundleId: "prepared-only-bundle", reviewHash: "h".repeat(64),
    });
    appendToReviewPending(seed, "applied-only");
    append(seed, "applied-only", "applied-only-task", "review.accept.prepared", {
      reviewId: "review-2", reviewBundleId: "applied-only-bundle", reviewHash: "h".repeat(64),
    });
    append(seed, "applied-only", "applied-only-task", "patch.applied", {
      patch_blob_hash: "p".repeat(64), expected_change_set_hash: "c".repeat(64),
      actual_change_set_hash: "c".repeat(64), apply_evidence_hash: "a".repeat(64),
    });
    seed.close();
    const events = new EventStore({ executionDirectory: f.executionRoot, tolerateLoadErrors: true });
    replayAndProject(f.database, events.getByAttemptId("prepared-only"));
    replayAndProject(f.database, events.getByAttemptId("applied-only"));

    const report = scanRecovery(scannerOptions(f, events));

    expect(issueKinds(report, "prepared-only")).toContain("PARTIAL_ACCEPT_PREPARED");
    expect(issueKinds(report, "applied-only")).toContain("PARTIAL_ACCEPT_APPLIED");
    expect(report.issues.filter((issue) => issue.kind.startsWith("PARTIAL_ACCEPT"))
      .every((issue) => issue.severity === "SAFE_HOLD")).toBe(true);
    events.close();
    f.database.close();
  });

  it("validates exact patch, review, and apply artifacts without false positives", async () => {
    const f = await fixture();
    const patch = Buffer.from("diff --git a/a b/a\n", "utf8");
    const patchHash = sha256Bytes(patch);
    const seed = new EventStore({ executionDirectory: f.executionRoot });
    appendToRunningWithFingerprint(seed, "valid-artifacts");
    append(seed, "valid-artifacts", "valid-artifacts-task", "agent.completed");
    append(seed, "valid-artifacts", "valid-artifacts-task", "evidence.diff.collected");
    append(seed, "valid-artifacts", "valid-artifacts-task", "patch.frozen", {
      artifact_id: "valid-patch", artifact_path: "frozen.patch", patch_blob_hash: patchHash, patch_bytes: patch.length,
    });
    const reviewHash = await writeReviewBundle(f.artifactRoot, "valid-artifacts");
    append(seed, "valid-artifacts", "valid-artifacts-task", "verification.completed");
    append(seed, "valid-artifacts", "valid-artifacts-task", "review.requested", {
      review_bundle_id: "valid-artifacts-bundle", review_bundle_hash: reviewHash,
    });
    append(seed, "valid-artifacts", "valid-artifacts-task", "review.accept.prepared", {
      reviewId: "review-1", reviewBundleId: "valid-artifacts-bundle", reviewHash,
    });
    const applyEvidence = Buffer.from("{\"status\":\"applied\"}\n", "utf8");
    await writeFile(join(f.artifactRoot, "valid-artifacts", "frozen.patch"), patch);
    await writeFile(join(f.artifactRoot, "valid-artifacts", "apply-evidence.json"), applyEvidence);
    append(seed, "valid-artifacts", "valid-artifacts-task", "patch.applied", {
      patch_blob_hash: patchHash, apply_evidence_hash: sha256Bytes(applyEvidence),
    });
    append(seed, "valid-artifacts", "valid-artifacts-task", "review.accept.completed", {
      reviewId: "review-1", reviewBundleId: "valid-artifacts-bundle", reviewHash,
    });
    seed.close();
    await writeFile(join(f.artifactRoot, "valid-artifacts", "outcome.json"), "{\"ok\":true}\n", "utf8");
    const events = new EventStore({ executionDirectory: f.executionRoot, tolerateLoadErrors: true });
    const loaded = events.getByAttemptId("valid-artifacts");
    expect(replayAndProject(f.database, loaded)).toBe("ACCEPTED");

    const report = scanRecovery(scannerOptions(f, events));

    expect(report.issues.filter((issue) => issue.executionId === "valid-artifacts")).toEqual([]);
    events.close();
    f.database.close();
  });

  it("reports missing and mismatched bound patch artifacts", async () => {
    const f = await fixture();
    const seed = new EventStore({ executionDirectory: f.executionRoot });
    for (const executionId of ["missing-patch", "mismatched-patch"]) {
      appendToRunningWithFingerprint(seed, executionId);
      append(seed, executionId, `${executionId}-task`, "agent.completed");
      append(seed, executionId, `${executionId}-task`, "evidence.diff.collected");
      append(seed, executionId, `${executionId}-task`, "patch.frozen", {
        artifact_id: `${executionId}-patch`, artifact_path: "frozen.patch", patch_blob_hash: "p".repeat(64), patch_bytes: 4,
      });
      append(seed, executionId, `${executionId}-task`, "verification.completed");
    }
    seed.close();
    await mkdir(join(f.artifactRoot, "mismatched-patch"), { recursive: true });
    await writeFile(join(f.artifactRoot, "mismatched-patch", "frozen.patch"), "bad!", "utf8");
    const events = new EventStore({ executionDirectory: f.executionRoot, tolerateLoadErrors: true });
    replayAndProject(f.database, events.getByAttemptId("missing-patch"));
    replayAndProject(f.database, events.getByAttemptId("mismatched-patch"));

    const report = scanRecovery(scannerOptions(f, events));

    expect(issueKinds(report, "missing-patch")).toContain("MISSING_COMMITTED_ARTIFACT");
    expect(issueKinds(report, "mismatched-patch")).toContain("ARTIFACT_HASH_MISMATCH");
    events.close();
    f.database.close();
  });

  it("classifies malformed and truncated journals while healthy executions remain appendable", async () => {
    const f = await fixture();
    const seed = new EventStore({ executionDirectory: f.executionRoot });
    appendToRunningWithFingerprint(seed, "z-healthy");
    seed.close();
    await mkdir(join(f.executionRoot, "a-malformed"), { recursive: true });
    await writeFile(join(f.executionRoot, "a-malformed", "state-events.ndjson"), "{bad\n", "utf8");
    const healthyJournal = join(f.executionRoot, "z-healthy", "state-events.ndjson");
    const healthyBytes = await readFile(healthyJournal);
    await writeFile(healthyJournal, healthyBytes.subarray(0, healthyBytes.lastIndexOf(10)),);
    const events = new EventStore({ executionDirectory: f.executionRoot, tolerateLoadErrors: true });
    replayAndProject(f.database, events.getByAttemptId("z-healthy"));

    const report = scanRecovery(scannerOptions(f, events));

    expect(issueKinds(report, "a-malformed")).toContain("JOURNAL_LOAD_ERROR");
    expect(issueKinds(report, "z-healthy")).toContain("JOURNAL_TRUNCATED_TAIL");
    expect(report.executions.find((execution) => execution.executionId === "a-malformed")?.appendable).toBe(false);
    expect(report.executions.find((execution) => execution.executionId === "z-healthy")?.appendable).toBe(false);
    expect(() => events.append({ taskId: "new-task", attemptId: "new-execution", type: "task.created", payload: {} })).not.toThrow();
    events.close();
    f.database.close();
  });

  it("reports stale projection metadata and cursor mismatch deterministically", async () => {
    const f = await fixture();
    const seed = new EventStore({ executionDirectory: f.executionRoot });
    appendToSucceeded(seed, "cursor-mismatch");
    appendToSucceeded(seed, "stale-meta");
    seed.close();
    const events = new EventStore({ executionDirectory: f.executionRoot, tolerateLoadErrors: true });
    const cursorEvents = events.getByAttemptId("cursor-mismatch");
    const staleEvents = events.getByAttemptId("stale-meta");
    replayAndProject(f.database, cursorEvents);
    replayAndProject(f.database, staleEvents);
    f.database.setMeta("execution:cursor-mismatch:last_event_hash", "wrong");
    f.database.setMeta("execution:stale-meta:stale", "backfill required");

    const report = scanRecovery(scannerOptions(f, events));

    expect(issueKinds(report, "cursor-mismatch")).toContain("PROJECTION_STALE");
    expect(issueKinds(report, "stale-meta")).toContain("PROJECTION_STALE");
    expect(report.issues.map((issue) => `${issue.executionId ?? ""}:${issue.kind}`)).toEqual(
      [...report.issues].sort((a, b) => `${a.executionId ?? "~"}:${a.kind}`.localeCompare(`${b.executionId ?? "~"}:${b.kind}`)).map((issue) => `${issue.executionId ?? ""}:${issue.kind}`),
    );
    events.close();
    f.database.close();
  });

  it("reports worktree and lock candidates read-only and leaves source bytes unchanged", async () => {
    const f = await fixture();
    const seed = new EventStore({ executionDirectory: f.executionRoot });
    appendToRunningWithFingerprint(seed, "bound-execution");
    seed.close();
    const events = new EventStore({ executionDirectory: f.executionRoot, tolerateLoadErrors: true });
    replayAndProject(f.database, events.getByAttemptId("bound-execution"));
    await mkdir(join(f.worktreeRoot, "unbound-worktree"), { recursive: true });
    const worktreeFile = join(f.worktreeRoot, "unbound-worktree", "marker");
    await writeFile(worktreeFile, "keep", "utf8");
    await mkdir(join(f.stateRoot, "locks"), { recursive: true });
    const lockFile = join(f.stateRoot, "locks", "lease.lock");
    await writeFile(lockFile, "lock-data", "utf8");
    const before = {
      journal: await readFile(join(f.executionRoot, "bound-execution", "state-events.ndjson")),
      worktree: await readFile(worktreeFile),
      lock: await readFile(lockFile),
      meta: f.database.getMeta("execution:bound-execution:last_event_hash"),
    };

    const report = scanRecovery(scannerOptions(f, events));

    expect(report.issues.some((issue) => issue.kind === "RETAINED_WORKTREE_CANDIDATE" && issue.severity === "REPORT_ONLY")).toBe(true);
    expect(report.issues.some((issue) => issue.kind === "LOCK_REQUIRES_VALIDATION" && issue.severity === "REPORT_ONLY")).toBe(true);
    expect(await readFile(join(f.executionRoot, "bound-execution", "state-events.ndjson"))).toEqual(before.journal);
    expect(await readFile(worktreeFile)).toEqual(before.worktree);
    expect(await readFile(lockFile)).toEqual(before.lock);
    expect(f.database.getMeta("execution:bound-execution:last_event_hash")).toBe(before.meta);
    events.close();
    f.database.close();
  });

  it("classifies stale, recovery-blocked, and malformed leases without deleting them", async () => {
    const f = await fixture();
    const seed = new EventStore({ executionDirectory: f.executionRoot });
    appendToReviewPending(seed, "terminal-lease");
    append(seed, "terminal-lease", "terminal-lease-task", "review.decision.block", {
      review_bundle_id: "terminal-lease-bundle", review_id: "review-1",
    });
    appendToRunningWithFingerprint(seed, "active-lease");
    appendToRunningWithFingerprint(seed, "recovery-lease");
    append(seed, "recovery-lease", "recovery-lease-task", "recovery.required", { reason: "unknown" });
    seed.close();
    const events = new EventStore({ executionDirectory: f.executionRoot, tolerateLoadErrors: true });
    replayAndProject(f.database, events.getByAttemptId("terminal-lease"));
    replayAndProject(f.database, events.getByAttemptId("active-lease"));
    replayAndProject(f.database, events.getByAttemptId("recovery-lease"));
    await mkdir(join(f.stateRoot, "locks"), { recursive: true });
    const leases = [
      ["a".repeat(64), "terminal-lease", "terminal-lease-task"],
      ["b".repeat(64), "active-lease", "active-lease-task"],
      ["c".repeat(64), "recovery-lease", "recovery-lease-task"],
    ] as const;
    for (const [key, executionId] of leases) {
      await writeFile(join(f.stateRoot, "locks", `${key}.lock`), JSON.stringify({
        lock_version: 1, workspace_key: key, workspace_id: "workspace-1", execution_id: executionId,
        lease_id: `lease-${executionId}`, pid: 999999, hostname: hostname(), created_at: 0, heartbeat_at: 0,
      }) + "\n", "utf8");
      await writeFile(join(f.stateRoot, "locks", `${key}.lease-${executionId}.heartbeat`), JSON.stringify({
        heartbeat_version: 1, workspace_key: key, lease_id: `lease-${executionId}`, heartbeat_at: 0,
      }) + "\n", "utf8");
    }
    const malformedPath = join(f.stateRoot, "locks", `${"d".repeat(64)}.lock`);
    await writeFile(malformedPath, "not-json", "utf8");
    const before = await readFile(malformedPath);

    const report = scanRecovery(scannerOptions(f, events));

    expect(report.issues).toContainEqual(expect.objectContaining({ kind: "LEASE_STALE", executionId: "terminal-lease", severity: "REPORT_ONLY" }));
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: "LEASE_STALE", executionId: "active-lease", severity: "SAFE_HOLD" }));
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: "LEASE_RECOVERY_BLOCKED", executionId: "recovery-lease" }));
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: "LEASE_MALFORMED" }));
    expect(await readFile(malformedPath)).toEqual(before);
    events.close();
    f.database.close();
  });

  it("reports interrupted GC and suppresses ordinary missing-artifact/outcome errors", async () => {
    const f = await fixture();
    const seed = new EventStore({ executionDirectory: f.executionRoot });
    appendToRunning(seed, "gc-interrupted");
    append(seed, "gc-interrupted", "gc-interrupted-task", "agent.failed");
    seed.close();
    const events = new EventStore({ executionDirectory: f.executionRoot, tolerateLoadErrors: true });
    replayAndProject(f.database, events.getByAttemptId("gc-interrupted"));
    const artifactPath = join(f.artifactRoot, "gc-interrupted");
    await mkdir(artifactPath, { recursive: true });
    await writeFile(join(artifactPath, "outcome.json"), "outcome", "utf8");
    const terminalAt = events.getByAttemptId("gc-interrupted").at(-1)?.timestampMs ?? 0;
    await writeStorageManifestAtomic(join(f.stateRoot, "executions", "gc-interrupted", "storage-manifest.json"), {
      executionId: "gc-interrupted",
      artifactBytes: 7,
      worktreeBytes: 0,
      artifactPath,
      worktreePath: join(f.worktreeRoot, "missing"),
      retentionClass: "NORMAL",
      gcEligibleAt: terminalAt + 30 * 24 * 60 * 60 * 1000,
      updatedAt: terminalAt,
    });
    const gcOptions: GcExecutorOptions = {
      stateRoot: f.stateRoot,
      artifactRoot: f.artifactRoot,
      worktreeRoot: f.worktreeRoot,
      eventStore: events,
      database: f.database,
      nowMs: terminalAt + 30 * 24 * 60 * 60 * 1000 + 1,
      completedRetentionDays: 30,
      fault: async (point) => { if (point === "after_gc_marked") throw new GcFaultError(point); },
    };
    await executeGc(gcOptions);
    await rm(artifactPath, { recursive: true, force: true });

    const report = scanRecovery(scannerOptions(f, events));

    expect(issueKinds(report, "gc-interrupted")).toContain("GC_INTERRUPTED");
    expect(issueKinds(report, "gc-interrupted")).not.toContain("MISSING_OUTCOME");
    expect(issueKinds(report, "gc-interrupted")).not.toContain("MISSING_COMMITTED_ARTIFACT");
    events.close();
    f.database.close();
  });
});
