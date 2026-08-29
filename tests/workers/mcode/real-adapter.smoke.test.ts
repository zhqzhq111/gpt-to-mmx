import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MCodeAdapter } from "../../../src/workers/mcode/adapter.js";
import type { WorkerInvocation } from "../../../src/workers/coding-worker.js";

const describeReal = process.env["G2M_RUN_REAL_E2E"] === "1" ? describe : describe.skip;

describeReal("real mcode adapter smoke test", () => {
  it("runs a read-only task through MCodeAdapter and collects the real envelope", async () => {
    const previous = process.env["G2M_MCODE_PATH"];
    const workspace = await mkdtemp(join(tmpdir(), "g2m-real-smoke-"));
    process.env["G2M_MCODE_PATH"] = "C:/Users/zhq/AppData/Roaming/npm/mcode.cmd";

    try {
      await writeFile(
        join(workspace, "README.md"),
        "# G2M real adapter smoke fixture\nDo not modify this file.\n",
        "utf8",
      );
      const invocation: WorkerInvocation = {
        executionId: "real-smoke-001",
        prompt: "Inspect README.md only. Do not create, modify, delete, or execute any files. Return a concise summary and confirm that no changes were made.",
        workspacePath: workspace,
        permissionPolicy: "read_only",
        requestedCapabilities: {
          read: true,
          write: false,
          test: false,
          network: false,
        },
        limits: { maxSteps: 8, timeoutMs: 90_000 },
        sessionPolicy: { mode: "new" },
      };

      const adapter = new MCodeAdapter();
      const result = await adapter.probe();
      expect(result.version).toBe("0.2.7");
      expect(result.locallyVerified.jsonContract).toBe(true);
      expect(result.locallyVerified.streamJsonContract).toBe(true);
      expect(result.locallyVerified.sessionIdExtraction).toBe(true);
      expect(result.locallyVerified.permissionMapping).toBe(true);
      expect(result.locallyVerified.timeoutBehavior).toBe(false);

      await adapter.start(invocation);
      const workerResult = await adapter.collectResult(invocation.executionId);

      expect(workerResult.executionId).toBe(invocation.executionId);
      expect(workerResult.sessionId).toMatch(/^mvs_/);
      expect(workerResult.summary).toContain("README");
      expect(workerResult.filesChanged).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["G2M_MCODE_PATH"];
      else process.env["G2M_MCODE_PATH"] = previous;
      await rm(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});
