import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { G2MLocalConfig } from "../../src/cli/config.js";
import { planRepair, RepairActionError } from "../../src/operations/repair.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function config(root: string): G2MLocalConfig {
  return {
    protocol_version: "g2m.local-config.v1",
    workspaces: [{ workspace_id: "ws-1", path: join(root, "workspace") }],
    verification_profiles: [], worktree_root: join(root, "worktrees"), artifact_root: join(root, "artifacts"), state_root: join(root, "state"),
    storage: { min_free_bytes: 0, safety_margin_bytes: 0, default_execution_reservation_bytes: 100, max_total_bytes: 0, max_artifact_bytes: 0, max_worktree_bytes: 0, completed_retention_days: 30, reservation_ttl_ms: 60_000, monitor_interval_ms: 1_000 },
    review_timeout_ms: 60_000,
  };
}

describe("operational repair", () => {
  it("creates a dry-run plan without creating repair state", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-")); roots.push(root);
    const plan = await planRepair({ config: config(root), action: "projection-rebuild", apply: false, nowMs: 10 });
    expect(plan.schemaVersion).toBe("g2m.repair-plan.v1");
    expect(plan.permitted).toBe(true);
    await expect(access(join(root, "state", "repair"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unknown and bypass actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-")); roots.push(root);
    await expect(planRepair({ config: config(root), action: "all", apply: false })).rejects.toBeInstanceOf(RepairActionError);
    await expect(planRepair({ config: config(root), action: "--force", apply: false })).rejects.toBeInstanceOf(RepairActionError);
  });
});
