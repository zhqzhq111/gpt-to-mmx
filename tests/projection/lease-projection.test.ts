import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ExecutionProjector } from "../../src/projection/execution-projector.js";
import { rebuildProjection } from "../../src/projection/rebuild.js";
import { StateDatabase } from "../../src/projection/database.js";
import { WorkspaceLock, workspaceKeyForPath } from "../../src/workspace/lock.js";

describe("workspace lease projection", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ root: string; workspacePath: string }> {
    const root = await mkdtemp(join(tmpdir(), "g2m-lease-projection-"));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    return { root, workspacePath };
  }

  it("upserts and conditionally deletes a lease projection", async () => {
    const { root, workspacePath } = await fixture();
    const lock = new WorkspaceLock({
      stateRoot: join(root, "state"),
      dependencies: { now: () => 10, hostname: () => "test-host", randomUUID: () => "lease-1", pidProbe: () => "ALIVE" },
    });
    const handle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec-1" });
    const owner = JSON.parse(await readFile(handle.ownerPath, "utf8")) as Parameters<ExecutionProjector["upsertWorkspaceLease"]>[0];
    const database = new StateDatabase(join(root, "state", "g2m-state.sqlite"));
    const projector = new ExecutionProjector(database);

    projector.upsertWorkspaceLease(owner);
    expect(projector.workspaceLease("demo")).toMatchObject({
      workspace_id: "demo",
      execution_id: "exec-1",
      lease_id: "lease-1",
      pid: process.pid,
      hostname: "test-host",
      heartbeat_at: 10,
    });
    projector.deleteWorkspaceLease("demo", "different-lease");
    expect(projector.workspaceLease("demo")).toBeDefined();
    projector.deleteWorkspaceLease("demo", "lease-1");
    expect(projector.workspaceLease("demo")).toBeUndefined();
    database.close();
    lock.release(handle);
  });

  it("projects a durable acquire and release without making SQLite authoritative", async () => {
    const { root, workspacePath } = await fixture();
    const stateRoot = join(root, "state");
    const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
    const projector = new ExecutionProjector(database);
    const lock = new WorkspaceLock({
      stateRoot,
      leaseProjection: {
        upsert: (owner) => projector.upsertWorkspaceLease(owner),
        removeIfLeaseMatches: (workspaceId, leaseId) => projector.deleteWorkspaceLease(workspaceId, leaseId),
      },
      dependencies: { now: () => 15, hostname: () => "test-host", randomUUID: () => "lease-runtime", pidProbe: () => "ALIVE" },
    });

    const handle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec-runtime" });
    expect(projector.workspaceLease("demo")).toMatchObject({ lease_id: "lease-runtime" });
    lock.release(handle);
    expect(projector.workspaceLease("demo")).toBeUndefined();
    database.close();
  });

  it("rebuilds workspace_locks from valid owner files after SQLite is deleted", async () => {
    const { root, workspacePath } = await fixture();
    const stateRoot = join(root, "state");
    const lock = new WorkspaceLock({
      stateRoot,
      dependencies: { now: () => 20, hostname: () => "test-host", randomUUID: () => "lease-rebuild", pidProbe: () => "ALIVE" },
    });
    const handle = await lock.acquire({ workspaceId: "demo", canonicalPath: workspacePath, executionId: "exec-rebuild" });
    const databasePath = join(stateRoot, "g2m-state.sqlite");
    await rm(databasePath, { force: true });

    await rebuildProjection({ stateRoot, workspaces: [], nowMs: 30 });

    const database = new StateDatabase(databasePath);
    expect(database.prepare("SELECT workspace_id, execution_id, lease_id FROM workspace_locks").all()).toEqual([
      { workspace_id: "demo", execution_id: "exec-rebuild", lease_id: "lease-rebuild" },
    ]);
    database.close();
    expect(await stat(handle.ownerPath)).toBeTruthy();
    lock.release(handle);
  });

  it("does not invent a projection row for a malformed owner file", async () => {
    const { root, workspacePath } = await fixture();
    const stateRoot = join(root, "state");
    const key = await workspaceKeyForPath(workspacePath);
    await mkdir(join(stateRoot, "locks"), { recursive: true });
    await writeFile(join(stateRoot, "locks", `${key}.lock`), "not-json", "utf8");

    await rebuildProjection({ stateRoot, workspaces: [], nowMs: 40 });

    const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
    expect(database.prepare("SELECT COUNT(*) AS count FROM workspace_locks").get()).toEqual({ count: 0 });
    database.close();
  });
});
