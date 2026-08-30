import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeRepairAudit } from "../../src/operations/repair-audit.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("repair audit", () => {
  it("writes and rereads an immutable audit record with its hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-repair-audit-"));
    roots.push(root);
    const result = await writeRepairAudit({
      stateRoot: root,
      operationId: "op-1",
      phase: "plan",
      action: "projection-rebuild",
      createdAt: 10,
      payload: { targetExecutionId: null },
    });
    expect(result.sha256).toHaveLength(64);
    const files = await readdir(join(root, "repair", "audit"));
    expect(files).toEqual(["op-1.plan.json"]);
    expect(JSON.parse(await readFile(join(root, "repair", "audit", files[0]!), "utf8"))).toMatchObject({ operation_id: "op-1", action: "projection-rebuild", phase: "plan" });
  });
});
