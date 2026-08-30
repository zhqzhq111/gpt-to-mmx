import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { EventStore } from "../../dist/events/store.js";
import { StateDatabase } from "../../dist/projection/database.js";
import { DEFAULT_STORAGE_POLICY } from "../../dist/storage/policy.js";
import { StorageManager } from "../../dist/storage/reservation.js";

const [, , mode, stateRoot, executionId, volumeId = "v1"] = process.argv;
await mkdir(stateRoot, { recursive: true });
const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
const eventStore = new EventStore({ executionDirectory: join(stateRoot, "executions") });
if (eventStore.getByAttemptId(executionId).length === 0) {
  eventStore.append({ taskId: `task-${executionId}`, attemptId: executionId, type: "task.created", payload: {} });
}
const manager = new StorageManager({
  database,
  eventStore,
  stateRoot,
  policy: { ...DEFAULT_STORAGE_POLICY, min_free_bytes: 0, safety_margin_bytes: 0, default_execution_reservation_bytes: 200 },
  hostname: "process-test-host",
  pid: process.pid,
  volumeResolver: (path) => ({ volumeId, rootPath: path, freeBytes: 250 }),
  now: () => Date.now(),
});

try {
  const handle = await manager.reserveExecution({
    executionId,
    taskId: `task-${executionId}`,
    roots: [{ rootPath: `root-${volumeId}`, roles: ["worktree"] }],
  });
  process.stdout.write(`${JSON.stringify({ status: "ADMITTED", executionId, reservationSetId: handle.reservationSetId })}\n`);
  if (mode === "hold") {
    await new Promise((resolve) => process.stdin.once("data", resolve));
    await manager.releaseReservation(handle, "process-test-release");
    process.stdout.write(`${JSON.stringify({ status: "RELEASED", executionId })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: error?.code === "STORAGE_ADMISSION_DENIED" ? "DENIED" : "ERROR", executionId, code: error?.code, message: error?.message })}\n`);
  process.exitCode = error?.code === "STORAGE_ADMISSION_DENIED" ? 0 : 1;
}

database.close();
eventStore.close();
