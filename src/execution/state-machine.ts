/**
 * State Machine — plan §41 + §51
 *
 * Task State enum + 转换表,Reducer 的核心。
 *
 * 关键设计(plan §51 + 用户要求 1-4):
 * - UNKNOWN 不在状态集合里 — UNKNOWN 是 Recovery Resolver 的"裁定",不是持久化 state
 * - RECOVERY_REQUIRED 是正式停驻状态,自动重试被禁止
 * - 任何 (state, eventType) 不在表里 → 抛 InvalidTransitionError
 * - Terminal state 不接受任何事件
 *
 * 转换驱动由 src/events/reducer.ts 完成(state-machine 只暴露 nextState),
 * reducer 负责:1) 初始 state 处理;2) fingerprint 冻结 / 变化检测;
 * 3) 调用 nextState;4) 把 fingerprint 变化映射到 RECOVERY_REQUIRED。
 */

import type { TaskEventType } from "../events/events.js";

/**
 * 全部 17 个 Task State(plan §41 + §51)。
 * 没有 UNKNOWN — UNKNOWN 是 plan §51 Recovery Resolver Verdict,不是持久化状态。
 */
export type TaskState =
  // Active
  | "PLANNED"
  | "VALIDATING"
  | "READY"
  | "WAITING_WORKSPACE_LOCK"
  | "SPAWNING_AGENT"
  | "RUNNING"
  | "COLLECTING_EVIDENCE"
  | "VERIFYING"
  | "EXECUTION_SUCCEEDED"
  | "REVIEW_PENDING"
  | "ACCEPT_PREPARED"
  | "PATCH_APPLIED"
  // Terminal
  | "REVISION_REQUESTED"
  | "ACCEPTED"
  | "BLOCKED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "RECOVERY_REQUIRED";

export const ACTIVE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "PLANNED",
  "VALIDATING",
  "READY",
  "WAITING_WORKSPACE_LOCK",
  "SPAWNING_AGENT",
  "RUNNING",
  "COLLECTING_EVIDENCE",
  "VERIFYING",
  "EXECUTION_SUCCEEDED",
  "REVIEW_PENDING",
  "ACCEPT_PREPARED",
  "PATCH_APPLIED",
]);

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "REVISION_REQUESTED",
  "ACCEPTED",
  "BLOCKED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "RECOVERY_REQUIRED",
]);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isActive(state: TaskState): boolean {
  return ACTIVE_STATES.has(state);
}

export class InvalidTransitionError extends Error {
  readonly fromState: TaskState | null;
  readonly eventType: string;
  readonly reason: string;
  constructor(
    fromState: TaskState | null,
    eventType: string,
    reason: string,
  ) {
    super(
      `invalid transition: ${fromState ?? "null"} --[${eventType}]--> ? (${reason})`,
    );
    this.name = "InvalidTransitionError";
    this.fromState = fromState;
    this.eventType = eventType;
    this.reason = reason;
  }
}

/**
 * 状态转换表(plan §41 + §51)。
 * 表里没有的 (state, eventType) 组合一律抛 InvalidTransitionError。
 *
 * 故意不放 "fingerprint.changed" 这种事件:
 * fingerprint 变化是 reducer 层的检测,不是一个会出现在事件流里的真实事件类型。
 * 见 src/events/reducer.ts。
 */
const TRANSITIONS: Readonly<
  Record<TaskState, Readonly<Partial<Record<TaskEventType, TaskState>>>>
> = {
  PLANNED: {
    "task.validation.started": "VALIDATING",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  VALIDATING: {
    "task.validation.passed": "READY",
    "task.validation.failed": "FAILED",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  READY: {
    "workspace.lock.requested": "WAITING_WORKSPACE_LOCK",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  WAITING_WORKSPACE_LOCK: {
    "workspace.lock.acquired": "SPAWNING_AGENT",
    "workspace.lock.busy": "FAILED",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  SPAWNING_AGENT: {
    "agent.spawn.started": "RUNNING",
    "agent.spawn.failed": "FAILED",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  RUNNING: {
    "agent.completed": "COLLECTING_EVIDENCE",
    "agent.failed": "FAILED",
    "agent.timed_out": "TIMED_OUT",
    "agent.cancelled": "CANCELLED",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  COLLECTING_EVIDENCE: {
    "evidence.diff.collected": "VERIFYING",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  VERIFYING: {
    "verification.completed": "EXECUTION_SUCCEEDED",
    "verification.skipped": "EXECUTION_SUCCEEDED",
    "verification.failed": "FAILED",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  EXECUTION_SUCCEEDED: {
    "review.requested": "REVIEW_PENDING",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  REVIEW_PENDING: {
    "review.accept.prepared": "ACCEPT_PREPARED",
    "review.decision.accept": "ACCEPTED",
    "review.decision.revise": "REVISION_REQUESTED",
    "review.decision.block": "BLOCKED",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  ACCEPT_PREPARED: {
    "patch.applied": "PATCH_APPLIED",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  PATCH_APPLIED: {
    "review.accept.completed": "ACCEPTED",
    "recovery.required": "RECOVERY_REQUIRED",
  },
  // Terminal states:no outgoing edges
  REVISION_REQUESTED: {},
  ACCEPTED: {},
  BLOCKED: {},
  FAILED: {},
  TIMED_OUT: {},
  CANCELLED: {},
  RECOVERY_REQUIRED: {},
};

/**
 * 查表得到 next state。查不到抛 InvalidTransitionError。
 * 不做 fingerprint / initial-state 处理 — 那些是 reducer 的职责。
 */
export function nextState(
  currentState: TaskState,
  eventType: TaskEventType,
): TaskState {
  const next = TRANSITIONS[currentState][eventType];
  if (next === undefined) {
    throw new InvalidTransitionError(
      currentState,
      eventType,
      `no transition from "${currentState}" via "${eventType}"`,
    );
  }
  return next;
}

/**
 * 测试 / 诊断用:列出指定 state 的所有合法 next-state。
 */
export function legalNextStates(state: TaskState): readonly TaskState[] {
  return Object.values(TRANSITIONS[state]);
}
