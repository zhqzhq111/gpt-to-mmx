import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireRepairLock, RepairLockBusyError } from "../../src/operations/repair-lock.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("repair lock", () => {
  it("serializes repair mutations and persists ownership metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-"));
    roots.push(root);
    const first = await acquireRepairLock(root, { nowMs: 10, operationId: "op-1", dependencies: { hostname: () => "host-a", pidProbe: () => "ALIVE" } });
    expect(JSON.parse(await readFile(join(root, "repair", "repair.lock"), "utf8"))).toMatchObject({ operation_id: "op-1", created_at: 10, heartbeat_at: 10 });
    await expect(acquireRepairLock(root, { nowMs: 11, operationId: "op-2" })).rejects.toBeInstanceOf(RepairLockBusyError);
    await first.release();
    const second = await acquireRepairLock(root, { nowMs: 12, operationId: "op-2" });
    await second.release();
  });

  it("refreshes heartbeat and reclaims only a stale same-host dead owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-")); roots.push(root);
    let now = 0;
    await writeFile(join(root, "repair.lock.seed"), "seed");
    const first = await acquireRepairLock(root, { operationId: "op-1", nowMs: 0, heartbeatIntervalMs: 10, staleAfterMs: 20, dependencies: { now: () => now, hostname: () => "host-a", pidProbe: () => "ALIVE" } });
    now = 5;
    await first.refresh();
    expect(JSON.parse(await readFile(join(root, "repair", "repair.lock"), "utf8"))).toMatchObject({ heartbeat_at: 5 });
    await first.release();

    const stalePath = join(root, "repair", "repair.lock");
    await writeFile(stalePath, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "crashed", pid: 999, hostname: "host-a", created_at: 0, heartbeat_at: 0 }) + "\n");
    const reclaimed = await acquireRepairLock(root, { operationId: "op-2", nowMs: 100, staleAfterMs: 20, dependencies: { now: () => 100, hostname: () => "host-a", pidProbe: () => "DEAD" } });
    expect(reclaimed.operationId).toBe("op-2");
    await reclaimed.release();
  });

  it.each([
    ["live", "host-a", "ALIVE"],
    ["unknown", "host-a", "UNKNOWN"],
    ["foreign", "host-b", "DEAD"],
  ] as const)("refuses reclaim for %s owner", async (label, ownerHost, pidStatus) => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-")); roots.push(root);
    const path = join(root, "repair", "repair.lock");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "repair"), { recursive: true }));
    await writeFile(path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: label, pid: 999, hostname: ownerHost, created_at: 0, heartbeat_at: 0 }) + "\n");
    await expect(acquireRepairLock(root, { operationId: "new", nowMs: 100, staleAfterMs: 20, dependencies: { now: () => 100, hostname: () => "host-a", pidProbe: () => pidStatus } })).rejects.toThrow();
  });

  it("does not release a lock whose operation ownership changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-")); roots.push(root);
    const first = await acquireRepairLock(root, { operationId: "op-1" });
    await writeFile(first.path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "op-2", pid: 1, hostname: "other", created_at: 1, heartbeat_at: 1 }) + "\n");
    await first.release();
    expect(JSON.parse(await readFile(first.path, "utf8"))).toMatchObject({ operation_id: "op-2" });
  });
});
