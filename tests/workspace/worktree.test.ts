import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TemporaryWorktreeError,
  applyAcceptedPatch,
  collectWorktreePatch,
  createTemporaryWorktree,
  preflightAcceptedPatch,
  applyPreflightedPatch,
  removeTemporaryWorktree,
  type TemporaryWorktreeHandle,
} from "../../src/workspace/worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    windowsHide: true,
  });
  return stdout.trim();
}

describe("Temporary Git Worktree", () => {
  let tempRoot: string;
  let repositoryPath: string;
  let worktreeRoot: string;
  let artifactRoot: string;
  let baseRevision: string;
  let handle: TemporaryWorktreeHandle | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "g2m-worktree-"));
    repositoryPath = join(tempRoot, "主仓库 with spaces");
    worktreeRoot = join(tempRoot, "isolated worktrees");
    artifactRoot = join(tempRoot, "patch artifacts");
    await mkdir(repositoryPath, { recursive: true });
    await git(repositoryPath, ["init", "--initial-branch=main"]);
    await git(repositoryPath, ["config", "user.email", "g2m@test.local"]);
    await git(repositoryPath, ["config", "user.name", "G2M Test"]);
    await writeFile(join(repositoryPath, "source.txt"), "before\n", "utf8");
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, ["commit", "-m", "baseline"]);
    baseRevision = await git(repositoryPath, ["rev-parse", "HEAD"]);
  });

  afterEach(async () => {
    if (handle !== undefined) {
      await removeTemporaryWorktree(handle).catch(() => undefined);
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("creates a detached clean worktree at the requested base revision", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });

    expect(handle.repositoryPath).toBe(repositoryPath);
    expect(handle.baseRevision).toBe(baseRevision);
    expect(await git(handle.worktreePath, ["rev-parse", "HEAD"])).toBe(baseRevision);
    expect(await git(handle.worktreePath, ["status", "--porcelain"])).toBe("");
    expect(await git(handle.worktreePath, ["branch", "--show-current"])).toBe("");
  });

  it("collects tracked and untracked files into one binary-capable patch", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });
    await writeFile(join(handle.worktreePath, "source.txt"), "after\n", "utf8");
    await writeFile(join(handle.worktreePath, "new-file.txt"), "new\n", "utf8");

    const patch = await collectWorktreePatch(handle, artifactRoot);

    expect(patch.empty).toBe(false);
    expect(patch.changedFiles).toEqual(["new-file.txt", "source.txt"]);
    const patchBytes = await readFile(patch.patchPath);
    expect(patchBytes.toString("utf8")).toContain("new-file.txt");
    expect(patch.patchBlobHash).toBe(createHash("sha256").update(patchBytes).digest("hex"));
    expect(patch.changeSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(patch.patchBytes).toBe(patchBytes.length);
    expect(JSON.parse(await readFile(patch.metadataPath, "utf8"))).toMatchObject({
      patch_blob_hash: patch.patchBlobHash,
      change_set_hash: patch.changeSetHash,
      base_revision: baseRevision,
      patch_bytes: patchBytes.length,
    });
  });

  it("applies an accepted patch to a clean main workspace without committing", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });
    await writeFile(join(handle.worktreePath, "source.txt"), "accepted\n", "utf8");
    await writeFile(join(handle.worktreePath, "new-file.txt"), "accepted new\n", "utf8");
    const patch = await collectWorktreePatch(handle, artifactRoot);

    const applied = await applyAcceptedPatch(handle, patch, repositoryPath);

    expect(applied.status).toBe("applied");
    expect(applied.actualChangeSetHash).toBe(patch.changeSetHash);
    expect((await readFile(join(repositoryPath, "source.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("accepted\n");
    expect((await readFile(join(repositoryPath, "new-file.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("accepted new\n");
    expect(await git(repositoryPath, ["rev-parse", "HEAD"])).toBe(baseRevision);
    expect(await git(repositoryPath, ["status", "--porcelain"])).not.toBe("");
  });

  // ---------------------------------------------------------------------------
  // P0#3 — Reviewed patch bytes == Applied patch bytes (byte-for-byte).
  // The preflight already hash-verified the Frozen Patch. The apply step
  // must pipe the SAME bytes to `git apply` (via stdin), not re-read
  // `frozen.patch` from disk. We verify by tampering the on-disk file
  // between preflight and apply — the apply must still succeed because
  // it uses the preflight bytes, not the tampered file.
  // ---------------------------------------------------------------------------
  it("P0#3: apply uses preflight-verified bytes via stdin, not the on-disk patch file", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });
    await writeFile(join(handle.worktreePath, "source.txt"), "accepted\n", "utf8");
    const patch = await collectWorktreePatch(handle, artifactRoot);

    const preflight = await preflightAcceptedPatch(handle, patch, repositoryPath);

    // Tamper the on-disk patch file AFTER preflight. If the apply step
    // re-reads from disk it will fail; if it pipes the preflight bytes
    // (correct path) it will succeed.
    await writeFile(patch.patchPath, Buffer.from("--- this is not a real git patch ---\n", "utf8"));
    expect(createHash("sha256").update(await readFile(patch.patchPath)).digest("hex"))
      .not.toBe(patch.patchBlobHash);

    const applied = await applyPreflightedPatch(preflight);

    expect(applied.status).toBe("applied");
    expect((await readFile(join(repositoryPath, "source.txt"), "utf8")).replace(/\r\n/g, "\n"))
      .toBe("accepted\n");
  });

  // ---------------------------------------------------------------------------
  // P0#4 — Normal ACCEPT must verify the FULL working-tree change set
  // after `git apply`. An unrelated user edit / untracked file in the
  // target workspace must flip the comparison to DIVERGED, never
  // silently accepted. We inject the unrelated file AFTER preflight
  // (which would otherwise catch it via DIRTY_TARGET) and BEFORE the
  // post-apply full change set check.
  // ---------------------------------------------------------------------------
  it("P0#4: full working-tree change set rejects an unrelated file in the target", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });
    await writeFile(join(handle.worktreePath, "source.txt"), "accepted\n", "utf8");
    const patch = await collectWorktreePatch(handle, artifactRoot);

    // Run preflight first while the target is still clean (otherwise
    // preflight would refuse with DIRTY_TARGET before the apply step).
    const preflight = await preflightAcceptedPatch(handle, patch, repositoryPath);
    // Now inject the unrelated file into the target workspace. This
    // simulates a concurrent user edit / untracked file that lands
    // between preflight and the post-apply full change set check.
    await writeFile(join(repositoryPath, "unrelated.txt"), "user-added\n", "utf8");

    await expect(applyPreflightedPatch(preflight))
      .rejects.toMatchObject({ code: "PATCH_RESULT_MISMATCH" });
    // The unrelated file must not be touched by the failed apply.
    expect((await readFile(join(repositoryPath, "unrelated.txt"), "utf8")).replace(/\r\n/g, "\n"))
      .toBe("user-added\n");
  });

  it("refuses to apply when the target workspace is dirty", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });
    await writeFile(join(handle.worktreePath, "source.txt"), "worker\n", "utf8");
    const patch = await collectWorktreePatch(handle, artifactRoot);
    await writeFile(join(repositoryPath, "source.txt"), "user edit\n", "utf8");

    await expect(
      applyAcceptedPatch(handle, patch, repositoryPath),
    ).rejects.toMatchObject({ code: "DIRTY_TARGET" });
  });

  it("refuses to apply when target HEAD moved away from the frozen base", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });
    await writeFile(join(handle.worktreePath, "source.txt"), "worker\n", "utf8");
    const patch = await collectWorktreePatch(handle, artifactRoot);
    await writeFile(join(repositoryPath, "main-only.txt"), "commit\n", "utf8");
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, ["commit", "-m", "move main"]);

    await expect(
      applyAcceptedPatch(handle, patch, repositoryPath),
    ).rejects.toMatchObject({ code: "BASE_REVISION_MISMATCH" });
  });

  it("detects a tampered patch before applying it", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });
    await writeFile(join(handle.worktreePath, "source.txt"), "worker\n", "utf8");
    const patch = await collectWorktreePatch(handle, artifactRoot);
    await writeFile(patch.patchPath, "tampered", "utf8");

    await expect(
      applyAcceptedPatch(handle, patch, repositoryPath),
    ).rejects.toMatchObject({ code: "PATCH_HASH_MISMATCH" });
  });

  it("preserves binary files through patch collection and apply", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });
    const binary = Buffer.from([0, 255, 1, 254, 10, 13, 128, 64]);
    await writeFile(join(handle.worktreePath, "binary.dat"), binary);
    const patch = await collectWorktreePatch(handle, artifactRoot);

    await applyAcceptedPatch(handle, patch, repositoryPath);

    expect(await readFile(join(repositoryPath, "binary.dat"))).toEqual(binary);
  });

  it("returns no_changes for an unchanged worktree", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });
    const patch = await collectWorktreePatch(handle, artifactRoot);

    expect(patch.empty).toBe(true);
    const applied = await applyAcceptedPatch(handle, patch, repositoryPath);
    expect(applied.status).toBe("no_changes");
    expect(await git(repositoryPath, ["status", "--porcelain"])).toBe("");
  });

  it("removes only the registered temporary worktree", async () => {
    handle = await createTemporaryWorktree({
      workspaceId: "robot-arm",
      repositoryPath,
      baseRevision,
      worktreeRoot,
    });
    const removedPath = handle.worktreePath;

    await removeTemporaryWorktree(handle);
    handle = undefined;

    const list = await git(repositoryPath, ["worktree", "list", "--porcelain"]);
    expect(list).not.toContain(removedPath);
    await expect(readFile(join(repositoryPath, "source.txt"), "utf8")).resolves.toBe("before\n");
  });

  it("rejects a non-git repository", async () => {
    const plain = join(tempRoot, "plain");
    await mkdir(plain, { recursive: true });

    await expect(
      createTemporaryWorktree({
        workspaceId: "plain",
        repositoryPath: plain,
        baseRevision: "HEAD",
        worktreeRoot,
      }),
    ).rejects.toBeInstanceOf(TemporaryWorktreeError);
  });
});
