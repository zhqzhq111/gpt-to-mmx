import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { reduce } from "../../src/events/reducer.js";
import { FingerprintRegistry } from "../../src/execution/fingerprint.js";
import { StateDatabase } from "../../src/projection/database.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("storage-domain projection", () => {
  it("projects reservation facts without changing lifecycle state", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-storage-projection-"));
    roots.push(root);
    const database = new StateDatabase(join(root, "state.sqlite"));
    const projector = new ExecutionProjector(database);
    const events = new EventStore();
    const created = events.append({
      taskId: "task-1",
      attemptId: "exec-1",
      type: "task.created",
      payload: { task: { task_id: "task-1", workspace_scope: { workspace_id: "ws", base_revision: "HEAD" } } },
    });
    const state = reduce(null, created, { fingerprintRegistry: new FingerprintRegistry() });
    projector.project(created, state);
    const storage = events.append({
      taskId: "task-1",
      attemptId: "exec-1",
      type: "storage.reservation.created",
      payload: {
        reservation_set_id: "set-1",
        record_path: "F:/state/reservations/set-1.json",
        record_hash: "hash-1",
        reservations: [{ reservation_id: "res-1", volume_id: "win32:c:\\", reserved_bytes: 200, roles: ["worktree"] }],
      },
    });
    const unchanged = reduce(state, storage, { fingerprintRegistry: new FingerprintRegistry() });
    expect(unchanged).toBe(state);
    projector.project(storage, unchanged);
    expect(database.prepare("SELECT reservation_id, state, reserved_bytes, volume_id FROM storage_reservations").all()).toEqual([
      { reservation_id: "res-1", state: "ACTIVE", reserved_bytes: 200, volume_id: "win32:c:\\" },
    ]);
    database.close();
  });

  it("projects a release conditionally", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-storage-release-"));
    roots.push(root);
    const database = new StateDatabase(join(root, "state.sqlite"));
    const projector = new ExecutionProjector(database);
    const events = new EventStore();
    const created = events.append({ taskId: "task", attemptId: "exec", type: "task.created", payload: {} });
    projector.project(created, reduce(null, created, { fingerprintRegistry: new FingerprintRegistry() }));
    const reservation = events.append({ taskId: "task", attemptId: "exec", type: "storage.reservation.created", payload: { reservations: [{ reservation_id: "r", volume_id: "v", reserved_bytes: 1 }] } });
    projector.project(reservation, reduce("PLANNED", reservation, { fingerprintRegistry: new FingerprintRegistry() }));
    const release = events.append({ taskId: "task", attemptId: "exec", type: "storage.reservation.released", payload: { reservation_ids: ["r"] } });
    projector.project(release, "PLANNED");
    expect(database.prepare("SELECT state FROM storage_reservations WHERE reservation_id = ?").get("r")).toEqual({ state: "RELEASED" });
    database.close();
  });
});
