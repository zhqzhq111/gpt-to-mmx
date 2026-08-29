/**
 * Event Replay — plan §52
 *
 * 从 append-only 事件流重建 task state。
 *
 * 关键约束(plan §52 + 用户要求 1):
 * - 物理顺序就是事件顺序,replay 禁止排序
 * - 输入 events 数组必须按 append 顺序传进来
 * - chain 验证失败抛 ReplayError,phase 9 的 recovery 会转 RECOVERY_REQUIRED
 *
 * Reducer 行为参见 ./reducer.ts。
 */

import type { TaskState } from "../execution/state-machine.js";
import { reduce, type ReduceContext } from "./reducer.js";
import { verifyChain, type EventStore } from "./store.js";
import type { TaskEvent } from "./events.js";

export class ReplayError extends Error {
  readonly code: "CHAIN_BROKEN" | "EMPTY_LOG";
  readonly details: string;
  constructor(code: ReplayError["code"], message: string, details: string) {
    super(`${message}: ${details}`);
    this.name = "ReplayError";
    this.code = code;
    this.details = details;
  }
}

export interface ReplayResult {
  /** 重建出的最终 state。空日志时为 null(任务还没创建事件)。 */
  readonly state: TaskState | null;
  /** 应用的事件数。 */
  readonly applied: number;
  /** Chain 是否完整。 */
  readonly chainValid: boolean;
}

/**
 * 便利函数:从 EventStore 直接 replay。
 * 内部会先 verifyChain 再 reduceAll。
 */
export function replayFromStore(
  store: EventStore,
  context: ReduceContext,
): ReplayResult {
  return replay(store.list(), context);
}

/**
 * 主 replay 入口。
 *
 * 步骤:
 * 1. verifyChain(events) — hash chain 必须完整,否则抛 ReplayError
 * 2. 严格按输入顺序 reduce 每个 event(不排序)
 * 3. 返回最终 state
 *
 * 空 events 数组返回 state = null(合法的"任务尚未产生事件"状态)。
 */
export function replay(
  events: readonly TaskEvent[],
  context: ReduceContext,
): ReplayResult {
  const chain = verifyChain(events);
  if (!chain.valid) {
    throw new ReplayError(
      "CHAIN_BROKEN",
      "event chain verification failed",
      `seq=${chain.brokenAtSeq} eventId=${chain.brokenAtEventId} reason=${chain.reason ?? "unknown"}`,
    );
  }

  let state: TaskState | null = null;
  let applied = 0;
  for (const event of events) {
    state = reduce(state, event, context);
    applied++;
  }
  return { state, applied, chainValid: true };
}
