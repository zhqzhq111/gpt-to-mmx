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
  type StreamJsonEvent,
} from "./stream-json-parser.js";
import {
  StreamJsonDecoder,
} from "./stream-json-decoder.js";
import { sha256 } from "../../protocol/hash.js";
import {
  buildRuntimeIdentity,
  type RuntimeIdentity,
} from "../../runtime/identity.js";
import {
  WORKER_SUMMARY_SCHEMA,
  WORKER_SUMMARY_SCHEMA_HASH,
} from "../../runtime/worker-summary.js";

interface MCodeExecutionState {
  readonly executionId: ExecutionId;
  readonly maxWorkerStdoutBytes: number;
  readonly maxStreamJsonLineBytes: number;
  readonly maxWorkerEvents: number;
  readonly process: ManagedProcess;
  readonly events: StreamJsonEvent[];
  readonly completionPromise: Promise<void>;
  readonly resolveCompletion: () => void;
  readonly processOutcomePromise: Promise<ProcessOutcome>;
  cancelRequested: boolean;
  terminalError?: AdapterError;
}

const WATCHDOG_GRACE_MS = 1_000;
const DEFAULT_WORKER_STDOUT_BYTES = 33_554_432;
const DEFAULT_STREAM_JSON_LINE_BYTES = 4_194_304;
const DEFAULT_WORKER_EVENTS = 100_000;

export class MCodeAdapter implements CodingWorkerAdapter {
  private readonly policy: LocalPermissionPolicy;
  private readonly processSupervisor: ProcessSupervisor;
  private readonly executions = new Map<ExecutionId, MCodeExecutionState>();
  private cachedDescriptor: MCodeLaunchDescriptor | null = null;

  constructor(options: {
    readonly policy?: LocalPermissionPolicy;
    readonly processSupervisor?: ProcessSupervisor;
    readonly model?: string;
    readonly maxProbeOutputBytes?: number;
    readonly maxWorkerStdoutBytes?: number;
    readonly maxStreamJsonLineBytes?: number;
    readonly maxWorkerEvents?: number;
  } = {}) {
    this.policy = options.policy ?? new LocalPermissionPolicy();
    this.processSupervisor = options.processSupervisor ?? new ProcessSupervisor();
    this.model = options.model;
    this.maxProbeOutputBytes = options.maxProbeOutputBytes;
    this.maxWorkerStdoutBytes = options.maxWorkerStdoutBytes;
    this.maxStreamJsonLineBytes = options.maxStreamJsonLineBytes;
    this.maxWorkerEvents = options.maxWorkerEvents;
  }

  private readonly model: string | undefined;
  private readonly maxProbeOutputBytes: number | undefined;
  private readonly maxWorkerStdoutBytes: number | undefined;
  private readonly maxStreamJsonLineBytes: number | undefined;
  private readonly maxWorkerEvents: number | undefined;

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
        outputSchema: d.outputSchemaSupported,
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

  async getRuntimeIdentity(capabilitySnapshotHash: string): Promise<RuntimeIdentity> {
    return buildRuntimeIdentity({
      descriptor: await this.getDescriptor(),
      capabilitySnapshotHash,
      workerSummarySchemaHash: WORKER_SUMMARY_SCHEMA_HASH,
      ...(this.model !== undefined ? { model: this.model } : {}),
    });
  }

  async revalidateRuntimeIdentity(expected: RuntimeIdentity): Promise<void> {
    const descriptor = await resolveMCode({
      explicitPath: expected.resolved_executable_path,
      preserveResolvedVia: expected.resolved_via,
      ...(this.maxProbeOutputBytes !== undefined
        ? { maxProbeOutputBytes: this.maxProbeOutputBytes }
        : {}),
      processSupervisor: this.processSupervisor,
    });
    const current = buildRuntimeIdentity({
      descriptor,
      capabilitySnapshotHash: expected.capability_snapshot_hash,
      workerSummarySchemaHash: expected.worker_summary_schema_hash,
      ...(this.model !== undefined ? { model: this.model } : {}),
    });
    if (current.identity_hash !== expected.identity_hash) {
      throw new AdapterError(
        "RUNTIME_DRIFT",
        `mcode runtime identity changed before spawn (expected ${expected.identity_hash}, got ${current.identity_hash})`,
      );
    }
  }

  async start(invocation: WorkerInvocation): Promise<void> {
    const id = invocation.executionId;
    if (this.executions.has(id)) {
      throw new AdapterError("FAILED", `executionId ${id} already started`, {
        executionId: id,
      });
    }

    const descriptor = await this.getDescriptor();
    if (invocation.expectedRuntimeIdentityHash !== undefined) {
      const snapshot = await this.probe();
      const expected = await this.getRuntimeIdentity(sha256(snapshot));
      if (expected.identity_hash !== invocation.expectedRuntimeIdentityHash) {
        throw new AdapterError(
          "RUNTIME_DRIFT",
          `mcode runtime identity binding does not match the execution fingerprint`,
          { executionId: id },
        );
      }
      await this.revalidateRuntimeIdentity(expected);
    }
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
      outputSchema: WORKER_SUMMARY_SCHEMA,
      ...(this.model !== undefined ? { model: this.model } : {}),
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
      executionId: id,
      maxWorkerStdoutBytes: this.maxWorkerStdoutBytes ?? DEFAULT_WORKER_STDOUT_BYTES,
      maxStreamJsonLineBytes: this.maxStreamJsonLineBytes ?? DEFAULT_STREAM_JSON_LINE_BYTES,
      maxWorkerEvents: this.maxWorkerEvents ?? DEFAULT_WORKER_EVENTS,
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
    let outcome;
    try {
      outcome = normalizeWorkerEvents(state.events, { strictSummary: true });
    } catch (error) {
      if (error instanceof Error && error.name === "WorkerSummaryValidationError") {
        throw new AdapterError(
          "UNKNOWN",
          `worker summary protocol failed: ${error.message}`,
          { executionId, cause: error },
        );
      }
      throw error;
    }
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
    const d = await resolveMCode({
      ...(this.maxProbeOutputBytes !== undefined
        ? { maxProbeOutputBytes: this.maxProbeOutputBytes }
        : {}),
      processSupervisor: this.processSupervisor,
    });
    this.cachedDescriptor = d;
    return d;
  }
}

function attachOutput(state: MCodeExecutionState): void {
  const decoder = new StreamJsonDecoder({
    maxLineBytes: state.maxStreamJsonLineBytes,
    maxTotalBytes: state.maxWorkerStdoutBytes,
    maxEvents: state.maxWorkerEvents,
  });
  const protocolFailure = (error: unknown): void => {
    if (state.terminalError === undefined) {
      const detail = error instanceof Error ? error.message : String(error);
      state.terminalError = new AdapterError(
        "UNKNOWN",
        `worker stream-json protocol failed: ${detail}`,
        { executionId: state.executionId, cause: error },
      );
      state.resolveCompletion();
    }
    void state.process.terminate("cleanup");
  };
  state.process.stdout?.on("data", (chunk: Buffer | string) => {
    try {
      for (const event of decoder.push(chunk)) recordEvent(state, event);
    } catch (error) {
      protocolFailure(error);
    }
  });
  state.process.stderr?.on("data", () => undefined);
  void state.processOutcomePromise.then(() => {
    if (state.terminalError !== undefined) return;
    try {
      for (const event of decoder.finish()) recordEvent(state, event);
    } catch (error) {
      protocolFailure(error);
    }
  });
}

function recordEvent(state: MCodeExecutionState, event: StreamJsonEvent): void {
  state.events.push(event);
  if (event.type === "exec.completed") state.resolveCompletion();
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
