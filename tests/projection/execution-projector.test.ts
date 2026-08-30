import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { StateDatabase } from "../../src/projection/database.js";
import {
  ExecutionProjector,
  type ProjectionReplayStep,
} from "../../src/projection/execution-projector.js";

const roots: string[] = [];
const databases: StateDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
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
  databases.push(database);
  return { database, projector: new ExecutionProjector(database), events: new EventStore() };
}

function seedExecutionRows(database: StateDatabase, executionId: string, label: string): void {
  database.prepare(`
    INSERT INTO executions(
      execution_id, task_id, workspace_id, state, created_at, updated_at,
      base_revision, runtime, runtime_version, model, fingerprint_hash,
      artifact_path, worktree_path, review_bundle_id, retention_class, gc_eligible_at
    ) VALUES (?, ?, ?, 'RUNNING', 1, 2, ?, 'node', '22', 'model', ?, ?, ?, ?, 'NORMAL', NULL)
  `).run(
    executionId,
    `task-${label}`,
    `workspace-${label}`,
    `base-${label}`,
    `fingerprint-${label}`,
    `artifact-path-${label}`,
    `worktree-path-${label}`,
    `review-${label}`,
  );
  database.prepare(`
    INSERT INTO artifacts(artifact_id, execution_id, kind, path, sha256, bytes, immutable)
    VALUES (?, ?, 'frozen.patch', ?, ?, 10, 1)
  `).run(`artifact-${label}`, executionId, `artifact-path-${label}`, `hash-${label}`);
  database.prepare(`
    INSERT INTO reviews(review_bundle_id, execution_id, review_id, decision, review_hash, applied_at)
    VALUES (?, ?, ?, 'BLOCK', ?, 3)
  `).run(`review-${label}`, executionId, `review-id-${label}`, `review-hash-${label}`);
  database.prepare(`
    INSERT INTO recovery_cases(execution_id, status, reason, created_at, resolved_at)
    VALUES (?, 'OPEN', ?, 4, NULL)
  `).run(executionId, `recovery-${label}`);
  database.prepare(`
    INSERT INTO storage_usage(execution_id, artifact_bytes, worktree_bytes, updated_at)
    VALUES (?, 11, 12, 13)
  `).run(executionId);
  database.prepare(`
    INSERT INTO storage_reservations(
      reservation_id, execution_id, volume_id, reserved_bytes, created_at, expires_at, state
    ) VALUES (?, ?, 'volume-1', 14, 15, 16, 'HELD')
  `).run(`reservation-${label}`, executionId);
  database.setMeta(`execution:${executionId}:last_event_hash`, `old-hash-${label}`);
  database.setMeta(`execution:${executionId}:last_event_seq`, `old-seq-${label}`);
  database.setMeta(`execution:${executionId}:obsolete`, `old-meta-${label}`);
  database.setMeta(`execution:${executionId}:stale`, `old-stale-${label}`);
}

function targetReplaySteps(events: EventStore, executionId: string): ProjectionReplayStep[] {
  const created = events.append({
    taskId: "new-task",
    attemptId: executionId,
    type: "task.created",
    timestampMs: 100,
    payload: {
      task: { workspace_scope: { workspace_id: "workspace-new", base_revision: "new-base" } },
    },
  });
  const patch = events.append({
    taskId: "new-task",
    attemptId: executionId,
    type: "patch.frozen",
    timestampMs: 200,
    payload: {
      artifact_id: "artifact-new",
      artifact_path: "artifact-path-new",
      patch_blob_hash: "hash-new",
      patch_bytes: 20,
    },
  });
  const review = events.append({
    taskId: "new-task",
    attemptId: executionId,
    type: "review.decision.accept",
    timestampMs: 300,
    payload: {
      review_bundle_id: "review-new",
      review_id: "review-id-new",
      review_hash: "review-hash-new",
    },
  });
  const recovery = events.append({
    taskId: "new-task",
    attemptId: executionId,
    type: "recovery.required",
    timestampMs: 400,
    payload: { reason: "new recovery reason" },
  });
  return [
    { event: created, state: "PLANNED", metadata: { artifactPath: "new-execution-path" } },
    { event: patch, state: "VERIFYING" },
    { event: review, state: "ACCEPTED" },
    { event: recovery, state: "RECOVERY_REQUIRED" },
  ];
}

describe("ExecutionProjector", () => {
  it("projects terminal retention eligibility from the terminal event timestamp", async () => {
    const { database, events } = await setup();
    const projector = new ExecutionProjector(database, { completedRetentionDays: 2 });
    const created = events.append({ taskId: "task-retention", attemptId: "execution-retention", type: "task.created", timestampMs: 100, payload: {} });
    projector.project(created, "PLANNED");
    const terminal = events.append({ taskId: "task-retention", attemptId: "execution-retention", type: "task.validation.failed", timestampMs: 200, payload: { reason: "test" } });
    projector.project(terminal, "FAILED");
    expect(projector.execution("execution-retention")).toMatchObject({
      state: "FAILED",
      retention_class: "NORMAL",
      gc_eligible_at: 200 + 2 * 24 * 60 * 60 * 1000,
    });

    const retained = events.append({ taskId: "task-retention", attemptId: "execution-retained", type: "task.created", timestampMs: 300, payload: {} });
    projector.project(retained, "PLANNED");
    projector.project(events.append({ taskId: "task-retention", attemptId: "execution-retained", type: "task.validation.started", timestampMs: 400, payload: {} }), "REVIEW_PENDING");
    expect(projector.execution("execution-retained")).toMatchObject({ retention_class: "RETAINED", gc_eligible_at: null });

    const recovery = events.append({ taskId: "task-retention", attemptId: "execution-recovery", type: "task.created", timestampMs: 500, payload: {} });
    projector.project(recovery, "PLANNED");
    projector.project(events.append({ taskId: "task-retention", attemptId: "execution-recovery", type: "recovery.required", timestampMs: 600, payload: { reason: "test" } }), "RECOVERY_REQUIRED");
    expect(projector.execution("execution-recovery")).toMatchObject({ retention_class: "RECOVERY_CRITICAL", gc_eligible_at: null });
  });

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

  it("replaces one execution projection while preserving unrelated rows and trusted workspace state", async () => {
    const { database, projector, events } = await setup();
    const executionId = "execution-replace";
    const unrelatedId = "execution-unrelated";
    seedExecutionRows(database, executionId, "old");
    seedExecutionRows(database, unrelatedId, "unrelated");
    database.prepare(
      "INSERT INTO workspaces(workspace_id, canonical_path, updated_at) VALUES (?, ?, ?)",
    ).run("workspace-unrelated", "C:/repos/unrelated", 50);
    database.prepare(`
      INSERT INTO workspace_locks(workspace_id, execution_id, lease_id, pid, hostname, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("workspace-unrelated", unrelatedId, "lease-unrelated", 99, "host", 51);

    projector.replaceExecution(executionId, targetReplaySteps(events, executionId));

    expect(projector.execution(executionId)).toMatchObject({
      execution_id: executionId,
      task_id: "new-task",
      state: "RECOVERY_REQUIRED",
      artifact_path: "new-execution-path",
    });
    expect(database.prepare("SELECT * FROM artifacts WHERE execution_id = ?").all(executionId))
      .toEqual([{
        artifact_id: "artifact-new",
        execution_id: executionId,
        kind: "frozen.patch",
        path: "artifact-path-new",
        sha256: "hash-new",
        bytes: 20,
        immutable: 1,
      }]);
    expect(database.prepare("SELECT * FROM reviews WHERE execution_id = ?").all(executionId))
      .toEqual([{
        review_bundle_id: "review-new",
        execution_id: executionId,
        review_id: "review-id-new",
        decision: "ACCEPT",
        review_hash: "review-hash-new",
        applied_at: 300,
      }]);
    expect(projector.recoveryCase(executionId)).toMatchObject({
      execution_id: executionId,
      status: "OPEN",
      reason: "new recovery reason",
    });
    expect(database.prepare("SELECT count(*) AS n FROM storage_usage WHERE execution_id = ?")
      .get(executionId)).toEqual({ n: 0 });
    expect(database.prepare("SELECT count(*) AS n FROM storage_reservations WHERE execution_id = ?")
      .get(executionId)).toEqual({ n: 0 });
    expect(database.getMeta(`execution:${executionId}:obsolete`)).toBeUndefined();
    expect(database.getMeta(`execution:${executionId}:stale`)).toBeUndefined();
    expect(database.getMeta(`execution:${executionId}:last_event_hash`))
      .toBe(events.getByAttemptId(executionId).at(-1)?.hash);
    expect(database.getMeta(`execution:${executionId}:last_event_seq`)).toBe("4");

    expect(projector.execution(unrelatedId)).toMatchObject({ execution_id: unrelatedId, task_id: "task-unrelated" });
    expect(database.prepare("SELECT artifact_id FROM artifacts WHERE execution_id = ?")
      .get(unrelatedId)).toEqual({ artifact_id: "artifact-unrelated" });
    expect(database.prepare("SELECT review_bundle_id FROM reviews WHERE execution_id = ?")
      .get(unrelatedId)).toEqual({ review_bundle_id: "review-unrelated" });
    expect(projector.recoveryCase(unrelatedId)?.reason).toBe("recovery-unrelated");
    expect(database.prepare("SELECT count(*) AS n FROM storage_usage WHERE execution_id = ?")
      .get(unrelatedId)).toEqual({ n: 1 });
    expect(database.prepare("SELECT canonical_path FROM workspaces WHERE workspace_id = ?")
      .get("workspace-unrelated")).toEqual({ canonical_path: "C:/repos/unrelated" });
    expect(database.prepare("SELECT lease_id FROM workspace_locks WHERE workspace_id = ?")
      .get("workspace-unrelated")).toEqual({ lease_id: "lease-unrelated" });
    database.close();
  });

  it("rolls back every reset and replay write when a replay step throws", async () => {
    const { database, projector, events } = await setup();
    const executionId = "execution-rollback";
    seedExecutionRows(database, executionId, "rollback");
    const before = {
      execution: projector.execution(executionId),
      artifacts: database.prepare("SELECT * FROM artifacts WHERE execution_id = ?").all(executionId),
      reviews: database.prepare("SELECT * FROM reviews WHERE execution_id = ?").all(executionId),
      recovery: projector.recoveryCase(executionId),
      usage: database.prepare("SELECT * FROM storage_usage WHERE execution_id = ?").all(executionId),
      reservations: database.prepare("SELECT * FROM storage_reservations WHERE execution_id = ?").all(executionId),
      meta: database.prepare("SELECT key, value FROM projection_meta WHERE key LIKE ? ORDER BY key")
        .all(`execution:${executionId}:%`),
    };
    const created = events.append({
      taskId: "replacement-task",
      attemptId: executionId,
      type: "task.created",
      payload: {},
      timestampMs: 100,
    });
    const brokenPatch = events.append({
      taskId: "replacement-task",
      attemptId: executionId,
      type: "patch.frozen",
      payload: { artifact_id: "broken-artifact" },
      timestampMs: 200,
    });

    expect(() => projector.replaceExecution(executionId, [
      { event: created, state: "PLANNED" },
      { event: brokenPatch, state: "VERIFYING" },
    ])).toThrow("patch.frozen has incomplete artifact bindings");

    expect({
      execution: projector.execution(executionId),
      artifacts: database.prepare("SELECT * FROM artifacts WHERE execution_id = ?").all(executionId),
      reviews: database.prepare("SELECT * FROM reviews WHERE execution_id = ?").all(executionId),
      recovery: projector.recoveryCase(executionId),
      usage: database.prepare("SELECT * FROM storage_usage WHERE execution_id = ?").all(executionId),
      reservations: database.prepare("SELECT * FROM storage_reservations WHERE execution_id = ?").all(executionId),
      meta: database.prepare("SELECT key, value FROM projection_meta WHERE key LIKE ? ORDER BY key")
        .all(`execution:${executionId}:%`),
    }).toEqual(before);
    database.close();
  });

  it("writes a truncated-tail stale reason inside the replacement transaction", async () => {
    const { database, projector, events } = await setup();
    const executionId = "execution-truncated-atomic";
    seedExecutionRows(database, executionId, "truncated-atomic");
    const created = events.append({
      taskId: "replacement-task",
      attemptId: executionId,
      type: "task.created",
      payload: {},
      timestampMs: 100,
    });

    projector.replaceExecution(
      executionId,
      [{ event: created, state: "PLANNED" }],
      { staleReason: "TRUNCATED_TAIL" },
    );

    expect(projector.execution(executionId)?.state).toBe("PLANNED");
    expect(database.getMeta(`execution:${executionId}:stale`)).toBe("TRUNCATED_TAIL");
  });

  it("rolls back the stale reason together with a failed stale replacement", async () => {
    const { database, projector, events } = await setup();
    const executionId = "execution-truncated-rollback";
    seedExecutionRows(database, executionId, "truncated-rollback");
    const created = events.append({
      taskId: "replacement-task",
      attemptId: executionId,
      type: "task.created",
      payload: {},
      timestampMs: 100,
    });
    const brokenPatch = events.append({
      taskId: "replacement-task",
      attemptId: executionId,
      type: "patch.frozen",
      payload: { artifact_id: "broken-artifact" },
      timestampMs: 200,
    });
    const before = projector.execution(executionId);

    expect(() => projector.replaceExecution(
      executionId,
      [
        { event: created, state: "PLANNED" },
        { event: brokenPatch, state: "VERIFYING" },
      ],
      { staleReason: "TRUNCATED_TAIL" },
    )).toThrow("patch.frozen has incomplete artifact bindings");

    expect(projector.execution(executionId)).toEqual(before);
    expect(database.getMeta(`execution:${executionId}:stale`)).toBe("old-stale-truncated-rollback");
  });

  it("projects projection-domain events as cursor-only updates", async () => {
    const { database, projector, events } = await setup();
    const created = events.append({
      taskId: "task-projection",
      attemptId: "execution-projection",
      type: "task.created",
      payload: {},
      timestampMs: 10,
    });
    projector.project(created, "PLANNED");
    const stale = events.append({
      taskId: "task-projection",
      attemptId: "execution-projection",
      type: "projection.stale",
      payload: { reason: "projection mismatch" },
      timestampMs: 20,
    });

    projector.project(stale, "PLANNED");

    expect(projector.execution("execution-projection")?.state).toBe("PLANNED");
    expect(database.prepare("SELECT count(*) AS n FROM artifacts WHERE execution_id = ?")
      .get("execution-projection")).toEqual({ n: 0 });
    expect(projector.recoveryCase("execution-projection")).toBeUndefined();
    expect(database.getMeta("execution:execution-projection:stale")).toBeUndefined();
    expect(database.getMeta("execution:execution-projection:last_event_hash")).toBe(stale.hash);
    expect(database.getMeta("execution:execution-projection:last_event_seq")).toBe("2");
    database.close();
  });

  it("rejects empty replacement steps before mutating the existing projection", async () => {
    const { database, projector } = await setup();
    const executionId = "execution-empty";
    seedExecutionRows(database, executionId, "empty");
    const before = projector.execution(executionId);

    expect(() => projector.replaceExecution(executionId, [])).toThrow(/at least one replay step/);

    expect(projector.execution(executionId)).toEqual(before);
    expect(database.getMeta(`execution:${executionId}:obsolete`)).toBe("old-meta-empty");
    database.close();
  });

  it("rejects a replay binding mismatch before mutating the existing projection", async () => {
    const { database, projector, events } = await setup();
    const executionId = "execution-mismatch";
    seedExecutionRows(database, executionId, "mismatch");
    const otherEvent = events.append({
      taskId: "other-task",
      attemptId: "other-execution",
      type: "task.created",
      payload: {},
    });

    expect(() => projector.replaceExecution(executionId, [
      { event: otherEvent, state: "PLANNED" },
    ])).toThrow(/attemptId.*execution-mismatch/);

    expect(projector.execution(executionId)?.task_id).toBe("task-mismatch");
    expect(database.getMeta(`execution:${executionId}:obsolete`)).toBe("old-meta-mismatch");
    database.close();
  });

  it("invalidates one execution without deleting neighboring wildcard-like IDs", async () => {
    const { database, projector, events } = await setup();
    const executionId = "execution%_target";
    const neighboringId = "executionXYZ_target";
    seedExecutionRows(database, executionId, "wildcard-target");
    seedExecutionRows(database, neighboringId, "wildcard-neighbor");
    database.setMeta(`execution:${neighboringId}:custom`, "neighbor-meta");
    const replacement = targetReplaySteps(events, executionId);

    projector.replaceExecution(executionId, replacement);

    expect(projector.execution(executionId)).toBeDefined();
    expect(database.getMeta(`execution:${executionId}:last_event_seq`)).toBe("4");
    expect(database.prepare("SELECT artifact_id FROM artifacts WHERE execution_id = ?")
      .get(executionId)).toEqual({ artifact_id: "artifact-new" });
    expect(projector.execution(neighboringId)).toMatchObject({
      execution_id: neighboringId,
      task_id: "task-wildcard-neighbor",
    });
    expect(database.getMeta(`execution:${neighboringId}:custom`)).toBe("neighbor-meta");
    expect(database.prepare("SELECT artifact_id FROM artifacts WHERE execution_id = ?")
      .get(neighboringId)).toEqual({ artifact_id: "artifact-wildcard-neighbor" });

    projector.invalidateExecution(executionId, "target stale");

    expect(projector.execution(executionId)).toBeUndefined();
    expect(database.getMeta(`execution:${executionId}:stale`)).toBe("target stale");
    expect(database.getMeta(`execution:${executionId}:last_event_seq`)).toBeUndefined();
    expect(database.prepare("SELECT count(*) AS n FROM artifacts WHERE execution_id = ?")
      .get(executionId)).toEqual({ n: 0 });
    expect(projector.execution(neighboringId)).toBeDefined();
    expect(database.getMeta(`execution:${neighboringId}:custom`)).toBe("neighbor-meta");
    database.close();
  });
});
