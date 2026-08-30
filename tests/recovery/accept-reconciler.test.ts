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
import { existsSync, readFileSync } from "node:fs";
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
  /** Pre-applied apply-evidence hash (only set when artifacts were pre-written). */
  readonly applyEvidenceHash?: string;
  /** Pre-applied outcome hash (only set when artifacts were pre-written). */
  readonly outcomeHash?: string;
  /** Number of times the target file was written. Used by tamper detection. */
  readonly applyInvocations?: number;
  database?: StateDatabase;
}

async function makeFixture(
  setup: "clean" | "applied" | "partial-extra" | "mid-apply" | "evidence-only-orphan" | "clean-with-evidence" | "orphan-semantic-mismatch",
): Promise<Fixture> {
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

  if (setup === "applied" || setup === "evidence-only-orphan" || setup === "orphan-semantic-mismatch") {
    // P0#2 / Phase 6.2: pre-apply the patch so target ==
    // EXACT_EXPECTED_CHANGE_SET.
    await git(repositoryPath, ["apply", "--binary", join(executionArtifact, "frozen.patch")]);
  } else if (setup === "mid-apply") {
    // P0#1: pre-apply the patch so target == EXACT_EXPECTED_CHANGE_SET,
    // but DO NOT pre-write the apply-evidence / outcome artifacts. The
    // crash happened after `git apply` but before either artifact was
    // written. The recovery path is what creates them with
    // `recovery_mode: true`.
    await git(repositoryPath, ["apply", "--binary", join(executionArtifact, "frozen.patch")]);
  } else if (setup === "partial-extra") {
    // Apply the patch and add an extra user file.
    await git(repositoryPath, ["apply", "--binary", join(executionArtifact, "frozen.patch")]);
    await writeFile(join(repositoryPath, "user-note.txt"), "unrelated\n", "utf8");
  }
  // For "clean-with-evidence" the target is CLEAN_BASE; the
  // apply-evidence.json is written later (after the setup returns) by
  // the test itself, to keep the fixture focused on the patch data.

  // In `applied` mode the immutable apply-evidence.json and outcome.json
  // artifacts are also on disk (P0#2). We compute the SAME bytes the
  // normal path would write (recovery_mode: false) so the SHA-256
  // bindings in the `patch.applied` test event match the file contents.
  let applyEvidenceHash: string | undefined;
  let outcomeHash: string | undefined;
  if (setup === "applied") {
    const evidencePayload = {
      schema_version: 1,
      execution_id: executionId,
      patch_blob_hash: patchBlobHash,
      expected_change_set_hash: changeSetHash,
      actual_change_set_hash: changeSetHash,
      base_revision: baseRevision,
      target_path: repositoryPath,
      status: "applied",
      recovery_mode: false,
      applied_at: 0,
    };
    const evidenceBytes = Buffer.from(JSON.stringify(evidencePayload, null, 2) + "\n", "utf8");
    applyEvidenceHash = sha256Hex(evidenceBytes);
    await writeFile(join(executionArtifact, "apply-evidence.json"), evidenceBytes);
    const outcomePayload = {
      schema_version: 1,
      task_id: "task-1",
      execution_id: executionId,
      decision: "ACCEPT",
      state: "ACCEPTED",
      patch_status: "applied",
      patch_blob_hash: patchBlobHash,
      change_set_hash: changeSetHash,
      review_id: reviewId,
      review_bundle_id: reviewBundleId,
    };
    const outcomeBytes = Buffer.from(JSON.stringify(outcomePayload, null, 2) + "\n", "utf8");
    outcomeHash = sha256Hex(outcomeBytes);
    await writeFile(join(executionArtifact, "outcome.json"), outcomeBytes);
  } else if (setup === "evidence-only-orphan" || setup === "orphan-semantic-mismatch") {
    // Phase 6.2: pre-write only apply-evidence.json (no outcome.json),
    // simulating a crash between `git apply`/`writeImmutableArtifact`
    // and the outcome write. The evidence's `recovery_mode=false` and
    // `applied_at=<non-zero>` legitimately differ from what Recovery
    // would synthesize; the test verifies Recovery preserves the bytes.
    const evidencePayload = setup === "orphan-semantic-mismatch"
      ? {
          // Wrong execution_id — Recovery must refuse.
          schema_version: 1,
          execution_id: "wrong-exec",
          patch_blob_hash: patchBlobHash,
          expected_change_set_hash: changeSetHash,
          actual_change_set_hash: changeSetHash,
          base_revision: baseRevision,
          target_path: repositoryPath,
          status: "applied",
          recovery_mode: false,
          applied_at: 1234,
        }
      : {
          schema_version: 1,
          execution_id: executionId,
          patch_blob_hash: patchBlobHash,
          expected_change_set_hash: changeSetHash,
          actual_change_set_hash: changeSetHash,
          base_revision: baseRevision,
          target_path: repositoryPath,
          status: "applied",
          recovery_mode: false,
          applied_at: 1234,
        };
    const evidenceBytes = Buffer.from(JSON.stringify(evidencePayload, null, 2) + "\n", "utf8");
    applyEvidenceHash = sha256Hex(evidenceBytes);
    await writeFile(join(executionArtifact, "apply-evidence.json"), evidenceBytes);
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
    ...(applyEvidenceHash !== undefined ? { applyEvidenceHash } : {}),
    ...(outcomeHash !== undefined ? { outcomeHash } : {}),
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

  it("reconciles a target already at EXACT_EXPECTED_CHANGE_SET without re-applying (P0#2 verify-only)", async () => {
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
        apply_evidence_hash: fixture.applyEvidenceHash ?? "0".repeat(64),
        outcome_hash: fixture.outcomeHash ?? "0".repeat(64),
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
    // P0#2: artifacts on disk are immutable evidence. The reconciler
    // verifies their hashes and only appends the terminal journal event.
    // Re-running recovery with the persisted events is idempotent and
    // must not duplicate the journal.
    const persisted = input.eventStore.getByAttemptId("exec-1");
    const second = await runAcceptRecovery({ ...input, events: persisted });
    expect(second.verdict).toBe("ALREADY_ACCEPTED");
    const completed = persisted.filter((event) => event.type === "review.accept.completed").length;
    expect(completed).toBe(1);
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

  // ---------------------------------------------------------------------------
  // P0#1: ACCEPT_PREPARED + patch.apply.started + EXACT_EXPECTED_CHANGE_SET
  //        must auto-reconcile (no re-apply, no REVOVERY_REQUIRED).
  //        The most common crash window: apply succeeded, journal tail
  //        lost before `patch.applied`.
  // ---------------------------------------------------------------------------
  it("P0#1: auto-reconciles ACCEPT_PREPARED + apply.started + EXACT (no re-apply)", async () => {
    const fixture = await makeFixture("mid-apply");
    const events = buildBaseEvents(fixture, true); // include apply.started
    // No `patch.applied` event — the crash happened between `git apply`
    // success and the `patch.applied` journal line.
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECONCILED_AND_ACCEPTED");
    expect(result.targetState).toBe("EXACT_EXPECTED_CHANGE_SET");
    expect(result.originalState).toBe("ACCEPT_PREPARED");
    // The journal events appended by recovery — note `patch.apply.started`
    // is NOT in this list because it was already durable before the crash.
    expect(result.appendedEvents).toEqual(["patch.applied", "review.accept.completed"]);
    // The target file content is "after\n" and the reconciler must NOT
    // have re-applied the patch (re-apply is for the CLEAN_BASE path).
    const content = readFileSync(join(fixture.repositoryPath, "source.txt"), "utf8").replace(/\r\n/g, "\n");
    expect(content).toBe("after\n");
    // Recovery is idempotent.
    const persisted = input.eventStore.getByAttemptId("exec-1");
    const second = await runAcceptRecovery({ ...input, events: persisted });
    expect(second.verdict).toBe("ALREADY_ACCEPTED");
  });

  // ---------------------------------------------------------------------------
  // P0#1 negative case: ACCEPT_PREPARED + EXACT but NO apply.started.
  //                  G2M cannot prove the change set was applied by us
  //                  (maybe a stale worktree from a prior session) —
  //                  must refuse.
  // ---------------------------------------------------------------------------
  it("P0#1 negative: ACCEPT_PREPARED + EXACT without apply.started → RECOVERY_REQUIRED", async () => {
    const fixture = await makeFixture("applied");
    const events = buildBaseEvents(fixture, false); // NO apply.started
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
    expect(result.targetState).toBe("EXACT_EXPECTED_CHANGE_SET");
    // P1#1: the safe-hold is persisted to the Journal.
    expect(result.appendedEvents).toEqual(["recovery.required"]);
    const persisted = input.eventStore.getByAttemptId("exec-1");
    const required = persisted.find((event) => event.type === "recovery.required");
    expect(required).toBeDefined();
    expect((required?.payload as { partial_accept?: unknown }).partial_accept).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // P0#2: PATCH_APPLIED + EXACT + matching on-disk artifacts
  //        → verify-only, NEVER overwrite, only append
  //        `review.accept.completed`.
  // ---------------------------------------------------------------------------
  it("P0#2: PATCH_APPLIED verifies existing artifacts and never overwrites them", async () => {
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
        apply_evidence_hash: fixture.applyEvidenceHash ?? "0".repeat(64),
        outcome_hash: fixture.outcomeHash ?? "0".repeat(64),
        status: "applied",
        targetPath: fixture.repositoryPath,
      },
      fingerprint: FINGERPRINT,
    });
    // Record the on-disk bytes BEFORE recovery. P0#2 says: they must be
    // identical AFTER recovery (the reconciler MUST NOT overwrite).
    const evidencePath = join(fixture.artifactRoot, "exec-1", "apply-evidence.json");
    const outcomePath = join(fixture.artifactRoot, "exec-1", "outcome.json");
    const evidenceBefore = readFileSync(evidencePath);
    const outcomeBefore = readFileSync(outcomePath);
    const input = makeInput(fixture, "exited_clean", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECONCILED_AND_ACCEPTED");
    expect(result.appendedEvents).toEqual(["review.accept.completed"]);
    expect(readFileSync(evidencePath)).toEqual(evidenceBefore);
    expect(readFileSync(outcomePath)).toEqual(outcomeBefore);
  });

  // ---------------------------------------------------------------------------
  // P0#2 negative: PATCH_APPLIED + EXACT but on-disk artifact hash
  //                  does NOT match the event binding
  //                  → RECOVERY_REQUIRED (corrupted; operator decides).
  // ---------------------------------------------------------------------------
  it("P0#2 negative: PATCH_APPLIED + tampered outcome.json → RECOVERY_REQUIRED", async () => {
    const fixture = await makeFixture("applied");
    // Tamper outcome.json on disk after pre-write.
    const outcomePath = join(fixture.artifactRoot, "exec-1", "outcome.json");
    await writeFile(outcomePath, Buffer.from("{ \"tampered\": true }\n", "utf8"));
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
        apply_evidence_hash: fixture.applyEvidenceHash ?? "0".repeat(64),
        outcome_hash: fixture.outcomeHash ?? "0".repeat(64),
        status: "applied",
        targetPath: fixture.repositoryPath,
      },
      fingerprint: FINGERPRINT,
    });
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
    expect(result.appendedEvents).toEqual(["recovery.required"]);
  });

  // ---------------------------------------------------------------------------
  // Phase 6.1: every proven-gone + unrecoverable branch must route through
  // `failAcceptRecovery` so the Journal carries a durable
  // `recovery.required` event (P1#1). The tests below check the three
  // shapes:
  //   1) frozen.patch tampered (artifact verify failure)
  //   2) review.requested has no review_bundle_hash (binding missing)
  //   3) projection failure on the recovery.required event
  //        → Journal still has recovery.required, AND a
  //          projection.stale is appended as the durable signal.
  // ---------------------------------------------------------------------------
  it("Phase 6.1: frozen.patch tampered → Journal carries recovery.required + finalState RECOVERY_REQUIRED", async () => {
    const fixture = await makeFixture("clean");
    // Tamper frozen.patch on disk.
    await writeFile(join(fixture.artifactRoot, "exec-1", "frozen.patch"), Buffer.from("tampered\n", "utf8"));
    const events = buildBaseEvents(fixture, false);
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
    expect(result.finalState).toBe("RECOVERY_REQUIRED");
    expect(result.appendedEvents).toEqual(["recovery.required"]);
    const persisted = input.eventStore.getByAttemptId("exec-1");
    const required = persisted.find((event) => event.type === "recovery.required");
    expect(required).toBeDefined();
    expect((required?.payload as { partial_accept?: unknown }).partial_accept).toBe(true);
    expect((required?.payload as { reason?: string }).reason).toMatch(/frozen\.patch|hash/i);
  });

  it("Phase 6.1: missing review_bundle_hash → Journal carries recovery.required", async () => {
    const fixture = await makeFixture("clean");
    const events = buildBaseEvents(fixture, false);
    // Wipe the review_bundle_hash from the review.requested event so the
    // reconciler refuses with a missing-binding error.
    const idx = events.findIndex((event) => event.type === "review.requested");
    const target = events[idx];
    if (target === undefined) throw new Error("setup: review.requested event missing");
    events[idx] = {
      ...target,
      payload: { review_bundle_id: fixture.reviewBundleId, task_hash: "a".repeat(64), result_hash: "b".repeat(64) },
    };
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
    expect(result.finalState).toBe("RECOVERY_REQUIRED");
    expect(result.appendedEvents).toEqual(["recovery.required"]);
    const persisted = input.eventStore.getByAttemptId("exec-1");
    const required = persisted.find((event) => event.type === "recovery.required");
    expect(required).toBeDefined();
    expect((required?.payload as { reason?: string }).reason).toMatch(/review_bundle_hash/);
  });

  it("Phase 6.1: projection failure on recovery.required → Journal still has recovery.required AND projection.stale", async () => {
    const fixture = await makeFixture("clean");
    // Tamper frozen.patch so the reconciler hits the artifact-verify
    // path and calls failAcceptRecovery.
    await writeFile(join(fixture.artifactRoot, "exec-1", "frozen.patch"), Buffer.from("tampered\n", "utf8"));
    const events = buildBaseEvents(fixture, false);
    const input = makeInput(fixture, "crashed", events);
    // Replace the projector with one whose `project` always throws.
    // The recovery.required CRITICAL event must still land in the
    // Journal (durable fact) and the projector failure must leave a
    // `projection.stale` durable signal — mirroring `appendReduceProject`.
    const brokenProjector = {
      project: () => {
        throw new Error("simulated projection failure");
      },
    };
    const result = await runAcceptRecovery({
      ...input,
      projector: brokenProjector as unknown as typeof input.projector,
    });
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
    expect(result.appendedEvents).toEqual(["recovery.required"]);
    const persisted = input.eventStore.getByAttemptId("exec-1");
    const required = persisted.find((event) => event.type === "recovery.required");
    const stale = persisted.find((event) => event.type === "projection.stale");
    expect(required).toBeDefined();
    expect(stale).toBeDefined();
    expect((stale?.payload as { failed_event_hash?: string }).failed_event_hash).toBe(required?.hash);
    expect((stale?.payload as { reason?: string }).reason).toMatch(/simulated projection failure/);
  });

  // ---------------------------------------------------------------------------
  // Phase 6.2 — Orphan pre-commit artifact recovery.
  //
  // The normal ACCEPT order is:
  //   git apply -> apply-evidence.json -> outcome.json -> patch.applied
  // A crash anywhere in the middle leaves the Journal in
  // ACCEPT_PREPARED + apply.started while one or both pre-commit
  // artifacts are already on disk. Recovery must preserve the
  // existing bytes (audit fields like recovery_mode / applied_at
  // legitimately differ) and finish the journal using their hashes.
  // ---------------------------------------------------------------------------
  it("Phase 6.2: orphan apply-evidence.json (no outcome.json) is preserved; outcome is created; ACCEPTED", async () => {
    const fixture = await makeFixture("evidence-only-orphan");
    const evidencePath = join(fixture.artifactRoot, "exec-1", "apply-evidence.json");
    const outcomePath = join(fixture.artifactRoot, "exec-1", "outcome.json");
    const evidenceBefore = readFileSync(evidencePath);
    const evidenceHashBefore = sha256Hex(evidenceBefore);
    const events = buildBaseEvents(fixture, true); // include apply.started
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECONCILED_AND_ACCEPTED");
    expect(result.targetState).toBe("EXACT_EXPECTED_CHANGE_SET");
    expect(result.appendedEvents).toEqual(["patch.applied", "review.accept.completed"]);
    // The pre-existing evidence bytes are preserved byte-for-byte.
    expect(readFileSync(evidencePath)).toEqual(evidenceBefore);
    expect(sha256Hex(readFileSync(evidencePath))).toBe(evidenceHashBefore);
    // Recovery bound the existing evidence hash in the journal event.
    expect(result.applyEvidenceHash).toBe(evidenceHashBefore);
    // The outcome was newly created and bound to the journal.
    expect(result.outcomeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(outcomePath)).toBe(true);
  });

  it("Phase 6.2: orphan apply-evidence.json + outcome.json (both pre-exist) are preserved; only journal appended", async () => {
    const fixture = await makeFixture("applied"); // both artifacts already on disk
    const events = buildBaseEvents(fixture, true); // include apply.started
    // No `patch.applied` event — simulates a crash after outcome.json,
    // before patch.applied.
    const evidencePath = join(fixture.artifactRoot, "exec-1", "apply-evidence.json");
    const outcomePath = join(fixture.artifactRoot, "exec-1", "outcome.json");
    const evidenceBefore = readFileSync(evidencePath);
    const outcomeBefore = readFileSync(outcomePath);
    const evidenceHashBefore = sha256Hex(evidenceBefore);
    const outcomeHashBefore = sha256Hex(outcomeBefore);
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECONCILED_AND_ACCEPTED");
    expect(result.appendedEvents).toEqual(["patch.applied", "review.accept.completed"]);
    // Both artifacts preserved byte-for-byte.
    expect(readFileSync(evidencePath)).toEqual(evidenceBefore);
    expect(readFileSync(outcomePath)).toEqual(outcomeBefore);
    expect(result.applyEvidenceHash).toBe(evidenceHashBefore);
    expect(result.outcomeHash).toBe(outcomeHashBefore);
  });

  it("Phase 6.2: CLEAN_BASE + existing apply-evidence.json refuses to re-apply (RECOVERY_REQUIRED)", async () => {
    const fixture = await makeFixture("clean-with-evidence");
    // Write apply-evidence.json even though the target is CLEAN_BASE.
    // This simulates an external `git reset --hard` / `git checkout`
    // that undid the previous apply after the evidence was written.
    const evidencePayload = {
      schema_version: 1,
      execution_id: "exec-1",
      patch_blob_hash: fixture.patchBlobHash,
      expected_change_set_hash: fixture.changeSetHash,
      actual_change_set_hash: fixture.changeSetHash,
      base_revision: fixture.baseRevision,
      target_path: fixture.repositoryPath,
      status: "applied",
      recovery_mode: false,
      applied_at: 1234,
    };
    await writeFile(
      join(fixture.artifactRoot, "exec-1", "apply-evidence.json"),
      Buffer.from(JSON.stringify(evidencePayload, null, 2) + "\n", "utf8"),
    );
    const events = buildBaseEvents(fixture, false);
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
    expect(result.targetState).toBe("CLEAN_BASE");
    expect(result.appendedEvents).toEqual(["recovery.required"]);
    // CRITICAL: `git apply` must NOT have been called — the target is
    // still CLEAN_BASE.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: fixture.repositoryPath, windowsHide: true, shell: false,
    });
    expect(stdout.trim()).toBe("");
  });

  it("Phase 6.2: orphan apply-evidence.json with semantic mismatch refuses (RECOVERY_REQUIRED)", async () => {
    const fixture = await makeFixture("orphan-semantic-mismatch");
    // The fixture pre-wrote apply-evidence.json with execution_id
    // "wrong-exec" — a semantic mismatch Recovery must catch.
    const events = buildBaseEvents(fixture, true); // include apply.started
    const input = makeInput(fixture, "crashed", events);
    const result = await runAcceptRecovery(input);
    expect(result.verdict).toBe("RECOVERY_REQUIRED");
    expect(result.targetState).toBe("EXACT_EXPECTED_CHANGE_SET");
    expect(result.appendedEvents).toEqual(["recovery.required"]);
    const persisted = input.eventStore.getByAttemptId("exec-1");
    const required = persisted.find((event) => event.type === "recovery.required");
    expect(required).toBeDefined();
    expect((required?.payload as { reason?: string }).reason).toMatch(/orphan artifact check|execution_id/);
  });
});
