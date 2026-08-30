/**
 * Independent Verification Runner.
 *
 * Verification commands use the same ProcessSupervisor as workers. The
 * runner owns output capture and result classification; the supervisor owns
 * process-tree termination and termination proof.
 */

import { sha256 } from "../protocol/hash.js";
import { BoundedOutput } from "../runtime/bounded-output.js";
import { resolveProgramIdentity, type ProgramIdentity } from "../runtime/program-identity.js";
import {
  ProcessSupervisor,
  type ProcessOutcome,
  type TerminationResult,
} from "../process/supervisor.js";
import type { VerificationProfile } from "../policy/verification.js";
import type { StorageCheckResult, StorageMonitor, StorageMonitorHandle } from "../storage/monitor.js";

export type VerificationStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "storage_limit_exceeded"
  | "termination_unconfirmed"
  | "spawn_error"
  | "runtime_drift"
  | "skipped";

export class VerificationError extends Error {
  readonly code: "PROFILE_REQUIRED" | "PROFILE_INVALID";
  constructor(code: VerificationError["code"], message: string) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
  }
}

export interface VerificationTermination {
  readonly confirmedGone: boolean;
  readonly gracefulAttempted: boolean;
  readonly forcedAttempted: boolean;
  readonly strategy: string;
}

export interface VerificationResult {
  readonly profileId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly status: VerificationStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  readonly durationMs: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly resultHash: string;
  readonly errorMessage?: string;
  readonly termination?: VerificationTermination;
}

export interface VerificationRunOptions {
  readonly processSupervisor?: ProcessSupervisor;
  readonly storageMonitor?: StorageMonitor;
  readonly storageArtifactPath?: string;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly expectedProgramIdentity?: ProgramIdentity;
}

function hashablePayload(r: VerificationResult): unknown {
  return {
    profileId: r.profileId,
    workspaceId: r.workspaceId,
    workspacePath: r.workspacePath,
    program: r.program,
    args: r.args,
    status: r.status,
    exitCode: r.exitCode,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
    ...(r.stdoutBytes !== undefined ? { stdoutBytes: r.stdoutBytes } : {}),
    ...(r.stderrBytes !== undefined ? { stderrBytes: r.stderrBytes } : {}),
    ...(r.stdoutTruncated !== undefined ? { stdoutTruncated: r.stdoutTruncated } : {}),
    ...(r.stderrTruncated !== undefined ? { stderrTruncated: r.stderrTruncated } : {}),
    errorMessage: r.errorMessage,
    ...(r.termination !== undefined
      ? {
          termination: {
            confirmedGone: r.termination.confirmedGone,
            strategy: r.termination.strategy,
          },
        }
      : {}),
  };
}

function computeResultHash(r: VerificationResult): string {
  return sha256(hashablePayload(r));
}

function withResultHash(
  partial: Omit<VerificationResult, "resultHash">,
): VerificationResult {
  return { ...partial, resultHash: computeResultHash({ ...partial, resultHash: "" }) };
}

function makeSkippedResult(
  workspaceId: string,
  workspacePath: string,
): VerificationResult {
  const now = Date.now();
  return withResultHash({
    profileId: "none",
    workspaceId,
    workspacePath,
    program: "",
    args: [],
    status: "skipped",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 0,
    startedAt: now,
    finishedAt: now,
  });
}

interface RunOutcome {
  readonly status: VerificationStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly errorMessage?: string;
  readonly termination?: VerificationTermination;
}

function terminationEvidence(
  termination: TerminationResult,
): VerificationTermination {
  return {
    confirmedGone: termination.confirmedGone,
    gracefulAttempted: termination.gracefulAttempted,
    forcedAttempted: termination.forcedAttempted,
    strategy: termination.strategy,
  };
}

function classifyProcessOutcome(
  profile: VerificationProfile,
  outcome: ProcessOutcome,
  stdout: string,
  stderr: string,
  stdoutOutput: BoundedOutput,
  stderrOutput: BoundedOutput,
): RunOutcome {
  const output = {
    stdout,
    stderr,
    stdoutBytes: stdoutOutput.totalBytes,
    stderrBytes: stderrOutput.totalBytes,
    stdoutTruncated: stdoutOutput.truncated,
    stderrTruncated: stderrOutput.truncated,
  };
  if (outcome.kind === "exited") {
    return {
      status: outcome.exitCode === 0 ? "passed" : "failed",
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      ...output,
    };
  }
  if (outcome.kind === "spawn_error") {
    return {
      status: "spawn_error",
      exitCode: null,
      signal: null,
      ...output,
      errorMessage: `program "${profile.program}" not found: ${outcome.error.message}`,
    };
  }
  if (outcome.kind === "timed_out") {
    return {
      status: "timed_out",
      exitCode: null,
      signal: null,
      ...output,
      errorMessage: `verification timed out after ${profile.timeoutMs}ms`,
      termination: terminationEvidence(outcome.termination),
    };
  }
  return {
    status: "termination_unconfirmed",
    exitCode: null,
    signal: null,
    ...output,
    errorMessage: `verification termination could not be confirmed: ${outcome.reason}`,
    termination: terminationEvidence(outcome.termination),
  };
}

async function runProfile(
  profile: VerificationProfile,
  workspaceId: string,
  workspacePath: string,
  options: VerificationRunOptions,
): Promise<VerificationResult> {
  const startedAt = Date.now();
  let program = profile.program;
  if (options.expectedProgramIdentity !== undefined) {
    try {
      const current = await resolveProgramIdentity(profile.program);
      if (
        current.resolved_program !== options.expectedProgramIdentity.resolved_program ||
        current.program_identity_hash !== options.expectedProgramIdentity.program_identity_hash ||
        current.program_bytes !== options.expectedProgramIdentity.program_bytes
      ) {
        return withResultHash({
          profileId: profile.id,
          workspaceId,
          workspacePath,
          program: options.expectedProgramIdentity.resolved_program,
          args: profile.args,
          status: "runtime_drift",
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: Date.now() - startedAt,
          startedAt,
          finishedAt: Date.now(),
          errorMessage: "verification executable identity changed before run",
        });
      }
      program = current.resolved_program;
    } catch (error) {
      return withResultHash({
        profileId: profile.id,
        workspaceId,
        workspacePath,
        program: options.expectedProgramIdentity.resolved_program,
        args: profile.args,
        status: "runtime_drift",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: Date.now() - startedAt,
        startedAt,
        finishedAt: Date.now(),
        errorMessage: `verification executable could not be revalidated: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const supervisor = options.processSupervisor ?? new ProcessSupervisor();
  const managed = supervisor.spawn({
    program,
    args: profile.args,
    cwd: workspacePath,
    env: profile.env !== undefined ? { ...process.env, ...profile.env } : process.env,
    timeoutMs: profile.timeoutMs,
    windowsHide: true,
  });
  const stdout = new BoundedOutput(options.maxStdoutBytes ?? 16_777_216);
  const stderr = new BoundedOutput(options.maxStderrBytes ?? 16_777_216);
  managed.stdout?.on("data", (chunk: Buffer | string) => {
    stdout.push(chunk);
  });
  managed.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(chunk);
  });

  let storageMonitorHandle: StorageMonitorHandle | undefined;
  let storageAbort: StorageCheckResult | undefined;
  if (options.storageMonitor !== undefined) {
    storageMonitorHandle = options.storageMonitor.start(
      { worktreePath: workspacePath, artifactPath: options.storageArtifactPath ?? workspacePath },
      async (result) => {
        storageAbort = result;
        await managed.terminate("timeout");
      },
    );
  }
  let processOutcome;
  try {
    processOutcome = await managed.wait();
  } finally {
    storageMonitorHandle?.stop();
  }
  let outcome = classifyProcessOutcome(
    profile,
    processOutcome,
    stdout.capturedText(),
    stderr.capturedText(),
    stdout,
    stderr,
  );
  if (storageAbort !== undefined) {
    const confirmedGone = outcome.termination?.confirmedGone ?? false;
    if (!confirmedGone) {
      outcome = {
        ...outcome,
        status: "termination_unconfirmed",
        errorMessage: "storage limit triggered termination, but process termination could not be confirmed",
      };
    } else {
      outcome = {
        ...outcome,
        status: "storage_limit_exceeded",
        errorMessage: storageAbort.reason ?? "verification stopped after storage limit was exceeded",
      };
    }
  }
  const finishedAt = Date.now();
  return withResultHash({
    profileId: profile.id,
    workspaceId,
    workspacePath,
    program: profile.program,
    args: profile.args,
    status: outcome.status,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    stdoutBytes: outcome.stdoutBytes,
    stderrBytes: outcome.stderrBytes,
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
    durationMs: finishedAt - startedAt,
    startedAt,
    finishedAt,
    ...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
    ...(outcome.termination !== undefined ? { termination: outcome.termination } : {}),
  });
}

export async function runVerification(
  profile: VerificationProfile | undefined,
  workspaceId: string,
  workspacePath: string,
  options: VerificationRunOptions = {},
): Promise<VerificationResult> {
  if (profile === undefined) return makeSkippedResult(workspaceId, workspacePath);
  return runProfile(profile, workspaceId, workspacePath, options);
}
