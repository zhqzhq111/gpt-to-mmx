/**
 * Review Ingress — plan §46 + §47 + §48
 *
 * 覆盖用户要求的 10 个验证点:
 * - Bundle 绑定 task_id / execution_id / task_hash / result_hash / review_bundle_hash
 * - 只允许在 REVIEW_PENDING 状态应用 Review
 * - 旧 Bundle 必须拒绝
 * - 相同 Review 重放必须幂等
 * - 相同 review_id 内容不同必须冲突
 * - REVISE 必须创建新 task_id(且 ≠ 当前 task_id)
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  buildReviewBundle,
  type BuildBundleInput,
  type ReviewBundle,
} from "../../src/review/bundle.js";
import { EventStore } from "../../src/events/store.js";
import { FingerprintRegistry, type TaskFingerprint } from "../../src/execution/fingerprint.js";
import { replay } from "../../src/events/replay.js";
import {
  applyReview,
  buildReview,
  computeReviewHash,
  ReviewIngressError,
  REVIEW_PROTOCOL_VERSION,
  type BuildReviewInput,
  type Review,
  type ReviewDecision,
  type ReviewIngressErrorCode,
} from "../../src/review/ingress.js";
import { ReplayGuard } from "../../src/review/replay-guard.js";
import { taskHash } from "../../src/protocol/hash.js";
import type { CodeTaskV1 } from "../../src/protocol/code-task.v1.schema.js";
import type { WorkerResult } from "../../src/workers/coding-worker.js";
import type { DiffResult } from "../../src/evidence/diff.js";
import type { WorkspaceBaseline } from "../../src/workspace/baseline.js";
import type { VerificationResult } from "../../src/evidence/verification.js";

const TASK_ID = "task-1";
const EXECUTION_ID = "exec-1";
const NEW_TASK_ID = "task-2";

/**
 * 期望函数抛 ReviewIngressError 且 code 匹配。
 * 用 try/catch 而不是 expect.toThrow(/regex/),因为 code 字段在 .code 上,
 * 不在 message 上,regex 匹配 message 会误报。
 */
function expectIngressError(
  fn: () => unknown,
  code: ReviewIngressErrorCode,
): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ReviewIngressError);
  expect((caught as ReviewIngressError).code).toBe(code);
}

function makeTask(overrides: Partial<CodeTaskV1> = {}): CodeTaskV1 {
  return {
    protocol_version: "g2m.code-task.v1",
    task_id: TASK_ID,
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
    executionId: EXECUTION_ID,
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

function makeBaseline(): WorkspaceBaseline {
  return {
    canonicalPath: "/ws",
    baseRevision: "HEAD",
    statusPorcelain: "",
    dirty: false,
    capturedAt: 1_000,
  };
}

function makeVerification(): VerificationResult {
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
  };
}

function makeBundleInput(task: CodeTaskV1): BuildBundleInput {
  return {
    task,
    taskHash: taskHash(task),
    executionId: EXECUTION_ID,
    workerSummary: makeWorkerResult(),
    workspaceEvidence: {
      diff: makeDiff(),
      baseline: makeBaseline(),
      patch: {
        artifactId: "patch-1",
        artifactPath: "frozen.patch",
        baseRevision: "HEAD",
        patchBlobHash: "p".repeat(64),
        changeSetHash: "c".repeat(64),
        patchBytes: 32,
        changeSet: [
          { path: "a.ts", kind: "file", mode: "100644", content_sha256: "f".repeat(64) },
        ],
        patchHash: "p".repeat(64),
        patchText: "diff --git a/a.ts b/a.ts\n+new\n",
        changedFiles: ["a.ts"],
        empty: false,
      },
    },
    verificationEvidence: { verification: makeVerification() },
    workerRuntime: { runtime: "mcode", version: "0.2.7", model: "minimax/MiniMax-M3" },
  };
}

function makeReviewInput(
  bundle: ReviewBundle,
  decision: ReviewDecision,
  overrides: Partial<Omit<BuildReviewInput, "newTaskId">> & { newTaskId?: string } = {},
): BuildReviewInput {
  const base: BuildReviewInput = {
    taskId: bundle.taskId,
    executionId: bundle.executionId,
    reviewBundleId: bundle.bundleId,
    taskHash: bundle.taskHash,
    resultHash: bundle.resultHash,
    reviewBundleHash: bundle.reviewBundleHash,
    decision,
  };
  if (decision === "REVISE" && overrides.newTaskId === undefined) {
    return { ...base, ...overrides, newTaskId: NEW_TASK_ID };
  }
  return { ...base, ...overrides };
}

function makeFP(overrides: Partial<TaskFingerprint> = {}): TaskFingerprint {
  return {
    taskHash: "x".repeat(64),
    workspaceId: "ws-A",
    baseRevision: "HEAD",
    mcodeVersion: "0.2.7",
    model: "minimax/MiniMax-M3",
    permissionProfile: "coding_standard",
    maxSteps: 30,
    timeoutMs: 600_000,
    adapterContractVersion: "g2m.worker.v1",
    runtimeCapabilitySnapshotHash: "rt-cap-1",
    ...overrides,
  };
}

/**
 * 真实 EventStore + Reducer 跑到 REVIEW_PENDING,返回 stores 准备好供 ingress 用。
 */
function setupReviewPending(): {
  eventStore: EventStore;
  fingerprintRegistry: FingerprintRegistry;
  replayGuard: ReplayGuard;
  task: CodeTaskV1;
  bundle: ReviewBundle;
  taskHash: string;
} {
  const task = makeTask();
  const th = taskHash(task);
  const fp = makeFP({ taskHash: th });
  const eventStore = new EventStore();
  eventStore.append({ taskId: TASK_ID, attemptId: EXECUTION_ID, type: "task.created", payload: {} });
  eventStore.append({ taskId: TASK_ID, attemptId: EXECUTION_ID, type: "task.validation.started", payload: {} });
  eventStore.append({ taskId: TASK_ID, attemptId: EXECUTION_ID, type: "task.validation.passed", payload: {} });
  eventStore.append({ taskId: TASK_ID, attemptId: EXECUTION_ID, type: "workspace.lock.requested", payload: {} });
  eventStore.append({ taskId: TASK_ID, attemptId: EXECUTION_ID, type: "workspace.lock.acquired", payload: {} });
  eventStore.append({ taskId: TASK_ID, attemptId: EXECUTION_ID, type: "agent.spawn.started", payload: {}, fingerprint: fp });
  eventStore.append({ taskId: TASK_ID, attemptId: EXECUTION_ID, type: "agent.completed", payload: {} });
  eventStore.append({ taskId: TASK_ID, attemptId: EXECUTION_ID, type: "evidence.diff.collected", payload: {} });
  eventStore.append({ taskId: TASK_ID, attemptId: EXECUTION_ID, type: "verification.completed", payload: {} });
  eventStore.append({ taskId: TASK_ID, attemptId: EXECUTION_ID, type: "review.requested", payload: {} });
  const fingerprintRegistry = new FingerprintRegistry();
  const replayGuard = new ReplayGuard();
  const bundle = buildReviewBundle(makeBundleInput(task));
  return { eventStore, fingerprintRegistry, replayGuard, task, bundle, taskHash: th };
}

describe("buildReview", () => {
  let bundle: ReviewBundle;
  beforeEach(() => {
    bundle = buildReviewBundle(makeBundleInput(makeTask()));
  });

  it("sets protocolVersion to g2m.review.v1", () => {
    const r = buildReview(makeReviewInput(bundle, "ACCEPT"));
    expect(r.protocolVersion).toBe(REVIEW_PROTOCOL_VERSION);
  });

  it("auto-generates reviewId and timestampMs if not provided", () => {
    const r1 = buildReview(makeReviewInput(bundle, "ACCEPT"));
    const r2 = buildReview(makeReviewInput(bundle, "ACCEPT"));
    expect(r1.reviewId).not.toBe(r2.reviewId);
    expect(r1.timestampMs).toBeGreaterThan(0);
  });

  it("reviewHash is a 64-char hex string", () => {
    const r = buildReview(makeReviewInput(bundle, "ACCEPT"));
    expect(r.reviewHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reviewHash is stable for identical inputs (plan §46 anti-replay)", () => {
    const overrides = { reviewId: "fixed-id", timestampMs: 1_700_000_000_000 };
    const a = buildReview(makeReviewInput(bundle, "ACCEPT", overrides));
    const b = buildReview(makeReviewInput(bundle, "ACCEPT", overrides));
    expect(a.reviewHash).toBe(b.reviewHash);
  });

  it("reviewHash changes when decision changes", () => {
    const overrides = { reviewId: "fixed-id", timestampMs: 1_700_000_000_000 };
    const a = buildReview(makeReviewInput(bundle, "ACCEPT", overrides));
    const b = buildReview(makeReviewInput(bundle, "BLOCK", overrides));
    expect(a.reviewHash).not.toBe(b.reviewHash);
  });

  it("reviewHash changes when findings change", () => {
    const overrides = { reviewId: "fixed-id", timestampMs: 1_700_000_000_000 };
    const a = buildReview(makeReviewInput(bundle, "REVISE"));
    const b = buildReview(makeReviewInput(bundle, "REVISE", { findings: "different" }));
    expect(a.reviewHash).not.toBe(b.reviewHash);
  });

  it("buildReview throws when REVISE has no newTaskId (plan §47)", () => {
    expect(() =>
      buildReview({
        taskId: bundle.taskId,
        executionId: bundle.executionId,
        reviewBundleId: bundle.bundleId,
        taskHash: bundle.taskHash,
        resultHash: bundle.resultHash,
        reviewBundleHash: bundle.reviewBundleHash,
        decision: "REVISE",
      }),
    ).toThrow(/REVISE.*newTaskId/);
  });

  it("buildReview throws when REVISE newTaskId === current taskId (plan §47)", () => {
    expect(() =>
      buildReview(makeReviewInput(bundle, "REVISE", { newTaskId: TASK_ID })),
    ).toThrow(/REVISE newTaskId must differ/);
  });

  it("buildReview throws on malformed hashes", () => {
    expect(() =>
      buildReview(makeReviewInput(bundle, "ACCEPT", { taskHash: "bad" })),
    ).toThrow(/taskHash/);
    expect(() =>
      buildReview(makeReviewInput(bundle, "ACCEPT", { resultHash: "bad" })),
    ).toThrow(/resultHash/);
    expect(() =>
      buildReview(makeReviewInput(bundle, "ACCEPT", { reviewBundleHash: "bad" })),
    ).toThrow(/reviewBundleHash/);
  });
});

describe("computeReviewHash", () => {
  it("matches buildReview's stored reviewHash", () => {
    const bundle = buildReviewBundle(makeBundleInput(makeTask()));
    const r = buildReview(makeReviewInput(bundle, "ACCEPT"));
    const { reviewHash, ...rest } = r;
    void reviewHash;
    expect(computeReviewHash(rest)).toBe(r.reviewHash);
  });
});

describe("applyReview — happy path (user requirement: REVIEW_PENDING only)", () => {
  it("ACCEPT in REVIEW_PENDING applies and produces ACCEPTED", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT"));
    const result = applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.newState).toBe("ACCEPTED");
      expect(result.decision).toBe("ACCEPT");
      expect(result.event.type).toBe("review.decision.accept");
    }
  });

  it("BLOCK in REVIEW_PENDING applies and produces BLOCKED", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "BLOCK", { findings: "too risky" }));
    const result = applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.newState).toBe("BLOCKED");
    expect(result.decision).toBe("BLOCK");
    expect(result.event.type).toBe("review.decision.block");
  });

  it("REVISE in REVIEW_PENDING applies and produces REVISION_REQUESTED with newTaskId", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "REVISE", {
      findings: "need more tests",
      newTaskId: NEW_TASK_ID,
    }));
    const result = applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.newState).toBe("REVISION_REQUESTED");
    expect(result.decision).toBe("REVISE");
    expect(result.newTaskId).toBe(NEW_TASK_ID);
    expect(result.event.type).toBe("review.decision.revise");
    expect(result.event.payload["newTaskId"]).toBe(NEW_TASK_ID);
  });

  it("appends to EventStore and grows hash chain", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const before = eventStore.size();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT"));
    applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    expect(eventStore.size()).toBe(before + 1);
  });

  it("records to ReplayGuard after application", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT"));
    applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    expect(replayGuard.get(bundle.bundleId)?.reviewId).toBe(review.reviewId);
  });
});

describe("applyReview — state machine integration", () => {
  it("after ACCEPT, replay of the full event log gives ACCEPTED", () => {
    const { eventStore, fingerprintRegistry, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT"));
    applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    const result = replay(eventStore.list(), { fingerprintRegistry });
    expect(result.state).toBe("ACCEPTED");
  });

  it("after BLOCK, replay gives BLOCKED", () => {
    const { eventStore, fingerprintRegistry, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "BLOCK"));
    applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    const result = replay(eventStore.list(), { fingerprintRegistry });
    expect(result.state).toBe("BLOCKED");
  });

  it("after REVISE, replay gives REVISION_REQUESTED", () => {
    const { eventStore, fingerprintRegistry, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "REVISE", { newTaskId: NEW_TASK_ID }));
    applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    const result = replay(eventStore.list(), { fingerprintRegistry });
    expect(result.state).toBe("REVISION_REQUESTED");
  });
});

describe("applyReview — hash binding (user requirement 5)", () => {
  it("throws TASK_ID_MISMATCH when review.taskId ≠ bundle.taskId", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT", {
      taskId: "other-task",
      taskHash: bundle.taskHash,
    }));
    expectIngressError(
      () => applyReview(review, bundle, {
        currentState: "REVIEW_PENDING",
        eventStore,
        replayGuard,
      }),
      "TASK_ID_MISMATCH",
    );
  });

  it("throws EXECUTION_ID_MISMATCH when review.executionId ≠ bundle.executionId", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT", {
      executionId: "other-exec",
    }));
    expectIngressError(
      () => applyReview(review, bundle, {
        currentState: "REVIEW_PENDING",
        eventStore,
        replayGuard,
      }),
      "EXECUTION_ID_MISMATCH",
    );
  });

  it("throws TASK_HASH_MISMATCH when review.taskHash ≠ bundle.taskHash", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT", {
      taskHash: "f".repeat(64),
    }));
    expectIngressError(
      () => applyReview(review, bundle, {
        currentState: "REVIEW_PENDING",
        eventStore,
        replayGuard,
      }),
      "TASK_HASH_MISMATCH",
    );
  });

  it("throws RESULT_HASH_MISMATCH when review.resultHash ≠ bundle.resultHash", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT", {
      resultHash: "9".repeat(64),
    }));
    expectIngressError(
      () => applyReview(review, bundle, {
        currentState: "REVIEW_PENDING",
        eventStore,
        replayGuard,
      }),
      "RESULT_HASH_MISMATCH",
    );
  });

  it("throws REVIEW_BUNDLE_HASH_MISMATCH when review.reviewBundleHash ≠ bundle.reviewBundleHash", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT", {
      reviewBundleHash: "e".repeat(64),
    }));
    expectIngressError(
      () => applyReview(review, bundle, {
        currentState: "REVIEW_PENDING",
        eventStore,
        replayGuard,
      }),
      "REVIEW_BUNDLE_HASH_MISMATCH",
    );
  });

  it("throws REVIEW_BUNDLE_ID_MISMATCH when review.reviewBundleId ≠ bundle.bundleId", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT", {
      reviewBundleId: "other-bundle",
    }));
    expectIngressError(
      () => applyReview(review, bundle, {
        currentState: "REVIEW_PENDING",
        eventStore,
        replayGuard,
      }),
      "REVIEW_BUNDLE_ID_MISMATCH",
    );
  });
});

describe("applyReview — REVIEW_PENDING state guard (user requirement)", () => {
  it("throws STALE_REVIEW when currentState is PLANNED", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT"));
    expectIngressError(
      () => applyReview(review, bundle, {
        currentState: "PLANNED",
        eventStore,
        replayGuard,
      }),
      "STALE_REVIEW",
    );
  });

  it("throws STALE_REVIEW when currentState is ACCEPTED (old bundle)", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT"));
    expectIngressError(
      () => applyReview(review, bundle, {
        currentState: "ACCEPTED",
        eventStore,
        replayGuard,
      }),
      "STALE_REVIEW",
    );
  });

  it("throws STALE_REVIEW when currentState is BLOCKED", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "BLOCK"));
    expectIngressError(
      () => applyReview(review, bundle, {
        currentState: "BLOCKED",
        eventStore,
        replayGuard,
      }),
      "STALE_REVIEW",
    );
  });
});

describe("applyReview — REVISE validation (user requirement 10)", () => {
  it("buildReview throws when REVISE has no newTaskId (plan §47)", () => {
    const { bundle } = setupReviewPending();
    expect(() =>
      buildReview({
        taskId: bundle.taskId,
        executionId: bundle.executionId,
        reviewBundleId: bundle.bundleId,
        taskHash: bundle.taskHash,
        resultHash: bundle.resultHash,
        reviewBundleHash: bundle.reviewBundleHash,
        decision: "REVISE",
      }),
    ).toThrow(/REVISE.*newTaskId/);
  });

  it("buildReview throws when REVISE newTaskId === current taskId (plan §47)", () => {
    const { bundle } = setupReviewPending();
    expect(() =>
      buildReview(makeReviewInput(bundle, "REVISE", { newTaskId: TASK_ID })),
    ).toThrow(/REVISE newTaskId must differ/);
  });

  it("defends REVISE_NEW_TASK_ID_SAME at ingress too (defense in depth)", () => {
    // buildReview 已经捕了,但这里手工构造一个 Review 来确认 applyReview 也会捕。
    // 用真正的 bundle.bundleId (不是 hardcoded BUNDLE_ID,否则会先抛 BUNDLE_ID_MISMATCH)。
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const partial: Omit<Review, "reviewHash"> = {
      protocolVersion: REVIEW_PROTOCOL_VERSION,
      reviewId: "manual-review",
      taskId: TASK_ID,
      executionId: EXECUTION_ID,
      reviewBundleId: bundle.bundleId,
      taskHash: bundle.taskHash,
      resultHash: bundle.resultHash,
      reviewBundleHash: bundle.reviewBundleHash,
      decision: "REVISE",
      newTaskId: TASK_ID, // same as current
      timestampMs: Date.now(),
    };
    const review: Review = { ...partial, reviewHash: computeReviewHash(partial) };
    expectIngressError(
      () => applyReview(review, bundle, {
        currentState: "REVIEW_PENDING",
        eventStore,
        replayGuard,
      }),
      "REVISE_NEW_TASK_ID_SAME",
    );
  });
});

describe("applyReview — replay guard (user requirements 8, 9)", () => {
  it("same reviewId + same content is idempotent (returns prior result, no new event)", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const overrides = { reviewId: "fixed-review-id", timestampMs: 1_700_000_000_000 };
    const review = buildReview(makeReviewInput(bundle, "ACCEPT", overrides));
    const first = applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    expect(first.kind).toBe("applied");
    const sizeAfterFirst = eventStore.size();
    const second = applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    expect(second.kind).toBe("idempotent");
    if (second.kind === "idempotent") {
      expect(second.newState).toBe("ACCEPTED");
      expect(second.decision).toBe("ACCEPT");
      expect(second.reviewId).toBe("fixed-review-id");
    }
    // idempotent: no new event appended
    expect(eventStore.size()).toBe(sizeAfterFirst);
  });

  it("same reviewId + different content throws REVIEW_ID_CONFLICT (user requirement 9)", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const reviewA = buildReview(makeReviewInput(bundle, "ACCEPT", {
      reviewId: "same-id",
      timestampMs: 1_700_000_000_000,
    }));
    applyReview(reviewA, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    const reviewB = buildReview(makeReviewInput(bundle, "ACCEPT", {
      reviewId: "same-id",
      timestampMs: 1_700_000_000_000,
      findings: "different content",
    }));
    expectIngressError(
      () => applyReview(reviewB, bundle, {
        currentState: "REVIEW_PENDING",
        eventStore,
        replayGuard,
      }),
      "REVIEW_ID_CONFLICT",
    );
  });

  it("different reviewId for same bundle throws BUNDLE_ALREADY_DECIDED", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const reviewA = buildReview(makeReviewInput(bundle, "ACCEPT"));
    applyReview(reviewA, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    const reviewB = buildReview(makeReviewInput(bundle, "BLOCK"));
    expectIngressError(
      () => applyReview(reviewB, bundle, {
        currentState: "REVIEW_PENDING",
        eventStore,
        replayGuard,
      }),
      "BUNDLE_ALREADY_DECIDED",
    );
  });

  it("idempotent replay works even after state has moved past REVIEW_PENDING", () => {
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const overrides = { reviewId: "fixed", timestampMs: 1_700_000_000_000 };
    const review = buildReview(makeReviewInput(bundle, "ACCEPT", overrides));
    applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    // Replay with currentState = ACCEPTED: should still be idempotent
    const second = applyReview(review, bundle, {
      currentState: "ACCEPTED",
      eventStore,
      replayGuard,
    });
    expect(second.kind).toBe("idempotent");
    if (second.kind === "idempotent") {
      expect(second.newState).toBe("ACCEPTED");
    }
  });
});

describe("applyReview — old bundle detection (user requirement 7)", () => {
  it("a second review for the same bundle after ACCEPT throws (BUNDLE_ALREADY_DECIDED beats STALE_REVIEW check)", () => {
    // Replay guard 先于 state check,所以旧 bundle 会以 BUNDLE_ALREADY_DECIDED
    // 形式被拒(不是 STALE_REVIEW),这是 anti-replay 的第二道保险。
    const { eventStore, replayGuard, bundle } = setupReviewPending();
    const review = buildReview(makeReviewInput(bundle, "ACCEPT"));
    applyReview(review, bundle, {
      currentState: "REVIEW_PENDING",
      eventStore,
      replayGuard,
    });
    const stale = buildReview(makeReviewInput(bundle, "BLOCK"));
    expectIngressError(
      () => applyReview(stale, bundle, {
        currentState: "ACCEPTED",
        eventStore,
        replayGuard,
      }),
      "BUNDLE_ALREADY_DECIDED",
    );
  });
});
