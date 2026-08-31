import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  WorkspaceLock,
  WorkspaceLockError,
  classifyLeasePolicy,
  resolveEffectiveLeasePolicy,
  workspaceKeyForPath,
  type LockHandle,
} from "../../src/workspace/lock.js";

describe("durable WorkspaceLock", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ stateRoot: string; workspacePath: string }> {
    const root = await mkdtemp(join(tmpdir(), "g2m-lease-"));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    await stat(root);
    return { stateRoot: join(root, "state"), workspacePath };
  }

  it("creates an immutable owner file through the async durable API", async () => {
    const { stateRoot, workspacePath } = await fixture();
    const lock = new WorkspaceLock({
      stateRoot,
      dependencies: {
        now: () => 1_000,
        hostname: () => "test-host",
        randomUUID: () => "lease-1",
        pidProbe: () => "ALIVE",
      },
    });

    const handle = await lock.acquire({
      workspaceId: "demo",
      canonicalPath: workspacePath,
      executionId: "exec-1",
    });

    expect(handle).toMatchObject<Partial<LockHandle>>({
      workspaceId: "demo",
      workspaceKey: await workspaceKeyForPath(workspacePath),
      executionId: "exec-1",
      leaseId: "lease-1",
      pid: process.pid,
      hostname: "test-host",
      acquiredAt: 1_000,
    });
    expect(await readFile(handle.ownerPath, "utf8")).toBe(JSON.stringify({
      lock_version: 1,
      workspace_key: handle.workspaceKey,
      workspace_id: "demo",
      execution_id: "exec-1",
      lease_id: "lease-1",
      pid: process.pid,
      hostname: "test-host",
      created_at: 1_000,
      heartbeat_at: 1_000,
    }) + "\n");
    expect(await readdir(join(stateRoot, "locks"))).toContain(`${handle.workspaceKey}.lock`);

    await lock.release(handle);
    await expect(stat(handle.ownerPath)).rejects.toBeTruthy();
  });

  it("allows only one independent manager to acquire the same physical workspace", async () => {
    const { stateRoot, workspacePath } = await fixture();
    const makeLock = (leaseId: string) => new WorkspaceLock({
      stateRoot,
      dependencies: {
        now: () => 2_000,
        hostname: () => "test-host",
        randomUUID: () => leaseId,
        pidProbe: () => "ALIVE",
      },
    });

    const [left, right] = [makeLock("left"), makeLock("right")];
    const results = await Promise.allSettled([
      left.acquire({ workspaceId: "left-id", canonicalPath: workspacePath, executionId: "left-exec" }),
      right.acquire({ workspaceId: "right-id", canonicalPath: workspacePath, executionId: "right-exec" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "WORKSPACE_BUSY" }),
    });

    const acquired = results.find((result): result is PromiseFulfilledResult<LockHandle> =>
      result.status === "fulfilled"
    )!;
    await (acquired.value.workspaceId === "left-id" ? left : right).release(acquired.value);
  });

  it("rejects empty identifiers before touching the filesystem", async () => {
    const { stateRoot, workspacePath } = await fixture();
    const lock = new WorkspaceLock({ stateRoot });

    await expect(lock.acquire({
      workspaceId: " ",
      canonicalPath: workspacePath,
      executionId: "exec-1",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("updates only the atomic heartbeat sidecar", async () => {
    const { stateRoot, workspacePath } = await fixture();
    let now = 3_000;
    const lock = new WorkspaceLock({
      stateRoot,
      dependencies: {
        now: () => now,
        hostname: () => "test-host",
        randomUUID: () => "lease-heartbeat",
        pidProbe: () => "ALIVE",
      },
    });

    const handle = await lock.acquire({
      workspaceId: "demo",
      canonicalPath: workspacePath,
      executionId: "exec-heartbeat",
    });
    const ownerBefore = await readFile(handle.ownerPath, "utf8");
    now = 4_000;
    await lock.heartbeat(handle);

    expect(await readFile(handle.ownerPath, "utf8")).toBe(ownerBefore);
    expect(await readFile(handle.heartbeatPath, "utf8")).toContain('"heartbeat_at":4000');
    expect(await readdir(join(stateRoot, "locks"))).not.toContain(expect.stringContaining(".tmp-"));
    lock.release(handle);
  });

  it("keeps the owner immutable while heartbeat refreshes continue", async () => {
    const { stateRoot, workspacePath } = await fixture();
    let now = 5_000;
    const lock = new WorkspaceLock({
      stateRoot,
      heartbeatIntervalMs: 10,
      staleAfterMs: 30,
      dependencies: {
        now: () => now,
        hostname: () => "test-host",
        randomUUID: () => "lease-refresh",
        pidProbe: () => "ALIVE",
      },
    });
    const handle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec-refresh" });
    const ownerBefore = await readFile(handle.ownerPath, "utf8");
    now = 5_100;
    await lock.heartbeat(handle);
    const heartbeat = JSON.parse(await readFile(handle.heartbeatPath, "utf8")) as Record<string, unknown>;

    expect(await readFile(handle.ownerPath, "utf8")).toBe(ownerBefore);
    expect(heartbeat).toMatchObject({ lease_id: "lease-refresh", heartbeat_at: 5_100 });
    await lock.release(handle);
  });

  it("stops an old handle from refreshing a replacement lease", async () => {
    const { stateRoot, workspacePath } = await fixture();
    const first = new WorkspaceLock({
      stateRoot,
      dependencies: { randomUUID: () => "lease-old", hostname: () => "test-host", pidProbe: () => "ALIVE" },
    });
    const second = new WorkspaceLock({
      stateRoot,
      dependencies: { randomUUID: () => "lease-new", hostname: () => "test-host", pidProbe: () => "ALIVE" },
    });
    const oldHandle = await first.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "old" });
    await rm(oldHandle.ownerPath);
    const newHandle = await second.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "new" });
    await expect(first.heartbeat(oldHandle)).rejects.toMatchObject({ code: "STALE_HANDLE" });
    await expect(readFile(newHandle.heartbeatPath, "utf8")).resolves.toContain('"lease_id":"lease-new"');
    second.release(newHandle);
  });

  it("does not let an old handle delete a replacement owner", async () => {
    const { stateRoot, workspacePath } = await fixture();
    const first = new WorkspaceLock({
      stateRoot,
      dependencies: { randomUUID: () => "lease-old", hostname: () => "test-host", pidProbe: () => "ALIVE" },
    });
    const second = new WorkspaceLock({
      stateRoot,
      dependencies: { randomUUID: () => "lease-new", hostname: () => "test-host", pidProbe: () => "ALIVE" },
    });
    const oldHandle = await first.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "old" });
    await rm(oldHandle.ownerPath);
    const newHandle = await second.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "new" });

    expect(() => first.release(oldHandle)).toThrow(/no longer owns/);
    expect(await readFile(newHandle.ownerPath, "utf8")).toContain('"lease_id":"lease-new"');
    second.release(newHandle);
  });

  it("reclaims only a terminal lease with stale heartbeat and dead PID", async () => {
    const { stateRoot, workspacePath } = await fixture();
    let now = 0;
    const lock = new WorkspaceLock({
      stateRoot,
      heartbeatIntervalMs: 10,
      staleAfterMs: 30,
      dependencies: {
        now: () => now,
        hostname: () => "test-host",
        randomUUID: () => "lease-stale",
        pidProbe: () => "DEAD",
      },
    });
    const handle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "old" });
    now = 31;

    const reclaimed = await lock.reclaimStaleLease({
      workspaceKey: handle.workspaceKey,
      journalState: "TERMINAL",
    });

    expect(reclaimed.lease_id).toBe("lease-stale");
    await expect(stat(handle.ownerPath)).rejects.toBeTruthy();
  });

  it("cleans a stale dead reclaim guard before acquiring it", async () => {
    const { stateRoot, workspacePath } = await fixture();
    const lock = new WorkspaceLock({
      stateRoot,
      reclaimGuardStaleMs: 30,
      dependencies: { now: () => 100, hostname: () => "test-host", randomUUID: () => "lease-guard", pidProbe: () => "DEAD" },
    });
    const handle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec" });
    const reclaimPath = join(stateRoot, "locks", `${handle.workspaceKey}.reclaim`);
    await writeFile(reclaimPath, JSON.stringify({
      reclaim_version: 1,
      workspace_key: handle.workspaceKey,
      pid: 99999,
      hostname: "test-host",
      created_at: 0,
    }) + "\n", "utf8");

    lock.release(handle);
    await expect(stat(reclaimPath)).rejects.toBeTruthy();
  });

  it("inspects owner and sidecar freshness without mutating either file", async () => {
    const { stateRoot, workspacePath } = await fixture();
    let now = 0;
    const lock = new WorkspaceLock({
      stateRoot,
      dependencies: { now: () => now, hostname: () => "test-host", randomUUID: () => "lease-inspect", pidProbe: () => "DEAD" },
    });
    const handle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec" });
    now = 100;
    const ownerBefore = await readFile(handle.ownerPath, "utf8");
    const heartbeatBefore = await readFile(handle.heartbeatPath, "utf8");

    const inspection = await lock.inspectWorkspaceLease({ workspaceKey: handle.workspaceKey });

    expect(inspection).toMatchObject({
      workspaceKey: handle.workspaceKey,
      owner: expect.objectContaining({ lease_id: "lease-inspect" }),
      heartbeat: expect.objectContaining({ lease_id: "lease-inspect" }),
      pidStatus: "DEAD",
      ageMs: 100,
      heartbeatAgeMs: 100,
    });
    expect(await readFile(handle.ownerPath, "utf8")).toBe(ownerBefore);
    expect(await readFile(handle.heartbeatPath, "utf8")).toBe(heartbeatBefore);
    lock.release(handle);
  });

  it("never reclaims a stale lease while its PID is alive or unknown", async () => {
    const { stateRoot, workspacePath } = await fixture();
    let now = 0;
    const lock = new WorkspaceLock({
      stateRoot,
      heartbeatIntervalMs: 10,
      staleAfterMs: 30,
      dependencies: { now: () => now, hostname: () => "test-host", randomUUID: () => "lease-live", pidProbe: () => "ALIVE" },
    });
    const handle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec" });
    now = 31;
    await expect(lock.reclaimStaleLease({ workspaceKey: handle.workspaceKey, journalState: "TERMINAL" }))
      .rejects.toMatchObject({ code: "RECLAIM_NOT_ALLOWED" });
    expect(await stat(handle.ownerPath)).toBeTruthy();
    lock.release(handle);
  });

  it("never reclaims foreign-host or RECOVERY_REQUIRED leases", async () => {
    const { stateRoot, workspacePath } = await fixture();
    let now = 0;
    const ownerLock = new WorkspaceLock({
      stateRoot,
      heartbeatIntervalMs: 10,
      staleAfterMs: 30,
      dependencies: { now: () => now, hostname: () => "remote-host", randomUUID: () => "lease-remote", pidProbe: () => "DEAD" },
    });
    const inspector = new WorkspaceLock({
      stateRoot,
      heartbeatIntervalMs: 10,
      staleAfterMs: 30,
      dependencies: { now: () => now, hostname: () => "test-host", randomUUID: () => "lease-local", pidProbe: () => "DEAD" },
    });
    const handle = await ownerLock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec" });
    now = 31;
    await expect(inspector.reclaimStaleLease({ workspaceKey: handle.workspaceKey, journalState: "TERMINAL" }))
      .rejects.toMatchObject({ code: "FOREIGN_HOST_LEASE" });
    await expect(inspector.reclaimStaleLease({ workspaceKey: handle.workspaceKey, journalState: "RECOVERY_REQUIRED" }))
      .rejects.toMatchObject({ code: "RECLAIM_NOT_ALLOWED" });
    ownerLock.release(handle);
  });

  it("reports malformed owner and heartbeat states read-only", async () => {
    const { stateRoot, workspacePath } = await fixture();
    const lock = new WorkspaceLock({ stateRoot });
    const key = await workspaceKeyForPath(workspacePath);
    const ownerPath = join(stateRoot, "locks", `${key}.lock`);
    await mkdir(join(stateRoot, "locks"), { recursive: true });
    await writeFile(ownerPath, "", "utf8");
    await expect(lock.inspectWorkspaceLease({ workspaceKey: key })).resolves.toMatchObject({
      owner: "INCOMPLETE",
      heartbeat: "MISSING",
    });
    await writeFile(ownerPath, "not-json", "utf8");
    await expect(lock.inspectWorkspaceLease({ workspaceKey: key })).resolves.toMatchObject({
      owner: "MALFORMED",
      heartbeat: "MISSING",
    });
  });

  it("rejects oversized and non-regular lease files without reading unbounded data", async () => {
    const { stateRoot, workspacePath } = await fixture();
    const lock = new WorkspaceLock({ stateRoot });
    const key = await workspaceKeyForPath(workspacePath);
    const ownerPath = join(stateRoot, "locks", `${key}.lock`);
    await mkdir(join(stateRoot, "locks"), { recursive: true });
    await writeFile(ownerPath, "x".repeat(64 * 1024 + 1), "utf8");
    await expect(lock.inspectWorkspaceLease({ workspaceKey: key })).resolves.toMatchObject({ owner: "MALFORMED" });
    await rm(ownerPath);
    await mkdir(ownerPath);
    await expect(lock.inspectWorkspaceLease({ workspaceKey: key })).resolves.toMatchObject({ owner: "MALFORMED" });
  });

  it("classifies policy using host, PID, heartbeat, and Journal state", () => {
    const owner = {
      lock_version: 1 as const,
      workspace_key: "a".repeat(64), workspace_id: "demo", execution_id: "exec",
      lease_id: "lease", pid: 123, hostname: "test-host", created_at: 0, heartbeat_at: 0,
    };
    const heartbeat = { heartbeat_version: 1 as const, workspace_key: owner.workspace_key, lease_id: "lease", heartbeat_at: 0 };
    const base = {
      workspaceKey: owner.workspace_key, owner, heartbeat, pidStatus: "DEAD" as const,
      ageMs: 100, heartbeatAgeMs: 100,
    };
    expect(classifyLeasePolicy({ inspection: base, journalState: "TERMINAL", staleAfterMs: 30, currentHostname: "test-host" }))
      .toBe("STALE_TERMINAL_RECLAIMABLE");
    expect(classifyLeasePolicy({ inspection: base, journalState: "ACTIVE", staleAfterMs: 30, currentHostname: "test-host" }))
      .toBe("ACTIVE_EXECUTION_STALE_OWNER");
    expect(classifyLeasePolicy({ inspection: base, journalState: "RECOVERY_REQUIRED", staleAfterMs: 30, currentHostname: "test-host" }))
      .toBe("RECOVERY_CRITICAL");
    expect(classifyLeasePolicy({ inspection: base, journalState: "TERMINAL", staleAfterMs: 30, currentHostname: "other-host" }))
      .toBe("FOREIGN_HOST");
  });
});

describe("effective workspace lease policy", () => {
  it("uses the same defaults and overrides as WorkspaceLock", () => {
    const defaults = resolveEffectiveLeasePolicy();
    expect(defaults).toEqual({
      heartbeat_interval_ms: 5_000,
      stale_after_ms: 30_000,
      incomplete_lease_grace_ms: 30_000,
      reclaim_guard_stale_ms: 30_000,
    });
    const custom = resolveEffectiveLeasePolicy({
      heartbeatIntervalMs: 1_000,
      staleAfterMs: 3_000,
      incompleteLeaseGraceMs: 4_000,
      reclaimGuardStaleMs: 5_000,
    });
    const lock = new WorkspaceLock({
      heartbeatIntervalMs: custom.heartbeat_interval_ms,
      staleAfterMs: custom.stale_after_ms,
      incompleteLeaseGraceMs: custom.incomplete_lease_grace_ms,
      reclaimGuardStaleMs: custom.reclaim_guard_stale_ms,
    });
    expect(lock.staleAfter).toBe(custom.stale_after_ms);
    expect(lock.incompleteGraceAfterMs).toBe(custom.incomplete_lease_grace_ms);
    expect(lock.reclaimGuardStaleAfterMs).toBe(custom.reclaim_guard_stale_ms);
  });
});
