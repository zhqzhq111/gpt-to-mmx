/**
 * Temporary Git Worktree isolation — plan §17 / Phase 11.
 *
 * Worker changes stay in a detached worktree. After ACCEPT, G2M verifies the
 * target still points at the frozen base revision and is clean, then applies a
 * binary-capable patch as uncommitted changes. This module never commits or
 * pushes and never runs through a shell.
 */

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { writeImmutableArtifact } from "../persistence/artifact-writer.js";
import {
  computeFullWorkingTreeChangeSet,
  computeIndexedChangeSet,
  computeWorkingTreeChangeSet,
  type ChangeSetEntry,
} from "./change-set.js";

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
  readonly artifactId: string;
  readonly worktreeId: string;
  readonly baseRevision: string;
  readonly patchPath: string;
  readonly metadataPath: string;
  readonly patchText: string;
  readonly patchBlobHash: string;
  readonly changeSetHash: string;
  readonly changeSet: readonly ChangeSetEntry[];
  readonly patchBytes: number;
  /** @deprecated Use patchBlobHash. */
  readonly patchHash: string;
  readonly changedFiles: readonly string[];
  readonly empty: boolean;
  readonly createdAt: number;
}

/**
 * A patch that has been assembled entirely in memory.  Keeping preparation
 * separate from freezing gives storage admission a hard checkpoint before an
 * immutable artifact is created.
 */
export interface PreparedWorktreePatch {
  readonly handle: TemporaryWorktreeHandle;
  readonly artifactRoot: string;
  readonly patchBytes: Buffer;
  readonly metadataBytes: number;
  readonly changeSetHash: string;
  readonly changeSet: WorktreePatch["changeSet"];
  readonly changedFiles: readonly string[];
}

export interface ApplyAcceptedPatchResult {
  readonly status: "applied" | "no_changes";
  readonly targetPath: string;
  readonly patchHash: string;
  readonly patchBlobHash: string;
  readonly expectedChangeSetHash: string;
  readonly actualChangeSetHash: string;
  readonly changedFiles: readonly string[];
  readonly appliedAt: number;
}

/**
 * Phase 6 preflight — all the read-only checks the engine must complete
 * BEFORE emitting a durable `patch.apply.started` event. The target Git
 * workspace is NOT mutated by this function. After preflight succeeds, the
 * caller is expected to:
 *
 *   1. `eventStore.append({ type: "patch.apply.started", ... })` so a crash
 *      mid-apply can be reconciled against the Frozen Patch.
 *   2. Call `applyPreflightedPatch(preflight)` to perform the actual apply.
 *
 * The preflight result is immutable and carries everything `applyPreflightedPatch`
 * needs (including the already-read patch bytes), so the two calls can be
 * separated by Journal writes without re-reading the patch artifact.
 */
export interface AcceptedPatchPreflight {
  readonly repositoryPath: string;
  readonly baseRevision: string;
  readonly patchPath: string;
  readonly patchBlobHash: string;
  readonly expectedChangeSetHash: string;
  readonly changedFiles: readonly string[];
  readonly patchBytes: Buffer;
  readonly targetPath: string;
  /** Directory where the temporary `git index` file lives for change-set computation. */
  readonly temporaryRoot: string;
}

export class TemporaryWorktreeError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "NOT_GIT_REPO"
    | "CREATE_FAILED"
    | "WORKTREE_HEAD_MOVED"
    | "PATCH_FAILED"
    | "PATCH_HASH_MISMATCH"
    | "PATCH_RESULT_MISMATCH"
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

/**
 * Phase 6 P0#3: feed `patchBytes` to `git` via stdin. The preflight already
 * verified the bytes against `patch_blob_hash`; piping the same bytes here
 * (instead of re-reading `patchPath` from disk) closes the
 * "reviewed A / applied B" race where the artifact file is rewritten between
 * preflight and apply.
 *
 * Uses `spawn` (not `execFile({ input })`) because Node's execFile on
 * Windows does not always close stdin after writing the input buffer —
 * `git apply` then waits forever for EOF and the call times out. `spawn`
 * lets us explicitly write the buffer and call `stdin.end()`, which
 * reliably signals EOF.
 */
async function gitStdin(
  cwd: string,
  args: readonly string[],
  patchBytes: Buffer,
  errorCode: TemporaryWorktreeError["code"],
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", [...args], {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 20 * 1024 * 1024) {
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(
        new TemporaryWorktreeError(
          errorCode,
          `git ${args.join(" ")} (stdin) failed to spawn in ${cwd}: ${error.message}`,
          error,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(
          new TemporaryWorktreeError(
            errorCode,
            `git ${args.join(" ")} (stdin) timed out in ${cwd}`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      rejectPromise(
        new TemporaryWorktreeError(
          errorCode,
          `git ${args.join(" ")} (stdin) failed in ${cwd} (exit ${code}): ${stderr.trim()}`,
        ),
      );
    });
    // Write the patch bytes, then explicitly close stdin so `git apply`
    // sees EOF and proceeds.
    child.stdin.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(
        new TemporaryWorktreeError(
          errorCode,
          `git ${args.join(" ")} (stdin) failed to write: ${error.message}`,
          error,
        ),
      );
    });
    child.stdin.end(patchBytes);
  });
}

async function gitBuffer(
  cwd: string,
  args: readonly string[],
  errorCode: TemporaryWorktreeError["code"],
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      encoding: "buffer",
      maxBuffer: 50 * 1024 * 1024,
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
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
  return freezePreparedWorktreePatch(await prepareWorktreePatch(handle, artifactRoot));
}

export async function prepareWorktreePatch(
  handle: TemporaryWorktreeHandle,
  artifactRoot: string,
): Promise<PreparedWorktreePatch> {
  assertNonEmpty("artifactRoot", artifactRoot);
  if (!isAbsolute(artifactRoot)) {
    throw new TemporaryWorktreeError("INVALID_INPUT", "artifactRoot must be absolute");
  }
  await assertWorktreeAtBase(handle);

  // Staging happens only inside the disposable worktree and allows one patch
  // to include tracked, deleted, binary, and previously untracked files.
  await git(handle.worktreePath, ["add", "-A"], "PATCH_FAILED");
  const patchBytes = await gitBuffer(
      handle.worktreePath,
      ["diff", "--cached", "--binary", handle.baseRevision],
      "PATCH_FAILED",
  );
  const changeSet = await computeIndexedChangeSet(handle.worktreePath, handle.baseRevision);
  const metadataBytes = Buffer.byteLength(`${JSON.stringify({
    artifact_id: `patch-${handle.worktreeId}`,
    artifact_path: "frozen.patch",
    patch_blob_hash: "0".repeat(64),
    change_set_hash: changeSet.hash,
    base_revision: handle.baseRevision,
    patch_bytes: patchBytes.length,
    change_set: changeSet.entries,
  }, null, 2)}\n`, "utf8");
  return Object.freeze({
    handle,
    artifactRoot: resolve(artifactRoot),
    patchBytes,
    metadataBytes,
    changeSetHash: changeSet.hash,
    changeSet: changeSet.entries,
    changedFiles: Object.freeze(changeSet.entries.map((entry) => entry.path)),
  });
}

export async function freezePreparedWorktreePatch(
  prepared: PreparedWorktreePatch,
): Promise<WorktreePatch> {
  const { handle, patchBytes, changeSetHash, changeSet, changedFiles } = prepared;
  const artifactDirectory = prepared.artifactRoot;
  await mkdir(artifactDirectory, { recursive: true });
  const patchPath = join(artifactDirectory, "frozen.patch");
  const metadataPath = join(artifactDirectory, "frozen-patch.json");
  const artifactId = `patch-${handle.worktreeId}`;
  const patchArtifact = await writeImmutableArtifact(patchPath, patchBytes);
  const metadata = {
    artifact_id: artifactId,
    artifact_path: "frozen.patch",
    patch_blob_hash: patchArtifact.sha256,
    change_set_hash: changeSetHash,
    base_revision: handle.baseRevision,
    patch_bytes: patchArtifact.bytes,
    change_set: changeSet,
  };
  await writeImmutableArtifact(
    metadataPath,
    Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
  );
  const patchText = patchBytes.toString("utf8");

  return Object.freeze({
    artifactId,
    worktreeId: handle.worktreeId,
    baseRevision: handle.baseRevision,
    patchPath,
    metadataPath,
    patchText,
    patchBlobHash: patchArtifact.sha256,
    changeSetHash,
    changeSet,
    patchBytes: patchArtifact.bytes,
    patchHash: patchArtifact.sha256,
    changedFiles,
    empty: patchBytes.length === 0,
    createdAt: Date.now(),
  });
}

export async function preflightAcceptedPatch(
  handle: TemporaryWorktreeHandle,
  patch: WorktreePatch,
  targetPath: string,
): Promise<AcceptedPatchPreflight> {
  const patchBytes = await readFile(patch.patchPath).catch((error) => {
    throw new TemporaryWorktreeError("PATCH_FAILED", "cannot read patch artifact", error);
  });
  const actualPatchHash = createHash("sha256").update(patchBytes).digest("hex");
  if (actualPatchHash !== patch.patchBlobHash) {
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

  return Object.freeze({
    repositoryPath: targetRoot,
    baseRevision: handle.baseRevision,
    patchPath: patch.patchPath,
    patchBlobHash: patch.patchBlobHash,
    expectedChangeSetHash: patch.changeSetHash,
    changedFiles: patch.changedFiles,
    patchBytes: Buffer.from(patchBytes),
    targetPath: targetRoot,
    temporaryRoot: dirname(patch.patchPath),
  });
}

/**
 * Phase 6 apply — runs `git apply --check --binary -` and
 * `git apply --binary -` (stdin) and verifies the FULL working-tree change
 * set. Caller MUST have emitted `patch.apply.started` to the Journal
 * BEFORE calling this; recovery assumes the event is durable so it can
 * distinguish "apply never started" from "apply succeeded, journal tail
 * missing".
 *
 * P0#3: we feed `preflight.patchBytes` to git via stdin instead of re-reading
 * the patch file from disk. This guarantees the bytes that were hash-verified
 * in preflight are the bytes actually applied — closing the
 * "reviewed A / applied B" window where `frozen.patch` is rewritten between
 * preflight and apply.
 *
 * P0#4: after `git apply` we compute the FULL working-tree change set
 * (`git add -A`, no pathspec) and require its hash to match the Frozen
 * Patch's expected change set. An unrelated user edit / untracked file in
 * the target workspace now flips the comparison to DIVERGED, never
 * silently accepted.
 */
export async function applyPreflightedPatch(
  preflight: AcceptedPatchPreflight,
): Promise<ApplyAcceptedPatchResult> {
  if (preflight.changedFiles.length === 0) {
    // No changes expected: verify the working tree is still CLEAN_BASE.
    const actualChangeSet = await computeFullWorkingTreeChangeSet(
      preflight.repositoryPath,
      preflight.baseRevision,
      preflight.temporaryRoot,
    );
    if (actualChangeSet.hash !== preflight.expectedChangeSetHash) {
      throw new TemporaryWorktreeError(
        "PATCH_RESULT_MISMATCH",
        `empty patch result hash ${actualChangeSet.hash} differs from expected ${preflight.expectedChangeSetHash}`,
      );
    }
    return Object.freeze({
      status: "no_changes",
      targetPath: preflight.targetPath,
      patchHash: preflight.patchBlobHash,
      patchBlobHash: preflight.patchBlobHash,
      expectedChangeSetHash: preflight.expectedChangeSetHash,
      actualChangeSetHash: actualChangeSet.hash,
      changedFiles: preflight.changedFiles,
      appliedAt: Date.now(),
    });
  }

  await gitStdin(
    preflight.repositoryPath,
    ["apply", "--check", "--binary", "-"],
    preflight.patchBytes,
    "APPLY_CHECK_FAILED",
  );
  await gitStdin(
    preflight.repositoryPath,
    ["apply", "--binary", "-"],
    preflight.patchBytes,
    "APPLY_FAILED",
  );

  // P0#4: full-tree change set (no pathspec) so unrelated user edits /
  // untracked files in the target break ACCEPT instead of being silently
  // carried into the journal.
  const actualChangeSet = await computeFullWorkingTreeChangeSet(
    preflight.repositoryPath,
    preflight.baseRevision,
    preflight.temporaryRoot,
  );
  if (actualChangeSet.hash !== preflight.expectedChangeSetHash) {
    throw new TemporaryWorktreeError(
      "PATCH_RESULT_MISMATCH",
      `applied change set hash ${actualChangeSet.hash} differs from expected ${preflight.expectedChangeSetHash}`,
    );
  }

  return Object.freeze({
    status: "applied",
    targetPath: preflight.targetPath,
    patchHash: preflight.patchBlobHash,
    patchBlobHash: preflight.patchBlobHash,
    expectedChangeSetHash: preflight.expectedChangeSetHash,
    actualChangeSetHash: actualChangeSet.hash,
    changedFiles: preflight.changedFiles,
    appliedAt: Date.now(),
  });
}

/**
 * Backward-compatible wrapper — runs preflight + apply as a single call.
 * Engine ACCEPT path should normally split this into preflight + a
 * `patch.apply.started` event + apply, but the legacy combined entry point
 * remains available for tests and the existing internal callers.
 */
export async function applyAcceptedPatch(
  handle: TemporaryWorktreeHandle,
  patch: WorktreePatch,
  targetPath: string,
): Promise<ApplyAcceptedPatchResult> {
  const preflight = await preflightAcceptedPatch(handle, patch, targetPath);
  return applyPreflightedPatch(preflight);
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
