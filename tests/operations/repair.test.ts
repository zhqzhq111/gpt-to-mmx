import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { G2MLocalConfig } from "../../src/cli/config.js";
import { executeRepair, planRepair, RepairActionError } from "../../src/operations/repair.js";
import type { OperationalSnapshot } from "../../src/operations/snapshot.js";

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

  it("refuses a plan whose preconditions changed after lock acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-")); roots.push(root);
    const base = await planRepair({ config: config(root), action: "projection-rebuild", apply: false, nowMs: 10 });
    void base;
    const snapshots: OperationalSnapshot[] = [];
    const makeSnapshot = (projectionStatus: "MISSING" | "OK"): OperationalSnapshot => ({
      schemaVersion: "g2m.status.v1", generatedAt: 10, stateRoot: { stateRootExists: true, executionsDirectoryExists: true, locksDirectoryExists: true, reservationsDirectoryExists: true, tombstonesDirectoryExists: true, projectionDatabaseExists: projectionStatus === "OK" },
      executions: [], workspaces: [], projection: { status: projectionStatus, databaseExists: projectionStatus === "OK", databaseReadable: projectionStatus === "OK", schemaVersion: projectionStatus === "OK" ? 1 : null, rebuildStatus: null, rebuildAt: null, staleExecutionCount: 0, projectionStaleEventCount: 0 },
      storage: { managedArtifactBytes: 0, managedWorktreeBytes: 0, managedTotalBytes: 0, activeReservedBytes: 0, maxTotalBytes: 0, maxArtifactBytes: 0, maxWorktreeBytes: 0, volumes: [] },
      recovery: { openRecoveryCases: 0, executionsRequiringRecovery: [], issuesByKind: {}, safeHoldCount: 0, reportOnlyCount: 0 },
      gc: { eligibleCount: 0, estimatedReclaimBytes: 0, interruptedCount: 0, cleanupPendingCount: 0, tombstoneCount: 0, invalidTombstoneCount: 0 },
    });
    snapshots.push(makeSnapshot("MISSING"), makeSnapshot("OK"));
    const result = await executeRepair({ config: config(root), action: "projection-rebuild", apply: true, nowMs: 10 }, {
      buildSnapshot: async () => snapshots.shift()!,
      dispatch: async () => { throw new Error("dispatch must not run"); },
    });
    expect(result.status).toBe("REFUSED");
    expect(result.reasons).toContain("REPAIR_PLAN_STALE");
  });
});
