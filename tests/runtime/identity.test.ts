import { describe, expect, it } from "vitest";

import {
  buildRuntimeIdentity,
  runtimeIdentityHash,
  validateRuntimeIdentity,
} from "../../src/runtime/identity.js";
import type { MCodeLaunchDescriptor } from "../../src/workers/mcode/resolver.js";

const descriptor: MCodeLaunchDescriptor = {
  kind: "exe",
  executablePath: "C:/tools/mcode.exe",
  executableSha256: "a".repeat(64),
  executableBytes: 123,
  version: "1.2.3",
  helpText: "help",
  helpSha256: "b".repeat(64),
  execHelpText: "--output-schema",
  execHelpSha256: "c".repeat(64),
  outputSchemaSupported: true,
  resolvedAt: 100,
  resolvedVia: "trusted-override",
};

describe("runtime identity", () => {
  it("has a self-validating stable identity hash without volatile fields", () => {
    const first = buildRuntimeIdentity({
      descriptor,
      nodeVersion: "v24.14.0",
      platform: "win32",
      arch: "x64",
      capabilitySnapshotHash: "d".repeat(64),
      workerSummarySchemaHash: "e".repeat(64),
    });
    const second = buildRuntimeIdentity({
      descriptor: { ...descriptor, resolvedAt: 999_999 },
      nodeVersion: "v24.14.0",
      platform: "win32",
      arch: "x64",
      capabilitySnapshotHash: "d".repeat(64),
      workerSummarySchemaHash: "e".repeat(64),
    });
    expect(first).toEqual(second);
    expect(validateRuntimeIdentity(first)).toBe(true);
    expect(runtimeIdentityHash(first)).toBe(first.identity_hash);
    expect(first.model).toBeNull();
    expect(first.model_pinned).toBe(false);
  });

  it("binds an explicitly pinned model", () => {
    const identity = buildRuntimeIdentity({
      descriptor,
      capabilitySnapshotHash: "d".repeat(64),
      workerSummarySchemaHash: "e".repeat(64),
      model: "MiniMax-M2",
    });
    expect(identity.model).toBe("MiniMax-M2");
    expect(identity.model_pinned).toBe(true);
  });

  it("changes identity when the pinned model changes and keeps unpinned distinct", () => {
    const common = {
      descriptor,
      capabilitySnapshotHash: "d".repeat(64),
      workerSummarySchemaHash: "e".repeat(64),
    } as const;
    const unpinned = buildRuntimeIdentity(common);
    const pinned = buildRuntimeIdentity({ ...common, model: "MiniMax-M2" });
    const changed = buildRuntimeIdentity({ ...common, model: "MiniMax-M3" });

    expect(unpinned.model).toBeNull();
    expect(unpinned.model_pinned).toBe(false);
    expect(pinned.identity_hash).not.toBe(unpinned.identity_hash);
    expect(changed.identity_hash).not.toBe(pinned.identity_hash);
    expect(validateRuntimeIdentity(changed)).toBe(true);
  });
});
