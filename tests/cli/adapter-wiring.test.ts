import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock("../../src/workers/mcode/adapter.js", () => ({
  MCodeAdapter: class MockMCodeAdapter {
    constructor(options: unknown) {
      captured.options.push(options);
    }

    async probe() {
      return {
        runtime: "mcode",
        available: true,
        version: "0.2.7-test",
        documentedCapabilities: {},
        locallyVerified: {},
        launchKind: "cmd",
        launchPath: "mock-mcode",
      };
    }
  },
}));

describe("CLI MCodeAdapter wiring", () => {
  it("passes the configured worker stderr limit to every adapter entry point", async () => {
    const { main } = await import("../../src/cli/index.js");
    const root = await mkdtemp(join(tmpdir(), "g2m-cli-adapter-wiring-"));
    const configPath = join(root, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({
        protocol_version: "g2m.local-config.v1",
        workspaces: [{ workspace_id: "demo", path: root }],
        verification_profiles: [],
        worktree_root: join(root, "worktrees"),
        artifact_root: join(root, "artifacts"),
        runtime_hardening: { max_worker_stderr_bytes: 17 },
      }), "utf8");

      captured.options.length = 0;
      await main(["probe", "--config", configPath]);

      expect(captured.options).toHaveLength(1);
      expect(captured.options[0]).toMatchObject({ maxWorkerStderrBytes: 17 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
