import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EventStore } from "../../dist/events/store.js";
import { StateDatabase } from "../../dist/projection/database.js";

const child = join(process.cwd(), "tests", "process", "operations.child.mjs");

function run(mode, configPath) {
  return new Promise((resolvePromise, reject) => {
    const handle = spawn(process.execPath, [child, mode, configPath], { cwd: process.cwd(), windowsHide: true });
    let stdout = "";
    let stderr = "";
    handle.stdout.on("data", (chunk) => { stdout += chunk; });
    handle.stderr.on("data", (chunk) => { stderr += chunk; });
    handle.on("error", reject);
    handle.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

async function fixture(prefix, journalCount = 0) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const stateRoot = join(root, "state");
  const configPath = join(root, "config.json");
  await mkdir(join(stateRoot, "executions"), { recursive: true });
  await mkdir(join(stateRoot, "locks"), { recursive: true });
  await mkdir(join(stateRoot, "reservations"), { recursive: true });
  await mkdir(join(stateRoot, "tombstones"), { recursive: true });
  await mkdir(join(root, "workspace"), { recursive: true });
  await mkdir(join(root, "artifacts"), { recursive: true });
  await mkdir(join(root, "worktrees"), { recursive: true });
  const events = new EventStore({ executionDirectory: join(stateRoot, "executions") });
  events.append({ taskId: "operations-task", attemptId: "operations-execution", type: "task.created", timestampMs: 1, payload: {} });
  for (let index = 0; index < journalCount; index += 1) {
    events.append({ taskId: `operations-task-${index}`, attemptId: `operations-execution-${index}`, type: "task.created", timestampMs: index + 2, payload: {} });
  }
  events.close();
  const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
  database.close();
  await writeFile(configPath, JSON.stringify({
    protocol_version: "g2m.local-config.v1",
    workspaces: [{ workspace_id: "ws-1", path: join(root, "workspace") }],
    verification_profiles: [], worktree_root: join(root, "worktrees"), artifact_root: join(root, "artifacts"), state_root: stateRoot,
  }), "utf8");
  return { root, stateRoot, configPath };
}

async function snapshotFiles(root) {
  const result = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        const info = await stat(path);
        result.set(path, { bytes: await readFile(path), size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  await visit(root);
  return result;
}

test("real status and doctor leave persisted state byte-for-byte unchanged", async () => {
  const f = await fixture("g2m-operations-process-read-");
  try {
    const before = await snapshotFiles(f.root);
    assert.equal((await run("status", f.configPath)).code, 0);
    assert.equal((await run("doctor", f.configPath)).code, 0);
    const after = await snapshotFiles(f.root);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [path, expected] of before) {
      const actual = after.get(path);
      assert.deepEqual(actual.bytes, expected.bytes, path);
      assert.equal(actual.size, expected.size, path);
      assert.equal(actual.mtimeMs, expected.mtimeMs, path);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("two real repair commands produce one applied result and no stale-plan mutation", async () => {
  const f = await fixture("g2m-operations-process-race-", 2000);
  try {
    const results = await Promise.all([run("repair", f.configPath), run("repair", f.configPath)]);
    assert.deepEqual(results.map((result) => result.code).sort(), [0, 1], results.map((result) => result.stderr).join("\n"));
    const successful = results.find((result) => result.code === 0);
    assert.ok(successful, results.map((result) => result.stderr).join("\n"));
    const output = JSON.parse(successful.stdout);
    assert.equal(output.status, "APPLIED");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a crashed repair owner is reclaimed only after same-host dead-PID proof", async () => {
  const f = await fixture("g2m-operations-process-reclaim-");
  try {
    const handle = spawn(process.execPath, [child, "hold-lock", f.configPath, "crashed-owner"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let line = "";
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("repair owner did not start")), 10_000);
      handle.stdout.once("data", (chunk) => { clearTimeout(timer); line = String(chunk).trim(); resolvePromise(); });
      handle.once("error", reject);
    });
    const owner = JSON.parse(line);
    handle.kill();
    await new Promise((resolvePromise) => handle.once("close", resolvePromise));
    const lockPath = owner.path;
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.heartbeat_at = 0;
    await writeFile(lockPath, JSON.stringify(lock) + "\n", "utf8");
    const reclaimed = await run("repair", f.configPath);
    assert.equal(reclaimed.code, 0, reclaimed.stderr);
    const output = JSON.parse(reclaimed.stdout);
    assert.notEqual(output.status, "REFUSED");
    assert.equal(owner.pid > 0, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("live, unknown, and foreign repair owners cannot be reclaimed", async () => {
  const f = await fixture("g2m-operations-process-held-");
  try {
    const handle = spawn(process.execPath, [child, "hold-lock", f.configPath, "live-owner"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    await new Promise((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error("owner did not start")), 10_000); handle.stdout.once("data", () => { clearTimeout(timer); resolvePromise(); }); handle.once("error", reject); });
    const live = await run("repair", f.configPath);
    assert.equal(live.code, 1);
    handle.stdin.end();
    await new Promise((resolvePromise) => handle.once("close", resolvePromise));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("unknown and foreign repair owners are refused by a real repair process", async () => {
  const f = await fixture("g2m-operations-process-unsafe-");
  try {
    await mkdir(join(f.stateRoot, "repair"), { recursive: true });
    const path = join(f.stateRoot, "repair", "repair.lock");
    await writeFile(path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "unknown-owner", pid: 99999999, hostname: "host-a", created_at: 0, heartbeat_at: 0 }) + "\n");
    const unknown = await run("repair", f.configPath);
    assert.equal(unknown.code, 1);
    const foreign = JSON.parse(await readFile(path, "utf8"));
    foreign.operation_id = "foreign-owner";
    foreign.hostname = "foreign-host";
    await writeFile(path, JSON.stringify(foreign) + "\n", "utf8");
    const foreignResult = await run("repair", f.configPath);
    assert.equal(foreignResult.code, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
