import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { StateDatabase } from "../../src/projection/database.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";
import {
  RebuildLockHeldError,
  RebuildOldDatabaseUnsettledError,
  commitDatabaseReplace,
  rebuildProjection,
} from "../../src/projection/rebuild.js";
import { writeTombstone } from "../../src/storage/tombstone.js";

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
  it("rebuilds a minimal historical execution row from a valid tombstone", async () => {
    const root = await stateRoot();
    await mkdir(join(root, "tombstones"), { recursive: true });
    await writeTombstone(join(root, "tombstones", "gc-execution.json"), {
      executionId: "gc-execution",
      taskId: "gc-task",
      workspaceId: "workspace-1",
      finalState: "ACCEPTED",
      createdAt: 1,
      terminalAt: 2,
      retentionClass: "NORMAL",
      gcMarkedEventId: "marked",
      gcMarkedEventHash: "m".repeat(64),
      gcCompletedAt: 3,
      artifactBytesBeforeGc: 10,
      worktreeBytesBeforeGc: 20,
    });

    const report = await rebuildProjection({ stateRoot: root, workspaces: [], nowMs: 10 });
    const rebuilt = new StateDatabase(join(root, "g2m-state.sqlite"));
    expect(report.invalidTombstones).toBe(0);
    expect(rebuilt.prepare("SELECT state, task_id, workspace_id, artifact_path, worktree_path, gc_eligible_at FROM executions WHERE execution_id = ?").get("gc-execution")).toEqual({
      state: "ACCEPTED", task_id: "gc-task", workspace_id: "workspace-1", artifact_path: null, worktree_path: null, gc_eligible_at: null,
    });
    expect(rebuilt.prepare("SELECT count(*) AS n FROM artifacts WHERE execution_id = ?").get("gc-execution")).toEqual({ n: 0 });
    rebuilt.close();
  });

  it("rejects a corrupted tombstone without fabricating an execution row", async () => {
    const root = await stateRoot();
    await mkdir(join(root, "tombstones"), { recursive: true });
    await writeTombstone(join(root, "tombstones", "bad-tombstone.json"), {
      executionId: "bad-tombstone",
      taskId: "bad-task",
      workspaceId: null,
      finalState: "FAILED",
      createdAt: 1,
      terminalAt: 2,
      retentionClass: "NORMAL",
      gcMarkedEventId: "marked",
      gcMarkedEventHash: "m".repeat(64),
      gcCompletedAt: 3,
      artifactBytesBeforeGc: 0,
      worktreeBytesBeforeGc: 0,
    });
    const path = join(root, "tombstones", "bad-tombstone.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    raw.self_hash = "0".repeat(64);
    await writeFile(path, JSON.stringify(raw), "utf8");

    const report = await rebuildProjection({ stateRoot: root, workspaces: [], nowMs: 10 });
    const rebuilt = new StateDatabase(join(root, "g2m-state.sqlite"));
    expect(report.invalidTombstones).toBe(1);
    expect(rebuilt.prepare("SELECT count(*) AS n FROM executions WHERE execution_id = ?").get("bad-tombstone")).toEqual({ n: 0 });
    rebuilt.close();
  });

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

  it("skips a corrupted journal but rebuilds the other healthy executions", async () => {
    const root = await stateRoot();
    const executions = join(root, "executions");

    // execution-good: a complete, valid journal that should be rebuilt
    const goodStore = new EventStore({ executionDirectory: executions });
    goodStore.append({
      taskId: "task-1", attemptId: "execution-good", type: "task.created", payload: {}, timestampMs: 1,
    });
    goodStore.close();

    // execution-corrupt: a journal whose middle line is invalid JSON
    const corruptDir = join(executions, "execution-corrupt");
    await mkdir(corruptDir, { recursive: true });
    const validLine = JSON.stringify({
      schema_version: 1,
      event_id: "11111111-1111-1111-1111-111111111111",
      seq: 1,
      timestamp_ms: 1,
      task_id: "task-1",
      execution_id: "execution-corrupt",
      domain: "lifecycle",
      type: "task.created",
      durability: "CRITICAL",
      prev_hash: null,
      hash: "f".repeat(64),
      payload: {},
    });
    const broken = "{not valid json";
    const next = JSON.stringify({
      schema_version: 1,
      event_id: "22222222-2222-2222-2222-222222222222",
      seq: 2,
      timestamp_ms: 2,
      task_id: "task-1",
      execution_id: "execution-corrupt",
      domain: "lifecycle",
      type: "task.validation.started",
      durability: "CRITICAL",
      prev_hash: "f".repeat(64),
      hash: "0".repeat(64),
      payload: {},
    });
    await writeFile(
      join(corruptDir, "state-events.ndjson"),
      `${validLine}\n${broken}\n${next}\n`,
      "utf8",
    );

    const report = await rebuildProjection({ stateRoot: root, workspaces: [], nowMs: 4_000 });
    const rebuilt = new StateDatabase(join(root, "g2m-state.sqlite"));

    expect(report.rebuiltExecutions).toBe(1);
    expect(report.staleExecutions).toBe(1);
    expect(report.failureReasons.find((f) => f.executionId === "execution-corrupt")).toBeDefined();
    expect(new ExecutionProjector(rebuilt).execution("execution-good")?.state).toBe("PLANNED");
    expect(new ExecutionProjector(rebuilt).execution("execution-corrupt")).toBeUndefined();
    expect(rebuilt.getMeta("execution:execution-corrupt:stale")).toMatch(/invalid journal JSON|chain|load/);
    rebuilt.close();
  });

  it("skips a journal whose chain is broken but rebuilds the other executions", async () => {
    const root = await stateRoot();
    const executions = join(root, "executions");

    const goodStore = new EventStore({ executionDirectory: executions });
    goodStore.append({
      taskId: "task-1", attemptId: "execution-good", type: "task.created", payload: {}, timestampMs: 1,
    });
    goodStore.close();

    // execution-broken-chain: two events where the second event's prev_hash
    // does not match the first event's hash. `verifyChain` will reject.
    const brokenDir = join(executions, "execution-broken-chain");
    await mkdir(brokenDir, { recursive: true });
    const first = JSON.stringify({
      schema_version: 1,
      event_id: "11111111-1111-1111-1111-111111111111",
      seq: 1,
      timestamp_ms: 1,
      task_id: "task-1",
      execution_id: "execution-broken-chain",
      domain: "lifecycle",
      type: "task.created",
      durability: "CRITICAL",
      prev_hash: null,
      hash: "a".repeat(64),
      payload: {},
    });
    const second = JSON.stringify({
      schema_version: 1,
      event_id: "22222222-2222-2222-2222-222222222222",
      seq: 2,
      timestamp_ms: 2,
      task_id: "task-1",
      execution_id: "execution-broken-chain",
      domain: "lifecycle",
      type: "task.validation.started",
      durability: "CRITICAL",
      prev_hash: "deadbeef".repeat(8), // wrong on purpose
      hash: "b".repeat(64),
      payload: {},
    });
    await writeFile(
      join(brokenDir, "state-events.ndjson"),
      `${first}\n${second}\n`,
      "utf8",
    );

    const report = await rebuildProjection({ stateRoot: root, workspaces: [], nowMs: 5_000 });
    const rebuilt = new StateDatabase(join(root, "g2m-state.sqlite"));

    expect(report.rebuiltExecutions).toBe(1);
    expect(report.staleExecutions).toBe(1);
    expect(
      report.failureReasons.find((f) => f.executionId === "execution-broken-chain")?.reason,
    ).toMatch(/chain is invalid/);
    expect(new ExecutionProjector(rebuilt).execution("execution-good")?.state).toBe("PLANNED");
    expect(new ExecutionProjector(rebuilt).execution("execution-broken-chain")).toBeUndefined();
    rebuilt.close();
  });

  it("treats a journal with an unsupported schema_version as a per-execution load error", async () => {
    // Fix 1: `restoreEvent` throws for an unsupported `schema_version`. The
    // rebuild must catch that throw inside `loadSingleExecutionJournal` and
    // mark the execution stale instead of aborting the whole rebuild.
    const root = await stateRoot();
    const executions = join(root, "executions");

    const goodStore = new EventStore({ executionDirectory: executions });
    goodStore.append({
      taskId: "task-1", attemptId: "execution-good", type: "task.created", payload: {}, timestampMs: 1,
    });
    goodStore.close();

    const badDir = join(executions, "execution-bad-schema");
    await mkdir(badDir, { recursive: true });
    const badEvent = JSON.stringify({
      schema_version: 999, // unsupported: restoreEvent throws
      event_id: "11111111-1111-1111-1111-111111111111",
      seq: 1,
      timestamp_ms: 1,
      task_id: "task-1",
      execution_id: "execution-bad-schema",
      domain: "lifecycle",
      type: "task.created",
      durability: "CRITICAL",
      prev_hash: null,
      hash: "a".repeat(64),
      payload: {},
    });
    await writeFile(join(badDir, "state-events.ndjson"), `${badEvent}\n`, "utf8");

    const report = await rebuildProjection({ stateRoot: root, workspaces: [], nowMs: 6_000 });
    const rebuilt = new StateDatabase(join(root, "g2m-state.sqlite"));

    expect(report.rebuiltExecutions).toBe(1);
    expect(report.staleExecutions).toBe(1);
    expect(
      report.failureReasons.find((f) => f.executionId === "execution-bad-schema")?.reason,
    ).toMatch(/unsupported journal schema version/);
    expect(new ExecutionProjector(rebuilt).execution("execution-good")?.state).toBe("PLANNED");
    expect(new ExecutionProjector(rebuilt).execution("execution-bad-schema")).toBeUndefined();
    expect(rebuilt.getMeta("execution:execution-bad-schema:stale")).toMatch(/unsupported journal schema version/);
    rebuilt.close();
  });

  it("acquires and releases the process-level rebuild lock on the happy path", async () => {
    const root = await stateRoot();
    const lockPath = join(root, "g2m-state.sqlite.lock");
    expect(existsSync(lockPath)).toBe(false);

    const report = await rebuildProjection({ stateRoot: root, workspaces: [], nowMs: 7_000 });

    expect(report.rebuiltExecutions).toBe(0);
    // The lock is released even on the happy path
    expect(existsSync(lockPath)).toBe(false);
  });

  it("rejects a concurrent rebuild while another holds the lock", async () => {
    const root = await stateRoot();

    // Manually acquire the lock to simulate another rebuild in progress.
    // (We are not going through the full `rebuildProjection` entry point
    // because that would release the lock on completion.)
    const lockPath = join(root, "g2m-state.sqlite.lock");
    await writeFile(lockPath, "", "utf8");

    let caught: unknown;
    try {
      await rebuildProjection({ stateRoot: root, workspaces: [], nowMs: 8_000 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RebuildLockHeldError);
    // The pre-existing lock must NOT be overwritten by the failed attempt.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("");
  });

  it("aborts with RebuildOldDatabaseUnsettledError when the old DB cannot be settled", async () => {
    // Fix 3: the rebuild must NOT move a database it cannot open / checkpoint
    // (it might be locked by another process). Instead it should abort,
    // release the lock, and preserve the old main file as-is.
    const root = await stateRoot();
    const databasePath = join(root, "g2m-state.sqlite");
    // A non-SQLite file: `StateDatabase` will throw on open. This is the
    // closest in-process approximation of "another process holds a write
    // lock on the database".
    await writeFile(databasePath, "not-a-real-sqlite-file", "utf8");

    let caught: unknown;
    try {
      await rebuildProjection({ stateRoot: root, workspaces: [], nowMs: 9_000 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RebuildOldDatabaseUnsettledError);
    // The lock must be released even on this failure path
    expect(existsSync(join(root, "g2m-state.sqlite.lock"))).toBe(false);
    // The old main file must be left exactly as we found it — no rename to
    // backups, no deletion. (We do not check the -wal/-shm siblings here:
    // SQLite may have created and left empty shadows during the open
    // attempt, which is harmless because the rebuild aborts before they
    // are ever used as authoritative state.)
    expect(readFileSync(databasePath, "utf8")).toBe("not-a-real-sqlite-file");
    expect(existsSync(join(root, "backups"))).toBe(false);
  });
});

describe("commitDatabaseReplace", () => {
  it("restores the old database from backup when the final rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-replace-"));
    roots.push(root);
    const oldPath = join(root, "g2m-state.sqlite");
    const newPath = join(root, "g2m-state.sqlite.rebuild-1.tmp");
    const backupPath = join(root, "backups", "g2m-state-1.sqlite");
    const backupsRoot = join(root, "backups");

    // Set up: old DB has a known marker, temp DB has a different marker.
    await writeFile(oldPath, "OLD-DB-CONTENT", "utf8");
    await writeFile(newPath, "NEW-DB-CONTENT", "utf8");

    const calls: Array<[string, string]> = [];
    const failingRename = (src: string, dest: string): void => {
      calls.push([src, dest]);
      if (src === newPath && dest === oldPath) {
        throw new Error("simulated atomic-replace failure on the new→old rename");
      }
      renameSync(src, dest);
    };

    let caught: unknown;
    try {
      commitDatabaseReplace({
        oldPath,
        newPath,
        backupPath,
        backupsRoot,
        rename: failingRename,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/simulated atomic-replace failure/);
    // Three rename calls: old→backup, new→old (fails), backup→old (rollback)
    expect(calls.map(([src, dest]) => `${src} -> ${dest}`)).toEqual([
      `${oldPath} -> ${backupPath}`,
      `${newPath} -> ${oldPath}`,
      `${backupPath} -> ${oldPath}`,
    ]);
    // The old database is restored to the official path with its original content
    expect(readFileSync(oldPath, "utf8")).toBe("OLD-DB-CONTENT");
    // The temp file is removed so a subsequent rebuild can start fresh
    expect(() => statSync(newPath)).toThrow();
    // The backup directory no longer contains the failed backup
    expect((await readdir(backupsRoot)).length).toBe(0);
  });

  it("removes the temp file even when there is no previous database to roll back", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-replace-fresh-"));
    roots.push(root);
    const oldPath = join(root, "g2m-state.sqlite");
    const newPath = join(root, "g2m-state.sqlite.rebuild-2.tmp");
    const backupPath = join(root, "backups", "g2m-state-2.sqlite");
    const backupsRoot = join(root, "backups");

    await writeFile(newPath, "NEW-DB-CONTENT", "utf8");
    // No oldPath file — fresh install

    const calls: Array<[string, string]> = [];
    const failingRename = (src: string, dest: string): void => {
      calls.push([src, dest]);
      if (src === newPath && dest === oldPath) {
        throw new Error("simulated fresh-install failure");
      }
      renameSync(src, dest);
    };

    let caught: unknown;
    try {
      commitDatabaseReplace({
        oldPath,
        newPath,
        backupPath,
        backupsRoot,
        rename: failingRename,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    // No old→backup call because there was no previous DB
    expect(calls.map(([src, dest]) => `${src} -> ${dest}`)).toEqual([
      `${newPath} -> ${oldPath}`,
    ]);
    expect(() => statSync(newPath)).toThrow();
    // No backup directory was ever created (no old DB existed)
    expect(() => statSync(backupsRoot)).toThrow();
  });

  it("succeeds on the happy path with a real rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-replace-happy-"));
    roots.push(root);
    const oldPath = join(root, "g2m-state.sqlite");
    const newPath = join(root, "g2m-state.sqlite.rebuild-3.tmp");
    const backupPath = join(root, "backups", "g2m-state-3.sqlite");
    const backupsRoot = join(root, "backups");

    await writeFile(oldPath, "OLD", "utf8");
    await writeFile(newPath, "NEW", "utf8");

    const result = commitDatabaseReplace({ oldPath, newPath, backupPath, backupsRoot });

    expect(result).toBe(backupPath);
    expect(readFileSync(oldPath, "utf8")).toBe("NEW");
    expect(() => statSync(newPath)).toThrow();
    expect(readFileSync(backupPath, "utf8")).toBe("OLD");
  });
});
