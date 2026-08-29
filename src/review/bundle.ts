/**
 * Review Bundle — plan §45
 *
 * g2m.code-review-bundle.v1
 *
 * 包含 Codex Reviewer 审核一个 Coding Task 执行结果所需的全部 evidence。
 * 三个 binding hash 字段(plan §46):
 * - taskHash        : hash of original task content
 * - resultHash      : hash of (worker summary + diff + verification)
 * - reviewBundleHash: self-hash of the bundle (excluding itself)
 *
 * 三者都是 64-char hex (sha256),Review ingress 必须 bind 到完全一致的值,
 * 任何不一致都意味着 bundle 或 review 跟当前 task 状态不匹配 → 拒绝。
 *
 * 默认不塞入(plan §45):
 * - 全部 Thinking
 * - 全部 Terminal Logs
 * - 全部 Tool Events
 * 这些只通过 WorkerResult.rawEventLogRef 引用,不进 bundle。
 *
 * 不动 src/workers/mcode、src/evidence/verification、src/evidence/store、
 * src/execution/reducer、src/recovery(本轮约束)。
 */

import { randomUUID } from "node:crypto";

import { sha256 } from "../protocol/hash.js";
import type { CodeTaskV1 } from "../protocol/code-task.v1.schema.js";
import type { WorkerResult } from "../workers/coding-worker.js";
import type { DiffResult } from "../evidence/diff.js";
import type { WorkspaceBaseline } from "../workspace/baseline.js";
import type { VerificationResult } from "../evidence/verification.js";

export const REVIEW_BUNDLE_PROTOCOL_VERSION = "g2m.code-review-bundle.v1" as const;

export type WorkerRuntimeName = "mcode" | "fake" | "unknown";

export interface WorkerRuntimeInfo {
  readonly runtime: WorkerRuntimeName;
  readonly version: string;
  readonly model: string;
}

export interface ReviewBundle {
  readonly protocolVersion: typeof REVIEW_BUNDLE_PROTOCOL_VERSION;
  readonly bundleId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly taskHash: string;
  readonly resultHash: string;
  readonly reviewBundleHash: string;
  readonly createdAt: number;
  readonly originalTask: CodeTaskV1;
  readonly workerRuntime: WorkerRuntimeInfo;
  readonly sessionId?: string;
  readonly workerSummary: WorkerResult;
  readonly workspaceEvidence: {
    readonly diff: DiffResult;
    readonly baseline: WorkspaceBaseline;
  };
  readonly verificationEvidence: {
    readonly verification: VerificationResult;
  };
  readonly warnings: readonly string[];
  readonly remainingRisks: readonly string[];
}

export interface BuildBundleInput {
  readonly task: CodeTaskV1;
  readonly taskHash: string;
  readonly executionId: string;
  readonly workerSummary: WorkerResult;
  readonly workspaceEvidence: {
    readonly diff: DiffResult;
    readonly baseline: WorkspaceBaseline;
  };
  readonly verificationEvidence: {
    readonly verification: VerificationResult;
  };
  readonly workerRuntime: WorkerRuntimeInfo;
  readonly bundleId?: string;
  readonly createdAt?: number;
}

/**
 * 计算 resultHash — 绑 "what was produced" 的整体内容。
 * workerSummary + diff + baseline + verification 一起进 sha256。
 */
export function computeResultHash(input: {
  readonly workerSummary: WorkerResult;
  readonly diff: DiffResult;
  readonly baseline: WorkspaceBaseline;
  readonly verification: VerificationResult;
}): string {
  return sha256({
    workerSummary: input.workerSummary,
    diff: input.diff,
    baseline: input.baseline,
    verification: input.verification,
  });
}

/**
 * 计算 reviewBundleHash — bundle 的 self-hash,排除 reviewBundleHash 自身。
 * 同样 64-char hex。
 */
export function computeReviewBundleHash(
  bundle: Omit<ReviewBundle, "reviewBundleHash">,
): string {
  return sha256({
    protocolVersion: bundle.protocolVersion,
    bundleId: bundle.bundleId,
    taskId: bundle.taskId,
    executionId: bundle.executionId,
    taskHash: bundle.taskHash,
    resultHash: bundle.resultHash,
    createdAt: bundle.createdAt,
    originalTask: bundle.originalTask,
    workerRuntime: bundle.workerRuntime,
    ...(bundle.sessionId !== undefined ? { sessionId: bundle.sessionId } : {}),
    workerSummary: bundle.workerSummary,
    workspaceEvidence: bundle.workspaceEvidence,
    verificationEvidence: bundle.verificationEvidence,
    warnings: bundle.warnings,
    remainingRisks: bundle.remainingRisks,
  });
}

const TEST_PATH_HINTS: readonly string[] = [
  "tests/",
  "test/",
  "__tests__/",
];

function isTestFile(path: string): boolean {
  return TEST_PATH_HINTS.some((hint) => path.includes(hint));
}

function deriveWarnings(
  workerSummary: WorkerResult,
  diff: DiffResult,
): string[] {
  const warnings: string[] = [];
  if (diff.protectedFilesTouched.length > 0) {
    warnings.push(
      `protected files touched: ${diff.protectedFilesTouched.join(", ")}`,
    );
  }
  const testFilesChanged = diff.changedFiles
    .filter((c) => isTestFile(c.path))
    .map((c) => c.path);
  if (testFilesChanged.length > 0) {
    warnings.push(`test files changed: ${testFilesChanged.join(", ")}`);
  }
  if (workerSummary.blockedReason !== undefined) {
    warnings.push(`worker reported blocked: ${workerSummary.blockedReason}`);
  }
  return warnings;
}

/**
 * 组装一个 ReviewBundle。
 * 自动计算 resultHash + reviewBundleHash + warnings。
 * 不会 mutate 任何 input;pure。
 */
export function buildReviewBundle(input: BuildBundleInput): ReviewBundle {
  if (input.taskHash.length !== 64 || !/^[0-9a-f]{64}$/.test(input.taskHash)) {
    throw new Error(
      `buildReviewBundle: taskHash must be 64-char hex sha256, got "${input.taskHash}"`,
    );
  }
  const bundleId = input.bundleId ?? randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const resultHash = computeResultHash({
    workerSummary: input.workerSummary,
    diff: input.workspaceEvidence.diff,
    baseline: input.workspaceEvidence.baseline,
    verification: input.verificationEvidence.verification,
  });
  const warnings = deriveWarnings(
    input.workerSummary,
    input.workspaceEvidence.diff,
  );
  const remainingRisks = [...input.workerSummary.remainingRisks];

  const partial: Omit<ReviewBundle, "reviewBundleHash"> = {
    protocolVersion: REVIEW_BUNDLE_PROTOCOL_VERSION,
    bundleId,
    taskId: input.task.task_id,
    executionId: input.executionId,
    taskHash: input.taskHash,
    resultHash,
    createdAt,
    originalTask: input.task,
    workerRuntime: input.workerRuntime,
    ...(input.workerSummary.sessionId !== undefined
      ? { sessionId: input.workerSummary.sessionId }
      : {}),
    workerSummary: input.workerSummary,
    workspaceEvidence: input.workspaceEvidence,
    verificationEvidence: input.verificationEvidence,
    warnings,
    remainingRisks,
  };

  const reviewBundleHash = computeReviewBundleHash(partial);
  return { ...partial, reviewBundleHash };
}
