import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { StateDatabase } from "../../src/projection/database.js";
import { rebuildStorageUsageFromManifests, writeStorageManifestAtomic } from "../../src/storage/usage.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("storage usage projection rebuild", () => {
  it("restores storage_usage from execution manifests after SQLite is recreated", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-usage-rebuild-"));
    roots.push(root);
    await mkdir(join(root, "executions", "exec-1"), { recursive: true });
    await writeStorageManifestAtomic(join(root, "executions", "exec-1", "storage-manifest.json"), {
      executionId: "exec-1",
      artifactBytes: 11,
      worktreeBytes: 22,
      artifactPath: "artifact",
      worktreePath: "worktree",
      retentionClass: "NORMAL",
      gcEligibleAt: 33,
      updatedAt: 44,
    });
    const database = new StateDatabase(join(root, "state.sqlite"));
    expect(rebuildStorageUsageFromManifests({ stateRoot: root, database, nowMs: 99 })).toEqual({ rebuilt: 1, skipped: 0 });
    expect(database.prepare("SELECT * FROM storage_usage").all()).toEqual([
      { execution_id: "exec-1", artifact_bytes: 11, worktree_bytes: 22, updated_at: 44 },
    ]);
    database.close();
  });
});
