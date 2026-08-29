/**
 * FakeMCodeAdapter — plan 第 64 节 Phase 3 "Fake MCode"。
 *
 * 在不花 MiniMax 额度的情况下,允许 G2M Core 跑通 Runtime:
 * - Success             ✅
 * - Failure             ✅
 * - Timeout             ✅
 * - Malformed JSON      ✅ (语义:worker 退出但 output 解析失败 → UNKNOWN)
 * - No final result     ✅
 * - Process crash       ✅ (语义:进程消失但 workspace 状态可能不一致 → UNKNOWN)
 *
 * 暂不实装(留给 Phase 4 MCode 实装时再补):
 * - Partial stream-json (需要真 mcode stream-json parser,纯 Fake 模拟意义有限)
 * - Hangs               (真 mcode 才会真挂,Fake 用 noResult 间接覆盖)
 * - Writes files / Writes unexpected files (需要真实 fs 注入,留给 Phase 5 验证)
 */

import {
  AdapterError,
  type CodingWorkerAdapter,
  type RuntimeCapabilitySnapshot,
  type WorkerInvocation,
  type WorkerResult,
  type WorkerPrompt,
  type ExecutionId,
} from "../coding-worker.js";

/**
 * Fake 模拟的 Worker 行为枚举。映射到 AdapterError code 或 WorkerResult。
 * 命名跟 plan §64 列表对齐,部分不在 AdapterError 范围内的用 UNKNOWN 表示
 * "G2M 不知道 Worker 真实状态"(plan §51 Recovery Resolver Verdict 语义)。
 */
export type FakeBehavior =
  | "success"            // 正常完成
  | "failure"            // Worker 报告失败 → AdapterError FAILED
  | "timeout"            // 超过 limits.timeoutMs → AdapterError TIMED_OUT
  | "noResult"           // 进程结束但没 produce result → AdapterError UNKNOWN
  | "processCrash"       // 进程消失 → AdapterError UNKNOWN(plan §51)
  | "malformedJson";     // output 不可解析 → AdapterError UNKNOWN

export type FakeBehaviorResolver =
  | FakeBehavior
  | ((invocation: WorkerInvocation) => FakeBehavior | Promise<FakeBehavior>);

export interface FakeMCodeOptions {
  /**
   * 给所有 invocation 一个固定 behavior,或按 invocation 动态决定。
   * 默认 "success"(保持 Round 1 的行为兼容)。
   */
  readonly behavior?: FakeBehaviorResolver;
}

interface FakeExecution {
  readonly id: ExecutionId;
  readonly invocation: WorkerInvocation;
  readonly behavior: FakeBehavior;
  readonly startedAt: number;
  status: "running" | "succeeded" | "failed";
  result?: WorkerResult;
}

/**
 * plan §21 Runtime Capability Snapshot — Fake 把所有 locallyVerified 标 true,
 * 但 runtime = "fake" 提醒 G2M Core 这只是 dev harness,不是真 mcode。
 */
const FAKE_SNAPSHOT: RuntimeCapabilitySnapshot = {
  runtime: "fake",
  available: true,
  version: "fake-0.2.0",
  documentedCapabilities: {
    headlessExec: true,
    jsonOutput: true,
    streamJson: true,
    outputSchema: true,
    sessions: true,
    timeout: true,
    maxSteps: true,
    acp: false,
  },
  locallyVerified: {
    jsonContract: true,
    streamJsonContract: true,
    sessionIdExtraction: true,
    permissionMapping: true,
    timeoutBehavior: true,
  },
};

export class FakeMCodeAdapter implements CodingWorkerAdapter {
  private readonly executions = new Map<ExecutionId, FakeExecution>();
  private readonly behaviorResolver: FakeBehaviorResolver;

  constructor(options: FakeMCodeOptions = {}) {
    this.behaviorResolver = options.behavior ?? "success";
  }

  probe(): Promise<RuntimeCapabilitySnapshot> {
    return Promise.resolve(FAKE_SNAPSHOT);
  }

  async start(invocation: WorkerInvocation): Promise<void> {
    const id = invocation.executionId;
    if (this.executions.has(id)) {
      throw new AdapterError("FAILED", `executionId ${id} already started`, {
        executionId: id,
      });
    }
    const behavior = await this.resolveBehavior(invocation);
    this.executions.set(id, {
      id,
      invocation,
      behavior,
      startedAt: Date.now(),
      status: "running",
    });
  }

  cancel(executionId: ExecutionId): Promise<void> {
    const exec = this.executions.get(executionId);
    if (!exec) {
      return Promise.reject(
        new AdapterError(
          "UNKNOWN",
          `cannot cancel unknown executionId ${executionId}`,
          { executionId },
        ),
      );
    }
    if (exec.status === "running") {
      exec.status = "failed";
    }
    return Promise.resolve();
  }

  collectResult(executionId: ExecutionId): Promise<WorkerResult> {
    const exec = this.executions.get(executionId);
    if (!exec) {
      return Promise.reject(
        new AdapterError(
          "UNKNOWN",
          `no execution found for ${executionId}`,
          { executionId },
        ),
      );
    }
    if (exec.result) {
      return Promise.resolve(exec.result);
    }

    switch (exec.behavior) {
      case "success":
        return this.completeSuccess(exec);
      case "failure":
        return Promise.reject(
          new AdapterError(
            "FAILED",
            `FakeMCodeAdapter: simulated worker failure for "${this.truncate(exec.invocation.prompt)}"`,
            { executionId },
          ),
        );
      case "timeout":
        return Promise.reject(
          new AdapterError(
            "TIMED_OUT",
            `FakeMCodeAdapter: simulated timeout (limit ${exec.invocation.limits.timeoutMs}ms exceeded)`,
            { executionId },
          ),
        );
      case "noResult":
        return Promise.reject(
          new AdapterError(
            "UNKNOWN",
            `FakeMCodeAdapter: worker exited without producing a result (plan §64 no final result)`,
            { executionId },
          ),
        );
      case "processCrash":
        return Promise.reject(
          new AdapterError(
            "UNKNOWN",
            `FakeMCodeAdapter: worker process crashed; workspace state may be inconsistent (plan §51)`,
            { executionId },
          ),
        );
      case "malformedJson":
        return Promise.reject(
          new AdapterError(
            "UNKNOWN",
            `FakeMCodeAdapter: worker output failed JSON parsing (plan §64 malformed JSON)`,
            { executionId },
          ),
        );
    }
  }

  resume(
    executionId: ExecutionId,
    verifiedSessionId: string,
    _prompt: WorkerPrompt,
  ): Promise<void> {
    return Promise.reject(
      new AdapterError(
        "NOT_IMPLEMENTED",
        `FakeMCodeAdapter.resume() not implemented (executionId=${executionId}, sessionId=${verifiedSessionId})`,
        { executionId },
      ),
    );
  }

  private completeSuccess(exec: FakeExecution): Promise<WorkerResult> {
    const result: WorkerResult = {
      executionId: exec.id,
      sessionId: `fake-session-${exec.id}`,
      summary: `FakeMCodeAdapter: simulated success for prompt "${this.truncate(exec.invocation.prompt)}"`,
      filesChanged: [],
      testsAttempted: [],
      remainingRisks: [],
    };
    exec.result = result;
    exec.status = "succeeded";
    return Promise.resolve(result);
  }

  private async resolveBehavior(invocation: WorkerInvocation): Promise<FakeBehavior> {
    if (typeof this.behaviorResolver === "function") {
      return await this.behaviorResolver(invocation);
    }
    return this.behaviorResolver;
  }

  private truncate(prompt: string): string {
    return prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
  }
}
