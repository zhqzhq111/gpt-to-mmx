import { mkdir, mkdtemp, readFile, readlink, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readStorageManifest,
  scanExecutionUsage,
  writeStorageManifestAtomic,
} from "../../src/storage/usage.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("storage usage scanner", () => {
  it("counts nested regular files and treats missing roots as zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-storage-"));
    roots.push(root);
    const worktree = join(root, "worktree");
    const artifact = join(root, "artifact");
    await mkdir(join(worktree, "nested"), { recursive: true });
    await writeFile(join(worktree, "a.txt"), "12345");
    await writeFile(join(worktree, "nested", "b.txt"), "123");
    await writeFile(artifact, "xx");

    await expect(scanExecutionUsage({
      executionId: "exec-1",
      worktreePath: worktree,
      artifactPath: artifact,
    })).resolves.toMatchObject({ worktreeBytes: 8, artifactBytes: 2, totalBytes: 10 });
  });

  it.skipIf(process.platform === "win32")("does not follow a symlink outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-storage-link-"));
    roots.push(root);
    const outside = join(root, "outside");
    const worktree = join(root, "worktree");
    await mkdir(outside);
    await mkdir(worktree);
    await writeFile(join(outside, "secret.txt"), "secret-bytes");
    const externalLink = join(worktree, "external");
    await symlink(outside, externalLink, "dir");

    await expect(scanExecutionUsage({
      executionId: "exec-link",
      worktreePath: worktree,
      artifactPath: join(root, "missing-artifact"),
    })).resolves.toMatchObject({ artifactBytes: 0 });
    const usage = await scanExecutionUsage({
      executionId: "exec-link",
      worktreePath: worktree,
      artifactPath: join(root, "missing-artifact"),
    });
    expect(usage.worktreeBytes).toBe(Buffer.byteLength(await readlink(externalLink)));
  });
});

describe("storage manifest", () => {
  it("atomically writes versioned manifests with increasing generations", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-manifest-"));
    roots.push(root);
    const path = join(root, "storage-manifest.json");
    const first = await writeStorageManifestAtomic(path, {
      executionId: "exec-1",
      artifactBytes: 2,
      worktreeBytes: 8,
      artifactPath: join(root, "artifact"),
      worktreePath: join(root, "worktree"),
      retentionClass: "RETAINED",
      gcEligibleAt: null,
      updatedAt: 10,
    });
    const second = await writeStorageManifestAtomic(path, {
      executionId: "exec-1",
      artifactBytes: 3,
      worktreeBytes: 9,
      artifactPath: join(root, "artifact"),
      worktreePath: join(root, "worktree"),
      retentionClass: "RETAINED",
      gcEligibleAt: null,
      updatedAt: 20,
    });

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(await readStorageManifest(path)).toEqual(second);
    expect(await readFile(path, "utf8")).not.toContain("undefined");
  });
});
