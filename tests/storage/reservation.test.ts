import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { StateDatabase } from "../../src/projection/database.js";
import { DEFAULT_STORAGE_POLICY } from "../../src/storage/policy.js";
import { StorageAdmissionError, StorageManager } from "../../src/storage/reservation.js";
import { reconcileStorageReservations } from "../../src/storage/reservation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "g2m-reservation-"));
  roots.push(root);
  const database = new StateDatabase(join(root, "g2m-state.sqlite"));
  const eventStore = new EventStore({ executionDirectory: join(root, "executions") });
  const stateRoot = join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  const policy = { ...DEFAULT_STORAGE_POLICY, min_free_bytes: 100, safety_margin_bytes: 50, default_execution_reservation_bytes: 200, max_total_bytes: 0 };
  return { root, database, eventStore, stateRoot, policy };
}

function manager(f: Awaited<ReturnType<typeof fixture>>, freeBytes: Record<string, number>) {
  return new StorageManager({
    database: f.database,
    eventStore: f.eventStore,
    stateRoot: f.stateRoot,
    policy: f.policy,
    hostname: "test-host",
    pid: 123,
    now: () => 1_000,
    volumeResolver: (path) => ({ volumeId: path.startsWith("D:") ? "win32:d:\\" : "win32:c:\\", rootPath: path, freeBytes: freeBytes[path] ?? 1_000 }),
  });
}

describe("StorageManager.reserveExecution", () => {
  it("admits enough space and records an ACTIVE reservation", async () => {
    const f = await fixture();
    const result = await manager(f, { "C:\\worktrees": 1_000 }).reserveExecution({
      executionId: "exec-1",
      taskId: "task-1",
      roots: [{ rootPath: "C:\\worktrees", roles: ["worktree"] }],
    });

    expect(result.reservations).toHaveLength(1);
    expect(f.database.prepare("SELECT state, reserved_bytes FROM storage_reservations").all()).toEqual([
      { state: "ACTIVE", reserved_bytes: 200 },
    ]);
    const recordText = await readFile(result.recordPath, "utf8");
    const record = JSON.parse(recordText) as object;
    expect(recordText).toContain("exec-1");
    expect(result.recordHash).toBe(createHash("sha256").update(JSON.stringify(record)).digest("hex"));
    expect(f.eventStore.getByAttemptId("exec-1")[0]).toMatchObject({
      type: "storage.reservation.created",
      domain: "storage",
      durability: "CRITICAL",
    });
    f.database.close();
    f.eventStore.close();
  });

  it("denies admission when minimum free space and safety margin leave too little", async () => {
    const f = await fixture();
    await expect(manager(f, { "C:\\worktrees": 300 }).reserveExecution({
      executionId: "exec-low",
      taskId: "task-low",
      roots: [{ rootPath: "C:\\worktrees", roles: ["worktree"] }],
    })).rejects.toMatchObject({ code: "STORAGE_ADMISSION_DENIED" });
    f.database.close();
    f.eventStore.close();
  });

  it("deduplicates same-volume roots and keeps different volumes independent", async () => {
    const f = await fixture();
    const result = await manager(f, { "C:\\worktrees": 1_000, "C:\\artifacts": 1_000, "D:\\artifacts": 1_000 }).reserveExecution({
      executionId: "exec-volumes",
      taskId: "task-volumes",
      roots: [
        { rootPath: "C:\\worktrees", roles: ["worktree"] },
        { rootPath: "C:\\artifacts", roles: ["artifact"] },
        { rootPath: "D:\\artifacts", roles: ["artifact"] },
      ],
    });
    expect(result.reservations.map((r) => r.volumeId)).toEqual(["win32:c:\\", "win32:d:\\"]);
    expect(f.database.prepare("SELECT count(*) AS n FROM storage_reservations").get()).toEqual({ n: 2 });
    f.database.close();
    f.eventStore.close();
  });

  it("enforces max_total against managed usage plus active reservations", async () => {
    const f = await fixture();
    f.database.run("INSERT INTO storage_usage(execution_id, artifact_bytes, worktree_bytes, updated_at) VALUES (?, ?, ?, ?)", "old", 400, 0, 1);
    f.policy.max_total_bytes = 500;
    await expect(manager(f, { "C:\\worktrees": 1_000 }).reserveExecution({
      executionId: "exec-total",
      taskId: "task-total",
      roots: [{ rootPath: "C:\\worktrees", roles: ["worktree"] }],
    })).rejects.toMatchObject({ code: "STORAGE_ADMISSION_DENIED" });
    f.database.close();
    f.eventStore.close();
  });
});

describe("StorageManager.releaseReservation", () => {
  it("writes the release event first and conditionally releases ACTIVE rows", async () => {
    const f = await fixture();
    const storage = manager(f, { "C:\\worktrees": 1_000 });
    const handle = await storage.reserveExecution({
      executionId: "exec-release",
      taskId: "task-release",
      roots: [{ rootPath: "C:\\worktrees", roles: ["worktree"] }],
    });
    await storage.releaseReservation(handle, "ACCEPTED");
    expect(f.database.prepare("SELECT state FROM storage_reservations").get()).toEqual({ state: "RELEASED" });
    expect(f.eventStore.getByAttemptId("exec-release").map((event) => event.type)).toEqual([
      "storage.reservation.created",
      "storage.reservation.released",
    ]);
    await storage.releaseReservation(handle, "ACCEPTED");
    expect(f.database.prepare("SELECT state FROM storage_reservations").get()).toEqual({ state: "RELEASED" });
    f.database.close();
    f.eventStore.close();
  });
});

describe("StorageManager storage checkpoints", () => {
  it("enforces worktree, artifact, and total limits after scanning usage", async () => {
    const f = await fixture();
    const storage = new StorageManager({
      database: f.database,
      stateRoot: f.stateRoot,
      policy: { ...f.policy, min_free_bytes: 0, safety_margin_bytes: 0, max_worktree_bytes: 2, max_artifact_bytes: 2, max_total_bytes: 3 },
      freeSpaceProvider: { freeBytes: async () => 1_000 },
    });
    for (const usage of [
      { artifactBytes: 0, worktreeBytes: 3, totalBytes: 3 },
      { artifactBytes: 3, worktreeBytes: 0, totalBytes: 3 },
      { artifactBytes: 2, worktreeBytes: 2, totalBytes: 4 },
    ]) {
      expect(() => storage.assertUsageWithinLimits(`limit-${usage.totalBytes}`, usage)).toThrowError(
        expect.objectContaining({ code: "STORAGE_LIMIT_EXCEEDED" }),
      );
    }
    f.database.close();
    f.eventStore.close();
  });

  it("does not reconstruct a pre-commit orphan as a permanent ACTIVE reservation", async () => {
    const f = await fixture();
    const reservationRoot = join(f.stateRoot, "reservations");
    await mkdir(reservationRoot, { recursive: true });
    const record = {
      schema_version: 1,
      reservation_set_id: "orphan-set",
      execution_id: "orphan-execution",
      pid: 123,
      hostname: "test-host",
      created_at: 100,
      expires_at: 200,
      reservations: [{ reservation_id: "orphan-reservation", volume_id: "v1", reserved_bytes: 10, roles: ["worktree"] }],
    };
    await (await import("node:fs/promises")).writeFile(join(reservationRoot, "orphan-set.json"), `${JSON.stringify(record)}\n`, "utf8");
    const report = await reconcileStorageReservations({ stateRoot: f.stateRoot, database: f.database, eventStore: f.eventStore, nowMs: 300 });
    expect(report.preCommitOrphans).toBe(1);
    expect(f.database.prepare("SELECT count(*) AS n FROM storage_reservations WHERE reservation_set_id = ?").get("orphan-set")).toEqual({ n: 0 });
    f.database.close();
    f.eventStore.close();
  });
});

it("exposes a stable storage admission error code", () => {
  expect(new StorageAdmissionError("STORAGE_LIMIT_EXCEEDED", "limit").code).toBe("STORAGE_LIMIT_EXCEEDED");
});
