/**
 * Independent Verification Runner — plan §28 + §67 + Phase 6
 *
 * 真正的 review evidence 必须由 G2M 独立运行,不能只信 Worker self-report
 * (plan §28)。这个 module 负责:
 * - 用 program+argv 跑 verification profile(plan §32 严格禁止 shell)
 * - 捕获 stdout / stderr / exitCode / duration(plan §37 stdout/stderr 分离)
 * - 区分 passed / failed / timed_out / spawn_error / skipped
 * - 返回带 resultHash 的 VerificationResult(plan §45 anti-replay binding)
 *
 * 约束:
 * - 不接受 shell string(plan §32 明确要求 program+argv,不拼接字符串)
 * - 不修改 MCodeAdapter(本轮约束)
 * - 不写 State Machine / Engine(本轮只提供 API,Phase 8 阶段才调用)
 * - Profile = undefined 时返回 status = "skipped"(对应 verification_profile = "none")
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sha256 } from "../protocol/hash.js";
import type { VerificationProfile } from "../policy/verification.js";

const execFileAsync = promisify(execFile);

export type VerificationStatus =
  | "passed"
  | "failed"
  | "timed_out"
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
}

/**
 * resultHash 绑定的"逻辑结果"字段(排除 timing 元数据)。
 * 同一命令两次跑 stdout/stderr/status/exitCode 都一致时 resultHash 稳定,
 * 用于 plan §45 Review Bundle 的 anti-replay / anti-stale 绑定。
 */
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

interface ExecFailure {
  readonly killed?: boolean;
  readonly code?: string | number;
  readonly signal?: NodeJS.Signals;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly message?: string;
}

function isExecFailure(e: unknown): e is ExecFailure {
  return typeof e === "object" && e !== null;
}

interface RunOutcome {
  readonly status: VerificationStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorMessage?: string;
}

function classifyExecution(
  profile: VerificationProfile,
  execError: ExecFailure | null,
): RunOutcome {
  // 没抛错:正常 exit。execFile 在 exit 0 时 resolve,exit 非 0 时 reject,
  // 所以"正常 resolve"只对应 exit 0。
  if (execError === null) {
    return { status: "passed", exitCode: 0, signal: null, stdout: "", stderr: "" };
  }

  const stdout = execError.stdout ?? "";
  const stderr = execError.stderr ?? "";
  const signal = typeof execError.signal === "string" ? execError.signal : null;

  // Timeout:Node 杀掉子进程,killed=true。
  if (execError.killed === true) {
    return {
      status: "timed_out",
      exitCode: null,
      signal,
      stdout,
      stderr,
      errorMessage: `verification timed out after ${profile.timeoutMs}ms`,
    };
  }

  // 程序不存在:ENOENT。
  if (execError.code === "ENOENT") {
    return {
      status: "spawn_error",
      exitCode: null,
      signal,
      stdout,
      stderr,
      errorMessage: `program "${profile.program}" not found: ${execError.message ?? ""}`,
    };
  }

  // 非零退出:execFile 把 exit code 放在 err.code(number)。
  if (typeof execError.code === "number") {
    return {
      status: "failed",
      exitCode: execError.code,
      signal,
      stdout,
      stderr,
    };
  }

  // 其他:spawn 阶段失败(权限、cwd 不存在等)。
  return {
    status: "spawn_error",
    exitCode: null,
    signal,
    stdout,
    stderr,
    errorMessage: execError.message ?? "unknown spawn error",
  };
}

async function runProfile(
  profile: VerificationProfile,
  workspaceId: string,
  workspacePath: string,
): Promise<VerificationResult> {
  const startedAt = Date.now();
  let outcome: RunOutcome;
  try {
    const result = await execFileAsync(profile.program, [...profile.args], {
      cwd: workspacePath,
      timeout: profile.timeoutMs,
      env: profile.env !== undefined
        ? { ...process.env, ...profile.env }
        : process.env,
      windowsHide: true,
    });
    outcome = classifyExecution(profile, null);
    outcome = {
      ...outcome,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (e) {
    if (!isExecFailure(e)) {
      throw new VerificationError(
        "PROFILE_INVALID",
        `unexpected non-object error from execFile: ${String(e)}`,
      );
    }
    outcome = classifyExecution(profile, e);
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
    durationMs: finishedAt - startedAt,
    startedAt,
    finishedAt,
    ...(outcome.errorMessage !== undefined
      ? { errorMessage: outcome.errorMessage }
      : {}),
  });
}

/**
 * 跑一次独立 verification。
 * - profile = undefined → 返回 status = "skipped"(对应 verification_profile = "none")
 * - profile 给定 → 实际 execFile,返回 passed / failed / timed_out / spawn_error
 *
 * 永远不抛错(只把异常转成 status = spawn_error),调用方拿到 result 就能判定。
 * 唯一会抛的场景是 execFile 返回了非 Error 对象(理论不会发生),用作防御。
 */
export async function runVerification(
  profile: VerificationProfile | undefined,
  workspaceId: string,
  workspacePath: string,
): Promise<VerificationResult> {
  if (profile === undefined) {
    return makeSkippedResult(workspaceId, workspacePath);
  }
  return await runProfile(profile, workspaceId, workspacePath);
}
