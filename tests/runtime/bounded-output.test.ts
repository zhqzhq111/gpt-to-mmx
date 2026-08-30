import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { BoundedOutput } from "../../src/runtime/bounded-output.js";

describe("bounded runtime output", () => {
  it("captures exactly the configured byte cap and accounts for overflow", () => {
    const output = new BoundedOutput(5);
    output.push("hello");
    output.push(" world");
    expect(output.capturedText()).toBe("hello");
    expect(output.capturedBytes).toBe(5);
    expect(output.totalBytes).toBe(11);
    expect(output.truncated).toBe(true);
  });

  it("counts UTF-8 bytes across split chunks without retaining unbounded data", () => {
    const output = new BoundedOutput(6);
    output.push(Buffer.from("你", "utf8").subarray(0, 1));
    output.push(Buffer.from("你，", "utf8").subarray(1));
    expect(output.totalBytes).toBe(Buffer.byteLength("你，"));
    expect(output.capturedText()).toBe("你，");
    expect(output.capturedBytes).toBe(6);
    expect(output.truncated).toBe(false);
  });

  it("rejects invalid limits", () => {
    expect(() => new BoundedOutput(0)).toThrow(/positive/i);
    expect(() => new BoundedOutput(Number.MAX_SAFE_INTEGER)).toThrow(/at most|maximum/i);
  });

  it("freezes evidence for the captured byte prefix", () => {
    const output = new BoundedOutput(5);
    output.push("hello world");

    expect(output.evidence()).toEqual({
      capturedBytes: 5,
      totalBytes: 11,
      truncated: true,
      capturedByteSha256: createHash("sha256").update("hello").digest("hex"),
    });
    expect(Object.isFrozen(output.evidence())).toBe(true);
  });
});
