/**
 * Replay Guard — plan §46 anti-replay / anti-stale
 */

import { describe, it, expect } from "vitest";

import { ReplayGuard, type ReviewSignature } from "../../src/review/replay-guard.js";

function sig(overrides: Partial<ReviewSignature> = {}): ReviewSignature {
  return {
    reviewId: "review-1",
    reviewBundleId: "bundle-1",
    reviewHash: "a".repeat(64),
    decision: "ACCEPT",
    ...overrides,
  };
}

describe("ReplayGuard.check", () => {
  it("returns 'allow' for a new bundle", () => {
    const guard = new ReplayGuard();
    expect(guard.check(sig())).toEqual({ kind: "allow" });
  });

  it("returns 'idempotent' for the same reviewId + same content (plan §46)", () => {
    const guard = new ReplayGuard();
    guard.record(sig());
    const result = guard.check(sig());
    expect(result.kind).toBe("idempotent");
    if (result.kind === "idempotent") {
      expect(result.existing.reviewId).toBe("review-1");
      expect(result.existing.decision).toBe("ACCEPT");
    }
  });

  it("returns 'conflict' for the same reviewId + different content", () => {
    const guard = new ReplayGuard();
    guard.record(sig({ reviewHash: "a".repeat(64) }));
    const result = guard.check(sig({ reviewHash: "b".repeat(64) }));
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.existing.reviewHash).toBe("a".repeat(64));
      expect(result.newHash).toBe("b".repeat(64));
    }
  });

  it("returns 'bundle_already_decided' for different reviewId on same bundle", () => {
    const guard = new ReplayGuard();
    guard.record(sig({ reviewId: "review-A" }));
    const result = guard.check(sig({ reviewId: "review-B" }));
    expect(result.kind).toBe("bundle_already_decided");
    if (result.kind === "bundle_already_decided") {
      expect(result.existing.reviewId).toBe("review-A");
    }
  });

  it("does not mutate state on check (pure read)", () => {
    const guard = new ReplayGuard();
    expect(guard.size()).toBe(0);
    guard.check(sig());
    guard.check(sig());
    expect(guard.size()).toBe(0);
  });

  it("different bundles are independent", () => {
    const guard = new ReplayGuard();
    guard.record(sig({ reviewBundleId: "bundle-A", reviewId: "rA" }));
    // bundle-B is fresh
    expect(guard.check(sig({ reviewBundleId: "bundle-B" })).kind).toBe("allow");
  });
});

describe("ReplayGuard.record", () => {
  it("stores the review under reviewBundleId", () => {
    const guard = new ReplayGuard();
    guard.record(sig());
    expect(guard.size()).toBe(1);
    const got = guard.get("bundle-1");
    expect(got?.reviewId).toBe("review-1");
    expect(got?.decision).toBe("ACCEPT");
  });

  it("records the appliedAt timestamp (custom or default)", () => {
    const guard = new ReplayGuard();
    const fixed = 1_700_000_000_000;
    guard.record(sig(), fixed);
    expect(guard.get("bundle-1")?.appliedAt).toBe(fixed);
  });

  it("overwrites the previous record for the same bundle (caller must check first)", () => {
    const guard = new ReplayGuard();
    guard.record(sig({ reviewId: "rA", decision: "ACCEPT" }));
    guard.record(sig({ reviewId: "rB", decision: "BLOCK" }));
    expect(guard.get("bundle-1")?.reviewId).toBe("rB");
    expect(guard.get("bundle-1")?.decision).toBe("BLOCK");
  });
});

describe("ReplayGuard.get / list / size / clear", () => {
  it("get returns undefined for unknown bundle", () => {
    const guard = new ReplayGuard();
    expect(guard.get("nope")).toBeUndefined();
  });

  it("listBundleIds returns all known bundle ids", () => {
    const guard = new ReplayGuard();
    guard.record(sig({ reviewBundleId: "A" }));
    guard.record(sig({ reviewBundleId: "B" }));
    expect(new Set(guard.listBundleIds())).toEqual(new Set(["A", "B"]));
  });

  it("clear empties the guard (Phase 9 recovery use case)", () => {
    const guard = new ReplayGuard();
    guard.record(sig());
    expect(guard.size()).toBe(1);
    guard.clear();
    expect(guard.size()).toBe(0);
    expect(guard.check(sig()).kind).toBe("allow");
  });
});
