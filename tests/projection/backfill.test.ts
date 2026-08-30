import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import type { TaskEvent } from "../../src/events/events.js";
import { FingerprintRegistry } from "../../src/execution/fingerprint.js";
import { reduce } from "../../src/events/reducer.js";
import { StateDatabase } from "../../src/projection/database.js";
import {
  ExecutionProjector,
  type ProjectionReplayStep,
  type WorkspaceSeed,
} from "../../src/projection/execution-projector.js";
import { backfillProjection } from "../../src/projection/backfill.js";

const roots: string[] = [];
const databases: StateDatabase[] = [];
const stores: EventStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ root: string; database: StateDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "g2m-backfill-"));
  roots.push(root);
  const database = new StateDatabase(join(root, "g2m-state.sqlite"));
  databases.push(database);
  return { root, database };
}

function storeAt(root: string): EventStore {
  const store = new EventStore({ executionDirectory: join(root, "executions") });
  stores.push(store);
  return store;
}

function appendPlanningHistory(store: EventStore, executionId: string, taskId = `task-${executionId}`): void {
  store.append({ taskId, attemptId: executionId, type: "task.created", timestampMs: 100, payload: {} });
  store.append({
    taskId,
    attemptId: executionId,
    type: "task.validation.started",
    timestampMs: 200,
    payload: {},
  });
  store.flush();
}

function replayIntoProjection(database: StateDatabase, events: readonly TaskEvent[]): void {
  const projector = new ExecutionProjector(database);
  const registry = new FingerprintRegistry();
  let state = null as Parameters<typeof reduce>[0];
  const steps: ProjectionReplayStep[] = [];
  for (const event of events) {
    state = reduce(state, event, { fingerprintRegistry: registry });
    steps.push({ event, state });
  }
  projector.replaceExecution(events[0]?.attemptId ?? "missing", steps);
}

function eventsFor(store: EventStore, executionId: string): readonly TaskEvent[] {
  return store.list().filter((event) => event.attemptId === executionId);
}

function seedOldExecution(database: StateDatabase, executionId: string): void {
  const events = new EventStore();
  const created = events.append({
    taskId: `old-task-${executionId}`,
    attemptId: executionId,
    type: "task.created",
    timestampMs: 1,
    payload: {},
  });
  new ExecutionProjector(database).project(created, "PLANNED");
}

function seedWorkspaces(): readonly WorkspaceSeed[] {
  return [{ workspaceId: "workspace-1", canonicalPath: "workspace/path" }];
}

describe("backfillProjection", () => {
  it("repairs a missing projection from a valid Journal and leaves Journal bytes unchanged", async () => {
    const { root, database } = await setup();
    const store = storeAt(root);
    appendPlanningHistory(store, "execution-missing");
    const path = join(root, "executions", "execution-missing", "state-events.ndjson");
    const before = await readFile(path);

    const report = backfillProjection({
      stateRoot: root,
      database,
      workspaces: seedWorkspaces(),
      nowMs: 9_000,
    });

    expect(report).toEqual({
      scannedExecutions: 1,
      repairedExecutions: 1,
      currentExecutions: 0,
      staleExecutions: 0,
      truncatedTails: 0,
      failureReasons: [],
    });
    expect(database.prepare("SELECT task_id, state, updated_at FROM executions").all()).toEqual([{
      task_id: "task-execution-missing",
      state: "VALIDATING",
      updated_at: 200,
    }]);
    expect(database.getMeta("execution:execution-missing:last_event_seq")).toBe("2");
    expect(database.prepare("SELECT canonical_path, updated_at FROM workspaces WHERE workspace_id = ?")
      .get("workspace-1")).toEqual({ canonical_path: "workspace/path", updated_at: 9_000 });
    expect(await readFile(path)).toEqual(before);
  });

  it("counts a fully current projection without rewriting unrelated projection fields", async () => {
    const { root, database } = await setup();
    const store = storeAt(root);
    appendPlanningHistory(store, "execution-current");
    replayIntoProjection(database, eventsFor(store, "execution-current"));
    database.prepare("UPDATE executions SET artifact_path = ? WHERE execution_id = ?")
      .run("preserve-this-field", "execution-current");

    const report = backfillProjection({ stateRoot: root, database, workspaces: [], nowMs: 10 });

    expect(report.currentExecutions).toBe(1);
    expect(report.repairedExecutions).toBe(0);
    expect(database.prepare("SELECT artifact_path FROM executions WHERE execution_id = ?")
      .get("execution-current")).toEqual({ artifact_path: "preserve-this-field" });
  });

  it("corrects a forged state even when the Journal cursor matches", async () => {
    const { root, database } = await setup();
    const store = storeAt(root);
    appendPlanningHistory(store, "execution-forged");
    replayIntoProjection(database, eventsFor(store, "execution-forged"));
    database.prepare("UPDATE executions SET state = ? WHERE execution_id = ?")
      .run("RUNNING", "execution-forged");

    const report = backfillProjection({ stateRoot: root, database, workspaces: [], nowMs: 10 });

    expect(report.repairedExecutions).toBe(1);
    expect(database.prepare("SELECT state FROM executions WHERE execution_id = ?")
      .get("execution-forged")).toEqual({ state: "VALIDATING" });
  });

  it("repairs projection.stale as a cursor-only event and is current on the second backfill", async () => {
    const { root, database } = await setup();
    const store = storeAt(root);
    store.append({ taskId: "task-stale", attemptId: "execution-stale", type: "task.created", timestampMs: 10, payload: {} });
    store.append({
      taskId: "task-stale",
      attemptId: "execution-stale",
      type: "projection.stale",
      timestampMs: 20,
      payload: { reason: "old projection" },
    });

    const first = backfillProjection({ stateRoot: root, database, workspaces: [], nowMs: 10 });
    expect(first.repairedExecutions).toBe(1);
    expect(database.prepare("SELECT state, updated_at FROM executions WHERE execution_id = ?")
      .get("execution-stale")).toEqual({ state: "PLANNED", updated_at: 10 });
    expect(database.getMeta("execution:execution-stale:last_event_seq")).toBe("2");
    expect(database.getMeta("execution:execution-stale:stale")).toBeUndefined();

    const second = backfillProjection({ stateRoot: root, database, workspaces: [], nowMs: 11 });
    expect(second.currentExecutions).toBe(1);
    expect(second.repairedExecutions).toBe(0);
  });

  it("replays a truncated valid prefix and atomically marks it stale", async () => {
    const { root, database } = await setup();
    const store = storeAt(root);
    store.append({ taskId: "task-truncated", attemptId: "execution-truncated", type: "task.created", timestampMs: 10, payload: {} });
    const path = join(root, "executions", "execution-truncated", "state-events.ndjson");
    await writeFile(path, `${await readFile(path, "utf8")}{`, "utf8");
    const before = await readFile(path);

    const report = backfillProjection({ stateRoot: root, database, workspaces: [], nowMs: 10 });

    expect(report).toMatchObject({
      scannedExecutions: 1,
      repairedExecutions: 1,
      currentExecutions: 0,
      staleExecutions: 1,
      truncatedTails: 1,
      failureReasons: [{ executionId: "execution-truncated", reason: "TRUNCATED_TAIL" }],
    });
    expect(database.prepare("SELECT state FROM executions WHERE execution_id = ?")
      .get("execution-truncated")).toEqual({ state: "PLANNED" });
    expect(database.getMeta("execution:execution-truncated:stale")).toBe("TRUNCATED_TAIL");
    expect(await readFile(path)).toEqual(before);
  });

  it("invalidates only a malformed Journal while repairing a healthy execution", async () => {
    const { root, database } = await setup();
    const store = storeAt(root);
    appendPlanningHistory(store, "healthy-execution");
    await mkdir(join(root, "executions", "bad-execution"), { recursive: true });
    await writeFile(join(root, "executions", "bad-execution", "state-events.ndjson"), "not-json\n", "utf8");
    seedOldExecution(database, "bad-execution");

    const report = backfillProjection({ stateRoot: root, database, workspaces: [], nowMs: 10 });

    expect(report.scannedExecutions).toBe(2);
    expect(report.repairedExecutions).toBe(1);
    expect(report.staleExecutions).toBe(1);
    expect(report.failureReasons).toEqual([{ executionId: "bad-execution", reason: "INVALID_JOURNAL" }]);
    expect(database.prepare("SELECT count(*) AS n FROM executions WHERE execution_id = ?")
      .get("bad-execution")).toEqual({ n: 0 });
    expect(database.getMeta("execution:bad-execution:stale")).toBe("INVALID_JOURNAL");
    expect(database.prepare("SELECT state FROM executions WHERE execution_id = ?")
      .get("healthy-execution")).toEqual({ state: "VALIDATING" });
  });

  it("invalidates an empty Journal instead of preserving an old row", async () => {
    const { root, database } = await setup();
    await mkdir(join(root, "executions", "execution-empty"), { recursive: true });
    await writeFile(join(root, "executions", "execution-empty", "state-events.ndjson"), "", "utf8");
    seedOldExecution(database, "execution-empty");

    const report = backfillProjection({ stateRoot: root, database, workspaces: [], nowMs: 10 });

    expect(report.failureReasons).toEqual([{ executionId: "execution-empty", reason: "EMPTY_JOURNAL" }]);
    expect(report.staleExecutions).toBe(1);
    expect(database.prepare("SELECT count(*) AS n FROM executions WHERE execution_id = ?")
      .get("execution-empty")).toEqual({ n: 0 });
    expect(database.getMeta("execution:execution-empty:stale")).toBe("EMPTY_JOURNAL");
  });

  it("classifies a broken Journal chain and continues scanning", async () => {
    const { root, database } = await setup();
    const store = storeAt(root);
    appendPlanningHistory(store, "execution-broken-chain");
    const path = join(root, "executions", "execution-broken-chain", "state-events.ndjson");
    const records = (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const second = records[1];
    if (second === undefined) throw new Error("test setup did not create a second event");
    second.prev_hash = "forged-previous-hash";
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    seedOldExecution(database, "execution-broken-chain");

    const report = backfillProjection({ stateRoot: root, database, workspaces: [], nowMs: 10 });

    expect(report).toMatchObject({
      scannedExecutions: 1,
      repairedExecutions: 0,
      currentExecutions: 0,
      staleExecutions: 1,
      truncatedTails: 0,
      failureReasons: [{ executionId: "execution-broken-chain", reason: "BROKEN_CHAIN" }],
    });
    expect(database.prepare("SELECT count(*) AS n FROM executions WHERE execution_id = ?")
      .get("execution-broken-chain")).toEqual({ n: 0 });
    expect(database.getMeta("execution:execution-broken-chain:stale")).toBe("BROKEN_CHAIN");
  });

  it("invalidates a reducer contradiction without aborting other executions", async () => {
    const { root, database } = await setup();
    const store = storeAt(root);
    store.append({ taskId: "task-contradiction", attemptId: "execution-contradiction", type: "task.created", timestampMs: 10, payload: {} });
    store.append({ taskId: "task-contradiction", attemptId: "execution-contradiction", type: "review.requested", timestampMs: 20, payload: {} });
    appendPlanningHistory(store, "execution-healthy");
    store.flush();
    seedOldExecution(database, "execution-contradiction");

    const report = backfillProjection({ stateRoot: root, database, workspaces: [], nowMs: 10 });

    expect(report.repairedExecutions).toBe(1);
    expect(report.staleExecutions).toBe(1);
    expect(report.failureReasons[0]?.executionId).toBe("execution-contradiction");
    expect(report.failureReasons[0]?.reason).toMatch(/^REDUCER_ERROR:/);
    expect(database.prepare("SELECT count(*) AS n FROM executions WHERE execution_id = ?")
      .get("execution-contradiction")).toEqual({ n: 0 });
    expect(database.prepare("SELECT state FROM executions WHERE execution_id = ?")
      .get("execution-healthy")).toEqual({ state: "VALIDATING" });
  });

  it("returns failure reasons in lexical execution-directory order", async () => {
    const { root, database } = await setup();
    for (const executionId of ["z-invalid", "a-invalid", "m-empty"]) {
      await mkdir(join(root, "executions", executionId), { recursive: true });
      await writeFile(
        join(root, "executions", executionId, "state-events.ndjson"),
        executionId === "m-empty" ? "" : "not-json\n",
        "utf8",
      );
    }

    const report = backfillProjection({ stateRoot: root, database, workspaces: [], nowMs: 10 });

    expect(report.failureReasons.map((failure) => failure.executionId)).toEqual([
      "a-invalid",
      "m-empty",
      "z-invalid",
    ]);
    expect(report.failureReasons.every((failure) => !failure.reason.includes(root))).toBe(true);
  });

  it("refreshes trusted workspaces even when there are zero execution directories", async () => {
    const { root, database } = await setup();
    database.prepare("INSERT INTO workspaces(workspace_id, canonical_path, updated_at) VALUES (?, ?, ?)")
      .run("workspace-1", "old/path", 1);

    const report = backfillProjection({
      stateRoot: root,
      database,
      workspaces: seedWorkspaces(),
      nowMs: 99,
    });

    expect(report).toMatchObject({ scannedExecutions: 0, repairedExecutions: 0, currentExecutions: 0 });
    expect(database.prepare("SELECT canonical_path, updated_at FROM workspaces WHERE workspace_id = ?")
      .get("workspace-1")).toEqual({ canonical_path: "workspace/path", updated_at: 99 });
    expect(database.getMeta("backfill_status")).toBe("complete");
    expect(database.getMeta("backfill_at")).toBe("99");
  });
});
