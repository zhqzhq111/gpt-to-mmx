import { describe, it, expect } from "vitest";
import { FakeMCodeAdapter } from "../../src/workers/mcode/fake.js";
import type { WorkerInvocation } from "../../src/workers/coding-worker.js";

function makeInvocation(overrides: Partial<WorkerInvocation> = {}): WorkerInvocation {
  return {
    executionId: "exec-001",
    prompt: "Fix the failing trajectory-planning test.",
    workspacePath: "D:/fake/workspace",
    permissionPolicy: "coding_standard",
    requestedCapabilities: {
      read: true,
      write: true,
      test: true,
      network: false,
    },
    limits: { maxSteps: 20, timeoutMs: 600_000 },
    sessionPolicy: { mode: "new" },
    ...overrides,
  };
}

describe("FakeMCodeAdapter", () => {
  it("runs a successful execution end-to-end", async () => {
    const adapter = new FakeMCodeAdapter();

    const snapshot = await adapter.probe();
    expect(snapshot.runtime).toBe("fake");
    expect(snapshot.available).toBe(true);
    expect(snapshot.locallyVerified.jsonContract).toBe(true);

    const invocation = makeInvocation();
    await adapter.start(invocation);

    const result = await adapter.collectResult(invocation.executionId);
    expect(result.executionId).toBe(invocation.executionId);
    expect(result.summary).toContain("FakeMCodeAdapter");
    expect(result.sessionId).toBe(`fake-session-${invocation.executionId}`);
  });

  it("rejects duplicate start of the same executionId", async () => {
    const adapter = new FakeMCodeAdapter();
    const inv = makeInvocation();
    await adapter.start(inv);

    await expect(adapter.start(inv)).rejects.toThrow(/already started/);
  });

  it("rejects collectResult for unknown executionId", async () => {
    const adapter = new FakeMCodeAdapter();
    await expect(adapter.collectResult("nope")).rejects.toThrow(
      /no execution found/,
    );
  });

  it("rejects resume() as not implemented (plan 第 48 节, MVP 不依赖 --continue)", async () => {
    const adapter = new FakeMCodeAdapter();
    await expect(
      adapter.resume("exec-001", "verified-session-xyz", "continue work"),
    ).rejects.toThrow(/not implemented/i);
  });
});
