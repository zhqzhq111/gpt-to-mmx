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
});
