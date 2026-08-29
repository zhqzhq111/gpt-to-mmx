import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { computeIndexedChangeSet } from "../../src/workspace/change-set.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, windowsHide: true });
  return stdout.trim();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("computeIndexedChangeSet", () => {
  it("represents rename as deleted old path plus final new path", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-change-set-"));
    roots.push(root);
    await git(root, ["init", "--initial-branch=main"]);
    await git(root, ["config", "user.email", "g2m@test.local"]);
    await git(root, ["config", "user.name", "G2M Test"]);
    await writeFile(join(root, "old.txt"), "same bytes\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "baseline"]);
    const base = await git(root, ["rev-parse", "HEAD"]);

    await mkdir(join(root, "nested"));
    await git(root, ["mv", "old.txt", "nested/new.txt"]);
    await git(root, ["add", "-A"]);

    const result = await computeIndexedChangeSet(root, base);

    expect(result.entries).toEqual([
      { path: "nested/new.txt", kind: "file", mode: "100644", content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { path: "old.txt", kind: "deleted", mode: null, content_sha256: null },
    ]);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("identifies mode-only, symlink, and gitlink index entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-change-set-modes-"));
    roots.push(root);
    await git(root, ["init", "--initial-branch=main"]);
    await git(root, ["config", "user.email", "g2m@test.local"]);
    await git(root, ["config", "user.name", "G2M Test"]);
    await writeFile(join(root, "script.sh"), "echo ok\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "baseline"]);
    const base = await git(root, ["rev-parse", "HEAD"]);

    await git(root, ["update-index", "--chmod=+x", "script.sh"]);
    await writeFile(join(root, "link-target.txt"), "target/path", "utf8");
    const linkBlob = await git(root, ["hash-object", "-w", "link-target.txt"]);
    await git(root, ["update-index", "--add", "--cacheinfo", `120000,${linkBlob},link`]);
    await git(root, ["update-index", "--add", "--cacheinfo", `160000,${base},vendor/submodule`]);

    const result = await computeIndexedChangeSet(root, base);

    expect(result.entries).toContainEqual({
      path: "script.sh",
      kind: "file",
      mode: "100755",
      content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.entries).toContainEqual({
      path: "link",
      kind: "symlink",
      mode: "120000",
      content_sha256: createHash("sha256").update("target/path").digest("hex"),
    });
    expect(result.entries).toContainEqual({
      path: "vendor/submodule",
      kind: "gitlink",
      mode: "160000",
      content_sha256: base,
    });
  });
});
