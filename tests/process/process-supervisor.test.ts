import { describe, expect, it } from "vitest";

import {
  ProcessSupervisor,
  type ProcessSpec,
} from "../../src/process/supervisor.js";
import type { PlatformProcessController } from "../../src/process/platform.js";

const cwd = process.cwd();

function nodeSpec(code: string, extra: Partial<ProcessSpec> = {}): ProcessSpec {
  return {
    program: process.execPath,
    args: ["-e", code],
    cwd,
    ...extra,
  };
}

describe("ProcessSupervisor", () => {
  it("returns an exited outcome for a successful process", async () => {
    const managed = new ProcessSupervisor().spawn(nodeSpec("process.stdout.write('ok')"));

    await expect(managed.wait()).resolves.toMatchObject({
      kind: "exited",
      exitCode: 0,
      signal: null,
    });
  });

  it("preserves a non-zero exit code", async () => {
    const managed = new ProcessSupervisor().spawn(nodeSpec("process.exit(2)"));

    await expect(managed.wait()).resolves.toMatchObject({
      kind: "exited",
      exitCode: 2,
      signal: null,
    });
  });

  it("turns a missing executable into a spawn_error outcome", async () => {
    const managed = new ProcessSupervisor().spawn({
      program: "g2m-executable-that-does-not-exist",
      args: [],
      cwd,
    });

    await expect(managed.wait()).resolves.toMatchObject({ kind: "spawn_error" });
  });

  it("terminates a timed-out process tree and proves it is gone", async () => {
    const managed = new ProcessSupervisor({
      gracefulTerminationMs: 250,
      forceTerminationMs: 500,
    }).spawn(nodeSpec("setInterval(() => {}, 1000)", { timeoutMs: 25 }));

    await expect(managed.wait()).resolves.toMatchObject({
      kind: "timed_out",
      termination: { confirmedGone: true },
    });
    expect(managed.isRunning()).toBe(false);
  }, 5_000);

  it("makes manual termination idempotent", async () => {
    const managed = new ProcessSupervisor({
      gracefulTerminationMs: 250,
      forceTerminationMs: 500,
    }).spawn(nodeSpec("setInterval(() => {}, 1000)"));

    const first = managed.terminate("cancel");
    const second = managed.terminate("cancel");
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ confirmedGone: true });
    expect(managed.isRunning()).toBe(false);
  }, 5_000);

  it("confirms termination when terminate is called after natural exit", async () => {
    const managed = new ProcessSupervisor().spawn(nodeSpec("process.exit(0)"));
    await managed.wait();

    await expect(managed.terminate("cleanup")).resolves.toMatchObject({
      confirmedGone: true,
      gracefulAttempted: false,
      forcedAttempted: false,
    });
  });

  it("reports termination_unconfirmed when the platform cannot prove disappearance", async () => {
    const controller: PlatformProcessController = {
      strategy: "windows_taskkill",
      isAlive: () => "alive",
      terminate: async () => ({
        confirmedGone: false,
        gracefulAttempted: true,
        forcedAttempted: true,
        strategy: "windows_taskkill",
        error: "probe remained alive",
      }),
    };
    const managed = new ProcessSupervisor({ platformController: controller }).spawn(
      nodeSpec("setInterval(() => {}, 1000)"),
    );

    const result = await managed.terminate("timeout");
    await expect(managed.wait()).resolves.toMatchObject({
      kind: "termination_unconfirmed",
      termination: result,
    });
    if (managed.pid !== undefined) {
      try { process.kill(managed.pid); } catch { /* test cleanup */ }
    }
  }, 5_000);
});
