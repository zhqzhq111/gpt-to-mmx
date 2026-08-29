/**
 * Verification Profile / ProfileRegistry / resolveProfile — plan §29 + §67
 */

import { describe, it, expect } from "vitest";

import {
  ProfileRegistry,
  ProfileRegistryError,
  ProfileResolutionError,
  NO_VERIFICATION_PROFILE,
  resolveProfile,
  type VerificationProfile,
} from "../../src/policy/verification.js";

function makeProfile(
  overrides: Partial<VerificationProfile> = {},
): VerificationProfile {
  return {
    id: "tests",
    description: "Run tests",
    program: "npm",
    args: ["test"],
    timeoutMs: 60_000,
    registeredAt: 0,
    ...overrides,
  };
}

/**
 * 期望函数抛 ProfileRegistryError 且 code 匹配。
 * 用 try/catch 而不是 expect.toThrow(/regex/),因为 code 字段在 .code 上,
 * 不在 message 上,regex 匹配 message 会误报。
 */
function expectRegistryError(
  fn: () => unknown,
  code: ProfileRegistryError["code"],
): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ProfileRegistryError);
  expect((caught as ProfileRegistryError).code).toBe(code);
}

function expectResolutionError(
  fn: () => unknown,
  code: ProfileResolutionError["code"],
): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ProfileResolutionError);
  expect((caught as ProfileResolutionError).code).toBe(code);
}

describe("ProfileRegistry.register", () => {
  it("registers a global profile (no workspaceId)", () => {
    const reg = new ProfileRegistry();
    const stored = reg.register(makeProfile());
    expect(stored.id).toBe("tests");
    expect(stored.registeredAt).toBeGreaterThan(0);
    expect(reg.get("tests")).toBeDefined();
    expect(reg.get("tests")?.program).toBe("npm");
  });

  it("registers a workspace-scoped profile", () => {
    const reg = new ProfileRegistry();
    reg.register(
      makeProfile({ id: "tests", workspaceId: "ws-A", program: "pytest" }),
    );
    expect(reg.get("tests", "ws-A")?.program).toBe("pytest");
    expect(reg.get("tests", "ws-B")).toBeUndefined();
    expect(reg.get("tests")).toBeUndefined();
  });

  it("rejects duplicate (id, workspaceId) registration with DUPLICATE", () => {
    const reg = new ProfileRegistry();
    reg.register(makeProfile({ id: "x", description: "first" }));
    expectRegistryError(
      () => reg.register(makeProfile({ id: "x", description: "dup" })),
      "DUPLICATE",
    );
  });

  it("allows same id under different workspaceId", () => {
    const reg = new ProfileRegistry();
    reg.register(makeProfile({ id: "tests", workspaceId: "ws-A" }));
    expect(() =>
      reg.register(makeProfile({ id: "tests", workspaceId: "ws-B" })),
    ).not.toThrow();
  });

  it("rejects empty id with INVALID_PROFILE", () => {
    const reg = new ProfileRegistry();
    expectRegistryError(() => reg.register(makeProfile({ id: "" })), "INVALID_PROFILE");
  });

  it("rejects empty program with INVALID_PROFILE", () => {
    const reg = new ProfileRegistry();
    expectRegistryError(() => reg.register(makeProfile({ program: "" })), "INVALID_PROFILE");
  });

  it("rejects non-positive timeoutMs with INVALID_PROFILE", () => {
    const reg = new ProfileRegistry();
    expectRegistryError(() => reg.register(makeProfile({ timeoutMs: 0 })), "INVALID_PROFILE");
    expectRegistryError(() => reg.register(makeProfile({ timeoutMs: -1 })), "INVALID_PROFILE");
    expectRegistryError(() => reg.register(makeProfile({ timeoutMs: 1.5 })), "INVALID_PROFILE");
  });
});

describe("ProfileRegistry.unregister", () => {
  it("removes an existing profile", () => {
    const reg = new ProfileRegistry();
    reg.register(makeProfile({ id: "x" }));
    reg.unregister("x");
    expect(reg.get("x")).toBeUndefined();
  });

  it("removes only the specified (id, workspaceId) pair", () => {
    const reg = new ProfileRegistry();
    reg.register(makeProfile({ id: "x" }));
    reg.register(makeProfile({ id: "x", workspaceId: "ws-A" }));
    reg.unregister("x");
    expect(reg.get("x")).toBeUndefined();
    expect(reg.get("x", "ws-A")).toBeDefined();
  });

  it("throws NOT_FOUND for missing profile", () => {
    const reg = new ProfileRegistry();
    expectRegistryError(() => reg.unregister("nonexistent"), "NOT_FOUND");
  });
});

describe("ProfileRegistry.get precedence", () => {
  it("workspace-scoped profile takes precedence over global", () => {
    const reg = new ProfileRegistry();
    reg.register(makeProfile({ id: "tests", program: "npm" }));
    reg.register(
      makeProfile({ id: "tests", workspaceId: "ws-A", program: "pytest" }),
    );
    expect(reg.get("tests", "ws-A")?.program).toBe("pytest");
    expect(reg.get("tests", "ws-B")?.program).toBe("npm");
    expect(reg.get("tests")?.program).toBe("npm");
  });
});

describe("ProfileRegistry.list", () => {
  it("returns all profiles when no workspaceId is given", () => {
    const reg = new ProfileRegistry();
    reg.register(makeProfile({ id: "global" }));
    reg.register(makeProfile({ id: "scoped", workspaceId: "ws-A" }));
    expect(reg.list()).toHaveLength(2);
  });

  it("returns global + workspace-specific when workspaceId is given", () => {
    const reg = new ProfileRegistry();
    reg.register(makeProfile({ id: "global" }));
    reg.register(makeProfile({ id: "scoped", workspaceId: "ws-A" }));
    reg.register(makeProfile({ id: "other", workspaceId: "ws-B" }));
    const visible = reg.list("ws-A");
    expect(visible).toHaveLength(2);
    const ids = visible.map((p) => p.id).sort();
    expect(ids).toEqual(["global", "scoped"]);
  });

  it("returns a snapshot, not a live view", () => {
    const reg = new ProfileRegistry();
    reg.register(makeProfile({ id: "a" }));
    const list = reg.list();
    reg.register(makeProfile({ id: "b" }));
    expect(list).toHaveLength(1);
  });
});

describe("resolveProfile", () => {
  it("returns undefined for the 'none' sentinel (plan §29 skip)", () => {
    const reg = new ProfileRegistry();
    expect(resolveProfile(reg, "ws-1", NO_VERIFICATION_PROFILE)).toBeUndefined();
  });

  it("throws NOT_FOUND when profile is not registered (plan §29 strict)", () => {
    const reg = new ProfileRegistry();
    expectResolutionError(
      () => resolveProfile(reg, "ws-1", "missing"),
      "NOT_FOUND",
    );
  });

  it("resolves a registered global profile from any workspace", () => {
    const reg = new ProfileRegistry();
    reg.register(makeProfile({ id: "tests" }));
    const a = resolveProfile(reg, "ws-A", "tests");
    const b = resolveProfile(reg, "ws-B", "tests");
    expect(a?.id).toBe("tests");
    expect(b?.id).toBe("tests");
  });

  it("resolves workspace-specific over global", () => {
    const reg = new ProfileRegistry();
    reg.register(makeProfile({ id: "tests", program: "npm" }));
    reg.register(
      makeProfile({ id: "tests", workspaceId: "ws-A", program: "pytest" }),
    );
    expect(resolveProfile(reg, "ws-A", "tests")?.program).toBe("pytest");
    expect(resolveProfile(reg, "ws-B", "tests")?.program).toBe("npm");
  });

  it("throws INVALID_ID for empty profile id", () => {
    const reg = new ProfileRegistry();
    expectResolutionError(() => resolveProfile(reg, "ws-1", ""), "INVALID_ID");
  });
});
