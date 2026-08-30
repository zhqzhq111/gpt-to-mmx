import { describe, expect, it } from "vitest";

import { parseLocalConfig } from "../../src/cli/config.js";

describe("G2M local config", () => {
  it("accepts trusted workspace and verification mappings", () => {
    const config = parseLocalConfig({
      protocol_version: "g2m.local-config.v1",
      workspaces: [{ workspace_id: "demo", path: "F:/demo" }],
      verification_profiles: [
        {
          id: "test",
          workspace_id: "demo",
          description: "run tests",
          program: "C:/Program Files/nodejs/node.exe",
          args: ["test.mjs"],
          timeout_ms: 10_000,
        },
      ],
      worktree_root: "F:/g2m-state/worktrees",
      artifact_root: "F:/g2m-state/artifacts",
      mcode_path: "C:/Users/test/AppData/Roaming/npm/mcode.cmd",
    });

    expect(config.workspaces[0]?.workspace_id).toBe("demo");
    expect(config.verification_profiles[0]?.timeout_ms).toBe(10_000);
  });

  it("rejects relative trusted paths", () => {
    expect(() =>
      parseLocalConfig({
        protocol_version: "g2m.local-config.v1",
        workspaces: [{ workspace_id: "demo", path: "./repo" }],
        verification_profiles: [],
        worktree_root: "F:/g2m-state/worktrees",
        artifact_root: "F:/g2m-state/artifacts",
      }),
    ).toThrow(/absolute/i);
  });

  it("rejects duplicate workspace ids and duplicate scoped profile ids", () => {
    expect(() =>
      parseLocalConfig({
        protocol_version: "g2m.local-config.v1",
        workspaces: [
          { workspace_id: "demo", path: "F:/demo" },
          { workspace_id: "demo", path: "F:/other" },
        ],
        verification_profiles: [],
        worktree_root: "F:/g2m-state/worktrees",
        artifact_root: "F:/g2m-state/artifacts",
      }),
    ).toThrow(/duplicate workspace/i);
  });

  it("provides backward-compatible runtime hardening defaults and optional model pinning", () => {
    const config = parseLocalConfig({
      protocol_version: "g2m.local-config.v1",
      workspaces: [{ workspace_id: "demo", path: "F:/demo" }],
      verification_profiles: [],
      worktree_root: "F:/g2m-state/worktrees",
      artifact_root: "F:/g2m-state/artifacts",
      mcode_model: "MiniMax-M3",
    });
    expect(config.mcode_model).toBe("MiniMax-M3");
    expect(config.runtime_hardening).toMatchObject({
      max_worker_stdout_bytes: 33_554_432,
      max_worker_stderr_bytes: 8_388_608,
      max_stream_json_line_bytes: 4_194_304,
      max_worker_events: 100_000,
      max_verification_stdout_bytes: 16_777_216,
      max_verification_stderr_bytes: 16_777_216,
      max_probe_output_bytes: 2_097_152,
      repair_reclaim_guard_stale_ms: 30_000,
    });
  });

  it("rejects zero, negative, and unreasonably large runtime limits", () => {
    const base = {
      protocol_version: "g2m.local-config.v1",
      workspaces: [{ workspace_id: "demo", path: "F:/demo" }],
      verification_profiles: [], worktree_root: "F:/g2m-state/worktrees", artifact_root: "F:/g2m-state/artifacts",
    };
    expect(() => parseLocalConfig({ ...base, runtime_hardening: { max_worker_stdout_bytes: 0 } })).toThrow(/positive|too small/i);
    expect(() => parseLocalConfig({ ...base, runtime_hardening: { max_worker_events: -1 } })).toThrow(/positive|too small/i);
    expect(() => parseLocalConfig({ ...base, runtime_hardening: { max_probe_output_bytes: 9_000_000_000 } })).toThrow(/too big|maximum|less than/i);
  });
});
