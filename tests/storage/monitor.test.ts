import { describe, expect, it } from "vitest";

import { StorageMonitor } from "../../src/storage/monitor.js";
import { DEFAULT_STORAGE_POLICY } from "../../src/storage/policy.js";

describe("StorageMonitor", () => {
  it("reports an emergency when physical free space crosses the safety floor", async () => {
    const monitor = new StorageMonitor({
      policy: { ...DEFAULT_STORAGE_POLICY, min_free_bytes: 100, safety_margin_bytes: 50 },
      freeSpaceProvider: { freeBytes: async () => 149 },
    });
    await expect(monitor.check({ worktreePath: "worktree", artifactPath: "artifact" })).resolves.toMatchObject({
      status: "emergency",
      freeBytes: 149,
    });
  });

  it("reports per-execution and managed-storage limit violations", async () => {
    const monitor = new StorageMonitor({
      policy: { ...DEFAULT_STORAGE_POLICY, min_free_bytes: 0, safety_margin_bytes: 0, max_worktree_bytes: 2 },
      freeSpaceProvider: { freeBytes: async () => 1000 },
      usageScanner: async () => ({ artifactBytes: 0, worktreeBytes: 3, totalBytes: 3 }),
    });
    await expect(monitor.check({ worktreePath: "worktree", artifactPath: "artifact" })).resolves.toMatchObject({
      status: "limit_exceeded",
      code: "STORAGE_LIMIT_EXCEEDED",
    });
  });

  it("invokes an emergency callback at most once and can be stopped", async () => {
    let callbackCount = 0;
    const monitor = new StorageMonitor({
      policy: { ...DEFAULT_STORAGE_POLICY, min_free_bytes: 100, safety_margin_bytes: 50, monitor_interval_ms: 1 },
      freeSpaceProvider: { freeBytes: async () => 0 },
    });
    const handle = monitor.start({ worktreePath: "worktree", artifactPath: "artifact" }, () => { callbackCount += 1; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();
    expect(callbackCount).toBe(1);
  });
});
