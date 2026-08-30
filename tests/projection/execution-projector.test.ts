import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { StateDatabase } from "../../src/projection/database.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{
  database: StateDatabase;
  projector: ExecutionProjector;
  events: EventStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "g2m-projector-"));
  roots.push(root);
  const database = new StateDatabase(join(root, "g2m-state.sqlite"));
  return { database, projector: new ExecutionProjector(database), events: new EventStore() };
}

describe("ExecutionProjector", () => {
  it("creates and advances an execution projection from durable lifecycle events", async () => {
    const { database, projector, events } = await setup();
    const created = events.append({
      taskId: "task-1",
      attemptId: "execution-1",
      type: "task.created",
      timestampMs: 100,
      payload: {
        task: {
          workspace_scope: { workspace_id: "workspace-1", base_revision: "abc123" },
        },
      },
    });
    projector.project(created, "PLANNED", {
      artifactPath: "C:/state/executions/execution-1",
    });
    const validating = events.append({
      taskId: "task-1",
      attemptId: "execution-1",
      type: "task.validation.started",
      timestampMs: 200,
      payload: {},
    });
    projector.project(validating, "VALIDATING");

    expect(projector.execution("execution-1")).toMatchObject({
      execution_id: "execution-1",
      task_id: "task-1",
      workspace_id: "workspace-1",
      state: "VALIDATING",
      created_at: 100,
      updated_at: 200,
      base_revision: "abc123",
      artifact_path: "C:/state/executions/execution-1",
    });
    expect(database.getMeta("execution:execution-1:last_event_hash")).toBe(validating.hash);
    database.close();
  });

  it("projects recovery cases without changing the authoritative Journal", async () => {
    const { database, projector, events } = await setup();
    const created = events.append({
      taskId: "task-1", attemptId: "execution-1", type: "task.created", payload: {}, timestampMs: 10,
    });
    projector.project(created, "PLANNED");
    const recovery = events.append({
      taskId: "task-1",
      attemptId: "execution-1",
      type: "recovery.required",
      payload: { reason: "worker outcome unknown" },
      timestampMs: 20,
    });
    projector.project(recovery, "RECOVERY_REQUIRED");

    expect(projector.recoveryCase("execution-1")).toMatchObject({
      execution_id: "execution-1",
      status: "OPEN",
      reason: "worker outcome unknown",
      created_at: 20,
    });
    expect(events.getByAttemptId("execution-1").map((event) => event.type)).toEqual([
      "task.created",
      "recovery.required",
    ]);
    database.close();
  });

  it("refuses to invent an execution row when its task.created fact is absent", async () => {
    const { database, projector, events } = await setup();
    const event = events.append({
      taskId: "task-1",
      attemptId: "execution-1",
      type: "task.validation.started",
      payload: {},
    });

    expect(() => projector.project(event, "VALIDATING")).toThrow(/task.created/);
    expect(projector.execution("execution-1")).toBeUndefined();
    database.close();
  });
});
