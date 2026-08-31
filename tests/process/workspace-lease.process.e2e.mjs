import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { workspaceKeyForPath } from "../../dist/workspace/lock.js";

const childPath = join(process.cwd(), "tests", "process", "workspace-lease.child.mjs");
const processTempRoot = join(process.cwd(), ".tmp");

async function makeProcessTempRoot(prefix) {
  await mkdir(processTempRoot, { recursive: true });
  return mkdtemp(join(processTempRoot, prefix));
}

function startChild(mode, stateRoot, workspacePath, workspaceId, executionId) {
  const child = spawn(process.execPath, [childPath, mode, stateRoot, workspacePath, workspaceId, executionId], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  const messages = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      messages.push(line === "READY" ? { kind: "ready" } : JSON.parse(line));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => undefined);
  return { child, messages };
}

async function waitForMessage(processHandle, predicate) {
  while (true) {
    const found = processHandle.messages.find(predicate);
    if (found) return found;
    if (processHandle.child.exitCode !== null) throw new Error("child exited before expected message");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function waitForExit(handle) {
  if (handle.child.exitCode === null) await once(handle.child, "exit");
}

async function removeRoot(root) {
  await rm(root, { recursive: true, force: true });
}

test("two real Node processes have exactly one acquire winner", async () => {
  const root = await makeProcessTempRoot("lease-process-");
  try {
    const stateRoot = join(root, "state");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const left = startChild("acquire", stateRoot, workspacePath, "left", "exec-left");
    const right = startChild("acquire", stateRoot, workspacePath, "right", "exec-right");
    await Promise.all([waitForMessage(left, (m) => m.kind === "ready"), waitForMessage(right, (m) => m.kind === "ready")]);
    left.child.stdin.write("GO\n");
    right.child.stdin.write("GO\n");
    const results = await Promise.all([
      waitForMessage(left, (m) => m.kind === "acquired" || m.kind === "error"),
      waitForMessage(right, (m) => m.kind === "acquired" || m.kind === "error"),
    ]);
    assert.equal(results.filter((m) => m.kind === "acquired").length, 1);
    assert.deepEqual(results.filter((m) => m.kind === "error").map((m) => m.code), ["WORKSPACE_BUSY"]);
    const winner = results[0].kind === "acquired" ? left : right;
    winner.child.stdin.write("RELEASE\n");
    await waitForMessage(winner, (m) => m.kind === "released");
    left.child.kill();
    right.child.kill();
    await Promise.all([waitForExit(left), waitForExit(right)]);
  } finally {
    await removeRoot(root);
  }
});

test("a second real process can acquire after the first releases", async () => {
  const root = await makeProcessTempRoot("lease-process-retry-");
  try {
    const stateRoot = join(root, "state");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const first = startChild("acquire", stateRoot, workspacePath, "first", "exec-first");
    const blocked = startChild("acquire", stateRoot, workspacePath, "blocked", "exec-blocked");
    await Promise.all([waitForMessage(first, (m) => m.kind === "ready"), waitForMessage(blocked, (m) => m.kind === "ready")]);
    first.child.stdin.write("GO\n");
    await waitForMessage(first, (m) => m.kind === "acquired");
    blocked.child.stdin.write("GO\n");
    assert.equal((await waitForMessage(blocked, (m) => m.kind === "error")).code, "WORKSPACE_BUSY");
    await waitForExit(blocked);
    first.child.stdin.write("RELEASE\n");
    await waitForMessage(first, (m) => m.kind === "released");
    await waitForExit(first);
    const retry = startChild("acquire", stateRoot, workspacePath, "retry", "exec-retry");
    await waitForMessage(retry, (m) => m.kind === "ready");
    retry.child.stdin.write("GO\n");
    await waitForMessage(retry, (m) => m.kind === "acquired");
    retry.child.stdin.write("RELEASE\n");
    await waitForMessage(retry, (m) => m.kind === "released");
    await waitForExit(retry);
  } finally {
    await removeRoot(root);
  }
});

test("a real lease refreshes only its heartbeat sidecar", async () => {
  const root = await makeProcessTempRoot("lease-process-heartbeat-");
  try {
    const stateRoot = join(root, "state");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const key = await workspaceKeyForPath(workspacePath);
    const owner = startChild("acquire", stateRoot, workspacePath, "heartbeat", "exec-heartbeat");
    await waitForMessage(owner, (m) => m.kind === "ready");
    owner.child.stdin.write("GO\n");
    const acquired = await waitForMessage(owner, (m) => m.kind === "acquired");
    const ownerPath = join(stateRoot, "locks", `${key}.lock`);
    const heartbeatPath = join(stateRoot, "locks", `${key}.${acquired.leaseId}.heartbeat`);
    const ownerBefore = await readFile(ownerPath, "utf8");
    const initialHeartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
    let refreshed = initialHeartbeat;
    const deadline = Date.now() + 1_000;
    while (refreshed.heartbeat_at === initialHeartbeat.heartbeat_at && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      refreshed = JSON.parse(await readFile(heartbeatPath, "utf8"));
    }
    assert.notEqual(refreshed.heartbeat_at, initialHeartbeat.heartbeat_at);
    assert.equal(await readFile(ownerPath, "utf8"), ownerBefore);
    owner.child.stdin.write("RELEASE\n");
    await waitForMessage(owner, (m) => m.kind === "released");
    await waitForExit(owner);
  } finally {
    await removeRoot(root);
  }
});

test("two real Node processes have exactly one stale reclaim winner", async () => {
  const root = await makeProcessTempRoot("lease-process-reclaim-");
  try {
    const stateRoot = join(root, "state");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const key = await workspaceKeyForPath(workspacePath);
    const locksRoot = join(stateRoot, "locks");
    await mkdir(locksRoot, { recursive: true });
    await writeFile(join(locksRoot, `${key}.lock`), JSON.stringify({
      lock_version: 1, workspace_key: key, workspace_id: "demo", execution_id: "exec-stale",
      lease_id: "lease-stale", pid: 999999, hostname: hostname(), created_at: 0, heartbeat_at: 0,
    }) + "\n", "utf8");
    await writeFile(join(locksRoot, `${key}.lease-stale.heartbeat`), JSON.stringify({
      heartbeat_version: 1, workspace_key: key, lease_id: "lease-stale", heartbeat_at: 0,
    }) + "\n", "utf8");
    const left = startChild("reclaim", stateRoot, key, "left", "exec-left");
    const right = startChild("reclaim", stateRoot, key, "right", "exec-right");
    await Promise.all([waitForMessage(left, (m) => m.kind === "ready"), waitForMessage(right, (m) => m.kind === "ready")]);
    left.child.stdin.write("GO\n");
    right.child.stdin.write("GO\n");
    const results = await Promise.all([
      waitForMessage(left, (m) => m.kind === "reclaimed" || m.kind === "error"),
      waitForMessage(right, (m) => m.kind === "reclaimed" || m.kind === "error"),
    ]);
    assert.equal(results.filter((m) => m.kind === "reclaimed").length, 1);
    assert.equal(results.filter((m) => m.kind === "error").length, 1);
    await Promise.all([waitForExit(left), waitForExit(right)]);
    await assert.rejects(readFile(join(locksRoot, `${key}.lock`)));
  } finally {
    await removeRoot(root);
  }
});
