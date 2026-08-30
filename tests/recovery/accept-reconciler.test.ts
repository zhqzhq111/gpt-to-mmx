/**
 * Phase 6 Accept Reconciler tests — plan §15-§26.
 *
 * The reconciler must prove what happened to a partial ACCEPT execution
 * from durable evidence alone (Frozen Patch, Journal, target Git state).
 * These tests exercise every disposition of `runAcceptRecovery` plus
 * the process-status and idempotency rules.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import type { TaskEvent } from "../../src/events/events.js";
import { FingerprintRegistry, type TaskFingerprint } from "../../src/execution/fingerprint.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";
import { StateDatabase } from "../../src/projection/database.js";
import { sha256 as canonicalSha256 } from "../../src/protocol/hash.js";
import { ReplayGuard } from "../../src/review/replay-guard.js";
import { computeReviewBundleHash, type ReviewBundle } from "../../src/review/bundle.js";
import {
  runAcceptRecovery,
  isPartialAccept,
  type AcceptProcessStatus,
  type AcceptRecoveryInput,
} from "../../src/recovery/accept-reconciler.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd, timeout: 30_000, windowsHide: true, shell: false,
  });
  return stdout.trim();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const FINGERPRINT: TaskFingerprint = {
  taskHash: "task-hash",
  workspaceId: "ws-1",
  baseRevision: "BASE",
  mcodeVersion: "0.2.7",
  model: "minimax/MiniMax-M3",
  permissionProfile: "coding_standard",
  maxSteps: 30,
  timeoutMs: 600_000,
  adapterContractVersion: "g2m.worker.v1",
  runtimeCapabilitySnapshotHash: "runtime-hash",
};

interface Fixture {
  readonly root: string;
  readonly repositoryPath: string;
  readonly artifactRoot: string;
  readonly executionRoot: string;
  readonly patchBlobHash: string;
  readonly changeSetHash: string;
  readonly reviewBundleHash: string;
  readonly reviewId: string;
  readonly reviewBundleId: string;
  readonly reviewHash: string;
  readonly baseRevision: string;
  database?: StateDatabase;
}

async function makeFixture(setup: "clean" | "applied" | "partial-extra"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "g2m-accept-reconciler-"));
  roots.push(root);
  const repositoryPath = join(root, "repo");
  const artifactRoot = join(root, "artifacts");
  const executionRoot = join(root, "state", "executions");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(executionRoot, { recursive: true });
  await git(repositoryPath, ["init", "--initial-branch=main"]);
  await git(repositoryPath, ["config", "user.email", "g2m@test.local"]);
  await git(repositoryPath, ["config", "user.name", "G2M Test"]);
  await writeFile(join(repositoryPath, "source.txt"), "before\n", "utf8");
  await git(repositoryPath, ["add", "."]);
  await git(repositoryPath, ["commit", "-m", "baseline"]);
  const baseRevision = await git(repositoryPath, ["rev-parse", "HEAD"]);

  // Write a real patch that flips source.txt to "after\n".
  const patchBytes = Buffer.from(
    [
      "diff --git a/source.txt b/source.txt",
      "index 0000001..0000002 100644",
      "--- a/source.txt",
      "+++ b/source.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n"),
    "utf8",
  );
  const patchBlobHash = sha256Hex(patchBytes);
  const changeSetHash = canonicalSha256([
    { path: "source.txt", kind: "file", mode: "100644", content_sha256: sha256Hex(Buffer.from("after\n", "utf8")) },
  ]);

  // Write frozen patch + metadata.
  const executionId = "exec-1";
  const executionArtifact = join(artifactRoot, executionId);
  await mkdir(executionArtifact, { recursive: true });
  await writeFile(join(executionArtifact, "frozen.patch"), patchBytes);
  await writeFile(
    join(executionArtifact, "frozen-patch.json"),
    JSON.stringify({
      artifact_id: `patch-${executionId}`,
      artifact_path: "frozen.patch",
      patch_blob_hash: patchBlobHash,
      change_set_hash: changeSetHash,
      base_revision: baseRevision,
      patch_bytes: patchBytes.length,
      change_set: [
        { path: "source.txt", kind: "file", mode: "100644", content_sha256: sha256Hex(Buffer.from("after\n", "utf8")) },
      ],
    }, null, 2) + "\n",
  );

  // Build a minimal ReviewBundle + Review for the immutable artifacts.
  const reviewId = "rev-1";
  const reviewBundleId = "bundle-1";
  const reviewHash = "f".repeat(64);
  const bundle: Omit<ReviewBundle, "reviewBundleHash"> = {
    protocolVersion: "g2m.code-review-bundle.v1",
    bundleId: reviewBundleId,
    taskId: "task-1",
    executionId,
    taskHash: "a".repeat(64),
    resultHash: "b".repeat(64),
    createdAt: 0,
    originalTask: {
      task_id: "task-1",
      protocol_version: "g2m.code-task.v1",
      workspace_scope: { workspace_id: "ws-1", base_revision: baseRevision, require_clean_worktree: false },
      goal: "test",
      constraints: [],
      requested_capabilities: { read: true, write: true, test: false, network: false },
      permission_policy: "coding_standard",
      limits: { max_steps: 1, timeout_ms: 1_000 },
      verification_profile: "none",
      acceptance_criteria: [],
      session_policy: { mode: "new" },
    },
    workerRuntime: { runtime: "fake", version: "0.0.0", model: "minimax/MiniMax-M3" },
    workerSummary: {
      executionId,
      summary: "ok",
      filesChanged: ["source.txt"],
      testsAttempted: [],
      remainingRisks: [],
    },
    workspaceEvidence: {
      diff: {
        workspacePath: repositoryPath,
        baseRevision,
        fullDiff: "",
        diffStat: "",
        changedFiles: [],
        untrackedFiles: [],
        deletedFiles: [],
        protectedFilesTouched: [],
        diffHash: "c".repeat(64),
        capturedAt: 0,
      },
      baseline: { canonicalPath: repositoryPath, baseRevision, statusPorcelain: "", dirty: false, capturedAt: 0 },
      patch: {
        artifactId: `patch-${executionId}`,
        artifactPath: "frozen.patch",
        baseRevision,
        patchBlobHash,
        changeSetHash,
        patchBytes: patchBytes.length,
        changeSet: [],
        patchHash: patchBlobHash,
        patchText: patchBytes.toString("utf8"),
        changedFiles: ["source.txt"],
        empty: false,
      },
    },
    verificationEvidence: {
      verification: {
        profileId: "none",
        workspaceId: "ws-1",
        workspacePath: repositoryPath,
        program: "noop",
        args: [],
        status: "passed",
        exitCode: 0,
        signal: null,
        resultHash: "d".repeat(64),
        startedAt: 0,
        finishedAt: 0,
        durationMs: 0,
        stdout: "",
        stderr: "",
      },
    },
    warnings: [],
    remainingRisks: [],
  };
  const reviewBundleHash = computeReviewBundleHash(bundle);
  const fullBundle: ReviewBundle = { ...bundle, reviewBundleHash };
  await writeFile(join(executionArtifact, "review-bundle.json"), JSON.stringify(fullBundle, null, 2) + "\n");

  // Review.json (Phase 6 §8) — must match review-binding below.
  const reviewJson = {
    protocolVersion: "g2m.review.v1",
    reviewId,
    taskId: "task-1",
    executionId,
    reviewBundleId,
    taskHash: "a".repeat(64),
    resultHash: "b".repeat(64),
    reviewBundleHash,
    decision: "ACCEPT",
    timestampMs: 0,
    reviewHash,
  };
  const reviewJsonBytes = Buffer.from(JSON.stringify(reviewJson, null, 2) + "\n", "utf8");
  await writeFile(join(executionArtifact, "review.json"), reviewJsonBytes);
  const reviewArtifactHash = sha256Hex(reviewJsonBytes);

  if (setup === "applied") {
    // Pre-apply the patch so target == EXACT_EXPECTED_CHANGE_SET.
    await git(repositoryPath, ["apply", "--binary", join(executionArtifact, "frozen.patch")]);
  } else if (setup === "partial-extra") {
    // Apply the patch and add an extra user file.
    await git(repositoryPath, ["apply", "--binary", join(executionArtifact, "frozen.patch")]);
    await writeFile(join(repositoryPath, "user-note.txt"), "unrelated\n", "utf8");
  }

  return {
    root,
    repositoryPath,
    artifactRoot,
    executionRoot,
    patchBlobHash,
    changeSetHash,
    reviewBundleHash,
    reviewId,
    reviewBundleId,
    reviewHash,
    baseRevision,
  };
}

function makeInput(
  fixture: Fixture,
  processStatus: AcceptProcessStatus,
  events: readonly TaskEvent[],
  overrides: Partial<AcceptRecoveryInput> = {},
): AcceptRecoveryInput {
  const executionId = "exec-1";
  const eventStore = new EventStore({});
  const database = new StateDatabase(":memory:");
  const projector = new ExecutionProjector(database);
  const replayGuard = new ReplayGuard({ statePath: join(fixture.root, "state", "replay-guard.json") });
  const fingerprintRegistry = new FingerprintRegistry({ statePath: join(fixture.root, "state", "fingerprints.json") });
  for (const event of events) eventStore.append({
    taskId: event.taskId,
    attemptId: event.attemptId,
    type: event.type,
    payload: event.payload,
    ...(event.fingerprint !== undefined ? { fingerprint: event.fingerprint } : {}),
  });
  fixture.database = database;
  return {
    executionId,
    processStatus,
    events,
    repositoryPath: fixture.repositoryPath,
    artifactRoot: fixture.artifactRoot,
    temporaryRoot: fixture.artifactRoot,
    eventStore,
    projector,
    replayGuard,
    fingerprintRegistry,
    ...overrides,
  };
}

function buildBaseEvents(fixture: Fixture, includeApplyStarted: boolean): TaskEvent[] {
  const reviewArtifactHash = sha256Hex(Buffer.from(JSON.stringify({
    protocolVersion: "g2m.review.v1",
    reviewId: fixture.reviewId,
    taskId: "task-1",
    executionId: "exec-1",
    reviewBundleId: fixture.reviewBundleId,
    taskHash: "a".repeat(64),
    resultHash: "b".repeat(64),
    reviewBundleHash: fixture.reviewBundleHash,
    decision: "ACCEPT",
    timestampMs: 0,
    reviewHash: fixture.reviewHash,
  }, null, 2) + "\n", "utf8"));

  const events: TaskEvent[] = [
    {
      schemaVersion: 1, eventId: "e1", seq: 1, timestampMs: 0,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "task.created", durability: "CRITICAL",
      prevHash: null, hash: "h1",
      payload: { task: { task_id: "task-1", workspace_scope: { workspace_id: "ws-1", base_revision: fixture.baseRevision } } },
      fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e2", seq: 2, timestampMs: 1,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "task.validation.started", durability: "CRITICAL",
      prevHash: "h1", hash: "h2", payload: {}, fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e3", seq: 3, timestampMs: 2,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "task.validation.passed", durability: "CRITICAL",
      prevHash: "h2", hash: "h3", payload: {}, fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e4", seq: 4, timestampMs: 3,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "workspace.lock.requested", durability: "CRITICAL",
      prevHash: "h3", hash: "h4", payload: {}, fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e5", seq: 5, timestampMs: 4,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "workspace.lock.acquired", durability: "CRITICAL",
      prevHash: "h4", hash: "h5", payload: {}, fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e6", seq: 6, timestampMs: 5,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "agent.spawn.started", durability: "CRITICAL",
      prevHash: "h5", hash: "h6", payload: {}, fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e7", seq: 7, timestampMs: 6,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "agent.completed", durability: "CRITICAL",
      prevHash: "h6", hash: "h7", payload: {}, fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e8", seq: 8, timestampMs: 7,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "evidence.diff.collected", durability: "CRITICAL",
      prevHash: "h7", hash: "h8",
      payload: { diffHash: "c".repeat(64) }, fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e9", seq: 9, timestampMs: 8,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "patch.frozen", durability: "CRITICAL",
      prevHash: "h8", hash: "h9",
      payload: {
        artifact_id: "patch-exec-1",
        artifact_path: "frozen.patch",
        patch_blob_hash: fixture.patchBlobHash,
        change_set_hash: fixture.changeSetHash,
        base_revision: fixture.baseRevision,
        patch_bytes: 1,
      },
      fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e10", seq: 10, timestampMs: 9,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "verification.completed", durability: "CRITICAL",
      prevHash: "h9", hash: "h10",
      payload: { resultHash: "d".repeat(64) }, fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e11", seq: 11, timestampMs: 10,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "review.requested", durability: "CRITICAL",
      prevHash: "h10", hash: "h11",
      payload: {
        review_bundle_id: fixture.reviewBundleId,
        review_bundle_hash: fixture.reviewBundleHash,
        task_hash: "a".repeat(64),
        result_hash: "b".repeat(64),
      },
      fingerprint: FINGERPRINT,
    },
    {
      schemaVersion: 1, eventId: "e12", seq: 12, timestampMs: 11,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "review.accept.prepared", durability: "CRITICAL",
      prevHash: "h11", hash: "h12",
      payload: {
        reviewId: fixture.reviewId,
        reviewBundleId: fixture.reviewBundleId,
        reviewHash: fixture.reviewHash,
        review_artifact_path: "review.json",
        review_artifact_hash: reviewArtifactHash,
        patch_blob_hash: fixture.patchBlobHash,
        change_set_hash: fixture.changeSetHash,
        base_revision: fixture.baseRevision,
      },
      fingerprint: FINGERPRINT,
    },
  ];
  if (includeApplyStarted) {
    events.push({
      schemaVersion: 1, eventId: "e13", seq: 13, timestampMs: 12,
      taskId: "task-1", attemptId: "exec-1",
      domain: "lifecycle", type: "patch.apply.started", durability: "CRITICAL",
      prevHash: "h12", hash: "h13",
      payload: {
        patch_blob_hash: fixture.patchBlobHash,
        change_set_hash: fixture.changeSetHash,
        base_revision: fixture.baseRevision,
        review_id: fixture.reviewId,
        review_bundle_id: fixture.reviewBundleId,
        review_hash: fixture.reviewHash,
      },
      fingerprint: FINGERPRINT,
    });
  }
  return events;
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("Accept Reconciler", () => {
  it("exposes isPartialAccept for ACCEPT_PREPARED and PATCH_APPLIED only", () => {
    expect(isPartialAccept("ACCEPT_PREPARED")).toBe(true);
    expect(isPartialAccept("PATCH_APPLIED")).toBe(true);
    expect(isPartialAccept("REVIEW_PENDING")).toBe(false);
    expect(isPartialAccept("ACCEPTED")).toBe(false);
    expect(isPartialAccept(null)).toBe(false);
  });

  it("returns NOT_PARTIAL_ACCEPT when execution never prepared an ACCEPT", async () => {
    const fixture = await makeFixture("clean");
    const events: TaskEvent[] = [{
      schemaVersion: 1,
      eventId: "only",
      seq: 1,
      timestampMs: 0,
      taskId: "task-1",
      attemptId: "exec-1",
      domain: "lifecycle",
      type: "task.created",
      durability: "CRITICAL",
      prevHash: null,
      hash: "h",
      payload: { task: { task_id: "task-1", workspace_scope: { workspace_id: "ws-1", base_revision: fixture.baseRevision } } },
      fingerprint: FINGERPRINT,
    }];
    const input = makeInput(fixture, "exited_clean", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("NOT_PARTIAL_ACCEPT");
    expect(result.reason).toMatch(/not a partial ACCEPT/);
  });

  it("returns PROCESS_NOT_PROVEN_GONE for alive / unknown", async () => {
    const fixture = await makeFixture("clean");
    const events = buildBaseEvents(fixture, false);
    for (const status of ["alive", "unknown"] as const) {
      const input = makeInput(fixture, status, events);
      const result = await runAcceptRecovery(input);
      expect(result.verdict).toBe("PROCESS_NOT_PROVEN_GONE");
    }
  });

  it("resumes a CLEAN_BASE target when ACCEPT_PREPARED is durable", async () => {
    const fixture = await makeFixture("clean");
    const events = buildBaseEvents(fixture, false);
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    if (result.verdict !== "RESUMED_AND_ACCEPTED") {
      throw new Error(`expected RESUMED_AND_ACCEPTED, got ${result.verdict}: ${result.reason}`);
    }
    expect(result.targetState).toBe("CLEAN_BASE");
    expect(result.appendedEvents).toContain("patch.apply.started");
    expect(result.appendedEvents).toContain("patch.applied");
    expect(result.appendedEvents).toContain("review.accept.completed");
    expect(result.applyEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.outcomeHash).toMatch(/^[a-f0-9]{64}$/);
    const applied = await git(fixture.repositoryPath, ["status", "--porcelain"]);
    expect(applied).not.toBe("");
    const content = readFileSync(join(fixture.repositoryPath, "source.txt"), "utf8").replace(/\r\n/g, "\n");
    expect(content).toBe("after\n");
  });

  it("reconciles a target already at EXACT_EXPECTED_CHANGE_SET without re-applying", async () => {
    const fixture = await makeFixture("applied");
    const events = buildBaseEvents(fixture, true);
    events.push({
      schemaVersion: 1,
      eventId: "applied",
      seq: 14,
      timestampMs: 13,
      taskId: "task-1",
      attemptId: "exec-1",
      domain: "lifecycle",
      type: "patch.applied",
      durability: "CRITICAL",
      prevHash: "h13",
      hash: "h14",
      payload: {
        patch_blob_hash: fixture.patchBlobHash,
        expected_change_set_hash: fixture.changeSetHash,
        actual_change_set_hash: fixture.changeSetHash,
        apply_evidence_hash: "0".repeat(64),
        outcome_hash: "0".repeat(64),
        status: "applied",
        targetPath: fixture.repositoryPath,
      },
      fingerprint: FINGERPRINT,
    });
    const input = makeInput(fixture, "exited_clean", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECONCILED_AND_ACCEPTED");
    expect(result.targetState).toBe("EXACT_EXPECTED_CHANGE_SET");
    expect(result.appendedEvents).toEqual(["review.accept.completed"]);
  });

  it("refuses when HEAD has moved (no target mutation)", async () => {
    const fixture = await makeFixture("clean");
    await git(fixture.repositoryPath, ["commit", "--allow-empty", "-m", "extra"]);
    const events = buildBaseEvents(fixture, false);
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
    expect(result.targetState).toBe("HEAD_MOVED");
    expect(await git(fixture.repositoryPath, ["status", "--porcelain"])).toBe("");
  });

  it("refuses when target has unrelated user changes (DIVERGED)", async () => {
    const fixture = await makeFixture("partial-extra");
    const events = buildBaseEvents(fixture, true);
    events.push({
      schemaVersion: 1,
      eventId: "applied",
      seq: 14,
      timestampMs: 13,
      taskId: "task-1",
      attemptId: "exec-1",
      domain: "lifecycle",
      type: "patch.applied",
      durability: "CRITICAL",
      prevHash: "h13",
      hash: "h14",
      payload: {
        patch_blob_hash: fixture.patchBlobHash,
        expected_change_set_hash: fixture.changeSetHash,
        actual_change_set_hash: fixture.changeSetHash,
        apply_evidence_hash: "0".repeat(64),
        outcome_hash: "0".repeat(64),
        status: "applied",
        targetPath: fixture.repositoryPath,
      },
      fingerprint: FINGERPRINT,
    });
    const input = makeInput(fixture, "exited_clean", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
    expect(result.targetState).toBe("DIVERGED");
  });

  it("refuses when frozen.patch has been tampered with (hash mismatch)", async () => {
    const fixture = await makeFixture("clean");
    await writeFile(join(fixture.artifactRoot, "exec-1", "frozen.patch"), Buffer.from("tampered\n", "utf8"));
    const events = buildBaseEvents(fixture, false);
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
    expect(result.reason).toMatch(/frozen\.patch|hash/i);
  });

  it("refuses when review.json has been tampered with", async () => {
    const fixture = await makeFixture("clean");
    const reviewPath = join(fixture.artifactRoot, "exec-1", "review.json");
    await writeFile(reviewPath, Buffer.from("{}" + "\n", "utf8"));
    const events = buildBaseEvents(fixture, false);
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
  });

  it("is idempotent: a second call after RESUMED_AND_ACCEPTED returns ALREADY_ACCEPTED", async () => {
    const fixture = await makeFixture("clean");
    const events = buildBaseEvents(fixture, false);
    const input = makeInput(fixture, "crashed", events);
    const first = await runAcceptRecovery(input);
    expect(first.verdict).toBe("RESUMED_AND_ACCEPTED");
    const persisted = input.eventStore.getByAttemptId("exec-1");
    const second = await runAcceptRecovery({ ...input, events: persisted });
    expect(second.verdict).toBe("ALREADY_ACCEPTED");
    const completed = persisted.filter((event) => event.type === "review.accept.completed").length;
    expect(completed).toBe(1);
  });
});
