/**
 * Review Ingress — plan §46 + §47 + §48
 *
 * g2m.review.v1
 *
 * 接收 Codex Reviewer 返回的 review,验证 binding(plan §46),应用状态
 * 转换,把状态事件 append 到 EventStore,记入 ReplayGuard。
 *
 * 关键校验(plan §46 + 用户要求 5/6/7/8/9/10):
 * - Bundle / Review 必须 bind 到 (task_id, execution_id, review_bundle_id,
 *   task_hash, result_hash, review_bundle_hash) — 任何不一致就拒
 * - 只允许在 REVIEW_PENDING 状态应用(plan §46 "新 Review 只允许在
 *   REVIEW_PENDING 状态应用")
 * - 同一 reviewId + 同 content = 幂等(plan §46 anti-replay)
 * - 同一 reviewId + 不同 content = conflict,拒
 * - REVISE 必须带 newTaskId,且 newTaskId ≠ 当前 taskId(plan §47)
 * - 老 bundle(状态已离开 REVIEW_PENDING)被拒为 STALE_REVIEW
 *
 * 不动 src/workers/mcode、src/evidence/verification、src/evidence/store、
 * src/recovery(本轮约束)。
 */

import { randomUUID } from "node:crypto";

import { sha256 } from "../protocol/hash.js";
import type { TaskEvent, TaskEventType } from "../events/events.js";
import type { EventStore } from "../events/store.js";
import type { TaskState } from "../execution/state-machine.js";
import { type ReviewBundle } from "./bundle.js";
import { ReplayGuard, type ReviewSignature } from "./replay-guard.js";

export const REVIEW_PROTOCOL_VERSION = "g2m.review.v1" as const;

export type ReviewDecision = "ACCEPT" | "REVISE" | "BLOCK";

export interface Review {
  readonly protocolVersion: typeof REVIEW_PROTOCOL_VERSION;
  readonly reviewId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly reviewBundleId: string;
  readonly taskHash: string;
  readonly resultHash: string;
  readonly reviewBundleHash: string;
  readonly decision: ReviewDecision;
  readonly findings?: string;
  readonly newTaskId?: string;
  readonly reviewerId?: string;
  readonly timestampMs: number;
  readonly reviewHash: string;
}

export interface BuildReviewInput {
  readonly taskId: string;
  readonly executionId: string;
  readonly reviewBundleId: string;
  readonly taskHash: string;
  readonly resultHash: string;
  readonly reviewBundleHash: string;
  readonly decision: ReviewDecision;
  readonly findings?: string;
  readonly newTaskId?: string;
  readonly reviewerId?: string;
  readonly reviewId?: string;
  readonly timestampMs?: number;
}

/**
 * 计算 reviewHash — review 的 self-hash,绑全部 6 个 binding 字段 + decision + findings + newTaskId。
 * 跟 plan §46 review_bundle_hash 字段对齐。
 */
export function computeReviewHash(review: Omit<Review, "reviewHash">): string {
  return sha256({
    protocolVersion: review.protocolVersion,
    reviewId: review.reviewId,
    taskId: review.taskId,
    executionId: review.executionId,
    reviewBundleId: review.reviewBundleId,
    taskHash: review.taskHash,
    resultHash: review.resultHash,
    reviewBundleHash: review.reviewBundleHash,
    decision: review.decision,
    ...(review.findings !== undefined ? { findings: review.findings } : {}),
    ...(review.newTaskId !== undefined ? { newTaskId: review.newTaskId } : {}),
    ...(review.reviewerId !== undefined ? { reviewerId: review.reviewerId } : {}),
    timestampMs: review.timestampMs,
  });
}

/**
 * 工厂函数:用 input + 现有 bundle 拼一个 Review,自动填 reviewId / timestampMs / reviewHash。
 * 测试用,真实 Codex Reviewer 也会走类似的工厂。
 */
export function buildReview(input: BuildReviewInput): Review {
  if (input.taskHash.length !== 64 || !/^[0-9a-f]{64}$/.test(input.taskHash)) {
    throw new Error(
      `buildReview: taskHash must be 64-char hex sha256, got "${input.taskHash}"`,
    );
  }
  if (input.resultHash.length !== 64 || !/^[0-9a-f]{64}$/.test(input.resultHash)) {
    throw new Error(
      `buildReview: resultHash must be 64-char hex sha256, got "${input.resultHash}"`,
    );
  }
  if (
    input.reviewBundleHash.length !== 64 ||
    !/^[0-9a-f]{64}$/.test(input.reviewBundleHash)
  ) {
    throw new Error(
      `buildReview: reviewBundleHash must be 64-char hex sha256, got "${input.reviewBundleHash}"`,
    );
  }
  if (input.decision === "REVISE") {
    if (input.newTaskId === undefined || input.newTaskId.trim().length === 0) {
      throw new Error(
        "buildReview: REVISE decision requires newTaskId (plan §47)",
      );
    }
    if (input.newTaskId === input.taskId) {
      throw new Error(
        `buildReview: REVISE newTaskId must differ from current taskId (plan §47), got same "${input.newTaskId}"`,
      );
    }
  }
  const reviewId = input.reviewId ?? randomUUID();
  const timestampMs = input.timestampMs ?? Date.now();
  const partial: Omit<Review, "reviewHash"> = {
    protocolVersion: REVIEW_PROTOCOL_VERSION,
    reviewId,
    taskId: input.taskId,
    executionId: input.executionId,
    reviewBundleId: input.reviewBundleId,
    taskHash: input.taskHash,
    resultHash: input.resultHash,
    reviewBundleHash: input.reviewBundleHash,
    decision: input.decision,
    ...(input.findings !== undefined ? { findings: input.findings } : {}),
    ...(input.newTaskId !== undefined ? { newTaskId: input.newTaskId } : {}),
    ...(input.reviewerId !== undefined ? { reviewerId: input.reviewerId } : {}),
    timestampMs,
  };
  const reviewHash = computeReviewHash(partial);
  return { ...partial, reviewHash };
}

export type ReviewIngressErrorCode =
  | "STALE_REVIEW"
  | "TASK_ID_MISMATCH"
  | "EXECUTION_ID_MISMATCH"
  | "TASK_HASH_MISMATCH"
  | "RESULT_HASH_MISMATCH"
  | "REVIEW_BUNDLE_ID_MISMATCH"
  | "REVIEW_BUNDLE_HASH_MISMATCH"
  | "REVISE_MISSING_NEW_TASK_ID"
  | "REVISE_NEW_TASK_ID_SAME"
  | "REVIEW_ID_CONFLICT"
  | "BUNDLE_ALREADY_DECIDED"
  | "INVALID_REVIEW_HASH";

export class ReviewIngressError extends Error {
  readonly code: ReviewIngressErrorCode;
  readonly details: string;
  constructor(
    code: ReviewIngressErrorCode,
    message: string,
    details: string,
  ) {
    super(message);
    this.name = "ReviewIngressError";
    this.code = code;
    this.details = details;
  }
}

export interface ApplyReviewContext {
  readonly currentState: TaskState;
  readonly eventStore: EventStore;
  readonly replayGuard: ReplayGuard;
}

export interface ValidateReviewContext {
  readonly currentState: TaskState;
  readonly replayGuard: ReplayGuard;
}

export type ValidateReviewResult =
  | {
      readonly kind: "apply";
      readonly newState: TaskState;
      readonly decision: ReviewDecision;
    }
  | {
      readonly kind: "idempotent";
      readonly newState: TaskState;
      readonly decision: ReviewDecision;
      readonly reviewId: string;
    };

export type ApplyReviewResult =
  | {
      readonly kind: "applied";
      readonly newState: TaskState;
      readonly decision: ReviewDecision;
      readonly event: TaskEvent;
      readonly newTaskId?: string;
    }
  | {
      readonly kind: "idempotent";
      readonly newState: TaskState;
      readonly decision: ReviewDecision;
      readonly reviewId: string;
    };

function stateFromDecision(decision: ReviewDecision): TaskState {
  switch (decision) {
    case "ACCEPT":
      return "ACCEPTED";
    case "REVISE":
      return "REVISION_REQUESTED";
    case "BLOCK":
      return "BLOCKED";
  }
}

function eventTypeFromDecision(decision: ReviewDecision): TaskEventType {
  switch (decision) {
    case "ACCEPT":
      return "review.decision.accept";
    case "REVISE":
      return "review.decision.revise";
    case "BLOCK":
      return "review.decision.block";
  }
}

function toSignature(review: Review): ReviewSignature {
  return {
    reviewId: review.reviewId,
    reviewBundleId: review.reviewBundleId,
    reviewHash: review.reviewHash,
    decision: review.decision,
  };
}

/**
 * Pure ingress validation. This deliberately performs no EventStore append and
 * does not record the ReplayGuard. Orchestrators can therefore validate a
 * decision before applying an ACCEPT patch, without consuming the decision if
 * the workspace preconditions fail.
 */
export function validateReview(
  review: Review,
  bundle: ReviewBundle,
  context: ValidateReviewContext,
): ValidateReviewResult {
  const guardCheck = context.replayGuard.check(toSignature(review));
  if (guardCheck.kind === "idempotent") {
    return {
      kind: "idempotent",
      newState: stateFromDecision(guardCheck.existing.decision),
      decision: guardCheck.existing.decision,
      reviewId: guardCheck.existing.reviewId,
    };
  }
  if (guardCheck.kind === "conflict") {
    throw new ReviewIngressError(
      "REVIEW_ID_CONFLICT",
      `reviewId "${review.reviewId}" was previously applied with different content (plan §46 anti-replay)`,
      `existing reviewHash=${guardCheck.existing.reviewHash} new reviewHash=${review.reviewHash}`,
    );
  }
  if (guardCheck.kind === "bundle_already_decided") {
    throw new ReviewIngressError(
      "BUNDLE_ALREADY_DECIDED",
      `reviewBundleId "${review.reviewBundleId}" already has a different review applied (plan §46)`,
      `existing reviewId=${guardCheck.existing.reviewId} decision=${guardCheck.existing.decision} appliedAt=${guardCheck.existing.appliedAt}`,
    );
  }

  if (context.currentState !== "REVIEW_PENDING") {
    throw new ReviewIngressError(
      "STALE_REVIEW",
      `cannot apply review in task state "${context.currentState}" (plan §46)`,
      `taskId="${review.taskId}" reviewBundleId="${review.reviewBundleId}"`,
    );
  }

  if (review.taskId !== bundle.taskId) {
    throw new ReviewIngressError(
      "TASK_ID_MISMATCH",
      `review.taskId "${review.taskId}" does not match bundle.taskId "${bundle.taskId}"`,
      "review must bind to the same task as the bundle (plan §46)",
    );
  }
  if (review.executionId !== bundle.executionId) {
    throw new ReviewIngressError(
      "EXECUTION_ID_MISMATCH",
      `review.executionId "${review.executionId}" does not match bundle.executionId "${bundle.executionId}"`,
      "review must bind to the same execution as the bundle (plan §46)",
    );
  }
  if (review.reviewBundleId !== bundle.bundleId) {
    throw new ReviewIngressError(
      "REVIEW_BUNDLE_ID_MISMATCH",
      `review.reviewBundleId "${review.reviewBundleId}" does not match bundle.bundleId "${bundle.bundleId}"`,
      "review must reference the same bundle it's reviewing (plan §46)",
    );
  }
  if (review.taskHash !== bundle.taskHash) {
    throw new ReviewIngressError(
      "TASK_HASH_MISMATCH",
      "review.taskHash does not match bundle.taskHash",
      `expected ${bundle.taskHash} got ${review.taskHash} (plan §46)`,
    );
  }
  if (review.resultHash !== bundle.resultHash) {
    throw new ReviewIngressError(
      "RESULT_HASH_MISMATCH",
      "review.resultHash does not match bundle.resultHash",
      `expected ${bundle.resultHash} got ${review.resultHash} (plan §46)`,
    );
  }
  if (review.reviewBundleHash !== bundle.reviewBundleHash) {
    throw new ReviewIngressError(
      "REVIEW_BUNDLE_HASH_MISMATCH",
      "review.reviewBundleHash does not match bundle.reviewBundleHash",
      `expected ${bundle.reviewBundleHash} got ${review.reviewBundleHash} (plan §46)`,
    );
  }

  if (review.decision === "REVISE") {
    if (review.newTaskId === undefined || review.newTaskId.trim().length === 0) {
      throw new ReviewIngressError(
        "REVISE_MISSING_NEW_TASK_ID",
        "REVISE decision requires newTaskId (plan §47)",
        `reviewId=${review.reviewId}`,
      );
    }
    if (review.newTaskId === review.taskId) {
      throw new ReviewIngressError(
        "REVISE_NEW_TASK_ID_SAME",
        "REVISE newTaskId must differ from current taskId (plan §47)",
        `newTaskId=${review.newTaskId} equals current taskId=${review.taskId}`,
      );
    }
  }

  return {
    kind: "apply",
    newState: stateFromDecision(review.decision),
    decision: review.decision,
  };
}

/**
 * 应用一个 Review 到当前 task。
 *
 * 步骤(plan §46):
 * 1. Replay guard 检查(优先于 state 检查,保证幂等性在 stale 状态下也能返回)
 *    - allow                       → 继续
 *    - idempotent                  → 直接返回 prior 结果
 *    - conflict                    → 抛 REVIEW_ID_CONFLICT
 *    - bundle_already_decided      → 抛 BUNDLE_ALREADY_DECIDED
 * 2. State 必须是 REVIEW_PENDING,否则抛 STALE_REVIEW
 * 3. 6 个 binding 字段必须 match,否则抛对应 *MISMATCH
 * 4. REVISE 必须带 newTaskId 且 ≠ taskId
 * 5. append review.decision.* 事件到 EventStore
 * 6. record 到 ReplayGuard
 * 7. 返回 {kind: "applied", newState, decision, event, newTaskId?}
 *
 * 副作用:append 到 EventStore,写入 ReplayGuard。Hash chain 完整性由 EventStore 保证。
 */
export function applyReview(
  review: Review,
  bundle: ReviewBundle,
  context: ApplyReviewContext,
): ApplyReviewResult {
  const validation = validateReview(review, bundle, context);
  if (validation.kind === "idempotent") return validation;

  // 5. Append state event(把 review 决策固化到 EventStore + 触发 reducer 转换)
  const event = context.eventStore.append({
    taskId: review.taskId,
    attemptId: review.executionId,
    type: eventTypeFromDecision(review.decision),
    payload: {
      reviewId: review.reviewId,
      reviewBundleId: review.reviewBundleId,
      reviewHash: review.reviewHash,
      ...(review.newTaskId !== undefined ? { newTaskId: review.newTaskId } : {}),
      ...(review.findings !== undefined ? { findings: review.findings } : {}),
    },
  });

  // 6. Record to guard
  context.replayGuard.record(toSignature(review));

  return {
    kind: "applied",
    newState: validation.newState,
    decision: review.decision,
    event,
    ...(review.newTaskId !== undefined ? { newTaskId: review.newTaskId } : {}),
  };
}
