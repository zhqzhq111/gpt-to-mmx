/**
 * Temporary Git Worktree isolation — plan §17 / Phase 11.
 *
 * Worker changes stay in a detached worktree. After ACCEPT, G2M verifies the
 * target still points at the frozen base revision and is clean, then applies a
 * binary-capable patch as uncommitted changes. This module never commits or
 * pushes and never runs through a shell.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "../protocol/hash.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

export interface CreateTemporaryWorktreeOptions {
  readonly workspaceId: string;
  readonly repositoryPath: string;
  readonly baseRevision: string;
  readonly worktreeRoot: string;
}

export interface TemporaryWorktreeHandle {
  readonly worktreeId: string;
  readonly workspaceId: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly baseRevision: string;
  readonly createdAt: number;
}

export interface WorktreePatch {
  readonly worktreeId: string;
  readonly baseRevision: string;
  readonly patchPath: string;
  readonly patchText: string;
  readonly patchHash: string;
  readonly changedFiles: readonly string[];
  readonly empty: boolean;
  readonly createdAt: number;
}

export interface ApplyAcceptedPatchResult {
  readonly status: "applied" | "no_changes";
  readonly targetPath: string;
  readonly patchHash: string;
  readonly changedFiles: readonly string[];
  readonly appliedAt: number;
}

export class TemporaryWorktreeError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "NOT_GIT_REPO"
    | "CREATE_FAILED"
    | "WORKTREE_HEAD_MOVED"
    | "PATCH_FAILED"
    | "PATCH_HASH_MISMATCH"
    | "TARGET_REPOSITORY_MISMATCH"
    | "BASE_REVISION_MISMATCH"
    | "DIRTY_TARGET"
    | "APPLY_CHECK_FAILED"
    | "APPLY_FAILED"
    | "REMOVE_FAILED";
  override readonly cause?: unknown;

  constructor(
    code: TemporaryWorktreeError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "TemporaryWorktreeError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

async function git(
  cwd: string,
  args: readonly string[],
  errorCode: TemporaryWorktreeError["code"],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new TemporaryWorktreeError(
      errorCode,
      `git ${args.join(" ")} failed in ${cwd}: ${(error as Error).message}`,
      error,
    );
  }
}

async function repositoryRoot(path: string): Promise<string> {
  try {
    const root = await git(path, ["rev-parse", "--show-toplevel"], "NOT_GIT_REPO");
    return resolve(root.trim());
  } catch (error) {
    if (error instanceof TemporaryWorktreeError) throw error;
    throw new TemporaryWorktreeError("NOT_GIT_REPO", `${path} is not a git repository`, error);
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new TemporaryWorktreeError("INVALID_INPUT", `${name} cannot be empty`);
  }
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length === 0 || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function safeWorkspaceName(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe.slice(0, 60) : "workspace";
}

export async function createTemporaryWorktree(
  options: CreateTemporaryWorktreeOptions,
): Promise<TemporaryWorktreeHandle> {
  assertNonEmpty("workspaceId", options.workspaceId);
  assertNonEmpty("repositoryPath", options.repositoryPath);
  assertNonEmpty("baseRevision", options.baseRevision);
  assertNonEmpty("worktreeRoot", options.worktreeRoot);
  if (!isAbsolute(options.repositoryPath) || !isAbsolute(options.worktreeRoot)) {
    throw new TemporaryWorktreeError(
      "INVALID_INPUT",
      "repositoryPath and worktreeRoot must be absolute",
    );
  }

  const root = await repositoryRoot(options.repositoryPath);
  const resolvedWorktreeRoot = resolve(options.worktreeRoot);
  if (isInside(root, resolvedWorktreeRoot)) {
    throw new TemporaryWorktreeError(
      "INVALID_INPUT",
      "worktreeRoot must be outside the source repository",
    );
  }

  let baseRevision: string;
  try {
    baseRevision = (
      await git(root, ["rev-parse", `${options.baseRevision}^{commit}`], "CREATE_FAILED")
    ).trim();
  } catch (error) {
    throw new TemporaryWorktreeError(
      "CREATE_FAILED",
      `base revision ${options.baseRevision} cannot be resolved`,
      error,
    );
  }

  await mkdir(resolvedWorktreeRoot, { recursive: true });
  const worktreeId = randomUUID();
  const worktreePath = join(
    resolvedWorktreeRoot,
    `${safeWorkspaceName(options.workspaceId)}-${worktreeId}`,
  );

  await git(
    root,
    ["worktree", "add", "--detach", worktreePath, baseRevision],
    "CREATE_FAILED",
  );

  return Object.freeze({
    worktreeId,
    workspaceId: options.workspaceId,
    repositoryPath: root,
    worktreePath: resolve(worktreePath),
    baseRevision,
    createdAt: Date.now(),
  });
}

async function assertWorktreeAtBase(handle: TemporaryWorktreeHandle): Promise<void> {
  const head = (
    await git(handle.worktreePath, ["rev-parse", "HEAD"], "WORKTREE_HEAD_MOVED")
  ).trim();
  if (head !== handle.baseRevision) {
    throw new TemporaryWorktreeError(
      "WORKTREE_HEAD_MOVED",
      `worktree HEAD ${head} differs from frozen base ${handle.baseRevision}`,
    );
  }
}

export async function collectWorktreePatch(
  handle: TemporaryWorktreeHandle,
  artifactRoot: string,
): Promise<WorktreePatch> {
  assertNonEmpty("artifactRoot", artifactRoot);
  if (!isAbsolute(artifactRoot)) {
    throw new TemporaryWorktreeError("INVALID_INPUT", "artifactRoot must be absolute");
  }
  await assertWorktreeAtBase(handle);

  // Staging happens only inside the disposable worktree and allows one patch
  // to include tracked, deleted, binary, and previously untracked files.
  await git(handle.worktreePath, ["add", "-A"], "PATCH_FAILED");
  const [patchText, changedOutput] = await Promise.all([
    git(
      handle.worktreePath,
      ["diff", "--cached", "--binary", handle.baseRevision],
      "PATCH_FAILED",
    ),
    git(
      handle.worktreePath,
      ["diff", "--cached", "--name-only", handle.baseRevision],
      "PATCH_FAILED",
    ),
  ]);

  const changedFiles = changedOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
  await mkdir(resolve(artifactRoot), { recursive: true });
  const patchPath = join(resolve(artifactRoot), `${handle.worktreeId}.patch`);
  await writeFile(patchPath, patchText, "utf8");
  const patchHash = sha256({ baseRevision: handle.baseRevision, patchText });

  return Object.freeze({
    worktreeId: handle.worktreeId,
    baseRevision: handle.baseRevision,
    patchPath,
    patchText,
    patchHash,
    changedFiles: Object.freeze(changedFiles),
    empty: patchText.length === 0,
    createdAt: Date.now(),
  });
}

export async function applyAcceptedPatch(
  handle: TemporaryWorktreeHandle,
  patch: WorktreePatch,
  targetPath: string,
): Promise<ApplyAcceptedPatchResult> {
  const patchText = await readFile(patch.patchPath, "utf8").catch((error) => {
    throw new TemporaryWorktreeError("PATCH_FAILED", "cannot read patch artifact", error);
  });
  const actualPatchHash = sha256({ baseRevision: patch.baseRevision, patchText });
  if (actualPatchHash !== patch.patchHash) {
    throw new TemporaryWorktreeError(
      "PATCH_HASH_MISMATCH",
      "patch artifact content no longer matches its frozen hash",
    );
  }
  if (
    patch.worktreeId !== handle.worktreeId ||
    patch.baseRevision !== handle.baseRevision
  ) {
    throw new TemporaryWorktreeError(
      "PATCH_HASH_MISMATCH",
      "patch is not bound to this worktree and base revision",
    );
  }

  const targetRoot = await repositoryRoot(targetPath);
  if (targetRoot !== handle.repositoryPath) {
    throw new TemporaryWorktreeError(
      "TARGET_REPOSITORY_MISMATCH",
      `target ${targetRoot} is not the registered repository ${handle.repositoryPath}`,
    );
  }
  const targetHead = (
    await git(targetRoot, ["rev-parse", "HEAD"], "BASE_REVISION_MISMATCH")
  ).trim();
  if (targetHead !== handle.baseRevision) {
    throw new TemporaryWorktreeError(
      "BASE_REVISION_MISMATCH",
      `target HEAD ${targetHead} differs from frozen base ${handle.baseRevision}`,
    );
  }
  const status = await git(targetRoot, ["status", "--porcelain"], "DIRTY_TARGET");
  if (status.trim().length > 0) {
    throw new TemporaryWorktreeError(
      "DIRTY_TARGET",
      "target workspace contains user or unrelated changes",
    );
  }

  if (patch.empty) {
    return Object.freeze({
      status: "no_changes",
      targetPath: targetRoot,
      patchHash: patch.patchHash,
      changedFiles: patch.changedFiles,
      appliedAt: Date.now(),
    });
  }

  await git(targetRoot, ["apply", "--check", "--binary", patch.patchPath], "APPLY_CHECK_FAILED");
  await git(targetRoot, ["apply", "--binary", patch.patchPath], "APPLY_FAILED");

  return Object.freeze({
    status: "applied",
    targetPath: targetRoot,
    patchHash: patch.patchHash,
    changedFiles: patch.changedFiles,
    appliedAt: Date.now(),
  });
}

export async function removeTemporaryWorktree(
  handle: TemporaryWorktreeHandle,
): Promise<void> {
  try {
    await git(
      handle.repositoryPath,
      ["worktree", "remove", "--force", handle.worktreePath],
      "REMOVE_FAILED",
    );
    await git(handle.repositoryPath, ["worktree", "prune"], "REMOVE_FAILED");
  } catch (error) {
    if (error instanceof TemporaryWorktreeError) throw error;
    throw new TemporaryWorktreeError("REMOVE_FAILED", "cannot remove worktree", error);
  }
}
