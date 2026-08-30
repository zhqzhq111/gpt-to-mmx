import { describe, expect, it } from "vitest";

import {
  buildProtectedPolicy,
  protectedPolicyHash,
  validateProtectedPolicy,
} from "../../src/runtime/protected-policy.js";

describe("protected policy", () => {
  it("persists env names and a hash, never env values", () => {
    const policy = buildProtectedPolicy({
      task_id: "task-1",
      execution_id: "exec-1",
      workspace_id: "ws-1",
      canonical_workspace_path: "C:/repo",
      base_revision: "HEAD",
      artifact_root: "C:/state/artifacts",
      worktree_root: "C:/state/worktrees",
      state_root: "C:/state",
      permission_policy: "coding_standard",
      requested_capabilities: { read: true, write: true, test: true, network: false },
      limits: { max_steps: 20, timeout_ms: 600_000 },
      verification_profile: {
        id: "tests",
        resolved_program: "C:/Program Files/nodejs/node.exe",
        program_identity_hash: "a".repeat(64),
        program_bytes: 10,
        args: ["--test"],
        timeout_ms: 30_000,
        env: { API_TOKEN: "secret-value", CI: "true" },
      },
      runtime_identity_hash: "b".repeat(64),
      output_limits: { max_worker_stdout_bytes: 33_554_432 },
      storage_policy_hash: "c".repeat(64),
      lease_policy_hash: "d".repeat(64),
    });
    expect(policy.verification_profile.env_names).toEqual(["API_TOKEN", "CI"]);
    expect(JSON.stringify(policy)).not.toContain("secret-value");
    expect(validateProtectedPolicy(policy)).toBe(true);
    expect(protectedPolicyHash(policy)).toBe(policy.policy_hash);
  });
});
