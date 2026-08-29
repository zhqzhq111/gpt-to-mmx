/**
 * Replay Guard — plan §46 anti-replay / anti-stale
 *
 * 跟踪已应用的 Review,提供 4 种结果:
 * - allow                       : 该 reviewBundleId 还没被任何 review 处理过
 * - idempotent                  : 同 reviewId + 同 content,重复应用 = 幂等
 * - conflict                    : 同 reviewId + 不同 content → 攻击/损坏,拒
 * - bundle_already_decided      : 同 reviewBundleId 但 reviewId 不同 → 拒
 *
 * 这是 plan §46 "新 Review 只允许在 REVIEW_PENDING 状态应用" 在跨进程场景下
 * 的兜底:即便状态机本身被绕过,replay guard 也会拒绝"对同一个 bundle 的
 * 第二个不同 review"。
 *
 * 内存版,跟其他 G2M 内部 registry 一致;持久化留到 Phase 9 Event Log。
 */

import type { ReviewDecision } from "./ingress.js";
import { readJsonFile, writeJsonAtomic } from "../persistence/durable-state.js";

export interface AppliedReview {
  readonly reviewId: string;
  readonly reviewHash: string;
  readonly decision: ReviewDecision;
  readonly appliedAt: number;
}

export type ReplayCheckResult =
  | { readonly kind: "allow" }
  | { readonly kind: "idempotent"; readonly existing: AppliedReview }
  | {
      readonly kind: "conflict";
      readonly existing: AppliedReview;
      readonly newHash: string;
    }
  | { readonly kind: "bundle_already_decided"; readonly existing: AppliedReview };

/**
 * Review 的"最少签名" — replay guard 只需要 reviewId / reviewHash / decision。
 * 不依赖完整 Review 类型以避免循环 import;ingress.ts 适配。
 */
export interface ReviewSignature {
  readonly reviewId: string;
  readonly reviewBundleId: string;
  readonly reviewHash: string;
  readonly decision: ReviewDecision;
}

export interface ReplayGuardOptions {
  readonly statePath?: string;
}

export class ReplayGuard {
  private readonly applied = new Map<string, AppliedReview>();
  private readonly statePath: string | undefined;

  constructor(options: ReplayGuardOptions = {}) {
    this.statePath = options.statePath;
    if (this.statePath === undefined) return;
    const loaded = readJsonFile<Record<string, AppliedReview>>(this.statePath);
    if (loaded === undefined) return;
    for (const [bundleId, review] of Object.entries(loaded)) {
      if (
        typeof bundleId !== "string" ||
        typeof review.reviewId !== "string" ||
        typeof review.reviewHash !== "string" ||
        typeof review.decision !== "string" ||
        typeof review.appliedAt !== "number"
      ) {
        throw new Error(`invalid replay guard entry for bundle "${bundleId}"`);
      }
      this.applied.set(bundleId, review);
    }
  }

  /**
   * 检查 review 是否可以应用。
   * 纯函数(不 mutate)。
   */
  check(review: ReviewSignature): ReplayCheckResult {
    const existing = this.applied.get(review.reviewBundleId);
    if (existing === undefined) {
      return { kind: "allow" };
    }
    if (existing.reviewId === review.reviewId) {
      if (existing.reviewHash === review.reviewHash) {
        return { kind: "idempotent", existing };
      }
      return {
        kind: "conflict",
        existing,
        newHash: review.reviewHash,
      };
    }
    return { kind: "bundle_already_decided", existing };
  }

  /**
   * 记录一个已应用的 review。覆盖前不检查 — 调用方(check 之后)负责保证合法性。
   */
  record(review: ReviewSignature, appliedAt: number = Date.now()): void {
    const applied: AppliedReview = {
      reviewId: review.reviewId,
      reviewHash: review.reviewHash,
      decision: review.decision,
      appliedAt,
    };
    if (this.statePath !== undefined) {
      const next = Object.fromEntries(this.applied.entries());
      next[review.reviewBundleId] = applied;
      writeJsonAtomic(this.statePath, next);
    }
    this.applied.set(review.reviewBundleId, applied);
  }

  /**
   * 诊断用:查询某个 reviewBundleId 的已应用 review。
   */
  get(reviewBundleId: string): AppliedReview | undefined {
    return this.applied.get(reviewBundleId);
  }

  /**
   * 诊断用:已记录的 review 数量。
   */
  size(): number {
    return this.applied.size;
  }

  /**
   * 诊断用:列出所有 reviewBundleId。
   */
  listBundleIds(): readonly string[] {
    return Array.from(this.applied.keys());
  }

  /**
   * Phase 9 Recovery 用的清除入口,本轮 reducer / ingress 都不调。
   */
  clear(): void {
    this.applied.clear();
  }
}
