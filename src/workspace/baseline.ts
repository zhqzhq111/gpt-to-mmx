/**
 * Workspace Baseline — plan 第 16 节 + 第 27 节
 *
 * 启动 Worker 前 capture 一次 git state(plan §27):
 *   - base_revision:git rev-parse HEAD
 *   - status:`git status --porcelain` 输出
 *   - dirty:status 非空即 true
 *
 * Worker 运行后再 capture 一次,跟 base diff 出真实改了什么。
 *
 * MVP 限制:
 * - 只支持真实 git 仓库;非 git 目录抛错
 * - 用 child_process.execFile 调 git,假设用户机器有 git(Git for Windows)
 * - 不解析 .git 内部结构(太脆,git CLI 是真权威)
 * - 不解决中文路径 / 空格路径测试(plan §36 Windows CI 必测,留到 Phase 7 之后)
 *
 * 这一轮只做 capture,不做 diff 收集(plan §28 留给 Phase 5)。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceBaseline {
  readonly canonicalPath: string;
  readonly baseRevision: string;
  readonly statusPorcelain: string;
  readonly dirty: boolean;
  readonly capturedAt: number;
}

export class BaselineError extends Error {
  readonly code: "NOT_GIT_REPO" | "GIT_FAILED" | "TIMEOUT";
  override readonly cause?: unknown;
  constructor(
    code: BaselineError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "BaselineError";
    this.code = code;
    this.cause = cause;
  }
}

const GIT_TIMEOUT_MS = 10_000;

/**
 * 调 git rev-parse HEAD 拿 commit hash。
 * 失败最常见原因是目录不是 git 仓库。
 */
async function gitRevParseHead(workspacePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: workspacePath, timeout: GIT_TIMEOUT_MS, windowsHide: true },
    );
    return stdout.trim();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { code?: string; killed?: boolean };
    if (err.code === "ENOENT") {
      throw new BaselineError(
        "GIT_FAILED",
        `git executable not found in PATH: ${err.message}`,
      );
    }
    if (err.killed) {
      throw new BaselineError("TIMEOUT", "git rev-parse HEAD timed out");
    }
    // exit code 128 通常是 "fatal: not a git repository"
    throw new BaselineError(
      "NOT_GIT_REPO",
      `git rev-parse HEAD failed: ${err.message ?? String(e)}`,
    );
  }
}

async function gitStatusPorcelain(workspacePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd: workspacePath, timeout: GIT_TIMEOUT_MS, windowsHide: true },
    );
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { code?: string; killed?: boolean };
    if (err.killed) {
      throw new BaselineError("TIMEOUT", "git status --porcelain timed out");
    }
    throw new BaselineError(
      "NOT_GIT_REPO",
      `git status --porcelain failed: ${err.message ?? String(e)}`,
    );
  }
}

export async function captureBaseline(
  workspacePath: string,
): Promise<WorkspaceBaseline> {
  const baseRevision = await gitRevParseHead(workspacePath);
  const statusPorcelain = await gitStatusPorcelain(workspacePath);
  return {
    canonicalPath: workspacePath,
    baseRevision,
    statusPorcelain,
    dirty: statusPorcelain.trim().length > 0,
    capturedAt: Date.now(),
  };
}
