/**
 * Clean Worktree Check — plan 第 16 节
 *
 * MVP 必须 `require_clean_worktree = true`:Worker 运行前,
 * `git status` 必须确认没有现有用户修改。否则 BLOCKED。
 *
 * 原因(plan 第 16 节):Worker Diff 必须能明确归因给 MiniMax,不能
 * 跟用户自己未提交的修改混在一起。
 *
 * 这一文件只做"check",不做"revert" / "stash" / 任何破坏性动作。
 * 留给 G2M Core 决策怎么 reconcile dirty worktree。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CleanCheckError extends Error {
  readonly code: "DIRTY_WORKSPACE" | "NOT_GIT_REPO" | "TIMEOUT";
  readonly dirtyFiles: readonly string[];
  constructor(
    code: CleanCheckError["code"],
    message: string,
    dirtyFiles: readonly string[] = [],
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CleanCheckError";
    this.code = code;
    this.dirtyFiles = dirtyFiles;
  }
}

const TIMEOUT_MS = 10_000;

interface GitStatusEntry {
  /** 两字符 XY status code 来自 git status --porcelain */
  readonly xy: string;
  readonly path: string;
}

/**
 * 解析 git status --porcelain 输出(每行 "XY path",XY 至少 2 字符)。
 * 处理带 rename 的格式("XY old -> new",plan §36 中文/空格路径相关)。
 */
function parsePorcelain(output: string): GitStatusEntry[] {
  const out: GitStatusEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (raw.length < 4) continue; // 至少 "XY " + 1 字符路径
    const xy = raw.slice(0, 2);
    let rest = raw.slice(3);
    if (rest.includes(" -> ")) {
      // rename / copy 格式,只保留目标
      rest = rest.split(" -> ")[1] ?? rest;
    }
    out.push({ xy, path: rest });
  }
  return out;
}

/**
 * 跑一次 git status --porcelain,看 workspace 是否干净。
 * 干净:返回空数组;非干净:返回 dirty 文件列表(plan §16 BLOCKED)。
 */
export async function requireCleanWorktree(workspacePath: string): Promise<void> {
  let stdout: string;
  try {
    const res = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd: workspacePath, timeout: TIMEOUT_MS, windowsHide: true },
    );
    stdout = res.stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { code?: string; killed?: boolean };
    if (err.killed) {
      throw new CleanCheckError("TIMEOUT", "git status --porcelain timed out");
    }
    throw new CleanCheckError(
      "NOT_GIT_REPO",
      `git status --porcelain failed: ${err.message ?? String(e)}`,
      [],
      e,
    );
  }

  const entries = parsePorcelain(stdout);
  if (entries.length > 0) {
    const paths = entries.map((e) => `${e.xy} ${e.path}`);
    throw new CleanCheckError(
      "DIRTY_WORKSPACE",
      `workspace is dirty (${entries.length} entries); Worker diff cannot be attributed (plan §16)`,
      paths,
    );
  }
}
