import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { StateDatabase } from "../../src/projection/database.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";
import { writeStorageManifestAtomic } from "../../src/storage/usage.js";
import { planGcCandidates, type GcPlannerOptions } from "../../src/storage/gc-candidate.js";
import { WorkspaceLock } from "../../src/workspace/lock.js";

const roots: string[] = [];
const openStores: EventStore[] = [];
const openDatabases: StateDatabase[] = [];
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(overrides: { readonly nowMs?: number } = {}): Promise<{
  readonly root: string;
  readonly options: GcPlannerOptions;
  readonly executionId: string;
  readonly eventStore: EventStore;
  readonly database: StateDatabase;
}> {
  const root = await mkdtemp(join(tmpdir(), "g2m-gc-candidate-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  const artifactRoot = join(root, "artifacts");
  const worktreeRoot = join(root, "worktrees");
  const executionId = "exec-failed";
  const eventStore = new EventStore({ executionDirectory: join(stateRoot, "executions") });
  const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
  openStores.push(eventStore);
  openDatabases.push(database);
  const projector = new ExecutionProjector(database, { completedRetentionDays: 1 });
  const created = eventStore.append({
    taskId: "task-failed",
    attemptId: executionId,
    type: "task.created",
    timestampMs: 100,
    payload: {},
  });
  projector.project(created, "PLANNED");
  const validating = eventStore.append({ taskId: "task-failed", attemptId: executionId, type: "task.validation.started", timestampMs: 110, payload: {} });
  projector.project(validating, "VALIDATING");
  const failed = eventStore.append({ taskId: "task-failed", attemptId: executionId, type: "task.validation.failed", timestampMs: 120, payload: {} });
  projector.project(failed, "FAILED");
  await mkdir(join(artifactRoot, executionId), { recursive: true });
  await writeFile(join(artifactRoot, executionId, "outcome.json"), "outcome");
  await writeStorageManifestAtomic(join(stateRoot, "executions", executionId, "storage-manifest.json"), {
    executionId,
    artifactBytes: 7,
    worktreeBytes: 0,
    artifactPath: join(artifactRoot, executionId),
    worktreePath: join(worktreeRoot, "missing-worktree"),
    retentionClass: "NORMAL",
    gcEligibleAt: 120 + DAY,
    updatedAt: 120,
  });
  const options: GcPlannerOptions = {
    stateRoot,
    artifactRoot,
    worktreeRoot,
    eventStore,
    database,
    nowMs: overrides.nowMs ?? 120 + DAY + 1,
    completedRetentionDays: 1,
  };
  return { root, options, executionId, eventStore, database };
}

describe("GC candidate planner", () => {
  it("plans an expired terminal execution as eligible from authoritative evidence", async () => {
    const f = await fixture();
    const [candidate] = await planGcCandidates(f.options);
    expect(candidate).toMatchObject({
      executionId: f.executionId,
      finalState: "FAILED",
      retentionClass: "NORMAL",
      decision: "ELIGIBLE",
      artifactBytes: 7,
      worktreeBytes: 0,
    });
  });

  it("blocks a candidate before retention expiry", async () => {
    const f = await fixture({ nowMs: 120 + DAY - 1 });
    const [candidate] = await planGcCandidates(f.options);
    expect(candidate?.decision).toBe("BLOCKED");
    expect(candidate?.reasons).toContain("GC_RETENTION_NOT_EXPIRED");
  });

  it.each(["REVIEW_PENDING", "REVISION_REQUESTED", "RECOVERY_REQUIRED", "RUNNING"] as const)(
    "blocks non-GC state %s",
    async (state) => {
      const f = await fixture();
      f.database.prepare("UPDATE executions SET state = ? WHERE execution_id = ?").run(state, f.executionId);
      const [candidate] = await planGcCandidates(f.options);
      expect(candidate?.decision).toBe("BLOCKED");
      expect(candidate?.reasons).toContain("GC_PROJECTION_DISAGREEMENT");
    },
  );

  it("blocks an active reservation and a stale projection", async () => {
    const f = await fixture();
    f.database.prepare(`INSERT INTO storage_reservations(
      reservation_id, reservation_set_id, execution_id, volume_id,
      reserved_bytes, created_at, expires_at, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`).run("reservation-1", "set-1", f.executionId, "volume-1", 1, 1, 2);
    f.database.prepare("UPDATE executions SET gc_eligible_at = ? WHERE execution_id = ?").run(999, f.executionId);
    const [candidate] = await planGcCandidates(f.options);
    expect(candidate?.decision).toBe("BLOCKED");
    expect(candidate?.reasons).toEqual(expect.arrayContaining(["GC_ACTIVE_RESERVATION", "GC_PROJECTION_DISAGREEMENT"]));
  });

  it("blocks deletion while the execution still owns a workspace lease", async () => {
    const f = await fixture();
    const workspacePath = join(f.root, "workspace");
    await mkdir(workspacePath);
    f.database.prepare("UPDATE executions SET workspace_id = ? WHERE execution_id = ?").run("ws-1", f.executionId);
    const lock = new WorkspaceLock({
      stateRoot: join(f.root, "state"),
      dependencies: { hostname: () => "test-host", randomUUID: () => "lease-gc", pidProbe: () => "ALIVE" },
    });
    const handle = await lock.acquire({ workspaceId: "ws-1", canonicalPath: workspacePath, executionId: f.executionId });
    const [candidate] = await planGcCandidates(f.options);

    expect(candidate?.decision).toBe("BLOCKED");
    expect(candidate?.reasons).toContain("GC_ACTIVE_LEASE");
    await lock.release(handle);
  });

  it("blocks missing or malformed manifests and broken Journals", async () => {
    const f = await fixture();
    await rm(join(f.root, "state", "executions", f.executionId, "storage-manifest.json"));
    const [missing] = await planGcCandidates(f.options);
    expect(missing?.reasons).toContain("GC_MANIFEST_INVALID");

    const brokenRoot = await mkdtemp(join(tmpdir(), "g2m-gc-broken-"));
    roots.push(brokenRoot);
    await mkdir(join(brokenRoot, "executions", "broken"), { recursive: true });
    await writeFile(join(brokenRoot, "executions", "broken", "state-events.ndjson"), "{broken\n");
    const brokenStore = new EventStore({ executionDirectory: join(brokenRoot, "executions"), tolerateLoadErrors: true });
    const brokenDb = new StateDatabase(join(brokenRoot, "g2m-state.sqlite"));
    const [broken] = await planGcCandidates({
      stateRoot: brokenRoot,
      artifactRoot: join(brokenRoot, "artifacts"),
      worktreeRoot: join(brokenRoot, "worktrees"),
      eventStore: brokenStore,
      database: brokenDb,
      nowMs: 100,
      completedRetentionDays: 1,
    });
    expect(broken?.decision).toBe("BLOCKED");
    expect(broken?.reasons).toContain("GC_JOURNAL_INVALID");
    openStores.push(brokenStore);
    openDatabases.push(brokenDb);
  });
});
