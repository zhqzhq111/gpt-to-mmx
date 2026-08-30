/**
 * Independent Verification Runner.
 *
 * Verification commands use the same ProcessSupervisor as workers. The
 * runner owns output capture and result classification; the supervisor owns
 * process-tree termination and termination proof.
 */

import { sha256 } from "../protocol/hash.js";
import {
  ProcessSupervisor,
  type ProcessOutcome,
  type TerminationResult,
} from "../process/supervisor.js";
import type { VerificationProfile } from "../policy/verification.js";

export type VerificationStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "termination_unconfirmed"
  | "spawn_error"
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
  readonly durationMs: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly resultHash: string;
  readonly errorMessage?: string;
  readonly termination?: VerificationTermination;
}

export interface VerificationRunOptions {
  readonly processSupervisor?: ProcessSupervisor;
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
): RunOutcome {
  if (outcome.kind === "exited") {
    return {
      status: outcome.exitCode === 0 ? "passed" : "failed",
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
    };
  }
  if (outcome.kind === "spawn_error") {
    return {
      status: "spawn_error",
      exitCode: null,
      signal: null,
      stdout,
      stderr,
      errorMessage: `program "${profile.program}" not found: ${outcome.error.message}`,
    };
  }
  if (outcome.kind === "timed_out") {
    return {
      status: "timed_out",
      exitCode: null,
      signal: null,
      stdout,
      stderr,
      errorMessage: `verification timed out after ${profile.timeoutMs}ms`,
      termination: terminationEvidence(outcome.termination),
    };
  }
  return {
    status: "termination_unconfirmed",
    exitCode: null,
    signal: null,
    stdout,
    stderr,
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
  const supervisor = options.processSupervisor ?? new ProcessSupervisor();
  const managed = supervisor.spawn({
    program: profile.program,
    args: profile.args,
    cwd: workspacePath,
    env: profile.env !== undefined ? { ...process.env, ...profile.env } : process.env,
    timeoutMs: profile.timeoutMs,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  managed.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  managed.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });

  const processOutcome = await managed.wait();
  const outcome = classifyProcessOutcome(profile, processOutcome, stdout, stderr);
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
