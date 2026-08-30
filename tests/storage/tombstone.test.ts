import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDirectExecutionChild,
  assertSafeDeletionTarget,
  computeTombstoneHash,
  readTombstone,
  writeTombstone,
  type TombstoneInput,
} from "../../src/storage/tombstone.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "g2m-tombstone-"));
  roots.push(root);
  return root;
}

const input: TombstoneInput = {
  executionId: "exec-1",
  taskId: "task-1",
  workspaceId: "workspace-1",
  finalState: "ACCEPTED",
  createdAt: 1,
  terminalAt: 2,
  retentionClass: "NORMAL",
  gcMarkedEventId: "event-marked",
  gcMarkedEventHash: "hash-marked",
  gcCompletedAt: 3,
  artifactBytesBeforeGc: 10,
  worktreeBytesBeforeGc: 20,
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("tombstone", () => {
  it("writes a durable self-hashed tombstone and reads it back", async () => {
    const root = await temporaryRoot();
    const path = join(root, "tombstones", "exec-1.json");

    const written = await writeTombstone(path, input);
    const loaded = await readTombstone(path);

    expect(written.selfHash).toBe(computeTombstoneHash(input));
    expect(loaded).toEqual(written);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schema_version: 1,
      execution_id: "exec-1",
      self_hash: written.selfHash,
    });
  });

  it("rejects a tombstone whose self hash was changed", async () => {
    const root = await temporaryRoot();
    const path = join(root, "tombstones", "exec-1.json");
    await writeTombstone(path, input);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    raw.self_hash = "0".repeat(64);
    await writeFile(path, `${JSON.stringify(raw)}\n`, "utf8");

    await expect(readTombstone(path)).rejects.toMatchObject({ code: "TOMBSTONE_INVALID" });
  });

  it("allows only the execution directory directly below its configured root", async () => {
    const root = await temporaryRoot();
    expect(assertDirectExecutionChild(root, join(root, "exec-1"), "exec-1")).toBe(resolve(root, "exec-1"));
    expect(() => assertDirectExecutionChild(root, root, "exec-1")).toThrow("direct child");
    expect(() => assertDirectExecutionChild(root, join(root, "..", "other"), "exec-1")).toThrow("direct child");
    expect(() => assertDirectExecutionChild(root, join(root, "exec-2"), "exec-1")).toThrow("execution");
    expect(() => assertDirectExecutionChild(root, join(root, "exec-1", "nested"), "exec-1")).toThrow("direct child");
  });

  it("blocks symlink and non-directory top-level deletion targets", async () => {
    const root = await temporaryRoot();
    const target = join(root, "exec-1");
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, target, "junction").catch(async () => symlink(outside, target, "dir"));

    await expect(assertSafeDeletionTarget(target)).rejects.toMatchObject({ code: "GC_PATH_UNSAFE" });
    const file = join(root, "exec-2");
    await writeFile(file, "not a directory");
    await expect(assertSafeDeletionTarget(file)).rejects.toMatchObject({ code: "GC_PATH_UNSAFE" });
  });
});
