/**
 * MCodeAdapter — protocol adapter for the mcode stream-json worker.
 *
 * ProcessSupervisor owns the operating-system process lifecycle. This adapter
 * only builds the invocation, parses stream-json, and maps logical worker
 * results to the stable CodingWorkerAdapter contract.
 */

import { resolve as resolvePath } from "node:path";

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
  ProcessSupervisor,
  type ManagedProcess,
  type ProcessOutcome,
} from "../../process/supervisor.js";
import {
  resolveMCode,
  type MCodeLaunchDescriptor,
  type MCodeLaunchKind,
} from "./resolver.js";
import { buildMCodeInvocation } from "./invocation.js";
import { LocalPermissionPolicy } from "./permission-mapper.js";
import {
  parseStreamJsonLine,
  type StreamJsonEvent,
} from "./stream-json-parser.js";

interface MCodeExecutionState {
  readonly process: ManagedProcess;
  readonly events: StreamJsonEvent[];
  readonly completionPromise: Promise<void>;
  readonly resolveCompletion: () => void;
  readonly processOutcomePromise: Promise<ProcessOutcome>;
  cancelRequested: boolean;
  terminalError?: AdapterError;
}

const BUFFER_FLUSH_INTERVAL_MS = 5_000;
const WATCHDOG_GRACE_MS = 1_000;

export class MCodeAdapter implements CodingWorkerAdapter {
  private readonly policy: LocalPermissionPolicy;
  private readonly processSupervisor: ProcessSupervisor;
  private readonly executions = new Map<ExecutionId, MCodeExecutionState>();
  private cachedDescriptor: MCodeLaunchDescriptor | null = null;

  constructor(options: {
    readonly policy?: LocalPermissionPolicy;
    readonly processSupervisor?: ProcessSupervisor;
  } = {}) {
    this.policy = options.policy ?? new LocalPermissionPolicy();
    this.processSupervisor = options.processSupervisor ?? new ProcessSupervisor();
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
        acp: true,
      },
      locallyVerified: {
        jsonContract: true,
        streamJsonContract: true,
        sessionIdExtraction: true,
        permissionMapping: true,
        timeoutBehavior: false,
      },
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

    const managed = this.processSupervisor.spawn({
      program: argv.program,
      args: argv.args,
      cwd: invocation.workspacePath,
      stdin: argv.stdin,
      timeoutMs: effective.effectiveTimeoutMs + WATCHDOG_GRACE_MS,
      windowsHide: true,
    });

    let resolveCompletion!: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const state: MCodeExecutionState = {
      process: managed,
      events: [],
      completionPromise,
      resolveCompletion,
      processOutcomePromise: managed.wait(),
      cancelRequested: false,
    };
    this.executions.set(id, state);
    attachOutput(state);
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
    if (!state.process.isRunning()) return;

    state.cancelRequested = true;
    const termination = await state.process.terminate("cancel");
    if (!termination.confirmedGone) {
      state.terminalError = new AdapterError(
        "UNKNOWN",
        `cannot confirm cancellation of execution ${executionId}`,
        { executionId },
      );
      state.resolveCompletion();
      throw state.terminalError;
    }
    state.resolveCompletion();
  }

  async collectResult(executionId: ExecutionId): Promise<WorkerResult> {
    const state = this.executions.get(executionId);
    if (!state) {
      throw new AdapterError(
        "UNKNOWN",
        `no execution found for ${executionId}`,
        { executionId },
      );
    }

    const first = await Promise.race([
      state.completionPromise.then(() => ({ kind: "logical" as const })),
      state.processOutcomePromise.then((outcome) => ({ kind: "process" as const, outcome })),
    ]);

    if (state.terminalError !== undefined) throw state.terminalError;
    if (state.cancelRequested) {
      throw new AdapterError(
        "CANCELLED",
        `execution ${executionId} was cancelled by G2M`,
        { executionId },
      );
    }

    if (first.kind === "process") {
      throwForProcessOutcome(first.outcome, executionId);
    } else {
      const termination = await state.process.terminate("result_complete");
      if (!termination.confirmedGone) {
        throw new AdapterError(
          "UNKNOWN",
          `cannot confirm mcode launcher cleanup for ${executionId}`,
          { executionId },
        );
      }
    }

    const { normalizeWorkerEvents } = await import("./result-normalizer.js");
    const outcome = normalizeWorkerEvents(state.events);
    if (outcome.workerStatus !== undefined && outcome.workerStatus !== "succeeded") {
      const code = /timeout|limit/i.test(outcome.workerStatus) ? "TIMED_OUT" : "FAILED";
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
        ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
      };
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
    if (!this.executions.has(executionId)) {
      throw new AdapterError(
        "NOT_IMPLEMENTED",
        `cannot resume unknown executionId ${executionId} (sessionId=${verifiedSessionId})`,
        { executionId },
      );
    }
    throw new AdapterError(
      "NOT_IMPLEMENTED",
      `MCodeAdapter.resume() not implemented in MVP (sessionId=${verifiedSessionId})`,
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

function attachOutput(state: MCodeExecutionState): void {
  let buffer = "";
  const flush = (): void => {
    if (buffer.length === 0) return;
    for (const line of buffer.split(/\r?\n/)) {
      const event = safeParseLine(line);
      if (event !== undefined) recordEvent(state, event);
    }
    buffer = "";
  };
  const flushTimer = setInterval(flush, BUFFER_FLUSH_INTERVAL_MS);

  state.process.stdout?.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = safeParseLine(line);
      if (event !== undefined) recordEvent(state, event);
    }
  });
  state.process.stderr?.on("data", () => undefined);
  void state.processOutcomePromise.then(() => {
    clearInterval(flushTimer);
    flush();
  });
}

function recordEvent(state: MCodeExecutionState, event: StreamJsonEvent): void {
  state.events.push(event);
  if (event.type === "exec.completed") state.resolveCompletion();
}

function safeParseLine(line: string): StreamJsonEvent | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    return parseStreamJsonLine(line);
  } catch {
    return undefined;
  }
}

function throwForProcessOutcome(outcome: ProcessOutcome, executionId: ExecutionId): void {
  if (outcome.kind === "exited") {
    if (outcome.exitCode === 0) return;
    throw new AdapterError(
      "FAILED",
      `mcode exited with code ${outcome.exitCode} (signal=${outcome.signal}) without producing result event`,
      { executionId },
    );
  }
  if (outcome.kind === "spawn_error") {
    throw new AdapterError("FAILED", `mcode spawn failed: ${outcome.error.message}`, {
      executionId,
      cause: outcome.error,
    });
  }
  if (outcome.kind === "timed_out") {
    throw new AdapterError("TIMED_OUT", "mcode process timed out", { executionId });
  }
  throw new AdapterError(
    "UNKNOWN",
    `mcode process termination could not be confirmed: ${outcome.reason}`,
    { executionId },
  );
}

export type { MCodeLaunchKind } from "./resolver.js";
