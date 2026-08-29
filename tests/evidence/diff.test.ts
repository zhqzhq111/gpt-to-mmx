/**
 * Git Diff Collector — plan §27-28 + §30 + §45
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { collectDiff, DiffError } from "../../src/evidence/diff.js";
import { captureBaseline } from "../../src/workspace/baseline.js";

const execFileAsync = promisify(execFile);

describe("collectDiff", () => {
  let tmpRoot: string;
  let repoDir: string;
  let baseRevision: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "g2m-diff-"));
    repoDir = join(tmpRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@g2m.local"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "G2M Test"], { cwd: repoDir });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });

    // 第一次 commit,让 baseline 有 head
    await writeFile(join(repoDir, "README.md"), "hello\n");
    await writeFile(join(repoDir, "src.ts"), "export const a = 1;\n");
    await mkdir(join(repoDir, "tests"), { recursive: true });
    await writeFile(join(repoDir, "tests/existing.test.ts"), "test('x', () => {});\n");
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });

    const b = await captureBaseline(repoDir);
    baseRevision = b.baseRevision;
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 重置 README + src.ts 到 baseline 状态,删任何 leftover
    await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd: repoDir });
    await execFileAsync("git", ["clean", "-fd"], { cwd: repoDir });
  });

  it("returns empty diff on a clean repo (no Worker changes)", async () => {
    const d = await collectDiff(repoDir, baseRevision);
    expect(d.changedFiles).toEqual([]);
    expect(d.untrackedFiles).toEqual([]);
    expect(d.deletedFiles).toEqual([]);
    expect(d.fullDiff).toBe("");
    expect(d.diffStat).toBe("");
    expect(d.protectedFilesTouched).toEqual([]);
    expect(d.diffHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("captures a modified file in changedFiles (plan §27)", async () => {
    await writeFile(join(repoDir, "src.ts"), "export const a = 2;\n");
    const d = await collectDiff(repoDir, baseRevision);
    expect(d.changedFiles.map((c) => c.path)).toContain("src.ts");
    expect(d.changedFiles.find((c) => c.path === "src.ts")?.status).toBe("M");
    expect(d.fullDiff).toContain("export const a = 2");
    expect(d.protectedFilesTouched).toEqual([]);
  });

  it("captures untracked file in both untrackedFiles and changedFiles (plan §27)", async () => {
    await writeFile(join(repoDir, "new-file.ts"), "// new\n");
    const d = await collectDiff(repoDir, baseRevision);
    expect(d.untrackedFiles).toContain("new-file.ts");
    expect(
      d.changedFiles.find((c) => c.path === "new-file.ts")?.status,
    ).toBe("?");
  });

  it("keeps diffHash stable when an untracked file is staged", async () => {
    await writeFile(join(repoDir, "new-file.ts"), "// new\n");
    const beforeStaging = await collectDiff(repoDir, baseRevision);

    await execFileAsync("git", ["add", "new-file.ts"], { cwd: repoDir });
    const afterStaging = await collectDiff(repoDir, baseRevision);

    expect(afterStaging.diffHash).toBe(beforeStaging.diffHash);
  });

  it("flags a test file change as protected (plan §30)", async () => {
    await writeFile(
      join(repoDir, "tests/existing.test.ts"),
      "test('x modified', () => {});\n",
    );
    const d = await collectDiff(repoDir, baseRevision);
    expect(d.protectedFilesTouched).toContain("tests/existing.test.ts");
  });

  it("flags package.json change as protected (plan §30 build config)", async () => {
    await writeFile(join(repoDir, "package.json"), '{ "name": "x" }\n');
    const d = await collectDiff(repoDir, baseRevision);
    expect(d.protectedFilesTouched).toContain("package.json");
  });

  it("throws NOT_GIT_REPO for a non-git directory", async () => {
    const plainDir = join(tmpRoot, "plain");
    await mkdir(plainDir, { recursive: true });
    await expect(collectDiff(plainDir, baseRevision)).rejects.toBeInstanceOf(
      DiffError,
    );
  });

  it("diffHash is stable for identical diff content (review binding, plan §45)", async () => {
    await writeFile(join(repoDir, "src.ts"), "export const a = 42;\n");
    const d1 = await collectDiff(repoDir, baseRevision);
    const d2 = await collectDiff(repoDir, baseRevision);
    expect(d1.diffHash).toBe(d2.diffHash);
  });
});
