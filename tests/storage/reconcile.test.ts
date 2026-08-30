import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { StateDatabase } from "../../src/projection/database.js";
import { DEFAULT_STORAGE_POLICY } from "../../src/storage/policy.js";
import { reconcileStorageReservations, StorageManager } from "../../src/storage/reservation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "g2m-storage-reconcile-"));
  roots.push(root);
  await mkdir(join(root, "state"), { recursive: true });
  const eventStore = new EventStore({ executionDirectory: join(root, "state", "executions") });
  const database = new StateDatabase(join(root, "state", "g2m-state.sqlite"));
  const storage = new StorageManager({
    database,
    eventStore,
    stateRoot: join(root, "state"),
    policy: { ...DEFAULT_STORAGE_POLICY, min_free_bytes: 0, safety_margin_bytes: 0, default_execution_reservation_bytes: 10 },
    volumeResolver: (path) => ({ volumeId: "v1", rootPath: path, freeBytes: 1_000 }),
    now: () => 100,
    pid: 42,
    hostname: "host",
  });
  return { root, database, eventStore, storage };
}

describe("reconcileStorageReservations", () => {
  it("rebuilds a reservation after SQLite deletion and releases a proven terminal leak", async () => {
    const f = await setup();
    f.eventStore.append({ taskId: "task-terminal", attemptId: "exec-terminal", type: "task.created", payload: {} });
    const handle = await f.storage.reserveExecution({ executionId: "exec-terminal", taskId: "task-terminal", roots: [{ rootPath: "worktree", roles: ["worktree"] }] });
    f.eventStore.append({ taskId: "task-terminal", attemptId: "exec-terminal", type: "task.validation.started", payload: {} });
    f.eventStore.append({ taskId: "task-terminal", attemptId: "exec-terminal", type: "task.validation.failed", payload: { reason: "low" } });
    f.database.close();
    const rebuilt = new StateDatabase(join(f.root, "state", "g2m-state.sqlite"));
    const report = await reconcileStorageReservations({ stateRoot: join(f.root, "state"), database: rebuilt, eventStore: f.eventStore, nowMs: 10_000 });
    expect(report.rebuiltReservations).toBe(1);
    expect(report.releasedReservations).toBe(1);
    expect(rebuilt.prepare("SELECT state FROM storage_reservations WHERE reservation_id = ?").get(handle.reservations[0]!.reservationId)).toEqual({ state: "RELEASED" });
    rebuilt.close();
    f.eventStore.close();
  });

  it("retains an ACTIVE reservation for RECOVERY_REQUIRED even when its TTL is old", async () => {
    const f = await setup();
    f.eventStore.append({ taskId: "task-recovery", attemptId: "exec-recovery", type: "task.created", payload: {} });
    const handle = await f.storage.reserveExecution({ executionId: "exec-recovery", taskId: "task-recovery", roots: [{ rootPath: "worktree", roles: ["worktree"] }] });
    f.eventStore.append({ taskId: "task-recovery", attemptId: "exec-recovery", type: "recovery.required", payload: { reason: "unknown writer" } });
    f.database.close();
    const rebuilt = new StateDatabase(join(f.root, "state", "g2m-state.sqlite"));
    const report = await reconcileStorageReservations({ stateRoot: join(f.root, "state"), database: rebuilt, eventStore: f.eventStore, nowMs: 999_999_999 });
    expect(report.retainedReservations).toBe(1);
    expect(rebuilt.prepare("SELECT state FROM storage_reservations WHERE reservation_id = ?").get(handle.reservations[0]!.reservationId)).toEqual({ state: "ACTIVE" });
    rebuilt.close();
    f.eventStore.close();
  });
});
