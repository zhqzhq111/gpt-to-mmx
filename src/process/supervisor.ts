import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";

import {
  createPlatformProcessController,
  type PlatformProcessController,
  type TerminationResult,
} from "./platform.js";

export interface ProcessSupervisorOptions {
  readonly gracefulTerminationMs?: number;
  readonly forceTerminationMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly platformController?: PlatformProcessController;
}

export interface ProcessSpec {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string | Buffer;
  readonly timeoutMs?: number;
  readonly windowsHide?: boolean;
}

export type ProcessOutcome =
  | { readonly kind: "exited"; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: "timed_out"; readonly termination: TerminationResult }
  | { readonly kind: "spawn_error"; readonly error: Error }
  | { readonly kind: "termination_unconfirmed"; readonly reason: string; readonly termination: TerminationResult };

export interface ManagedProcess {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  wait(): Promise<ProcessOutcome>;
  terminate(reason: "cancel" | "timeout" | "result_complete" | "cleanup"): Promise<TerminationResult>;
  isRunning(): boolean;
}

const DEFAULT_GRACEFUL_TERMINATION_MS = 1_000;
const DEFAULT_FORCE_TERMINATION_MS = 2_000;

type TerminalCause = "timeout" | "cancel" | "result_complete" | "cleanup";

class ManagedProcessImpl implements ManagedProcess {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;

  private readonly child: ChildProcess | null;
  private readonly controller: PlatformProcessController;
  private readonly gracefulTerminationMs: number;
  private readonly forceTerminationMs: number;
  private readonly waitPromise: Promise<ProcessOutcome>;
  private resolveWait!: (outcome: ProcessOutcome) => void;
  private terminationPromise: Promise<TerminationResult> | undefined;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private waitSettled = false;
  private terminationConfirmed = false;
  private terminalCause: TerminalCause | undefined;

  constructor(
    child: ChildProcess | null,
    spawnError: Error | undefined,
    options: {
      readonly controller: PlatformProcessController;
      readonly gracefulTerminationMs: number;
      readonly forceTerminationMs: number;
      readonly timeoutMs?: number;
    },
  ) {
    this.child = child;
    this.controller = options.controller;
    this.gracefulTerminationMs = options.gracefulTerminationMs;
    this.forceTerminationMs = options.forceTerminationMs;
    this.pid = child?.pid;
    this.stdout = child?.stdout ?? null;
    this.stderr = child?.stderr ?? null;
    this.waitPromise = new Promise((resolve) => { this.resolveWait = resolve; });

    if (spawnError !== undefined) {
      this.closed = true;
      this.settleWait({ kind: "spawn_error", error: spawnError });
      return;
    }
    if (child === null) return;

    // Keep stderr flowing even when a caller intentionally ignores diagnostics.
    child.stderr?.on("data", () => undefined);
    child.once("error", (error) => this.onSpawnError(error));
    child.once("close", (code, signal) => this.onClose(code, signal));
    if (options.timeoutMs !== undefined) {
      this.timeoutTimer = setTimeout(() => { void this.onTimeout(); }, Math.max(0, options.timeoutMs));
    }
  }

  wait(): Promise<ProcessOutcome> {
    return this.waitPromise;
  }

  isRunning(): boolean {
    return !this.closed && !this.terminationConfirmed;
  }

  terminate(reason: TerminalCause): Promise<TerminationResult> {
    if (this.terminationPromise !== undefined) return this.terminationPromise;
    this.terminalCause = this.terminalCause ?? reason;
    this.terminationPromise = this.performTermination(reason).then((termination) => {
      if (termination.confirmedGone) this.terminationConfirmed = true;
      if (reason === "timeout" && !this.waitSettled) {
        this.settleWait(termination.confirmedGone
          ? { kind: "timed_out", termination }
          : {
              kind: "termination_unconfirmed",
              reason: "timeout termination could not be confirmed",
              termination,
            });
      }
      return termination;
    });
    return this.terminationPromise;
  }

  private async onTimeout(): Promise<void> {
    if (this.closed || this.terminalCause !== undefined) return;
    this.terminalCause = "timeout";
    await this.terminate("timeout");
  }

  private async performTermination(_reason: TerminalCause): Promise<TerminationResult> {
    if (this.closed || this.pid === undefined) {
      return {
        confirmedGone: true,
        gracefulAttempted: false,
        forcedAttempted: false,
        strategy: this.controller.strategy,
      };
    }
    try {
      const result = await this.controller.terminate(this.pid, {
        gracefulTerminationMs: this.gracefulTerminationMs,
        forceTerminationMs: this.forceTerminationMs,
      });
      return result;
    } catch (error) {
      return {
        confirmedGone: false,
        gracefulAttempted: true,
        forcedAttempted: true,
        strategy: this.controller.strategy,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private onSpawnError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimeout();
    this.settleWait({ kind: "spawn_error", error });
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimeout();
    if (this.terminalCause === "timeout") return;
    this.settleWait({ kind: "exited", exitCode: code, signal });
  }

  private settleWait(outcome: ProcessOutcome): void {
    if (this.waitSettled) return;
    this.waitSettled = true;
    this.resolveWait(outcome);
  }

  private clearTimeout(): void {
    if (this.timeoutTimer !== undefined) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }
}

export class ProcessSupervisor {
  private readonly gracefulTerminationMs: number;
  private readonly forceTerminationMs: number;
  private readonly controller: PlatformProcessController;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.gracefulTerminationMs = options.gracefulTerminationMs ?? DEFAULT_GRACEFUL_TERMINATION_MS;
    this.forceTerminationMs = options.forceTerminationMs ?? DEFAULT_FORCE_TERMINATION_MS;
    this.controller = options.platformController ?? (
      options.platform === undefined
        ? createPlatformProcessController()
        : createPlatformProcessController({ platform: options.platform })
    );
  }

  spawn(spec: ProcessSpec): ManagedProcess {
    try {
      const child = crossSpawn(spec.program, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        windowsHide: spec.windowsHide ?? true,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
      else child.stdin?.end();
      return new ManagedProcessImpl(child, undefined, {
        controller: this.controller,
        gracefulTerminationMs: this.gracefulTerminationMs,
        forceTerminationMs: this.forceTerminationMs,
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      });
    } catch (error) {
      return new ManagedProcessImpl(null, error instanceof Error ? error : new Error(String(error)), {
        controller: this.controller,
        gracefulTerminationMs: this.gracefulTerminationMs,
        forceTerminationMs: this.forceTerminationMs,
      });
    }
  }
}

export type { TerminationResult } from "./platform.js";
