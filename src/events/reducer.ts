/**
 * Reducer — plan §41 + §51 + §53
 *
 * (state, event) → nextState 的纯函数(MVP 唯一副作用:在 agent.spawn.started
 * 时把 fingerprint 写入 FingerprintRegistry)。
 *
 * 关键语义(plan §51 + 用户要求 1-6):
 * 1. UNKNOWN 不出现在 state 集合里(plan §51)
 * 2. 非法状态转换抛 InvalidTransitionError
 * 3. Terminal state 不接受任何事件
 * 4. 第一个事件必须是 task.created,否则抛
 * 5. agent.spawn.started 冻结 fingerprint 到 FingerprintRegistry
 * 6. 冻结后任何事件的 fingerprint 若不同 → 强制 RECOVERY_REQUIRED
 *    (不管事件本身转换到什么 active state)
 * 7. RECOVERY_REQUIRED 是最终停驻状态,Reducer 不再响应后续事件
 *
 * 不在 reducer 里做的事(Phase 9):
 * - 真正的 recovery 流程(把 RECOVERY_REQUIRED 解析成可执行动作)
 * - 自动重试(RECOVERY_REQUIRED 严格禁止 plan §51)
 * - 任何 task 之间的调度
 */

import {
  InvalidTransitionError,
  isTerminal,
  nextState,
  type TaskState,
} from "../execution/state-machine.js";
import {
  fingerprintHash,
  type FingerprintRegistry,
} from "../execution/fingerprint.js";
import type { TaskEvent } from "./events.js";

export interface ReduceContext {
  readonly fingerprintRegistry: FingerprintRegistry;
}

const FINGERPRINT_TRANSITION_EVENTS = new Set<string>([
  // 这些事件的 payload 通常会带 fingerprint;replay / 调用方负责填。
  "agent.spawn.started",
  "agent.completed",
  "agent.failed",
  "agent.timed_out",
  "agent.cancelled",
  "verification.completed",
  "verification.skipped",
  "verification.failed",
  "patch.frozen",
  "review.decision.accept",
  "review.decision.revise",
  "review.decision.block",
  "review.accept.prepared",
  "patch.applied",
  "review.accept.completed",
]);

/**
 * Reducer 主函数。
 * 步骤:
 * 1. 初始 state:仅 task.created → PLANNED,其他抛
 * 2. Terminal state:拒绝任何事件,抛 InvalidTransitionError
 * 3. 计算 next state(查转换表,可能抛)
 * 4. Fingerprint 变化检测:如果 event.fingerprint 与冻结值不同 → RECOVERY_REQUIRED
 * 5. agent.spawn.started 时把 fingerprint 写入 registry(冻结)
 *
 * 副作用:FingerprintRegistry.freeze。只发生在 step 5 成功通过 step 3 之后。
 */
export function reduce(
  state: TaskState | null,
  event: TaskEvent,
  context: ReduceContext,
): TaskState {
  // Step 1:初始 state
  if (state === null) {
    if (event.type === "task.created") {
      return "PLANNED";
    }
    throw new InvalidTransitionError(
      null,
      event.type,
      `first event must be "task.created", got "${event.type}"`,
    );
  }

  // Step 2:Terminal state 拒绝所有事件
  if (isTerminal(state)) {
    throw new InvalidTransitionError(
      state,
      event.type,
      `state "${state}" is terminal and rejects all events`,
    );
  }

  // Step 3:查表得 next state(可能抛)
  const next = nextState(state, event.type);

  // Step 4:fingerprint 变化检测(覆盖 step 3 的结果)
  if (event.fingerprint !== undefined) {
    const frozen = context.fingerprintRegistry.get(event.taskId);
    if (frozen !== undefined) {
      if (
        fingerprintHash(frozen) !== fingerprintHash(event.fingerprint)
      ) {
        return "RECOVERY_REQUIRED";
      }
    }
  }

  // Step 5:在 agent.spawn.started 冻结 fingerprint
  if (
    event.type === "agent.spawn.started" &&
    event.fingerprint !== undefined
  ) {
    context.fingerprintRegistry.freeze(event.taskId, event.fingerprint);
  }

  return next;
}

/**
 * 便利函数:把一段事件 + 初始 state 跑完,得到最终 state 和冻结的指纹集合。
 * 主要给测试和将来的 recovery 流程用。
 *
 * 调用方传一个全新的 FingerprintRegistry(避免 test 之间串)。
 */
export function reduceAll(
  events: readonly TaskEvent[],
  context: ReduceContext,
): { state: TaskState | null; applied: number } {
  let state: TaskState | null = null;
  let applied = 0;
  for (const event of events) {
    state = reduce(state, event, context);
    applied++;
  }
  return { state, applied };
}

/**
 * 诊断用:列出在 reducer 里会触发 fingerprint 比对的事件类型。
 * 真正的 fingerprint 字段是 optional,调用方决定哪些事件需要带。
 */
export function fingerprintAwareEventTypes(): ReadonlySet<string> {
  return FINGERPRINT_TRANSITION_EVENTS;
}
