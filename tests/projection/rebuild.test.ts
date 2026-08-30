import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { StateDatabase } from "../../src/projection/database.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";
import { rebuildProjection } from "../../src/projection/rebuild.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "g2m-rebuild-"));
  roots.push(root);
  return root;
}

function appendReviewPending(store: EventStore, executionId: string): void {
  const common = { taskId: "task-1", attemptId: executionId, payload: {} } as const;
  store.append({ ...common, type: "task.created", timestampMs: 1, payload: {
    task: { workspace_scope: { workspace_id: "workspace-1", base_revision: "abc123" } },
  } });
  store.append({ ...common, type: "task.validation.started", timestampMs: 2 });
  store.append({ ...common, type: "task.validation.passed", timestampMs: 3 });
  store.append({ ...common, type: "workspace.lock.requested", timestampMs: 4 });
  store.append({ ...common, type: "workspace.lock.acquired", timestampMs: 5 });
  store.append({ ...common, type: "agent.spawn.started", timestampMs: 6 });
  store.append({ ...common, type: "agent.completed", timestampMs: 7 });
  store.append({ ...common, type: "evidence.diff.collected", timestampMs: 8 });
  store.append({ ...common, type: "patch.frozen", timestampMs: 9, payload: {
    artifact_id: "patch-1",
    artifact_path: "frozen.patch",
    patch_blob_hash: "a".repeat(64),
    patch_bytes: 10,
  } });
  store.append({ ...common, type: "verification.completed", timestampMs: 10 });
  store.append({ ...common, type: "review.requested", timestampMs: 11, payload: {
    review_bundle_id: "bundle-1",
  } });
}

describe("rebuildProjection", () => {
  it("replaces a disposable SQLite index from Journals and trusted workspace config", async () => {
    const root = await stateRoot();
    const executions = join(root, "executions");
    const store = new EventStore({ executionDirectory: executions });
    appendReviewPending(store, "execution-1");
    store.close();
    const old = new StateDatabase(join(root, "g2m-state.sqlite"));
    old.setMeta("bogus", "must disappear");
    old.close();

    const report = await rebuildProjection({
      stateRoot: root,
      workspaces: [{ workspaceId: "workspace-1", canonicalPath: "C:/trusted/repo" }],
      nowMs: 1_000,
    });
    const rebuilt = new StateDatabase(join(root, "g2m-state.sqlite"));
    const projector = new ExecutionProjector(rebuilt);

    expect(report).toMatchObject({ rebuiltExecutions: 1, staleExecutions: 0 });
    expect(projector.execution("execution-1")).toMatchObject({
      state: "REVIEW_PENDING",
      workspace_id: "workspace-1",
      review_bundle_id: "bundle-1",
    });
    expect(rebuilt.getMeta("bogus")).toBeUndefined();
    expect(rebuilt.getMeta("rebuild_status")).toBe("complete");
    expect(rebuilt.prepare("SELECT canonical_path FROM workspaces WHERE workspace_id = ?")
      .get("workspace-1")).toEqual({ canonical_path: "C:/trusted/repo" });
    rebuilt.close();
    expect((await readdir(join(root, "backups"))).length).toBe(1);
  });

  it("replays a valid prefix but marks an incomplete final line stale", async () => {
    const root = await stateRoot();
    const executions = join(root, "executions");
    const store = new EventStore({ executionDirectory: executions });
    store.append({
      taskId: "task-1", attemptId: "execution-1", type: "task.created", payload: {}, timestampMs: 1,
    });
    store.close();
    await writeFile(
      join(executions, "execution-1", "state-events.ndjson"),
      '{"schema_version":',
      { encoding: "utf8", flag: "a" },
    );

    const report = await rebuildProjection({ stateRoot: root, workspaces: [], nowMs: 2_000 });
    const rebuilt = new StateDatabase(join(root, "g2m-state.sqlite"));

    expect(report).toMatchObject({ rebuiltExecutions: 1, staleExecutions: 1 });
    expect(new ExecutionProjector(rebuilt).execution("execution-1")?.state).toBe("PLANNED");
    expect(rebuilt.getMeta("execution:execution-1:stale")).toBe("TRUNCATED_TAIL");
    rebuilt.close();
  });

  it("marks contradictory history stale and invents no execution row", async () => {
    const root = await stateRoot();
    const store = new EventStore({ executionDirectory: join(root, "executions") });
    store.append({
      taskId: "task-1",
      attemptId: "execution-1",
      type: "task.validation.started",
      payload: {},
    });
    store.close();

    const report = await rebuildProjection({ stateRoot: root, workspaces: [], nowMs: 3_000 });
    const rebuilt = new StateDatabase(join(root, "g2m-state.sqlite"));

    expect(report.staleExecutions).toBe(1);
    expect(new ExecutionProjector(rebuilt).execution("execution-1")).toBeUndefined();
    expect(rebuilt.getMeta("execution:execution-1:stale")).toMatch(/first event/);
    rebuilt.close();
  });
});
