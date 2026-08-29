/**
 * Git Diff Collector — plan 第 27-28 节 + 第 30 节 + 第 45 节
 *
 * 真实采集 Worker 改了什么。这是 G2M 跟 Worker self-report(plan §28)对账的
 * 唯一权威来源。Worker 说"我改了 X"不算数,必须 git diff 显示改了 X。
 *
 * 三个独立来源:
 * 1. `git diff <baseRevision>` — 改 / 删(工作区相对 baseline)
 * 2. `git ls-files --others --exclude-standard` — untracked
 * 3. `--diff-filter=D` — deleted(从 baseline 视角)
 *
 * Diff Hash 是 plan §45 Review Bundle 的 binding 字段,Review 必须能
 * 绑到 (task_id, execution_id, review_bundle_id, task_hash, result_hash,
 * review_bundle_hash) 一起 hash。
 *
 * Protected Paths(plan §30):Worker 修改测试文件 / build config 是
 * 常见"假阳性"来源,DiffResult 必须 surface 出来让 Reviewer 看到。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { canonicalJson } from "../protocol/hash.js";

const execFileAsync = promisify(execFile);

export class DiffError extends Error {
  readonly code: "GIT_FAILED" | "TIMEOUT" | "NOT_GIT_REPO";
  constructor(
    code: DiffError["code"],
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DiffError";
    this.code = code;
  }
}

export type FileChangeStatus = "M" | "A" | "D" | "R" | "C" | "?";

export interface FileChange {
  readonly path: string;
  readonly status: FileChangeStatus;
}

export interface DiffResult {
  readonly workspacePath: string;
  readonly baseRevision: string;
  readonly fullDiff: string;
  readonly diffStat: string;
  readonly changedFiles: readonly FileChange[];
  readonly untrackedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly protectedFilesTouched: readonly string[];
  readonly diffHash: string;
  readonly capturedAt: number;
}

const TIMEOUT_MS = 15_000;

/**
 * 默认 protected paths 模式(plan §30)。任务级 policy 可以覆盖。
 * Glob 简化成"包含子串"判断,够 MVP 用,Phase 4 切到 picomatch / minimatch。
 */
const DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
  "tests/",
  "test/",
  "__tests__/",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "CMakeLists.txt",
  "Makefile",
  "tsconfig",
  ".github/workflows/",
  "pytest.ini",
  "vitest.config",
  "jest.config",
];

async function gitDiffNameStatus(
  workspacePath: string,
  base: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-status", base],
      { cwd: workspacePath, timeout: TIMEOUT_MS, windowsHide: true },
    );
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean };
    if (err.killed) {
      throw new DiffError("TIMEOUT", "git diff --name-status timed out");
    }
    throw new DiffError(
      "NOT_GIT_REPO",
      `git diff --name-status failed: ${err.message ?? String(e)}`,
      e,
    );
  }
}

async function gitDiffFull(workspacePath: string, base: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", base],
      { cwd: workspacePath, timeout: TIMEOUT_MS, windowsHide: true },
    );
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean };
    if (err.killed) {
      throw new DiffError("TIMEOUT", "git diff timed out");
    }
    throw new DiffError(
      "NOT_GIT_REPO",
      `git diff failed: ${err.message ?? String(e)}`,
      e,
    );
  }
}

async function gitDiffStat(workspacePath: string, base: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--stat", base],
      { cwd: workspacePath, timeout: TIMEOUT_MS, windowsHide: true },
    );
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean };
    if (err.killed) {
      throw new DiffError("TIMEOUT", "git diff --stat timed out");
    }
    throw new DiffError(
      "NOT_GIT_REPO",
      `git diff --stat failed: ${err.message ?? String(e)}`,
      e,
    );
  }
}

async function gitLsUntracked(workspacePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: workspacePath, timeout: TIMEOUT_MS, windowsHide: true },
    );
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean };
    if (err.killed) {
      throw new DiffError("TIMEOUT", "git ls-files timed out");
    }
    throw new DiffError(
      "NOT_GIT_REPO",
      `git ls-files failed: ${err.message ?? String(e)}`,
      e,
    );
  }
}

/**
 * 解析 `git diff --name-status` 输出。
 * 格式:每行 "X<tab>path" 或 "X<tab>old -> new"(rename)。
 */
function parseNameStatus(output: string): FileChange[] {
  const out: FileChange[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (raw.length === 0) continue;
    const tab = raw.indexOf("\t");
    if (tab < 0) continue;
    const status = raw.slice(0, tab).charAt(0) as FileChangeStatus;
    let path = raw.slice(tab + 1);
    if (path.includes(" -> ")) {
      path = path.split(" -> ")[1] ?? path;
    }
    out.push({ status, path });
  }
  return out;
}

function isProtected(filePath: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (filePath.includes(p)) return true;
  }
  return false;
}

export interface CollectDiffOptions {
  readonly protectedPatterns?: readonly string[];
}

/**
 * 收集 Worker 真实修改证据。
 * 假设 worker **不** commit(MVP 简化);如果 worker commit 了,
 * 改成 `git diff <base>..HEAD` 即可,接口不变。
 */
export async function collectDiff(
  workspacePath: string,
  baseRevision: string,
  options: CollectDiffOptions = {},
): Promise<DiffResult> {
  const patterns = options.protectedPatterns ?? DEFAULT_PROTECTED_PATTERNS;

  const [nameStatusOut, fullDiff, diffStat, untrackedOut] = await Promise.all([
    gitDiffNameStatus(workspacePath, baseRevision),
    gitDiffFull(workspacePath, baseRevision),
    gitDiffStat(workspacePath, baseRevision),
    gitLsUntracked(workspacePath),
  ]);

  const trackedChanges = parseNameStatus(nameStatusOut);
  const untrackedFiles = unackedTrackedChanges(untrackedOut);
  const untrackedEntries: FileChange[] = untrackedFiles.map((p) => ({
    path: p,
    status: "?" as const,
  }));

  const changedFiles: FileChange[] = [...trackedChanges, ...untrackedEntries];
  const deletedFiles = trackedChanges
    .filter((c) => c.status === "D")
    .map((c) => c.path);
  const protectedFilesTouched = changedFiles
    .filter((c) => isProtected(c.path, patterns))
    .map((c) => c.path);

  const diffHash = createHash("sha256")
    .update(canonicalJson({ fullDiff, changedFiles }), "utf8")
    .digest("hex");

  return {
    workspacePath,
    baseRevision,
    fullDiff,
    diffStat,
    changedFiles,
    untrackedFiles,
    deletedFiles,
    protectedFilesTouched,
    diffHash,
    capturedAt: Date.now(),
  };
}

function unackedTrackedChanges(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
