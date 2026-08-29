/**
 * Coding Worker Adapter — G2M Core 跟具体 Coding Agent 之间的接口。
 *
 * 参考 plan 第 8 节「为什么仍然保留 Worker Adapter」、第 60 节目录结构
 * `src/workers/coding-worker.ts`、第 65 节 Phase 4 MCodeAdapter。
 *
 * 设计原则:
 * - 保持接口小而稳定(probe / start / cancel / collectResult / resume)
 * - 不暴露任何 plan 第 11 节禁止字段(command / shell / api_key / token / credential / mcode_executable / absolute_workspace_path)
 * - 不依赖具体 Coding Agent 实现(可能换成 OpenCode,见 plan 第 9 节)
 */

import type { PermissionPolicy, ExecutionLimits } from "./policy.js";

/**
 * Worker 一次完整执行的 id,由 Adapter 在 start() 时生成,G2M Core 在后续
 * callBack 用它关联。G2M 不该假设它的格式(可能是 UUID / ULID / 自定义),
 * 只把它当不透明字符串。
 */
export type ExecutionId = string;

/**
 * 计划 prompt,作为 data 不是 shell(plan 第 11 节、32 节)。
 * G2M Core 负责把它包装成结构化 Worker Prompt(plan 第 24 节),不直接传裸字符串。
 */
export type WorkerPrompt = string;

/**
 * 调用一个 Coding Agent 时必需的"已 resolved 信任路径"。
 * G2M 不接受 Plan 直接传 absolute path,必须由 Workspace Registry
 * 把 workspace_id 解析成 canonical path 后再传入(plan 第 13 节)。
 *
 * requestedCapabilities 跟 limits 一起,Adapter 用它们做 Local Policy 决策
 * (plan §12:Planner requests, G2M authorizes)。
 */
export interface WorkerInvocation {
  readonly executionId: ExecutionId;
  readonly prompt: WorkerPrompt;
  readonly workspacePath: string;
  readonly permissionPolicy: PermissionPolicy;
  readonly requestedCapabilities: {
    readonly read: boolean;
    readonly write: boolean;
    readonly test: boolean;
    readonly network: boolean;
  };
  readonly limits: ExecutionLimits;
  readonly sessionPolicy: SessionPolicy;
}

/**
 * 是否新建 session,或者 attach 到一个已验证存在的 session id。
 * 严格遵守 plan 第 23 节「MVP 不允许依赖 --continue」:没有 verified session_id
 * 之前 G2M 必须走 new session。
 */
export type SessionPolicy =
  | { readonly mode: "new" }
  | { readonly mode: "attach"; readonly verifiedSessionId: string };

/**
 * Worker 返回结构化结果(plan 第 25 节 Worker Summary + 第 26 节 Worker Evidence)。
 * 注意 plan 第 28 节:这是 Worker self-report,不能当作最终证据,必须经 G2M 独立 Verification。
 */
export interface WorkerResult {
  readonly executionId: ExecutionId;
  readonly sessionId?: string;
  readonly summary: string;
  readonly filesChanged: readonly string[];
  readonly testsAttempted: readonly TestAttempt[];
  readonly remainingRisks: readonly string[];
  readonly blockedReason?: string;
  readonly rawEventLogRef?: string;
}

export interface TestAttempt {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly message?: string;
}

/**
 * Runtime Probe Snapshot(plan 第 21 节 Runtime Capability Snapshot)。
 * 区分 Documented(官方文档承诺)跟 Locally Verified(本机实测),plan 第 21 节强制。
 */
export interface RuntimeCapabilitySnapshot {
  readonly runtime: "mcode" | "opencode" | "fake" | "unknown";
  readonly available: boolean;
  readonly version?: string;
  readonly documentedCapabilities: {
    readonly headlessExec: boolean;
    readonly jsonOutput: boolean;
    readonly streamJson: boolean;
    readonly outputSchema: boolean;
    readonly sessions: boolean;
    readonly timeout: boolean;
    readonly maxSteps: boolean;
    readonly acp: boolean;
  };
  readonly locallyVerified: {
    readonly jsonContract: boolean;
    readonly streamJsonContract: boolean;
    readonly sessionIdExtraction: boolean;
    readonly permissionMapping: boolean;
    readonly timeoutBehavior: boolean;
  };
}

/**
 * AdapterError — G2M Core 跟 Adapter 之间的错误传递通道(plan 第 50 节 Retry / 第 51 节 UNKNOWN)。
 * - RETRY:plan 第 50 节定义的"明确未进入 Agent Execution 的瞬时失败"
 * - FAILED:正常失败
 * - TIMED_OUT:超时(plan 第 39 节 mcode timeout + G2M watchdog)
 * - CANCELLED:被取消(plan 第 54 节)
 * - UNKNOWN:Recovery Resolver 临时裁定,evidence 不够判断真实执行结果(plan 第 51 节)
 * - NOT_IMPLEMENTED:Adapter stub 还没实装
 */
export type AdapterErrorCode =
  | "RETRY"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "UNKNOWN"
  | "NOT_IMPLEMENTED";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly executionId?: ExecutionId;
  override readonly cause?: unknown;

  constructor(
    code: AdapterErrorCode,
    message: string,
    opts: { executionId?: ExecutionId; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    if (opts.executionId !== undefined) {
      this.executionId = opts.executionId;
    }
    if (opts.cause !== undefined) {
      this.cause = opts.cause;
    }
  }
}

/**
 * CodingWorkerAdapter — G2M Core 调用 Coding Agent 的唯一接口。
 *
 * 接口保持很小即可(plan 第 8 节末):
 *   probe()                 — Runtime Probe,plan 第 20-21 节
 *   start()                 — 启动一次执行,非阻塞
 *   cancel()                — 取消执行,plan 第 54 节
 *   collectResult()         — 收集 Worker Result(可能跟 start 同步或异步)
 *   resume() (optional)     — 续上 verified session,plan 第 48 节
 */
export interface CodingWorkerAdapter {
  /**
   * Runtime Probe(plan 第 20 节)。在 start 之前必须先做,这是 G2M 跟具体
   * Worker 真实 Contract 对齐的唯一手段,也是 Permission Mapping 何时从
   * UNVERIFIED 变成 VERIFIED 的依据(plan 第 19 节)。
   */
  probe(): Promise<RuntimeCapabilitySnapshot>;

  /**
   * 启动一次执行。start 成功后 G2M Core 通过 collectResult() 拿结果。
   * Adapter 负责进程 lifecycle、timeout watchdog(plan 第 39 节)、
   * process tree 终止(plan 第 55 节)、stdout/stderr 分离(plan 第 37 节)。
   */
  start(invocation: WorkerInvocation): Promise<void>;

  /**
   * 取消执行。gracious interrupt + 超时后 kill 进程树(plan 第 54-55 节)。
   * 调用后必须仍然可以 collectResult() 拿到 CANCELLED 状态。
   */
  cancel(executionId: ExecutionId): Promise<void>;

  /**
   * 收集 Worker Result。Adapter 内部要把 stream-json parse 成 WorkerResult
   * (plan 第 38 节)。G2M Core 拿到后用真实 git diff 跟 Worker 自述对账
   * (plan 第 27-28 节)。
   */
  collectResult(executionId: ExecutionId): Promise<WorkerResult>;

  /**
   * 续上已 verified 的 session。plan 第 48 节:只有 Phase 0 证明 Session ID
   * 可靠获得后才允许使用,否则 REVISE 必须走新 session(plan 第 49 节)。
   * 所以这个方法对 MVP 可能是 throw not-implemented。
   */
  resume(
    executionId: ExecutionId,
    verifiedSessionId: string,
    prompt: WorkerPrompt,
  ): Promise<void>;
}
