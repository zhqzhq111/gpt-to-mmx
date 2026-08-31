import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireGcRunLock, type GcLockDependencies } from "../../src/storage/gc-lock.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "g2m-gc-lock-"));
  roots.push(value);
  return value;
}

function deps(overrides: Partial<GcLockDependencies> = {}): GcLockDependencies {
  return {
    now: () => 1_000,
    hostname: () => "host-a",
    pid: 10,
    randomUUID: () => "run-a",
    pidProbe: () => "ALIVE",
    ...overrides,
  };
}

describe("GC run lock", () => {
  it("serializes two mutating owners and releases only its own handle", async () => {
    const stateRoot = await root();
    const first = await acquireGcRunLock({ stateRoot, dependencies: deps() });
    await expect(acquireGcRunLock({ stateRoot, dependencies: deps({ pid: 11, randomUUID: () => "run-b" }) })).rejects.toMatchObject({ code: "GC_LOCK_BUSY" });
    await first.release();
    const second = await acquireGcRunLock({ stateRoot, dependencies: deps({ pid: 11, randomUUID: () => "run-b" }) });
    await second.release();
  });

  it("waits for a concurrently published lock before classifying it as busy", async () => {
    const stateRoot = await root();
    const gcRoot = join(stateRoot, "gc");
    const lockPath = join(gcRoot, "gc.lock");
    const metadata = {
      lock_version: 1 as const,
      gc_run_id: "run-a",
      pid: 10,
      hostname: "host-a",
      created_at: 1_000,
      heartbeat_at: 1_000,
    };
    const serialized = `${JSON.stringify(metadata)}\n`;
    await mkdir(gcRoot, { recursive: true });
    await writeFile(lockPath, serialized.slice(0, 12), "utf8");
    const publication = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await writeFile(lockPath, serialized, "utf8");
        resolve();
      }, 20);
    });

    try {
      await expect(acquireGcRunLock({ stateRoot, dependencies: deps({ pid: 11, randomUUID: () => "run-b" }) }))
        .rejects.toMatchObject({ code: "GC_LOCK_BUSY" });
    } finally {
      await publication;
    }
  });

  it("still rejects a persistent malformed lock as invalid", async () => {
    const stateRoot = await root();
    const gcRoot = join(stateRoot, "gc");
    await mkdir(gcRoot, { recursive: true });
    await writeFile(join(gcRoot, "gc.lock"), "{not-json\n", "utf8");

    await expect(acquireGcRunLock({ stateRoot, dependencies: deps({ pid: 11, randomUUID: () => "run-b" }) }))
      .rejects.toMatchObject({ code: "GC_LOCK_INVALID" });
  });

  it("reclaims only a stale same-host lock whose PID is dead", async () => {
    const stateRoot = await root();
    const old = await acquireGcRunLock({ stateRoot, dependencies: deps({ now: () => 100 }) });
    await expect(acquireGcRunLock({
      stateRoot,
      staleAfterMs: 10,
      dependencies: deps({ now: () => 1_000, pid: 11, randomUUID: () => "run-b", pidProbe: () => "DEAD" }),
    })).resolves.toMatchObject({ runId: "run-b" });
    await expect(old.release()).rejects.toMatchObject({ code: "GC_LOCK_STALE_HANDLE" });
  });

  it.each([
    ["foreign host", { hostname: (): string => "host-b", pidProbe: (): "DEAD" => "DEAD" }],
    ["unknown PID", { pidProbe: (): "UNKNOWN" => "UNKNOWN" }],
    ["live PID", { pidProbe: (): "ALIVE" => "ALIVE" }],
  ] as const)("does not reclaim a stale lock when evidence is %s", async (_label, override) => {
    const stateRoot = await root();
    await acquireGcRunLock({ stateRoot, dependencies: deps({ now: () => 100 }) });
    await expect(acquireGcRunLock({ stateRoot, staleAfterMs: 10, dependencies: deps({ now: () => 1_000, pid: 11, ...override }) })).rejects.toMatchObject({ code: "GC_LOCK_BUSY" });
  });
});
