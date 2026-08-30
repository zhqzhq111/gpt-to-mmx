import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { StateDatabase } from "../../src/projection/database.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";
import { writeStorageManifestAtomic } from "../../src/storage/usage.js";
import { cleanupSafeOrphans, executeGc, GcFaultError, resumeInterrupted, type GcExecutorOptions } from "../../src/storage/gc.js";
import { readTombstone } from "../../src/storage/tombstone.js";

const roots: string[] = [];
const stores: EventStore[] = [];
const databases: StateDatabase[] = [];
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly options: GcExecutorOptions; readonly stateRoot: string; readonly artifactPath: string; readonly executionId: string; }> {
  const root = await mkdtemp(join(tmpdir(), "g2m-gc-executor-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  const artifactRoot = join(root, "artifacts");
  const worktreeRoot = join(root, "worktrees");
  const executionId = "exec-gc";
  const artifactPath = join(artifactRoot, executionId);
  const eventStore = new EventStore({ executionDirectory: join(stateRoot, "executions") });
  const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
  stores.push(eventStore);
  databases.push(database);
  const projector = new ExecutionProjector(database, { completedRetentionDays: 1 });
  const created = eventStore.append({ taskId: "task-gc", attemptId: executionId, type: "task.created", timestampMs: 100, payload: {} });
  projector.project(created, "PLANNED");
  const validating = eventStore.append({ taskId: "task-gc", attemptId: executionId, type: "task.validation.started", timestampMs: 110, payload: {} });
  projector.project(validating, "VALIDATING");
  const failed = eventStore.append({ taskId: "task-gc", attemptId: executionId, type: "task.validation.failed", timestampMs: 120, payload: {} });
  projector.project(failed, "FAILED");
  await mkdir(artifactPath, { recursive: true });
  await writeFile(join(artifactPath, "outcome.json"), "outcome");
  await writeStorageManifestAtomic(join(stateRoot, "executions", executionId, "storage-manifest.json"), {
    executionId,
    artifactBytes: 7,
    worktreeBytes: 0,
    artifactPath,
    worktreePath: join(worktreeRoot, "missing"),
    retentionClass: "NORMAL",
    gcEligibleAt: 120 + DAY,
    updatedAt: 120,
  });
  const options: GcExecutorOptions = {
    stateRoot,
    artifactRoot,
    worktreeRoot,
    eventStore,
    database,
    completedRetentionDays: 1,
    nowMs: 120 + DAY + 1,
  };
  return { options, stateRoot, artifactPath, executionId };
}

describe("GC executor", () => {
  it("deletes only after durable gc.marked and leaves a valid tombstone", async () => {
    const f = await fixture();
    const result = await executeGc(f.options);

    expect(result.completed).toBe(1);
    expect(existsSync(f.artifactPath)).toBe(false);
    expect(existsSync(join(f.stateRoot, "executions", f.executionId))).toBe(false);
    const tombstone = await readTombstone(join(f.stateRoot, "tombstones", f.executionId + ".json"));
    expect(tombstone).toMatchObject({ executionId: f.executionId, finalState: "FAILED" });
    expect(f.options.eventStore.getByAttemptId(f.executionId).map((event) => event.type)).toEqual([
      "task.created", "task.validation.started", "task.validation.failed", "gc.marked", "gc.completed",
    ]);
    expect(f.options.database.prepare("SELECT artifact_path, worktree_path, gc_eligible_at FROM executions WHERE execution_id = ?").get(f.executionId)).toEqual({ artifact_path: null, worktree_path: null, gc_eligible_at: null });
    expect(f.options.database.prepare("SELECT count(*) AS n FROM artifacts WHERE execution_id = ?").get(f.executionId)).toEqual({ n: 0 });
    expect(f.options.database.prepare("SELECT count(*) AS n FROM storage_usage WHERE execution_id = ?").get(f.executionId)).toEqual({ n: 0 });
  });

  it("keeps gc.marked and refuses gc.completed when deletion fails", async () => {
    const f = await fixture();
    const failed = await executeGc({ ...f.options, removeArtifact: async () => { throw new Error("injected delete failure"); } });
    expect(failed.completed).toBe(0);
    expect(f.options.eventStore.getByAttemptId(f.executionId).at(-1)?.type).toBe("gc.marked");
    expect(existsSync(f.artifactPath)).toBe(true);
    expect(await readFile(join(f.stateRoot, "executions", f.executionId, "state-events.ndjson"), "utf8")).toContain("gc.marked");
  });

  it("exposes deterministic crash points after the durable mark", async () => {
    const f = await fixture();
    const report = await executeGc({ ...f.options, fault: async (point) => { if (point === "after_gc_marked") throw new GcFaultError(point); } });
    expect(report.failures[0]?.reason).toContain("after_gc_marked");
    expect(f.options.eventStore.getByAttemptId(f.executionId).at(-1)?.type).toBe("gc.marked");
    expect(existsSync(f.artifactPath)).toBe(true);
  });

  it("resumes a marked operation idempotently after the process is restarted", async () => {
    const f = await fixture();
    await executeGc({ ...f.options, fault: async (point) => { if (point === "after_gc_marked") throw new GcFaultError(point); } });
    const result = await resumeInterrupted(f.options);

    expect(result.completed).toBe(1);
    expect(existsSync(f.artifactPath)).toBe(false);
    expect(existsSync(join(f.stateRoot, "executions", f.executionId))).toBe(false);
    expect((await readTombstone(join(f.stateRoot, "tombstones", f.executionId + ".json")))).toBeDefined();
    expect(f.options.eventStore.getByAttemptId(f.executionId).filter((event) => event.type === "gc.completed")).toHaveLength(1);
  });

  it("finishes state cleanup when gc.completed was durable before the crash", async () => {
    const f = await fixture();
    await executeGc({ ...f.options, fault: async (point) => { if (point === "after_gc_completed") throw new GcFaultError(point); } });
    expect(existsSync(join(f.stateRoot, "executions", f.executionId))).toBe(true);

    const result = await resumeInterrupted(f.options);

    expect(result.completed).toBe(1);
    expect(existsSync(join(f.stateRoot, "executions", f.executionId))).toBe(false);
    expect(await readTombstone(join(f.stateRoot, "tombstones", f.executionId + ".json"))).toBeDefined();
  });

  it("cleans only leftovers bound by a valid tombstone", async () => {
    const f = await fixture();
    await executeGc({ ...f.options, fault: async (point) => { if (point === "after_gc_completed") throw new GcFaultError(point); } });
    await mkdir(f.artifactPath, { recursive: true });
    await writeFile(join(f.artifactPath, "orphan"), "bound", "utf8");
    const unknown = join(f.options.artifactRoot, "unknown-orphan");
    await mkdir(unknown, { recursive: true });
    const result = await cleanupSafeOrphans(f.options);

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(f.artifactPath)).toBe(false);
    expect(existsSync(unknown)).toBe(true);
  });
});
