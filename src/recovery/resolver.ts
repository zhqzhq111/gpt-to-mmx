/**
 * Recovery Resolver — plan §51
 *
 * 接到 G2M Core 崩溃后的状态切片(Event Log + 当前 State + 进程状态 +
 * Result + Diff + Fingerprint),返回两个 verdict 之一:
 *
 * - RECOVERY_RECONCILED  — 状态可以被安全确定,系统继续
 * - UNKNOWN              — 证据不足以判断真实执行结果(plan §51 example)
 *
 * UNKNOWN 不持久化(plan §51)。它只是 resolver 的裁定 — caller 拿到
 * UNKNOWN 之后必须把 task 转进 RECOVERY_REQUIRED,然后:
 *   - 禁止自动 Retry
 *   - 禁止自动 Resume
 *   - 禁止继续后续 Task
 * 这三条直接由 `safeToRetry` / `safeToResume` / `canAutoContinueNextTask`
 * 全部 = false 表达。
 *
 * 不修改 src/workers/mcode、src/evidence/verification、src/evidence/store、
 * src/review(本轮约束)。复用 events/replay 和 execution/state-machine 的现有
 * 状态机,只新增 recovery.required 事件类型 + transition。
 */

import { isTerminal, type TaskState } from "../execution/state-machine.js";
import { EventStore } from "../events/store.js";
import { FingerprintRegistry } from "../execution/fingerprint.js";
import { replay, ReplayError } from "../events/replay.js";
import type { TaskEvent } from "../events/events.js";
import type { WorkerResult } from "../workers/coding-worker.js";
import type { DiffResult } from "../evidence/diff.js";

/**
 * mcode 进程状态(由 process supervisor / recovery 触发器提供):
 * - alive        进程还在跑,不能动它,也不能判定
 * - exited_clean 进程正常退出(exit 0)
 * - exited_error 进程异常退出(非 0)
 * - crashed      进程被 kill / 系统崩溃 / 异常消失
 * - unknown      caller 不确定
 *
 * resolver 不区分 exited_clean / exited_error / crashed — 都属于"进程没了"。
 * alive 才单独处理。
 */
export type ProcessStatus =
  | "alive"
  | "exited_clean"
  | "exited_error"
  | "crashed"
  | "unknown";

export type RecoveryVerdict = "RECOVERY_RECONCILED" | "UNKNOWN";

export interface RecoveryInput {
  readonly currentState: TaskState | null;
  readonly events: readonly TaskEvent[];
  readonly processStatus: ProcessStatus;
  readonly workerResult: WorkerResult | null;
  readonly diff: DiffResult | null;
  readonly fingerprintMatch: boolean;
  readonly workspaceDirty: boolean;
}

export interface RecoveryResolution {
  readonly verdict: RecoveryVerdict;
  readonly reason: string;
  /**
   * 建议的下一步 task state。
   * - UNKNOWN → 总是 "RECOVERY_REQUIRED"(plan §51)
   * - RECOVERY_RECONCILED → 可能是 current state、replay state、COLLECTING_EVIDENCE
   *   等等(取决于证据)
   */
  readonly suggestedNextState: TaskState;
  /** 总是 false(plan §50:仅在明确"未进入 Agent Execution 的瞬时失败"才允许 retry) */
  readonly safeToRetry: boolean;
  /** 总是 false(plan §48:仅 verified session_id 才允许 resume) */
  readonly safeToResume: boolean;
  /**
   * 后续 task 能不能自动开始。
   * - UNKNOWN → false(plan §51:RECOVERY_REQUIRED 禁止继续后续 Task)
   * - RECOVERY_RECONCILED + 当前已经是 ACCEPTED / BLOCKED / FAILED 等终态 → true
   * - RECOVERY_RECONCILED + 当前在 RECOVERY_REQUIRED → false
   * - RECOVERY_RECONCILED + 当前是 active state(异常但能 reconcile)→ false
   */
  readonly canAutoContinueNextTask: boolean;
}

// 三条 "禁止" 由 plan §50 / §48 / §51 严格规定 — 全部 false。
const FORBIDDEN_RECOVERY_ACTIONS = {
  safeToRetry: false,
  safeToResume: false,
} as const;

function isTaskConclusive(state: TaskState): boolean {
  // 终态中只有 RECOVERY_REQUIRED 是"需要人工介入的停驻",其他都算"任务结束"
  return isTerminal(state) && state !== "RECOVERY_REQUIRED";
}

function makeUnknown(reason: string): RecoveryResolution {
  return {
    verdict: "UNKNOWN",
    reason,
    suggestedNextState: "RECOVERY_REQUIRED",
    ...FORBIDDEN_RECOVERY_ACTIONS,
    canAutoContinueNextTask: false,
  };
}

function makeReconciled(
  suggestedNextState: TaskState,
  reason: string,
): RecoveryResolution {
  return {
    verdict: "RECOVERY_RECONCILED",
    reason,
    suggestedNextState,
    ...FORBIDDEN_RECOVERY_ACTIONS,
    canAutoContinueNextTask: isTaskConclusive(suggestedNextState),
  };
}

/**
 * Recovery Resolver 主函数。
 *
 * 步骤(plan §51):
 * 1. 用 events + 一个 fresh FingerprintRegistry replay 一次 — 验证 hash chain
 *    完整性 + 拿到 replayedState。chain 断了或 transition 非法都直接 UNKNOWN。
 * 2. fingerprint 不匹配 → UNKNOWN(plan §51 / §53 — 环境可能变了)
 * 3. 进程还活着 → UNKNOWN(不能 kill,无法判定)
 * 4. currentState 已经是 terminal → RECOVERED(caller 给的状态是权威)
 * 5. replayedState 已经是 terminal → RECOVERED(事件链是权威)
 * 6. 完全没事件 → UNKNOWN
 * 7. 进程没了,中间分析:
 *    - 有 Final Result → RECOVERED at COLLECTING_EVIDENCE(post-result state)
 *    - 没 Result + 工作区 dirty → UNKNOWN(plan §51 example)
 *    - 没 Result + 工作区 clean → RECOVERED at replayedState(agent 没改文件)
 *
 * 纯函数(除了内部创建新 FingerprintRegistry,不影响外部状态)。
 * 不修改任何 input。
 */
export function resolveRecovery(input: RecoveryInput): RecoveryResolution {
  // Step 1:Replay 验证 hash chain + 算 replayedState
  let replayedState: TaskState | null = null;
  try {
    const reg = new FingerprintRegistry();
    const result = replay(input.events, { fingerprintRegistry: reg });
    replayedState = result.state;
  } catch (e) {
    if (e instanceof ReplayError) {
      return makeUnknown(`event chain broken: ${e.details}`);
    }
    return makeUnknown(
      `event replay failed: ${(e as Error).message ?? String(e)}`,
    );
  }

  // Step 2:Fingerprint 必须匹配
  if (!input.fingerprintMatch) {
    return makeUnknown(
      "fingerprint does not match expected (plan §51 / §53) — environment may have changed",
    );
  }

  // Step 3:进程还活着 → 不能 kill,无法判定
  if (input.processStatus === "alive") {
    return makeUnknown(
      "process is still alive; recovery must not kill or interrupt",
    );
  }

  // Step 4:currentState 已经是 terminal → RECOVERED
  if (input.currentState !== null && isTerminal(input.currentState)) {
    return makeReconciled(
      input.currentState,
      `current state "${input.currentState}" is already terminal`,
    );
  }

  // Step 5:replay 已经到 terminal → RECOVERED
  if (replayedState !== null && isTerminal(replayedState)) {
    return makeReconciled(
      replayedState,
      `event log replays to terminal state "${replayedState}"`,
    );
  }

  // Step 6:完全没事件
  if (input.events.length === 0) {
    return makeUnknown(
      "no events recorded; cannot determine execution state",
    );
  }

  // Step 7:进程没了 + mid-execution 分析
  const lastEvent = input.events[input.events.length - 1];
  const lastEventType = lastEvent?.type ?? "unknown";

  // 7a:有 Final Result → 推断 agent 已完成,advance 到 post-result state
  if (input.workerResult !== null) {
    return makeReconciled(
      "COLLECTING_EVIDENCE",
      `worker result present at last event "${lastEventType}"; advance to post-result state`,
    );
  }

  // 7b:没 Result + 工作区 dirty → UNKNOWN(plan §51 example)
  if (input.workspaceDirty) {
    return makeUnknown(
      `process gone at "${lastEventType}" with no Final Result and dirty workspace — cannot determine completion (plan §51)`,
    );
  }

  // 7c:没 Result + 工作区 clean → RECOVERED at replayedState
  // (agent 要么没跑,要么跑了但没改文件 — 都不会留下"半成品")
  return makeReconciled(
    replayedState ?? "PLANNED",
    `process gone at "${lastEventType}" with no result and clean workspace — agent did not modify files`,
  );
}

export interface AppendRecoveryContext {
  readonly taskId: string;
  readonly attemptId: string;
  readonly currentState: TaskState;
  readonly eventStore: EventStore;
}

/**
 * 应用 resolver 的判定到 EventStore。
 *
 * - UNKNOWN + current state 非 terminal:append `recovery.required` 事件,
 *   reducer 会把状态推到 RECOVERY_REQUIRED。
 * - UNKNOWN + current state 已经是 terminal:无法再转移,返回 null
 *   (caller 应该已经知道是终态,可能是嵌套的 UNKNOWN — 比如 RECOVERY_REQUIRED
 *   之后再调一次 resolver;此时 caller 应该 escalate 而不是再 append 事件)。
 * - RECOVERY_RECONCILED:状态已经一致,不需要 append 任何事件 — 返回 null。
 *   (caller 如果想 advance 到 suggestedNextState 比如 COLLECTING_EVIDENCE,
 *   需要自己 append 对应的事件 — 这部分是状态机自己的逻辑,不属于 recovery。)
 *
 * 不修改任何 input 中的 state,只 append 事件到 eventStore。
 */
export function appendRecoveryTransition(
  resolution: RecoveryResolution,
  context: AppendRecoveryContext,
): TaskEvent | null {
  if (resolution.verdict === "RECOVERY_RECONCILED") {
    return null;
  }
  // UNKNOWN 但当前是 terminal — 不能从终态再走一次
  if (isTerminal(context.currentState)) {
    return null;
  }
  return context.eventStore.append({
    taskId: context.taskId,
    attemptId: context.attemptId,
    type: "recovery.required",
    payload: { reason: resolution.reason },
  });
}
