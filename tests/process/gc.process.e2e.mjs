import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EventStore } from "../../dist/events/store.js";
import { StateDatabase } from "../../dist/projection/database.js";
import { ExecutionProjector } from "../../dist/projection/execution-projector.js";
import { writeStorageManifestAtomic } from "../../dist/storage/usage.js";

const DAY = 24 * 60 * 60 * 1000;

function child(args) {
  return new Promise((resolvePromise, reject) => {
    const processChild = spawn(process.execPath, args, { cwd: resolve("."), windowsHide: true });
    let stdout = "";
    let stderr = "";
    processChild.stdout.on("data", (chunk) => { stdout += chunk; });
    processChild.stderr.on("data", (chunk) => { stderr += chunk; });
    processChild.on("error", reject);
    processChild.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const stateRoot = join(root, "state");
  const artifactRoot = join(root, "artifacts");
  const worktreeRoot = join(root, "worktrees");
  const workspace = join(root, "workspace");
  const executionId = "process-gc-execution";
  await mkdir(workspace, { recursive: true });
  const events = new EventStore({ executionDirectory: join(stateRoot, "executions") });
  const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
  const projector = new ExecutionProjector(database);
  const created = events.append({ taskId: "process-gc-task", attemptId: executionId, type: "task.created", timestampMs: 1, payload: {} });
  projector.project(created, "PLANNED");
  const validating = events.append({ taskId: "process-gc-task", attemptId: executionId, type: "task.validation.started", timestampMs: 2, payload: {} });
  projector.project(validating, "VALIDATING");
  const failed = events.append({ taskId: "process-gc-task", attemptId: executionId, type: "task.validation.failed", timestampMs: 3, payload: {} });
  projector.project(failed, "FAILED");
  const artifactPath = join(artifactRoot, executionId);
  await mkdir(artifactPath, { recursive: true });
  await writeFile(join(artifactPath, "outcome.json"), "process-gc", "utf8");
  await writeStorageManifestAtomic(join(stateRoot, "executions", executionId, "storage-manifest.json"), {
    executionId, artifactBytes: 10, worktreeBytes: 0, artifactPath,
    worktreePath: join(worktreeRoot, "missing"), retentionClass: "NORMAL",
    gcEligibleAt: 3 + 30 * DAY, updatedAt: 3,
  });
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    protocol_version: "g2m.local-config.v1",
    workspaces: [{ workspace_id: "process-workspace", path: workspace }],
    verification_profiles: [], worktree_root: worktreeRoot, artifact_root: artifactRoot,
    state_root: stateRoot, storage: { completed_retention_days: 30 },
  }), "utf8");
  events.close();
  database.close();
  return { root, stateRoot, artifactRoot, worktreeRoot, configPath, executionId, artifactPath };
}

async function exists(path) { return access(path).then(() => true).catch(() => false); }

async function recoveryFixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const stateRoot = join(root, "state");
  const artifactRoot = join(root, "artifacts");
  const worktreeRoot = join(root, "worktrees");
  const workspace = join(root, "workspace");
  const executionId = "process-gc-recovery";
  await mkdir(workspace, { recursive: true });
  const events = new EventStore({ executionDirectory: join(stateRoot, "executions") });
  const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
  const projector = new ExecutionProjector(database);
  const created = events.append({ taskId: "process-gc-recovery-task", attemptId: executionId, type: "task.created", timestampMs: 1, payload: {} });
  projector.project(created, "PLANNED");
  const required = events.append({ taskId: "process-gc-recovery-task", attemptId: executionId, type: "recovery.required", timestampMs: 2, payload: { reason: "unknown worker" } });
  projector.project(required, "RECOVERY_REQUIRED");
  const artifactPath = join(artifactRoot, executionId);
  await mkdir(artifactPath, { recursive: true });
  await writeFile(join(artifactPath, "recovery-evidence"), "keep", "utf8");
  await writeStorageManifestAtomic(join(stateRoot, "executions", executionId, "storage-manifest.json"), {
    executionId, artifactBytes: 4, worktreeBytes: 0, artifactPath,
    worktreePath: join(worktreeRoot, "missing"), retentionClass: "RECOVERY_CRITICAL",
    gcEligibleAt: null, updatedAt: 2,
  });
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    protocol_version: "g2m.local-config.v1",
    workspaces: [{ workspace_id: "process-workspace", path: workspace }],
    verification_profiles: [], worktree_root: worktreeRoot, artifact_root: artifactRoot,
    state_root: stateRoot,
  }), "utf8");
  events.close();
  database.close();
  return { root, configPath, artifactPath, stateRoot, executionId };
}

async function ageGcLock(stateRoot) {
  const path = join(stateRoot, "gc", "gc.lock");
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.heartbeat_at = 0;
  await writeFile(path, JSON.stringify(raw) + "\n", "utf8");
}

const roots = [];
try {
  const race = await fixture("g2m-gc-process-race-");
  roots.push(race.root);
  const raced = await Promise.all([
    child(["tests/process/gc.child.mjs", "cli", race.configPath]),
    child(["tests/process/gc.child.mjs", "cli", race.configPath]),
  ]);
  assert.equal(raced.filter((item) => item.code === 0).length, 1, raced.map((item) => item.stderr).join("\n"));
  assert.equal(raced.filter((item) => item.code !== 0).length, 1);
  assert.match(raced.find((item) => item.code !== 0).stderr, /GC_LOCK_BUSY/);
  const raceOutputs = raced.filter((item) => item.code === 0).map((item) => JSON.parse(item.stdout.trim().split(/\r?\n/).at(-1)));
  assert.equal(raceOutputs.filter((item) => item.mode === "apply" && item.result.completed === 1).length, 1);
  assert.equal(await exists(join(race.stateRoot, "tombstones", race.executionId + ".json")), true);
  assert.equal(await exists(race.artifactPath), false);
  assert.equal(await exists(join(race.stateRoot, "executions", race.executionId)), false);

  const marked = await fixture("g2m-gc-process-marked-");
  roots.push(marked.root);
  const crashedMarked = await child(["tests/process/gc.child.mjs", "crash", marked.configPath, "after_gc_marked"]);
  assert.equal(crashedMarked.code, 91, crashedMarked.stderr);
  await ageGcLock(marked.stateRoot);
  const resumedMarked = await child(["tests/process/gc.child.mjs", "cli", marked.configPath]);
  assert.equal(resumedMarked.code, 0, resumedMarked.stderr);
  assert.equal(await exists(join(marked.stateRoot, "tombstones", marked.executionId + ".json")), true);
  assert.equal(await exists(join(marked.stateRoot, "executions", marked.executionId)), false);

  const completed = await fixture("g2m-gc-process-completed-");
  roots.push(completed.root);
  const crashedCompleted = await child(["tests/process/gc.child.mjs", "crash", completed.configPath, "after_gc_completed"]);
  assert.equal(crashedCompleted.code, 91, crashedCompleted.stderr);
  assert.equal(await exists(join(completed.stateRoot, "executions", completed.executionId)), true);
  await ageGcLock(completed.stateRoot);
  const resumedCompleted = await child(["tests/process/gc.child.mjs", "cli", completed.configPath]);
  assert.equal(resumedCompleted.code, 0, resumedCompleted.stderr);
  assert.equal(await exists(join(completed.stateRoot, "executions", completed.executionId)), false);
  assert.equal(await exists(join(completed.stateRoot, "tombstones", completed.executionId + ".json")), true);

  const recovery = await recoveryFixture("g2m-gc-process-recovery-");
  roots.push(recovery.root);
  const protectedRun = await child(["tests/process/gc.child.mjs", "cli", recovery.configPath]);
  assert.equal(protectedRun.code, 0, protectedRun.stderr);
  const protectedOutput = JSON.parse(protectedRun.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(protectedOutput.result.completed, 0);
  assert.equal(await exists(recovery.artifactPath), true);
  assert.equal(await exists(join(recovery.stateRoot, "tombstones", recovery.executionId + ".json")), false);

  process.stdout.write("GC_PROCESS_E2E_OK\n");
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
