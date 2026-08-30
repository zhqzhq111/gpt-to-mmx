import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceLock } from "../../src/workspace/lock.js";

describe("startup lease reconciliation and recovery takeover", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ root: string; workspacePath: string; stateRoot: string }> {
    const root = await mkdtemp(join(tmpdir(), "g2m-lease-lifecycle-"));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspacePath);
    return { root, workspacePath, stateRoot };
  }

  it("startup reconciliation reclaims only stale terminal leases", async () => {
    const { workspacePath, stateRoot } = await fixture();
    let now = 0;
    const lock = new WorkspaceLock({
      stateRoot,
      heartbeatIntervalMs: 1_000,
      staleAfterMs: 3_000,
      dependencies: { now: () => now, hostname: () => "test-host", randomUUID: () => "lease-terminal", pidProbe: () => "DEAD" },
    });
    const handle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec-terminal" });
    now = 3_001;

    const report = await lock.reconcileStartupLeases(new Map([["exec-terminal", "TERMINAL"]]));

    expect(report.reclaimedExecutionIds).toEqual(["exec-terminal"]);
    await expect(stat(handle.ownerPath)).rejects.toBeTruthy();
  });

  it("startup reconciliation holds active and recovery-critical leases", async () => {
    const { root, workspacePath, stateRoot } = await fixture();
    const secondWorkspacePath = join(root, "workspace-2");
    await mkdir(secondWorkspacePath);
    let now = 0;
    const lock = new WorkspaceLock({
      stateRoot,
      heartbeatIntervalMs: 1_000,
      staleAfterMs: 3_000,
      dependencies: { now: () => now, hostname: () => "test-host", randomUUID: () => "lease-held", pidProbe: () => "DEAD" },
    });
    const handle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec-held" });
    const secondHandle = await lock.acquire({ workspaceId: "demo-2", canonicalPath: secondWorkspacePath, executionId: "exec-recovery" });
    now = 3_001;

    const report = await lock.reconcileStartupLeases(new Map([
      ["exec-held", "ACTIVE"],
      ["exec-recovery", "RECOVERY_REQUIRED"],
    ]));

    expect(report.reclaimedExecutionIds).toEqual([]);
    await expect(stat(handle.ownerPath)).resolves.toBeTruthy();
    lock.release(handle);
    lock.release(secondHandle);
  });

  it("explicit recovery takes over a proven-gone stale lease with a new lease ID", async () => {
    const { workspacePath, stateRoot } = await fixture();
    let now = 0;
    let nextLease = 0;
    const lock = new WorkspaceLock({
      stateRoot,
      heartbeatIntervalMs: 1_000,
      staleAfterMs: 3_000,
      dependencies: {
        now: () => now,
        hostname: () => "test-host",
        randomUUID: () => `lease-${++nextLease}`,
        pidProbe: () => "DEAD",
      },
    });
    const oldHandle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec-recover" });
    const oldOwner = await readFile(oldHandle.ownerPath, "utf8");
    now = 3_001;

    const recovery = await lock.takeoverRecoveryLease({
      workspaceId: "demo",
      canonicalPath: workspacePath,
      executionId: "exec-recover",
      processStatus: "exited_clean",
    });

    expect(recovery.executionId).toBe("exec-recover");
    expect(recovery.leaseId).not.toBe(oldHandle.leaseId);
    expect(await readFile(recovery.ownerPath, "utf8")).not.toBe(oldOwner);
    lock.release(recovery);
  });

  it("does not mutate a lease for alive or unknown recovery status", async () => {
    const { workspacePath, stateRoot } = await fixture();
    let now = 3_001;
    const lock = new WorkspaceLock({
      stateRoot,
      heartbeatIntervalMs: 1_000,
      staleAfterMs: 3_000,
      dependencies: { now: () => now, hostname: () => "test-host", randomUUID: () => "lease-old", pidProbe: () => "DEAD" },
    });
    const oldHandle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec-recover" });
    const ownerBefore = await readFile(oldHandle.ownerPath, "utf8");
    for (const processStatus of ["alive", "unknown"] as const) {
      await expect(lock.takeoverRecoveryLease({
        workspaceId: "demo",
        canonicalPath: workspacePath,
        executionId: "exec-recover",
        processStatus,
      })).rejects.toMatchObject({ code: "RECLAIM_NOT_ALLOWED" });
      expect(await readFile(oldHandle.ownerPath, "utf8")).toBe(ownerBefore);
    }
    lock.release(oldHandle);
  });

  it("cannot recover by stealing another execution's lease", async () => {
    const { workspacePath, stateRoot } = await fixture();
    const lock = new WorkspaceLock({
      stateRoot,
      heartbeatIntervalMs: 1_000,
      staleAfterMs: 3_000,
      dependencies: { now: () => 31, hostname: () => "test-host", randomUUID: () => "lease-other", pidProbe: () => "DEAD" },
    });
    const oldHandle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec-other" });

    await expect(lock.takeoverRecoveryLease({
      workspaceId: "demo",
      canonicalPath: workspacePath,
      executionId: "exec-recover",
      processStatus: "exited_error",
    })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await readFile(oldHandle.ownerPath, "utf8")).toContain('"execution_id":"exec-other"');
    lock.release(oldHandle);
  });
});
