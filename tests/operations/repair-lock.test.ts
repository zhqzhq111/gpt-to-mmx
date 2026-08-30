import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    const first = await acquireRepairLock(root, { nowMs: 10, operationId: "op-1" });
    expect(JSON.parse(await readFile(join(root, "repair", "repair.lock"), "utf8"))).toMatchObject({ operation_id: "op-1", created_at: 10 });
    await expect(acquireRepairLock(root, { nowMs: 11, operationId: "op-2" })).rejects.toBeInstanceOf(RepairLockBusyError);
    await first.release();
    const second = await acquireRepairLock(root, { nowMs: 12, operationId: "op-2" });
    await second.release();
  });
});
