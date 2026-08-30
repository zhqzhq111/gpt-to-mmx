/**
 * Task Event Types — plan §41 + §52
 *
 * 事件类型集合。事件是 G2M 内部状态机的"输入",
 * 由各种来源(Protocol validator / Workspace lock / MCodeAdapter /
 * Verification Runner / Reviewer)产生,append 到 events.jsonl (Phase 9
 * 持久化,MVP 内存版)。
 *
 * 关键约束(plan §52 + 用户要求 1):
 * - 物理文件顺序就是事件顺序,append-only,禁止 Replay 时排序
 * - seq 只用于校验,不能用作排序 key
 *
 * 注:故意不放 "fingerprint.changed" 这种事件 — fingerprint 变化是
 * reducer 的检测结果,不是一个真实事件类型。reducer 在普通事件里检测
 * fingerprint 变化然后转 RECOVERY_REQUIRED。
 */

import type { TaskFingerprint } from "../execution/fingerprint.js";

export type TaskEventType =
  // Task 生命周期入口
  | "task.created"
  // Validation
  | "task.validation.started"
  | "task.validation.passed"
  | "task.validation.failed"
  // Workspace Lock
  | "workspace.lock.requested"
  | "workspace.lock.acquired"
  | "workspace.lock.busy"
  // Agent execution
  | "agent.spawn.started"
  | "agent.spawn.failed"
  | "agent.completed"
  | "agent.failed"
  | "agent.timed_out"
  | "agent.cancelled"
  // Evidence collection
  | "evidence.diff.collected"
  | "patch.frozen"
  // Verification
  | "verification.completed"
  | "verification.skipped"
  | "verification.failed"
  // Review
  | "review.requested"
  | "review.accept.prepared"
  | "patch.apply.started"
  | "patch.applied"
  | "review.accept.completed"
  | "review.decision.accept"
  | "review.decision.revise"
  | "review.decision.block"
  // Recovery (plan §51) — 任何 active state 看到 recovery.required 都会进 RECOVERY_REQUIRED
  | "recovery.required"
  | "recovery.reconciled"
  | "storage.reservation.created"
  | "storage.reservation.released"
  | "storage.reservation.expired"
  | "storage.reservation.abandoned"
  | "gc.marked"
  | "gc.completed"
  | "projection.stale"
  | "projection.repaired";

export type EventDomain = "lifecycle" | "recovery" | "storage" | "projection";
export type EventDurability = "CRITICAL" | "NORMAL" | "DIAGNOSTIC";

/**
 * 事件 payload。MVP 用宽泛的 Record<string, unknown> —
 * 每个 event type 期望的字段在 reducer / state-machine 注释里说明,
 * 真正的 typed payload union 留到 Phase 7 Review Bundle 一起做。
 */
export type TaskEventPayload = Record<string, unknown>;

/**
 * 事件通用 metadata + payload + 链式 hash 字段。
 * prevHash / hash 由 EventStore.append 自动填,调用方不传。
 */
export interface TaskEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly seq: number;
  readonly timestampMs: number;
  readonly taskId: string;
  readonly attemptId: string;
  readonly domain: EventDomain;
  readonly type: TaskEventType;
  readonly durability: EventDurability;
  readonly prevHash: string | null;
  readonly hash: string;
  /**
   * 可选 fingerprint。
   * - agent.spawn.started 事件必带,触发 reducer 在 FingerprintRegistry 里冻结
   * - 之后的任何事件如果带 fingerprint 且与冻结值不同,reducer 转 RECOVERY_REQUIRED
   * - 冻结前(PLANNED / VALIDATING / READY / WAITING_WORKSPACE_LOCK / SPAWNING_AGENT
   *   状态)的事件,reducer 不做 fingerprint 比对,只是原样透传
   */
  readonly fingerprint?: TaskFingerprint;
  readonly payload: TaskEventPayload;
}
