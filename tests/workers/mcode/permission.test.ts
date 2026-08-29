/**
 * Permission Mapper + Local Policy 测试(plan §12, §18-19)
 */

import { describe, it, expect } from "vitest";
import { LocalPermissionPolicy } from "../../../src/workers/mcode/permission-mapper.js";
import type { RequestedCapabilities } from "../../../src/protocol/code-task.v1.schema.js";
import type { ExecutionLimits } from "../../../src/workers/policy.js";

const baseCaps: RequestedCapabilities = {
  read: true,
  write: true,
  test: true,
  network: false,
};

const baseLimits: ExecutionLimits = {
  maxSteps: 20,
  timeoutMs: 600_000,
};

describe("LocalPermissionPolicy.mapToMCode (plan §18)", () => {
  it("read_only → smart (most conservative headless policy)", () => {
    const p = new LocalPermissionPolicy();
    expect(p.mapToMCode("read_only")).toBe("smart");
  });

  it("coding_standard → smart (default headless coding policy)", () => {
    const p = new LocalPermissionPolicy();
    expect(p.mapToMCode("coding_standard")).toBe("smart");
  });

  it("coding_extended → full (extended trust)", () => {
    const p = new LocalPermissionPolicy();
    expect(p.mapToMCode("coding_extended")).toBe("full");
  });
});

describe("LocalPermissionPolicy.decide (plan §12 Planner requests, G2M authorizes)", () => {
  it("network: Planner requests true, local allows false → effective false", () => {
    const p = new LocalPermissionPolicy({ localNetwork: false });
    const eff = p.decide("coding_standard", { ...baseCaps, network: true }, baseLimits);
    expect(eff.capabilities.network).toBe(false);
  });

  it("network: Planner requests false, local allows true → effective false (stays off)", () => {
    const p = new LocalPermissionPolicy({ localNetwork: true });
    const eff = p.decide("coding_standard", { ...baseCaps, network: false }, baseLimits);
    expect(eff.capabilities.network).toBe(false);
  });

  it("network: both true → effective true", () => {
    const p = new LocalPermissionPolicy({ localNetwork: true });
    const eff = p.decide("coding_extended", { ...baseCaps, network: true }, baseLimits);
    expect(eff.capabilities.network).toBe(true);
  });

  it("effectiveMaxSteps = min(Planner, Local) (plan §40)", () => {
    const p = new LocalPermissionPolicy({ localMaxSteps: 30 });
    const eff = p.decide(
      "coding_standard",
      baseCaps,
      { maxSteps: 100, timeoutMs: 600_000 },
    );
    expect(eff.effectiveMaxSteps).toBe(30);
  });

  it("effectiveMaxSteps = Planner when Planner < Local", () => {
    const p = new LocalPermissionPolicy({ localMaxSteps: 100 });
    const eff = p.decide(
      "coding_standard",
      baseCaps,
      { maxSteps: 20, timeoutMs: 600_000 },
    );
    expect(eff.effectiveMaxSteps).toBe(20);
  });

  it("effectiveTimeoutMs = min(Planner, Local) (plan §39)", () => {
    const p = new LocalPermissionPolicy({ localTimeoutMs: 1_000_000 });
    const eff = p.decide(
      "coding_standard",
      baseCaps,
      { maxSteps: 20, timeoutMs: 5_000_000 },
    );
    expect(eff.effectiveTimeoutMs).toBe(1_000_000);
  });

  it("permission mapping flows through decide() (plan §18-19 chained)", () => {
    const p = new LocalPermissionPolicy();
    expect(p.decide("read_only", baseCaps, baseLimits).mcodePermission).toBe("smart");
    expect(p.decide("coding_standard", baseCaps, baseLimits).mcodePermission).toBe("smart");
    expect(p.decide("coding_extended", baseCaps, baseLimits).mcodePermission).toBe("full");
  });
});
