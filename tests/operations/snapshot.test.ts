import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { G2MLocalConfig } from "../../src/cli/config.js";
import { buildOperationalSnapshot } from "../../src/operations/snapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(root: string): G2MLocalConfig {
  return {
    protocol_version: "g2m.local-config.v1",
    workspaces: [{ workspace_id: "ws-1", path: join(root, "workspace") }],
    verification_profiles: [],
    worktree_root: join(root, "worktrees"),
    artifact_root: join(root, "artifacts"),
    state_root: join(root, "state"),
    storage: {
      min_free_bytes: 0,
      safety_margin_bytes: 0,
      default_execution_reservation_bytes: 100,
      max_total_bytes: 0,
      max_artifact_bytes: 0,
      max_worktree_bytes: 0,
      completed_retention_days: 30,
      reservation_ttl_ms: 60_000,
      monitor_interval_ms: 1_000,
    },
    review_timeout_ms: 60_000,
  };
}

describe("read-only operational snapshot", () => {
  it("reports missing state roots without creating directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-snapshot-"));
    roots.push(root);

    const snapshot = await buildOperationalSnapshot({ config: config(root), nowMs: 100 });

    expect(snapshot.schemaVersion).toBe("g2m.status.v1");
    expect(snapshot.generatedAt).toBe(100);
    expect(snapshot.stateRoot.stateRootExists).toBe(false);
    expect(snapshot.stateRoot.executionsDirectoryExists).toBe(false);
    await expect(stat(join(root, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues filesystem reporting when the projection database is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-snapshot-"));
    roots.push(root);
    await mkdir(join(root, "state", "executions"), { recursive: true });
    await mkdir(join(root, "artifacts"), { recursive: true });
    await writeFile(join(root, "state", "executions", "orphan"), "not a directory");

    const before = await stat(join(root, "state", "executions", "orphan"));
    const snapshot = await buildOperationalSnapshot({ config: config(root) });
    const after = await stat(join(root, "state", "executions", "orphan"));

    expect(snapshot.projection.status).toBe("MISSING");
    expect(snapshot.stateRoot.executionsDirectoryExists).toBe(true);
    expect(before.size).toBe(after.size);
    expect(before.mtimeMs).toBe(after.mtimeMs);
  });
});
