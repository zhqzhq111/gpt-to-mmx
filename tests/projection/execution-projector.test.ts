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

  it("closes a recovery case when recovery.reconciled is projected", async () => {
    const { database, projector, events } = await setup();
    const created = events.append({
      taskId: "task-1", attemptId: "execution-1", type: "task.created", payload: {}, timestampMs: 10,
    });
    projector.project(created, "PLANNED");
    const required = events.append({
      taskId: "task-1",
      attemptId: "execution-1",
      type: "recovery.required",
      payload: { reason: "worker outcome unknown" },
      timestampMs: 20,
    });
    projector.project(required, "RECOVERY_REQUIRED");
    const reconciled = events.append({
      taskId: "task-1",
      attemptId: "execution-1",
      type: "recovery.reconciled",
      payload: { reason: "matched frozen patch" },
      timestampMs: 30,
    });
    projector.project(reconciled, "RECOVERY_REQUIRED");

    expect(projector.recoveryCase("execution-1")).toMatchObject({
      execution_id: "execution-1",
      status: "RESOLVED",
      reason: "worker outcome unknown",
      created_at: 20,
      resolved_at: 30,
    });
    // Recovery-domain event must not advance the lifecycle state
    expect(projector.execution("execution-1")?.state).toBe("RECOVERY_REQUIRED");
    // Recovery-domain event must not be written to the projection again
    expect(
      database.prepare("SELECT count(*) AS n FROM recovery_cases WHERE execution_id = ?")
        .get("execution-1"),
    ).toEqual({ n: 1 });
    database.close();
  });

  it("seeds the workspaces table from trusted config without affecting executions", async () => {
    const { database, projector } = await setup();

    projector.seedWorkspaces([
      { workspaceId: "ws-1", canonicalPath: "C:/repos/one" },
      { workspaceId: "ws-2", canonicalPath: "C:/repos/two" },
    ], 5_000);

    expect(
      database.prepare("SELECT canonical_path, updated_at FROM workspaces WHERE workspace_id = ?")
        .get("ws-1"),
    ).toEqual({ canonical_path: "C:/repos/one", updated_at: 5_000 });
    expect(
      database.prepare("SELECT count(*) AS n FROM workspaces").get(),
    ).toEqual({ n: 2 });

    // UPSERT — re-seeding refreshes canonical_path and updated_at only
    projector.seedWorkspaces(
      [{ workspaceId: "ws-1", canonicalPath: "C:/repos/one-renamed" }],
      9_000,
    );
    expect(
      database.prepare("SELECT canonical_path, updated_at FROM workspaces WHERE workspace_id = ?")
        .get("ws-1"),
    ).toEqual({ canonical_path: "C:/repos/one-renamed", updated_at: 9_000 });
    // ws-2 is preserved because UPSERT never deletes
    expect(
      database.prepare("SELECT canonical_path FROM workspaces WHERE workspace_id = ?")
        .get("ws-2"),
    ).toEqual({ canonical_path: "C:/repos/two" });
    database.close();
  });
});
