import { describe, expect, it } from "vitest";

import {
  StreamJsonDecoder,
  StreamJsonProtocolError,
} from "../../../src/workers/mcode/stream-json-decoder.js";

const validResult = JSON.stringify({
  type: "result",
  status: "success",
  summary: "done",
  files_changed: [],
  tests: [],
  remaining_risks: [],
});

describe("incremental stream-json decoder", () => {
  it("preserves a JSON event split across many chunks", () => {
    const decoder = new StreamJsonDecoder({ maxLineBytes: 1_024, maxTotalBytes: 2_048, maxEvents: 10 });
    const chunks: string[] = [];
    for (let index = 0; index < validResult.length; index += 3) chunks.push(validResult.slice(index, index + 3));
    const events = chunks.flatMap((chunk) => decoder.push(chunk));
    expect(events).toEqual([]);
    expect(decoder.finish()).toMatchObject([{ type: "result", status: "success" }]);
  });

  it("parses the final non-newline-terminated line exactly once", () => {
    const decoder = new StreamJsonDecoder({ maxLineBytes: 1_024, maxTotalBytes: 2_048, maxEvents: 10 });
    decoder.push(`${validResult}\n`);
    expect(decoder.finish()).toEqual([]);
    expect(decoder.eventCount).toBe(1);
  });

  it("reports malformed non-empty JSON instead of dropping it", () => {
    const decoder = new StreamJsonDecoder({ maxLineBytes: 100, maxTotalBytes: 200, maxEvents: 10 });
    expect(() => decoder.push("not-json\n")).toThrow(StreamJsonProtocolError);
  });

  it("rejects a known event with an invalid enum or required field", () => {
    const decoder = new StreamJsonDecoder({ maxLineBytes: 1_024, maxTotalBytes: 2_048, maxEvents: 10 });
    expect(() => decoder.push(`${JSON.stringify({ type: "result", status: "random" })}\n`)).toThrow(/known event|status/i);
  });

  it("allows unknown future event types as raw events", () => {
    const decoder = new StreamJsonDecoder({ maxLineBytes: 1_024, maxTotalBytes: 2_048, maxEvents: 10 });
    expect(decoder.push('{"type":"future.mcode.event","value":1}\n')).toEqual([
      { type: "future.mcode.event", value: 1 },
    ]);
  });

  it("rejects an oversized line before waiting for its newline", () => {
    const decoder = new StreamJsonDecoder({ maxLineBytes: 8, maxTotalBytes: 100, maxEvents: 10 });
    expect(() => decoder.push("123456789")).toThrow(/line/i);
  });

  it("rejects when the worker event count exceeds its bound", () => {
    const decoder = new StreamJsonDecoder({ maxLineBytes: 1_024, maxTotalBytes: 4_096, maxEvents: 1 });
    expect(() => decoder.push(`${validResult}\n${validResult}\n`)).toThrow(/event/i);
  });

  it("rejects when total control stdout exceeds its bound", () => {
    const decoder = new StreamJsonDecoder({ maxLineBytes: 1_024, maxTotalBytes: 10, maxEvents: 10 });
    expect(() => decoder.push(validResult)).toThrow(/stdout|total|output/i);
  });
});
