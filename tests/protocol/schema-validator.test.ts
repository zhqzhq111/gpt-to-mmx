import { describe, it, expect } from "vitest";
import { validateCodeTask } from "../../src/protocol/schema-validator.js";
import { taskHash, canonicalJson } from "../../src/protocol/hash.js";
import type { CodeTaskV1 } from "../../src/protocol/code-task.v1.schema.js";

/**
 * Plan 第 10 节 JSON 模板的最小可接受版本。
 * 任何测试都基于这个 base,只改要测的字段。
 */
function baseTask(): CodeTaskV1 {
  return {
    protocol_version: "g2m.code-task.v1",
    task_id: "task-001",
    workspace_scope: {
      workspace_id: "robot-arm-project",
      base_revision: "HEAD",
      require_clean_worktree: true,
    },
    goal: "Fix the failing trajectory planning test without changing the public API.",
    constraints: ["Keep the patch minimal."],
    requested_capabilities: {
      read: true,
      write: true,
      test: true,
      network: false,
    },
    permission_policy: "coding_standard",
    limits: { max_steps: 20, timeout_ms: 600_000 },
    verification_profile: "targeted_tests",
    acceptance_criteria: ["The target test passes."],
    session_policy: { mode: "new" },
  };
}

describe("validateCodeTask", () => {
  it("accepts a well-formed plan §10 task", () => {
    const result = validateCodeTask(baseTask());
    expect(result.ok).toBe(true);
  });

  it("rejects every field listed in plan §11 forbidden list", () => {
    const forbidden = [
      "command",
      "shell",
      "raw_argv",
      "powershell",
      "cmd",
      "api_key",
      "apiKey",
      "token",
      "credential",
      "mcode_executable",
      "mcodeExecutable",
      "absolute_workspace_path",
      "absoluteWorkspacePath",
    ];

    for (const field of forbidden) {
      const t = baseTask() as unknown as Record<string, unknown>;
      t[field] = "MALICIOUS_VALUE";
      const result = validateCodeTask(t);
      expect(result.ok, `should reject ${field}`).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => e.code === "FORBIDDEN_FIELD" && e.message.includes(field)),
        ).toBe(true);
      }
    }
  });

  it("rejects unknown top-level fields (strict zod, plan §62 Phase 1)", () => {
    const t = baseTask() as unknown as Record<string, unknown>;
    t["sneaky_extra"] = "should be rejected";
    const result = validateCodeTask(t);
    // 只验 strict() 核心契约:有 unknown 字段就拒。不查 zod issue 内部结构
    // (zod 4/5 的 code/path 命名有差异,绑定太脆)。
    expect(result.ok).toBe(false);
  });

  it("rejects non-object input (e.g. number, string, null)", () => {
    for (const bad of [null, 42, "string", true, []]) {
      const result = validateCodeTask(bad);
      expect(result.ok, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("rejects protocol_version other than g2m.code-task.v1", () => {
    const t = baseTask() as unknown as Record<string, unknown>;
    t["protocol_version"] = "g2m.code-task.v99";
    const result = validateCodeTask(t);
    expect(result.ok).toBe(false);
  });

  it("rejects session_policy.attach without verified_session_id (plan §23)", () => {
    const t = baseTask() as unknown as Record<string, unknown>;
    t["session_policy"] = { mode: "attach" };
    const result = validateCodeTask(t);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) =>
            e.path.includes("session_policy") &&
            (e.code === "MISSING_FIELD" || e.code === "INVALID_TYPE"),
        ),
      ).toBe(true);
    }
  });
});

describe("taskHash", () => {
  it("is stable across key order changes (canonical JSON subset)", () => {
    const a = { goal: "x", constraints: ["a", "b"], task_id: "t1" };
    const b = { task_id: "t1", constraints: ["a", "b"], goal: "x" };
    expect(taskHash(a)).toBe(taskHash(b));
  });

  it("differs for different content", () => {
    expect(taskHash({ a: 1 })).not.toBe(taskHash({ a: 2 }));
  });

  it("canonicalJson sorts keys deterministically", () => {
    const c1 = canonicalJson({ z: 1, a: 2, m: { y: 1, b: 2 } });
    const c2 = canonicalJson({ a: 2, m: { b: 2, y: 1 }, z: 1 });
    expect(c1).toBe(c2);
    expect(c1).toBe('{"a":2,"m":{"b":2,"y":1},"z":1}');
  });
});
