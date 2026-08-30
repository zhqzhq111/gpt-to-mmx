import { mkdtemp, rm } from "node:fs/promises";
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
