import { describe, expect, it } from "vitest";

import { renderJson, renderText } from "../../src/operations/format.js";

describe("operational output formatting", () => {
  it("renders nested camelCase values as stable snake_case JSON", () => {
    const output = renderJson({
      schemaVersion: "g2m.status.v1",
      generatedAt: 10,
      stateRoot: { stateRootExists: true },
      executions: [{ executionId: "x", lastEventSeq: 4 }],
    });

    expect(JSON.parse(output)).toEqual({
      schema_version: "g2m.status.v1",
      generated_at: 10,
      state_root: { state_root_exists: true },
      executions: [{ execution_id: "x", last_event_seq: 4 }],
    });
  });

  it("renders a deterministic human-readable summary", () => {
    const output = renderText({
      schemaVersion: "g2m.doctor.v1",
      status: "WARN",
      checks: [{ id: "projection.readable", status: "PASS", message: "ok" }],
    });

    expect(output).toContain("g2m.doctor.v1");
    expect(output).toContain("WARN");
    expect(output).toContain("PASS projection.readable: ok");
  });

  it("includes operational sections in status text", () => {
    const output = renderText({
      schemaVersion: "g2m.status.v1",
      generatedAt: 10,
      stateRoot: { stateRootExists: true },
      executions: [{ executionId: "exec-1", state: "RUNNING" }],
      recovery: { openRecoveryCases: 2 },
    });
    expect(output).toContain("Executions: 1");
    expect(output).toContain("Recovery: open cases 2");
  });
});
