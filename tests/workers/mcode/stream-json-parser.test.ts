import { describe, expect, it } from "vitest";

import {
  parseStreamJson,
  parseStreamJsonLine,
} from "../../../src/workers/mcode/stream-json-parser.js";
import { normalizeWorkerEvents } from "../../../src/workers/mcode/result-normalizer.js";

const completedLine = JSON.stringify({
  schemaVersion: 1,
  sequence: 2,
  timestampMs: 1788007639048,
  runId: "exec_turn_probe",
  sessionId: "mvs_probe_session",
  turnId: "turn_probe",
  type: "exec.completed",
  result: {
    schemaVersion: 1,
    type: "exec.result",
    runId: "exec_turn_probe",
    sessionId: "mvs_probe_session",
    turnId: "turn_probe",
    status: "succeeded",
    output: [
      "```json",
      JSON.stringify({
        summary: "Fixed the probe task",
        files_changed: ["src/example.ts"],
        tests: [{ name: "example test", status: "passed" }],
        remaining_risks: [],
      }),
      "```",
    ].join("\n"),
    model: {
      providerId: "minimax",
      modelId: "MiniMax-M3",
      variant: "thinking",
    },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    durationMs: 7418,
  },
});

describe("real mcode stream-json contract", () => {
  it("preserves exec.completed result and camelCase sessionId", () => {
    const event = parseStreamJsonLine(completedLine) as unknown as Record<string, unknown>;

    expect(event.type).toBe("exec.completed");
    expect(event.sessionId).toBe("mvs_probe_session");
    expect((event.result as Record<string, unknown>).status).toBe("succeeded");
  });

  it("normalizes the final JSON worker summary from exec.completed.result.output", () => {
    const events = parseStreamJson([
      JSON.stringify({
        schemaVersion: 1,
        sequence: 1,
        timestampMs: 1788007630000,
        runId: "exec_turn_probe",
        sessionId: "mvs_probe_session",
        turnId: "turn_probe",
        type: "exec.started",
      }),
      completedLine,
    ].join("\n"));

    const normalized = normalizeWorkerEvents(events);

    expect(normalized.sessionId).toBe("mvs_probe_session");
    expect(normalized.result).toMatchObject({
      summary: "Fixed the probe task",
      filesChanged: ["src/example.ts"],
      testsAttempted: [{ name: "example test", status: "passed" }],
      remainingRisks: [],
    });
  });

  it("strictly validates an exact worker summary JSON string", () => {
    const event = parseStreamJsonLine(JSON.stringify({
      type: "exec.completed",
      result: {
        status: "succeeded",
        output: JSON.stringify({
          summary: "done",
          files_changed: [],
          tests: [{ name: "unit", status: "passed" }],
          remaining_risks: [],
        }),
      },
    }));
    expect(normalizeWorkerEvents([event], { strictSummary: true }).result?.summary).toBe("done");
  });

  it("strict mode rejects heuristic Markdown wrapping and invalid fields", () => {
    const fenced = parseStreamJsonLine(JSON.stringify({
      type: "exec.completed",
      result: {
        status: "succeeded",
        output: "```json\n{\"summary\":\"done\",\"files_changed\":[],\"tests\":[],\"remaining_risks\":[]}\n```",
      },
    }));
    expect(() => normalizeWorkerEvents([fenced], { strictSummary: true })).toThrow(/summary|JSON|strict/i);

    const invalid = parseStreamJsonLine(JSON.stringify({
      type: "exec.completed",
      result: {
        status: "succeeded",
        output: JSON.stringify({ summary: "done", files_changed: [1], tests: [], remaining_risks: [] }),
      },
    }));
    expect(() => normalizeWorkerEvents([invalid], { strictSummary: true })).toThrow(/files_changed|array|string/i);
  });
});
