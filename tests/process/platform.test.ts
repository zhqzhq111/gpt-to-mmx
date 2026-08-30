import { describe, expect, it } from "vitest";

import {
  createPlatformProcessController,
  type ProcessLiveness,
} from "../../src/process/platform.js";

function sequenceProbe(values: ProcessLiveness[]): (pid: number) => ProcessLiveness {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? "unknown";
}

describe("platform process termination", () => {
  it("terminates a POSIX process group with SIGTERM before confirming gone", async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const controller = createPlatformProcessController({
      platform: "linux",
      dependencies: {
        probe: sequenceProbe(["alive", "alive", "gone"]),
        sendSignal: (pid, signal) => signals.push([pid, signal]),
        sleep: async () => undefined,
        now: (() => {
          let value = 0;
          return () => ++value;
        })(),
      },
    });

    const result = await controller.terminate(1234, {
      gracefulTerminationMs: 20,
      forceTerminationMs: 20,
    });

    expect(result).toMatchObject({
      confirmedGone: true,
      gracefulAttempted: true,
      forcedAttempted: false,
      strategy: "posix_process_group",
    });
    expect(signals).toEqual([[-1234, "SIGTERM"]]);
  });

  it("escalates a POSIX process group from SIGTERM to SIGKILL", async () => {
    const signals: NodeJS.Signals[] = [];
    const controller = createPlatformProcessController({
      platform: "linux",
      dependencies: {
        probe: sequenceProbe(["alive", "alive", "alive", "alive", "gone"]),
        sendSignal: (_pid, signal) => signals.push(signal),
        sleep: async () => undefined,
        now: (() => {
          let value = 0;
          return () => ++value;
        })(),
      },
    });

    const result = await controller.terminate(1234, {
      gracefulTerminationMs: 20,
      forceTerminationMs: 20,
    });

    expect(result).toMatchObject({
      confirmedGone: true,
      gracefulAttempted: true,
      forcedAttempted: true,
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("uses Windows taskkill tree termination and force escalation", async () => {
    const calls: Array<[number, boolean]> = [];
    const controller = createPlatformProcessController({
      platform: "win32",
      dependencies: {
        probe: sequenceProbe(["alive", "alive", "alive", "alive", "gone"]),
        runTaskkill: async (pid, force) => {
          calls.push([pid, force]);
          return { success: true };
        },
        sleep: async () => undefined,
        now: (() => {
          let value = 0;
          return () => ++value;
        })(),
      },
    });

    const result = await controller.terminate(4321, {
      gracefulTerminationMs: 20,
      forceTerminationMs: 20,
    });

    expect(result).toMatchObject({
      confirmedGone: true,
      gracefulAttempted: true,
      forcedAttempted: true,
      strategy: "windows_taskkill",
    });
    expect(calls).toEqual([[4321, false], [4321, true]]);
  });
});
