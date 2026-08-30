import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProcessSupervisor } from "../../dist/process/supervisor.js";
import { runVerification } from "../../dist/evidence/verification.js";

const fixture = join(process.cwd(), "tests/process/process-supervisor.child.mjs");

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function readPid(path) {
  await waitForFile(path);
  return Number.parseInt(await readFile(path, "utf8"), 10);
}

async function assertGone(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`PID ${pid} remained alive`);
}

async function fixturePaths() {
  const root = await mkdtemp(join(tmpdir(), "g2m-process-supervisor-e2e-"));
  return { root, heartbeat: join(root, "heartbeat.log") };
}

function parentSpec(heartbeat, extra = {}) {
  return {
    program: process.execPath,
    args: [fixture, "parent", heartbeat],
    cwd: process.cwd(),
    ...extra,
  };
}

test("real supervisor cancellation removes parent and grandchild", async () => {
  const { root, heartbeat } = await fixturePaths();
  try {
    const managed = new ProcessSupervisor().spawn(parentSpec(heartbeat));
    const parentPid = await readPid(`${heartbeat}.parent.pid`);
    const grandchildPid = await readPid(`${heartbeat}.grandchild.pid`);
    await waitForFile(heartbeat);
    const termination = await managed.terminate("cancel");

    assert.equal(termination.confirmedGone, true);
    await assertGone(parentPid);
    await assertGone(grandchildPid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real supervisor timeout removes the full process tree", async () => {
  const { root, heartbeat } = await fixturePaths();
  try {
    const managed = new ProcessSupervisor({
      gracefulTerminationMs: 1_000,
      forceTerminationMs: 2_000,
    }).spawn(parentSpec(heartbeat, { timeoutMs: 150 }));
    const grandchildPid = await readPid(`${heartbeat}.grandchild.pid`);
    const result = await managed.wait();

    assert.equal(result.kind, "timed_out");
    assert.equal(result.termination.confirmedGone, true);
    await assertGone(grandchildPid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification timeout reports timed_out only after its grandchild is gone", async () => {
  const { root, heartbeat } = await fixturePaths();
  try {
    const result = await runVerification({
      id: "process-tree",
      description: "real process tree timeout",
      program: process.execPath,
      args: [fixture, "parent", heartbeat],
      timeoutMs: 150,
      registeredAt: 0,
    }, "ws-process-tree", root);

    const grandchildPid = await readPid(`${heartbeat}.grandchild.pid`);
    assert.equal(result.status, "timed_out");
    assert.equal(result.termination?.confirmedGone, true);
    await assertGone(grandchildPid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
