/**
 * MCodeAdapter — plan §65 Phase 4 真实实现
 *
 * 拼装 Resolver(§33-35) + Permission Mapper(§18-19) + Argument Builder(§32)
 * + Process Supervisor(基础版,Phase 9 升级 watchdog + process tree) + stream-json Parser
 * + Result Normalizer。
 *
 * 这一轮做主流程:
 * - start: spawn mcode exec ... + 通过 stdin 发送 Prompt + 启动 stdout 收集
 * - cancel: kill 进程
 * - collectResult: 等进程退出 + normalize events → WorkerResult
 *
 * 仍延后到 Phase 9 Reliability(plan §39 + §55):
 * - 双层 timeout(mcode --timeout + G2M outer watchdog)
 * - 更完整的 process tree 状态机
 * - UNKNOWN Resolver 持久化恢复
 */

import { execFile, type ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import spawn from "cross-spawn";

import {
  AdapterError,
  type CodingWorkerAdapter,
  type ExecutionId,
  type RuntimeCapabilitySnapshot,
  type WorkerInvocation,
  type WorkerPrompt,
  type WorkerResult,
} from "../coding-worker.js";
import {
  resolveMCode,
  type MCodeLaunchDescriptor,
  type MCodeLaunchKind,
} from "./resolver.js";
import { buildMCodeInvocation } from "./invocation.js";
import { LocalPermissionPolicy } from "./permission-mapper.js";
import {
  parseStreamJson,
  parseStreamJsonLine,
  type StreamJsonEvent,
} from "./stream-json-parser.js";

interface MCodeExecutionState {
  readonly invocation: WorkerInvocation;
  readonly process: ChildProcess;
  readonly events: StreamJsonEvent[];
  sessionId?: string;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  completionPromise: Promise<void>;
  resolveCompletion: () => void;
  watchdog?: NodeJS.Timeout;
  terminalError?: AdapterError;
}

const BUFFER_FLUSH_INTERVAL_MS = 5_000;
const WATCHDOG_GRACE_MS = 1_000;

export class MCodeAdapter implements CodingWorkerAdapter {
  private readonly policy: LocalPermissionPolicy;
  private readonly executions = new Map<ExecutionId, MCodeExecutionState>();
  private cachedDescriptor: MCodeLaunchDescriptor | null = null;

  constructor(options: { policy?: LocalPermissionPolicy } = {}) {
    this.policy = options.policy ?? new LocalPermissionPolicy();
  }

  async probe(): Promise<RuntimeCapabilitySnapshot> {
    const d = await this.getDescriptor();
    return {
      runtime: "mcode",
      available: true,
      version: d.version,
      documentedCapabilities: {
        headlessExec: true,
        jsonOutput: true,
        streamJson: true,
        outputSchema: true,
        sessions: true,
        timeout: true,
        maxSteps: true,
        acp: true, // plan §4 mcode acp 存在
      },
      // Phase 0 已用真实 mcode exec 验证 JSON、stream-json、sessionId，
      // 以及 smart/full/off 均可在 headless 模式修改隔离夹具。G2M 因而
      // 不把任一原生 permission 当作 read-only 边界，而是在 Engine 层
      // 对未授权 diff 做独立拒绝。真实 mcode 内部 timeout 仍待单独验证。
      locallyVerified: {
        jsonContract: true,
        streamJsonContract: true,
        sessionIdExtraction: true,
        permissionMapping: true,
        timeoutBehavior: false,
      },
      // launch-specific 字段也带过去,后续 Worker 可以用
      // (虽然 RuntimeCapabilitySnapshot 接口没这字段,扩展再说)
      ...({
        launchKind: d.kind,
        launchPath: d.executablePath,
        launchResolvedVia: d.resolvedVia,
      } as Record<string, unknown>),
    };
  }

  async start(invocation: WorkerInvocation): Promise<void> {
    const id = invocation.executionId;
    if (this.executions.has(id)) {
      throw new AdapterError("FAILED", `executionId ${id} already started`, {
        executionId: id,
      });
    }

    const descriptor = await this.getDescriptor();
    const effective = this.policy.decide(
      invocation.permissionPolicy,
      invocation.requestedCapabilities,
      invocation.limits,
    );

    const argv = buildMCodeInvocation(descriptor.executablePath, {
      workspacePath: resolvePath(invocation.workspacePath),
      prompt: invocation.prompt,
      permissionPolicy: effective.mcodePermission,
      timeoutMs: effective.effectiveTimeoutMs,
      maxSteps: effective.effectiveMaxSteps,
      outputFormat: "stream-json",
    });

    // cross-spawn 负责 Windows .cmd shim 的 argv 转义，避免 Node
    // shell=true 的未转义参数拼接。Prompt 仍只通过 --input - / stdin
    // 传输。exec.completed 到达后先收集结果，再清理残留 cmd.exe 子树。
    const child: ChildProcess = spawn(argv.program, [...argv.args], {
      cwd: invocation.workspacePath,
      windowsHide: true,
    });

    const events: StreamJsonEvent[] = [];
    let resolveCompletion!: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      // 用 close 而不是 exit：需要等 stdio 完全关闭后再判断结果。
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    const state: MCodeExecutionState = {
      invocation,
      process: child,
      events,
      exitPromise,
      completionPromise,
      resolveCompletion,
      exitInfo: null,
    };
    this.executions.set(id, state);
    state.watchdog = setTimeout(() => {
      if (state.terminalError !== undefined || state.exitInfo !== null) return;
      state.terminalError = new AdapterError(
        "TIMED_OUT",
        `G2M outer watchdog exceeded ${effective.effectiveTimeoutMs}ms (executionId=${id})`,
        { executionId: id },
      );
      state.resolveCompletion();
      void terminateChildProcess(state.process);
    }, effective.effectiveTimeoutMs + WATCHDOG_GRACE_MS);

    // Line-buffered stdout collector
    let buf = "";
    let lastFlush = Date.now();
    const flushTimer = setInterval(() => {
      if (buf.length > 0 && Date.now() - lastFlush > BUFFER_FLUSH_INTERVAL_MS) {
        // 强制 flush 残余 buf(plan §38 partial stream-json 处理)
        for (const ev of safeParseLines(buf)) {
          recordEvent(state, ev);
        }
        buf = "";
        lastFlush = Date.now();
      }
    }, BUFFER_FLUSH_INTERVAL_MS);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      lastFlush = Date.now();
      for (const line of lines) {
        for (const ev of safeParseLines(line)) {
          recordEvent(state, ev);
        }
      }
    });

    child.stderr?.on("data", () => {
      // 这一轮不解析 stderr,只忽略(plan §37 严格要求 stdout/stderr 分离)
      // Phase 9 Reliability 会做 stderr diagnostics collector
    });

    // Prompt travels through mcode's --input - channel, never through the
    // Windows shell command line. Closing stdin is required for mcode exec to
    // know that the prompt is complete.
    child.stdin?.end(argv.stdin, "utf8");

    child.on("close", (code, signal) => {
      clearInterval(flushTimer);
      if (state.watchdog !== undefined) clearTimeout(state.watchdog);
      // 进程退出时 flush 残余 buf
      if (buf.length > 0) {
        for (const ev of safeParseLines(buf)) {
          recordEvent(state, ev);
        }
        buf = "";
      }
      state.exitInfo = { code, signal };
      state.resolveCompletion();
    });
  }

  async cancel(executionId: ExecutionId): Promise<void> {
    const state = this.executions.get(executionId);
    if (!state) {
      throw new AdapterError(
        "UNKNOWN",
        `cannot cancel unknown executionId ${executionId}`,
        { executionId },
      );
    }
    if (state.terminalError === undefined) {
      state.terminalError = new AdapterError(
        "CANCELLED",
        `execution ${executionId} was cancelled by G2M`,
        { executionId },
      );
    }
    if (state.watchdog !== undefined) clearTimeout(state.watchdog);
    state.resolveCompletion();
    await terminateChildProcess(state.process);
  }

  async collectResult(
    executionId: ExecutionId,
  ): Promise<WorkerResult> {
    const state = this.executions.get(executionId);
    if (!state) {
      throw new AdapterError(
        "UNKNOWN",
        `no execution found for ${executionId}`,
        { executionId },
      );
    }

    await withTimeout(
      Promise.race([state.exitPromise, state.completionPromise]),
      Math.max(state.invocation.limits.timeoutMs + WATCHDOG_GRACE_MS + 5_000, 10_000),
      executionId,
    );

    if (state.terminalError !== undefined) throw state.terminalError;

    // mcode.cmd can leave cmd.exe alive after exec.completed has arrived.
    // Reconcile from the durable result event first, then clean up only this
    // launcher process tree so G2M does not leak a worker.
    if (state.process.exitCode === null && state.process.pid !== undefined) {
      await terminateProcessTree(state.process.pid);
    }

    const exit = state.exitInfo ?? { code: null, signal: null };

    const { normalizeWorkerEvents } = await import("./result-normalizer.js");
    const outcome = normalizeWorkerEvents(state.events);

    if (
      outcome.workerStatus !== undefined &&
      outcome.workerStatus !== "succeeded"
    ) {
      const code = /timeout|limit/i.test(outcome.workerStatus)
        ? "TIMED_OUT"
        : "FAILED";
      throw new AdapterError(
        code,
        `mcode completed with status ${outcome.workerStatus}`,
        { executionId },
      );
    }

    if (outcome.result) {
      return {
        ...outcome.result,
        executionId,
        ...(outcome.sessionId !== undefined
          ? { sessionId: outcome.sessionId }
          : state.sessionId !== undefined
          ? { sessionId: state.sessionId }
          : {}),
      };
    }

    if (exit.code !== 0) {
      throw new AdapterError(
        "FAILED",
        `mcode exited with code ${exit.code} (signal=${exit.signal}) without producing result event`,
        { executionId },
      );
    }
    throw new AdapterError(
      "UNKNOWN",
      `mcode exited cleanly but no result event in stream-json output (${state.events.length} events seen)`,
      { executionId },
    );
  }

  async resume(
    executionId: ExecutionId,
    verifiedSessionId: string,
    _prompt: WorkerPrompt,
  ): Promise<void> {
    const state = this.executions.get(executionId);
    if (!state) {
      throw new AdapterError(
        "NOT_IMPLEMENTED",
        `cannot resume unknown executionId ${executionId} (sessionId=${verifiedSessionId})`,
        { executionId },
      );
    }
    // 真实 resume 需要 spawn 同一 session,Phase 4 MVP 不实装(plan §48)
    throw new AdapterError(
      "NOT_IMPLEMENTED",
      `MCodeAdapter.resume() not implemented in MVP (plan §48); sessionId=${verifiedSessionId}`,
      { executionId },
    );
  }

  private async getDescriptor(): Promise<MCodeLaunchDescriptor> {
    if (this.cachedDescriptor) return this.cachedDescriptor;
    const d = await resolveMCode();
    this.cachedDescriptor = d;
    return d;
  }
}

function recordEvent(
  state: MCodeExecutionState,
  ev: StreamJsonEvent,
): void {
  state.events.push(ev);
  const raw = ev as unknown as Record<string, unknown>;
  const sid = raw["sessionId"];
  if (typeof sid === "string" && sid.length > 0) {
    state.sessionId = sid;
  } else if (ev.type === "system") {
    const legacySid = ev.session_id;
    if (typeof legacySid === "string" && legacySid.length > 0) {
      state.sessionId = legacySid;
    }
  }
  if (ev.type === "exec.completed") {
    if (state.watchdog !== undefined) clearTimeout(state.watchdog);
    state.resolveCompletion();
  }
}

function safeParseLines(line: string): StreamJsonEvent[] {
  if (line.trim().length === 0) return [];
  try {
    return [parseStreamJsonLine(line)];
  } catch {
    return [];
  }
}

function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((resolve) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true },
      () => resolve(),
    );
  });
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    await terminateProcessTree(child.pid);
    return;
  }
  child.kill("SIGTERM");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  executionId: ExecutionId,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new AdapterError(
          "TIMED_OUT",
          `collectResult timed out after ${timeoutMs}ms (executionId=${executionId})`,
          { executionId },
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// re-export MCodeLaunchKind for consumers that want to read descriptor type
export type { MCodeLaunchKind } from "./resolver.js";
