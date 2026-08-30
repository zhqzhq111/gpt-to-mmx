import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const child = join(process.cwd(), "tests", "process", "storage-reservation.child.mjs");

function start(stateRoot, executionId, mode = "once", volumeId = "v1") {
  const processHandle = spawn(process.execPath, [child, mode, stateRoot, executionId, volumeId], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  const lines = [];
  processHandle.stdout.setEncoding("utf8");
  processHandle.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const first = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child ${executionId} did not report`)), 10_000);
    const poll = () => {
      if (lines.length > 0) { clearTimeout(timer); resolve(lines.shift()); return; }
      if (processHandle.exitCode !== null) { clearTimeout(timer); reject(new Error(`child ${executionId} exited early`)); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
  const done = new Promise((resolve, reject) => {
    let stderr = "";
    processHandle.stderr.setEncoding("utf8");
    processHandle.stderr.on("data", (chunk) => { stderr += chunk; });
    processHandle.once("error", reject);
    processHandle.once("close", (code) => code === 0 ? resolve(stderr) : reject(new Error(`child ${executionId} exit ${code}: ${stderr}`)));
  });
  return { processHandle, first, done };
}

test("two real processes cannot over-reserve the same capacity", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g2m-storage-process-race-"));
  try {
    const a = start(stateRoot, "race-a");
    const b = start(stateRoot, "race-b");
    const results = await Promise.all([a.first, b.first]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["ADMITTED", "DENIED"]);
    await Promise.all([a.done, b.done]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a released reservation lets a denied process retry successfully", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g2m-storage-process-release-"));
  try {
    const a = start(stateRoot, "release-a", "hold");
    assert.equal((await a.first).status, "ADMITTED");
    const b = start(stateRoot, "release-b");
    assert.equal((await b.first).status, "DENIED");
    a.processHandle.stdin.end("release\n");
    assert.equal((await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("release not observed")), 10_000);
      a.processHandle.stdout.once("data", (chunk) => { clearTimeout(timer); resolve(JSON.parse(String(chunk).trim().split("\n").at(-1))); });
    })).status, "RELEASED");
    await Promise.all([a.done, b.done]);
    const retry = start(stateRoot, "release-b-retry");
    assert.equal((await retry.first).status, "ADMITTED");
    await retry.done;
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("different volume buckets admit independently", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g2m-storage-process-volumes-"));
  try {
    const a = start(stateRoot, "volume-a", "once", "v1");
    const b = start(stateRoot, "volume-b", "once", "v2");
    assert.deepEqual((await Promise.all([a.first, b.first])).map((result) => result.status).sort(), ["ADMITTED", "ADMITTED"]);
    await Promise.all([a.done, b.done]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
