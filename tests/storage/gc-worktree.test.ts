import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { StateDatabase } from "../../src/projection/database.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";
import { executeGc } from "../../src/storage/gc.js";
import { writeStorageManifestAtomic } from "../../src/storage/usage.js";
import { WorkspaceLock } from "../../src/workspace/lock.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const stores: EventStore[] = [];
const databases: StateDatabase[] = [];
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, windowsHide: true });
  return result.stdout;
}

describe("GC registered worktree safety", () => {
  it("removes a registered worktree through Git and prunes its metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-gc-worktree-"));
    roots.push(root);
    const repo = join(root, "repo");
    const stateRoot = join(root, "state");
    const artifactRoot = join(root, "artifacts");
    const worktreeRoot = join(root, "worktrees");
    const worktreePath = join(worktreeRoot, "exec-worktree");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "--initial-branch=main"]);
    await git(repo, ["config", "user.email", "gc@test.local"]);
    await git(repo, ["config", "user.name", "GC Test"]);
    await writeFile(join(repo, "README.md"), "base\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    await mkdir(worktreeRoot, { recursive: true });
    await git(repo, ["worktree", "add", "--detach", worktreePath, "HEAD"]);

    const executionId = "exec-worktree";
    const events = new EventStore({ executionDirectory: join(stateRoot, "executions") });
    const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
    stores.push(events);
    databases.push(database);
    const projector = new ExecutionProjector(database);
    const created = events.append({ taskId: "task-worktree", attemptId: executionId, type: "task.created", timestampMs: 1, payload: { task: { workspace_scope: { workspace_id: "ws", base_revision: "HEAD" } } } });
    projector.project(created, "PLANNED");
    const validating = events.append({ taskId: "task-worktree", attemptId: executionId, type: "task.validation.started", timestampMs: 2, payload: {} });
    projector.project(validating, "VALIDATING");
    const failed = events.append({ taskId: "task-worktree", attemptId: executionId, type: "task.validation.failed", timestampMs: 3, payload: {} });
    projector.project(failed, "FAILED");
    const artifactPath = join(artifactRoot, executionId);
    await mkdir(artifactPath, { recursive: true });
    await writeFile(join(artifactPath, "outcome.json"), "done", "utf8");
    await writeStorageManifestAtomic(join(stateRoot, "executions", executionId, "storage-manifest.json"), {
      executionId, artifactBytes: 4, worktreeBytes: 0, artifactPath, worktreePath,
      retentionClass: "NORMAL", gcEligibleAt: 3 + 30 * DAY, updatedAt: 3,
    });

    const workspaceLock = new WorkspaceLock({ stateRoot });
    const result = await executeGc({
      stateRoot, artifactRoot, worktreeRoot, eventStore: events, database,
      nowMs: 3 + 30 * DAY + 1, completedRetentionDays: 30,
      workspaces: [{ workspaceId: "ws", canonicalPath: repo }], workspaceLock,
    });

    expect(result.completed).toBe(1);
    const listing = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(listing).not.toContain(worktreePath);
  });
});
