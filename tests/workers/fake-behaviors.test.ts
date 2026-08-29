/**
 * FakeMCodeAdapter — 行为矩阵测试
 *
 * 覆盖 plan §64 列出的核心 case(Round 2d 补齐):
 * - Failure / Timeout / NoResult / ProcessCrash / MalformedJSON
 * - 动态 behavior(按 invocation 决定 behavior)
 * - cancel 不留 stale state
 */

import { describe, it, expect } from "vitest";
import {
  FakeMCodeAdapter,
  type FakeBehavior,
} from "../../src/workers/mcode/fake.js";
import {
  AdapterError,
  type WorkerInvocation,
  type WorkerResult,
} from "../../src/workers/coding-worker.js";

function makeInvocation(overrides: Partial<WorkerInvocation> = {}): WorkerInvocation {
  return {
    executionId: `exec-${Math.random().toString(36).slice(2, 8)}`,
    prompt: "Fix the trajectory test",
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

/**
 * start 后直接返回 invocation;测试自己 collectResult 来验 success 或 rejects。
 * 注意:这里不 catch,让 AdapterError 冒泡,这样 `rejects.toMatchObject` 才能工作。
 */
async function setupStart(behavior: FakeBehavior): Promise<{
  adapter: FakeMCodeAdapter;
  invocation: WorkerInvocation;
}> {
  const adapter = new FakeMCodeAdapter({ behavior });
  const invocation = makeInvocation();
  await adapter.start(invocation);
  return { adapter, invocation };
}

describe("FakeMCodeAdapter behavior matrix (plan §64)", () => {
  it("Failure: collectResult throws AdapterError FAILED", async () => {
    const { adapter, invocation } = await setupStart("failure");
    await expect(adapter.collectResult(invocation.executionId)).rejects.toBeInstanceOf(
      AdapterError,
    );
    await expect(adapter.collectResult(invocation.executionId)).rejects.toMatchObject({
      code: "FAILED",
      executionId: invocation.executionId,
    });
  });

  it("Timeout: collectResult throws AdapterError TIMED_OUT with limit echoed", async () => {
    const invocation = makeInvocation({
      limits: { maxSteps: 5, timeoutMs: 12_345 },
    });
    const adapter = new FakeMCodeAdapter({ behavior: "timeout" });
    await adapter.start(invocation);
    await expect(
      adapter.collectResult(invocation.executionId),
    ).rejects.toMatchObject({
      code: "TIMED_OUT",
      message: expect.stringContaining("12345"),
    });
  });

  it("NoResult: collectResult throws AdapterError UNKNOWN (plan §64)", async () => {
    const { adapter, invocation } = await setupStart("noResult");
    await expect(adapter.collectResult(invocation.executionId)).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("no final result"),
    });
  });

  it("ProcessCrash: collectResult throws AdapterError UNKNOWN with crash context (plan §51)", async () => {
    const { adapter, invocation } = await setupStart("processCrash");
    await expect(adapter.collectResult(invocation.executionId)).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("crash"),
    });
  });

  it("MalformedJSON: collectResult throws AdapterError UNKNOWN with parse context", async () => {
    const { adapter, invocation } = await setupStart("malformedJson");
    await expect(adapter.collectResult(invocation.executionId)).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("JSON"),
    });
  });

  it("Dynamic behavior: resolver receives invocation and decides per call", async () => {
    const adapter = new FakeMCodeAdapter({
      behavior: (inv) => (inv.executionId === "exec-fail" ? "failure" : "success"),
    });
    const ok = makeInvocation({ executionId: "exec-ok" });
    const bad = makeInvocation({ executionId: "exec-fail" });
    await adapter.start(ok);
    await adapter.start(bad);

    const okResult: WorkerResult = await adapter.collectResult(ok.executionId);
    expect(okResult.executionId).toBe("exec-ok");
    expect(okResult.summary).toContain("success");

    await expect(adapter.collectResult(bad.executionId)).rejects.toMatchObject({
      code: "FAILED",
      executionId: "exec-fail",
    });
  });

  it("Success: cached result is returned on subsequent collectResult (idempotent)", async () => {
    const adapter = new FakeMCodeAdapter({ behavior: "success" });
    const inv = makeInvocation();
    await adapter.start(inv);
    const r1 = await adapter.collectResult(inv.executionId);
    const r2 = await adapter.collectResult(inv.executionId);
    expect(r1).toEqual(r2);
  });

  it("Cancel after Failure behavior: collectResult still throws FAILED (cancel is no-op for terminal state)", async () => {
    const adapter = new FakeMCodeAdapter({ behavior: "failure" });
    const inv = makeInvocation();
    await adapter.start(inv);
    await adapter.cancel(inv.executionId);
    // Cancel 不改变已设定的 behavior 路径 — collectResult 仍按 behavior 走
    await expect(adapter.collectResult(inv.executionId)).rejects.toMatchObject({
      code: "FAILED",
    });
  });
});
