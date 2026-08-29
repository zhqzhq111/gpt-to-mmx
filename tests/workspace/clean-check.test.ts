/**
 * Clean Worktree Check — plan §16
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { requireCleanWorktree, CleanCheckError } from "../../src/workspace/clean-check.js";

const execFileAsync = promisify(execFile);

describe("requireCleanWorktree", () => {
  let tmpRoot: string;
  let repoDir: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "g2m-clean-"));
    repoDir = join(tmpRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@g2m.local"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "G2M Test"], { cwd: repoDir });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
    await writeFile(join(repoDir, "README.md"), "hello\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("passes on a clean repo (plan §16)", async () => {
    await expect(requireCleanWorktree(repoDir)).resolves.toBeUndefined();
  });

  it("rejects on a modified file with DIRTY_WORKSPACE", async () => {
    await writeFile(join(repoDir, "README.md"), "modified\n");
    try {
      await expect(requireCleanWorktree(repoDir)).rejects.toBeInstanceOf(
        CleanCheckError,
      );
      await expect(requireCleanWorktree(repoDir)).rejects.toMatchObject({
        code: "DIRTY_WORKSPACE",
        dirtyFiles: expect.arrayContaining([expect.stringMatching(/README\.md/)]),
      });
    } finally {
      await execFileAsync("git", ["checkout", "--", "README.md"], { cwd: repoDir });
    }
  });

  it("rejects on an untracked file (plan §16 also counts untracked as dirty)", async () => {
    await writeFile(join(repoDir, "scratch.txt"), "temp\n");
    try {
      await expect(requireCleanWorktree(repoDir)).rejects.toMatchObject({
        code: "DIRTY_WORKSPACE",
      });
    } finally {
      await rm(join(repoDir, "scratch.txt"), { force: true });
    }
  });

  it("throws NOT_GIT_REPO for a non-git directory", async () => {
    const plainDir = join(tmpRoot, "plain");
    await mkdir(plainDir, { recursive: true });
    await expect(requireCleanWorktree(plainDir)).rejects.toMatchObject({
      code: "NOT_GIT_REPO",
    });
  });
});
