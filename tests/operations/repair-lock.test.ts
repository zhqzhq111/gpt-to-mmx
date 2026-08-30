import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
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

  it("persists an auditable reclaim guard record while reclaiming", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-")); roots.push(root);
    const path = join(root, "repair", "repair.lock");
    const guardPath = join(root, "repair", "repair.lock.reclaim");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "repair"), { recursive: true }));
    await writeFile(path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "crashed", pid: 999, hostname: "host-a", created_at: 0, heartbeat_at: -100 }) + "\n");
    let observed: Record<string, unknown> | undefined;
    let probes = 0;
    const reclaimed = await acquireRepairLock(root, {
      operationId: "op-2", nowMs: 100, staleAfterMs: 20, reclaimGuardStaleMs: 20,
      dependencies: { now: () => 100, hostname: () => "host-a", pidProbe: () => {
        probes += 1;
        if (probes === 2) observed = JSON.parse(readFileSync(guardPath, "utf8")) as Record<string, unknown>;
        return "DEAD";
      } },
    });
    expect(Object.keys(observed ?? {}).sort()).toEqual(["created_at", "guard_id", "heartbeat_at", "hostname", "operation_id", "pid", "schema_version"]);
    expect(observed).toMatchObject({ schema_version: "g2m.repair-lock-reclaim.v1", operation_id: "op-2", pid: process.pid, hostname: "host-a", created_at: 100, heartbeat_at: 100 });
    expect(typeof observed?.guard_id).toBe("string");
    await reclaimed.release();
  });

  it("refuses a fresh dead repair owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-")); roots.push(root);
    const path = join(root, "repair", "repair.lock");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "repair"), { recursive: true }));
    await writeFile(path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "fresh", pid: 999, hostname: "host-a", created_at: 90, heartbeat_at: 90 }) + "\n");
    await expect(acquireRepairLock(root, { operationId: "new", nowMs: 100, staleAfterMs: 20, dependencies: { now: () => 100, hostname: () => "host-a", pidProbe: () => "DEAD" } })).rejects.toMatchObject({ reason: "STALE" });
  });

  it("reclaims a stale guard only when its same-host owner is dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-")); roots.push(root);
    const path = join(root, "repair", "repair.lock");
    const guardPath = join(root, "repair", "repair.lock.reclaim");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "repair"), { recursive: true }));
    await writeFile(path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "crashed", pid: 999, hostname: "host-a", created_at: 0, heartbeat_at: -100 }) + "\n");
    await writeFile(guardPath, JSON.stringify({ schema_version: "g2m.repair-lock-reclaim.v1", guard_id: "guard-1", operation_id: "reclaimer", pid: 998, hostname: "host-a", created_at: 0, heartbeat_at: 0 }) + "\n");
    const reclaimed = await acquireRepairLock(root, {
      operationId: "op-2", nowMs: 100, staleAfterMs: 20, reclaimGuardStaleMs: 20,
      dependencies: { now: () => 100, hostname: () => "host-a", pidProbe: () => "DEAD" },
    });
    expect(reclaimed.operationId).toBe("op-2");
    await reclaimed.release();
    await expect(readFile(guardPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a fresh dead reclaim guard and preserves its bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-")); roots.push(root);
    const path = join(root, "repair", "repair.lock");
    const guardPath = join(root, "repair", "repair.lock.reclaim");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "repair"), { recursive: true }));
    await writeFile(path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "crashed", pid: 999, hostname: "host-a", created_at: 0, heartbeat_at: -100 }) + "\n");
    const guard = JSON.stringify({ schema_version: "g2m.repair-lock-reclaim.v1", guard_id: "guard-1", operation_id: "reclaimer", pid: 998, hostname: "host-a", created_at: 90, heartbeat_at: 90 }) + "\n";
    await writeFile(guardPath, guard);
    await expect(acquireRepairLock(root, {
      operationId: "op-2", nowMs: 100, staleAfterMs: 20, reclaimGuardStaleMs: 20,
      dependencies: { now: () => 100, hostname: () => "host-a", pidProbe: () => "DEAD" },
    })).rejects.toMatchObject({ reason: "STALE" });
    expect(await readFile(guardPath, "utf8")).toBe(guard);
  });

  it.each([
    ["live", "host-a", "ALIVE"],
    ["unknown", "host-a", "UNKNOWN"],
    ["foreign", "host-b", "DEAD"],
  ] as const)("refuses a stale reclaim guard with %s ownership evidence", async (_label, ownerHost, pidStatus) => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-")); roots.push(root);
    const path = join(root, "repair", "repair.lock");
    const guardPath = join(root, "repair", "repair.lock.reclaim");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "repair"), { recursive: true }));
    await writeFile(path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "crashed", pid: 999, hostname: "host-a", created_at: 0, heartbeat_at: -100 }) + "\n");
    const guard = JSON.stringify({ schema_version: "g2m.repair-lock-reclaim.v1", guard_id: "guard-1", operation_id: "reclaimer", pid: 998, hostname: ownerHost, created_at: 0, heartbeat_at: 0 }) + "\n";
    await writeFile(guardPath, guard);
    await expect(acquireRepairLock(root, {
      operationId: "op-2", nowMs: 100, staleAfterMs: 20, reclaimGuardStaleMs: 20,
      dependencies: { now: () => 100, hostname: () => "host-a", pidProbe: () => pidStatus },
    })).rejects.toMatchObject({ reason: pidStatus === "ALIVE" ? "LIVE" : pidStatus === "UNKNOWN" ? "UNKNOWN" : "FOREIGN_HOST" });
    expect(await readFile(guardPath, "utf8")).toBe(guard);
  });

  it("refuses an old malformed reclaim guard without using its mtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-")); roots.push(root);
    const path = join(root, "repair", "repair.lock");
    const guardPath = join(root, "repair", "repair.lock.reclaim");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "repair"), { recursive: true }));
    await writeFile(path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "crashed", pid: 999, hostname: "host-a", created_at: 0, heartbeat_at: -100 }) + "\n");
    await writeFile(guardPath, "not-json\n");
    await utimes(guardPath, 0, 0);
    await expect(acquireRepairLock(root, {
      operationId: "op-2", nowMs: 100_000, staleAfterMs: 20, reclaimGuardStaleMs: 20,
      dependencies: { now: () => 100_000, hostname: () => "host-a", pidProbe: () => "DEAD" },
    })).rejects.toMatchObject({ reason: "MALFORMED" });
    expect(await readFile(guardPath, "utf8")).toBe("not-json\n");
  });

  it("does not delete a replacement owner observed during reclaim confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-lock-")); roots.push(root);
    const path = join(root, "repair", "repair.lock");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "repair"), { recursive: true }));
    await writeFile(path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "crashed", pid: 999, hostname: "host-a", created_at: 0, heartbeat_at: -100 }) + "\n");
    let probes = 0;
    await expect(acquireRepairLock(root, {
      operationId: "op-2", nowMs: 100, staleAfterMs: 20, dependencies: {
        now: () => 100, hostname: () => "host-a", pidProbe: () => {
          probes += 1;
          if (probes === 2) {
            writeFileSync(path, JSON.stringify({ schema_version: "g2m.repair-lock.v1", operation_id: "new-owner", pid: 1000, hostname: "host-a", created_at: 100, heartbeat_at: 100 }) + "\n");
          }
          return probes === 2 ? "ALIVE" : "DEAD";
        },
      },
    })).rejects.toMatchObject({ reason: "LIVE" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ operation_id: "new-owner" });
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
