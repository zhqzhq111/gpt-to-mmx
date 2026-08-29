/**
 * Review Bundle — plan §45
 */

import { describe, it, expect } from "vitest";

import {
  buildReviewBundle,
  computeResultHash,
  computeReviewBundleHash,
  REVIEW_BUNDLE_PROTOCOL_VERSION,
  type BuildBundleInput,
  type ReviewBundle,
} from "../../src/review/bundle.js";
import type { CodeTaskV1 } from "../../src/protocol/code-task.v1.schema.js";
import { taskHash } from "../../src/protocol/hash.js";
import type { WorkerResult } from "../../src/workers/coding-worker.js";
import type { DiffResult } from "../../src/evidence/diff.js";
import type { WorkspaceBaseline } from "../../src/workspace/baseline.js";
import type { VerificationResult } from "../../src/evidence/verification.js";

const VALID_TASK_HASH = "a".repeat(64);

function makeTask(overrides: Partial<CodeTaskV1> = {}): CodeTaskV1 {
  return {
    protocol_version: "g2m.code-task.v1",
    task_id: "task-1",
    workspace_scope: {
      workspace_id: "ws-A",
      base_revision: "HEAD",
      require_clean_worktree: true,
    },
    goal: "fix the bug",
    constraints: [],
    requested_capabilities: {
      read: true,
      write: true,
      test: true,
      network: false,
    },
    permission_policy: "coding_standard",
    limits: { max_steps: 30, timeout_ms: 600_000 },
    verification_profile: "targeted_tests",
    acceptance_criteria: [],
    session_policy: { mode: "new" },
    ...overrides,
  };
}

function makeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    executionId: "exec-1",
    sessionId: "sess-1",
    summary: "did the thing",
    filesChanged: ["a.ts"],
    testsAttempted: [{ name: "t1", status: "passed" }],
    remainingRisks: [],
    ...overrides,
  };
}

function makeDiff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    workspacePath: "/ws",
    baseRevision: "HEAD",
    fullDiff: "diff --git a/a.ts b/a.ts\n+new",
    diffStat: " a.ts | 1 +",
    changedFiles: [{ path: "a.ts", status: "M" }],
    untrackedFiles: [],
    deletedFiles: [],
    protectedFilesTouched: [],
    diffHash: "d".repeat(64),
    capturedAt: 1_000,
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<WorkspaceBaseline> = {}): WorkspaceBaseline {
  return {
    canonicalPath: "/ws",
    baseRevision: "HEAD",
    statusPorcelain: "",
    dirty: false,
    capturedAt: 1_000,
    ...overrides,
  };
}

function makePatch() {
  return {
    baseRevision: "HEAD",
    patchHash: "p".repeat(64),
    patchText: "diff --git a/a.ts b/a.ts\n+new\n",
    changedFiles: ["a.ts"],
    empty: false,
  };
}

function makeVerification(
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    profileId: "tests",
    workspaceId: "ws-A",
    workspacePath: "/ws",
    program: "npm",
    args: ["test"],
    status: "passed",
    exitCode: 0,
    signal: null,
    stdout: "all passed",
    stderr: "",
    durationMs: 1_000,
    startedAt: 0,
    finishedAt: 1_000,
    resultHash: "v".repeat(64),
    ...overrides,
  };
}

function makeInput(overrides: Partial<BuildBundleInput> = {}): BuildBundleInput {
  return {
    task: makeTask(),
    taskHash: VALID_TASK_HASH,
    executionId: "exec-1",
    workerSummary: makeWorkerResult(),
    workspaceEvidence: {
      diff: makeDiff(),
      baseline: makeBaseline(),
      patch: makePatch(),
    },
    verificationEvidence: { verification: makeVerification() },
    workerRuntime: { runtime: "mcode", version: "0.2.7", model: "minimax/MiniMax-M3" },
    ...overrides,
  };
}

describe("buildReviewBundle", () => {
  it("sets protocolVersion to g2m.code-review-bundle.v1", () => {
    const bundle = buildReviewBundle(makeInput());
    expect(bundle.protocolVersion).toBe(REVIEW_BUNDLE_PROTOCOL_VERSION);
  });

  it("includes the frozen patch content used for review", () => {
    const bundle = buildReviewBundle(makeInput());
    expect(bundle.workspaceEvidence.patch).toEqual(makePatch());
  });

  it("auto-generates bundleId if not provided", () => {
    const b1 = buildReviewBundle(makeInput());
    const b2 = buildReviewBundle(makeInput());
    expect(b1.bundleId).not.toBe(b2.bundleId);
    expect(b1.bundleId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses provided bundleId and createdAt when given", () => {
    const fixed = "fixed-bundle-id";
    const ts = 1_700_000_000_000;
    const bundle = buildReviewBundle(makeInput({ bundleId: fixed, createdAt: ts }));
    expect(bundle.bundleId).toBe(fixed);
    expect(bundle.createdAt).toBe(ts);
  });

  it("binds taskId from input.task.task_id", () => {
    const bundle = buildReviewBundle(makeInput({ task: makeTask({ task_id: "task-XYZ" }) }));
    expect(bundle.taskId).toBe("task-XYZ");
  });

  it("binds executionId from input.executionId", () => {
    const bundle = buildReviewBundle(makeInput({ executionId: "exec-XYZ" }));
    expect(bundle.executionId).toBe("exec-XYZ");
  });

  it("throws on malformed taskHash", () => {
    expect(() => buildReviewBundle(makeInput({ taskHash: "not-a-hash" }))).toThrow(/taskHash/);
    expect(() => buildReviewBundle(makeInput({ taskHash: "z".repeat(64) }))).toThrow(/taskHash/);
  });

  it("binds sessionId from workerSummary if present", () => {
    const bundle = buildReviewBundle(
      makeInput({ workerSummary: makeWorkerResult({ sessionId: "sess-XYZ" }) }),
    );
    expect(bundle.sessionId).toBe("sess-XYZ");
  });

  it("omits sessionId when workerSummary has no sessionId", () => {
    const workerResult: WorkerResult = {
      executionId: "exec-1",
      summary: "did the thing",
      filesChanged: ["a.ts"],
      testsAttempted: [{ name: "t1", status: "passed" }],
      remainingRisks: [],
    };
    const bundle = buildReviewBundle(makeInput({ workerSummary: workerResult }));
    expect(bundle.sessionId).toBeUndefined();
  });
});

describe("computeResultHash (plan §45 binding)", () => {
  it("is stable for identical inputs", () => {
    const a = computeResultHash({
      workerSummary: makeWorkerResult(),
      diff: makeDiff(),
      baseline: makeBaseline(),
      patch: makePatch(),
      verification: makeVerification(),
    });
    const b = computeResultHash({
      workerSummary: makeWorkerResult(),
      diff: makeDiff(),
      baseline: makeBaseline(),
      patch: makePatch(),
      verification: makeVerification(),
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when workerSummary changes", () => {
    const baseline = computeResultHash({
      workerSummary: makeWorkerResult(),
      diff: makeDiff(),
      baseline: makeBaseline(),
      patch: makePatch(),
      verification: makeVerification(),
    });
    const modified = computeResultHash({
      workerSummary: makeWorkerResult({ summary: "different" }),
      diff: makeDiff(),
      baseline: makeBaseline(),
      patch: makePatch(),
      verification: makeVerification(),
    });
    expect(baseline).not.toBe(modified);
  });

  it("changes when diff changes", () => {
    const baseline = computeResultHash({
      workerSummary: makeWorkerResult(),
      diff: makeDiff(),
      baseline: makeBaseline(),
      patch: makePatch(),
      verification: makeVerification(),
    });
    const modified = computeResultHash({
      workerSummary: makeWorkerResult(),
      diff: makeDiff({ fullDiff: "different" }),
      baseline: makeBaseline(),
      patch: makePatch(),
      verification: makeVerification(),
    });
    expect(baseline).not.toBe(modified);
  });

  it("changes when verification changes", () => {
    const baseline = computeResultHash({
      workerSummary: makeWorkerResult(),
      diff: makeDiff(),
      baseline: makeBaseline(),
      patch: makePatch(),
      verification: makeVerification(),
    });
    const modified = computeResultHash({
      workerSummary: makeWorkerResult(),
      diff: makeDiff(),
      baseline: makeBaseline(),
      patch: makePatch(),
      verification: makeVerification({ status: "failed" }),
    });
    expect(baseline).not.toBe(modified);
  });
});

describe("computeReviewBundleHash (plan §45 self-hash)", () => {
  function partialBundle(overrides: Partial<BuildBundleInput> = {}): Omit<ReviewBundle, "reviewBundleHash"> {
    const bundle = buildReviewBundle(
      makeInput({
        bundleId: "fixed-bundle-id",
        createdAt: 1_700_000_000_000,
        ...overrides,
      }),
    );
    const { reviewBundleHash: _ignored, ...rest } = bundle;
    void _ignored;
    return rest;
  }

  it("is stable for identical bundle content (excluding itself)", () => {
    const p1 = partialBundle();
    const p2 = partialBundle();
    expect(computeReviewBundleHash(p1)).toBe(computeReviewBundleHash(p2));
  });

  it("changes when taskId changes", () => {
    const p1 = partialBundle();
    const p2 = partialBundle({ task: makeTask({ task_id: "other" }) });
    expect(computeReviewBundleHash(p1)).not.toBe(computeReviewBundleHash(p2));
  });

  it("changes when executionId changes", () => {
    const p1 = partialBundle();
    const p2 = partialBundle({ executionId: "other-exec" });
    expect(computeReviewBundleHash(p1)).not.toBe(computeReviewBundleHash(p2));
  });

  it("changes when workerSummary changes", () => {
    const p1 = partialBundle();
    const p2 = partialBundle({ workerSummary: makeWorkerResult({ summary: "diff" }) });
    expect(computeReviewBundleHash(p1)).not.toBe(computeReviewBundleHash(p2));
  });
});

describe("buildReviewBundle — auto warnings", () => {
  it("flags protected files touched (plan §45)", () => {
    const bundle = buildReviewBundle(
      makeInput({
        workspaceEvidence: {
          diff: makeDiff({ protectedFilesTouched: ["tests/foo.test.ts"] }),
          baseline: makeBaseline(),
          patch: makePatch(),
        },
      }),
    );
    expect(bundle.warnings.some((w) => w.includes("protected files touched"))).toBe(true);
    expect(bundle.warnings.some((w) => w.includes("tests/foo.test.ts"))).toBe(true);
  });

  it("flags test files changed", () => {
    const bundle = buildReviewBundle(
      makeInput({
        workspaceEvidence: {
          diff: makeDiff({
            changedFiles: [
              { path: "src/a.ts", status: "M" },
              { path: "src/tests/b.test.ts", status: "M" },
            ],
          }),
          baseline: makeBaseline(),
          patch: makePatch(),
        },
      }),
    );
    expect(bundle.warnings.some((w) => w.includes("test files changed"))).toBe(true);
  });

  it("flags worker reported blocked", () => {
    const bundle = buildReviewBundle(
      makeInput({
        workerSummary: makeWorkerResult({ blockedReason: "needs human input" }),
      }),
    );
    expect(bundle.warnings.some((w) => w.includes("worker reported blocked"))).toBe(true);
  });

  it("emits no warnings for a clean execution", () => {
    const bundle = buildReviewBundle(makeInput());
    expect(bundle.warnings).toEqual([]);
  });
});

describe("buildReviewBundle — remainingRisks pass-through", () => {
  it("forwards worker remainingRisks", () => {
    const bundle = buildReviewBundle(
      makeInput({
        workerSummary: makeWorkerResult({ remainingRisks: ["r1", "r2"] }),
      }),
    );
    expect(bundle.remainingRisks).toEqual(["r1", "r2"]);
  });
});

describe("buildReviewBundle — round-trip with taskHash helper", () => {
  it("bundle.taskHash matches taskHash(task) (plan §45 binding)", () => {
    const task = makeTask({ task_id: "task-rt" });
    const expectedTaskHash = taskHash(task);
    const bundle = buildReviewBundle(makeInput({ task, taskHash: expectedTaskHash }));
    expect(bundle.taskHash).toBe(expectedTaskHash);
  });
});
