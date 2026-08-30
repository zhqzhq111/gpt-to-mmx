import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/index.js";
import { EventStore } from "../../src/events/store.js";
import { StateDatabase } from "../../src/projection/database.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";
import { writeStorageManifestAtomic } from "../../src/storage/usage.js";

const roots: string[] = [];
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("g2m gc CLI", () => {
  it("defaults to a read-only dry-run and does not change files or SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-gc-cli-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const artifactRoot = join(root, "artifacts");
    const worktreeRoot = join(root, "worktrees");
    const workspace = join(root, "workspace");
    const executionId = "cli-gc-execution";
    await mkdir(workspace, { recursive: true });
    const events = new EventStore({ executionDirectory: join(stateRoot, "executions") });
    const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
    const projector = new ExecutionProjector(database);
    const created = events.append({ taskId: "cli-gc-task", attemptId: executionId, type: "task.created", timestampMs: 1, payload: {} });
    projector.project(created, "PLANNED");
    const validating = events.append({ taskId: "cli-gc-task", attemptId: executionId, type: "task.validation.started", timestampMs: 2, payload: {} });
    projector.project(validating, "VALIDATING");
    const failed = events.append({ taskId: "cli-gc-task", attemptId: executionId, type: "task.validation.failed", timestampMs: 3, payload: {} });
    projector.project(failed, "FAILED");
    const artifactPath = join(artifactRoot, executionId);
    await mkdir(artifactPath, { recursive: true });
    await writeFile(join(artifactPath, "outcome.json"), "keep", "utf8");
    await writeStorageManifestAtomic(join(stateRoot, "executions", executionId, "storage-manifest.json"), {
      executionId,
      artifactBytes: 4,
      worktreeBytes: 0,
      artifactPath,
      worktreePath: join(worktreeRoot, "missing"),
      retentionClass: "NORMAL",
      gcEligibleAt: 3 + 30 * DAY,
      updatedAt: 3,
    });
    events.close();
    database.close();
    const before = new Map<string, Buffer>();
    for (const entry of await readdir(stateRoot, { withFileTypes: true })) {
      if (entry.isFile()) before.set(entry.name, await readFile(join(stateRoot, entry.name)));
    }
    const journalBefore = await readFile(join(stateRoot, "executions", executionId, "state-events.ndjson"));
    const artifactBefore = await readFile(join(artifactPath, "outcome.json"));
    await writeFile(join(root, "config.json"), JSON.stringify({
      protocol_version: "g2m.local-config.v1",
      workspaces: [{ workspace_id: "cli-workspace", path: workspace }],
      verification_profiles: [],
      worktree_root: worktreeRoot,
      artifact_root: artifactRoot,
      state_root: stateRoot,
    }), "utf8");
    let output = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    try {
      await main(["gc", "--config", join(root, "config.json")]);
    } finally {
      process.stdout.write = originalWrite;
    }
    const result = JSON.parse(output) as { mode: string; eligible: unknown[]; message: string };
    expect(result.mode).toBe("dry-run");
    expect(result.eligible).toHaveLength(1);
    expect(result.message).toContain("No files were deleted");
    expect(await readFile(join(stateRoot, "executions", executionId, "state-events.ndjson"))).toEqual(journalBefore);
    expect(await readFile(join(artifactPath, "outcome.json"))).toEqual(artifactBefore);
    for (const [name, bytes] of before) expect(await readFile(join(stateRoot, name))).toEqual(bytes);
  });
});
