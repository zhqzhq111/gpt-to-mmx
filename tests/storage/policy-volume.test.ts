import { describe, expect, it } from "vitest";

import { DEFAULT_STORAGE_POLICY, resolveStoragePolicy } from "../../src/storage/policy.js";
import { deduplicateVolumeRoots, volumeIdForPath } from "../../src/storage/volume.js";
import { parseLocalConfig } from "../../src/cli/config.js";

describe("Phase 9 storage policy", () => {
  it("keeps legacy local configs valid and fills storage defaults", () => {
    const config = parseLocalConfig({
      protocol_version: "g2m.local-config.v1",
      workspaces: [{ workspace_id: "demo", path: "F:/demo" }],
      verification_profiles: [],
      worktree_root: "F:/g2m-state/worktrees",
      artifact_root: "F:/g2m-state/artifacts",
    });

    expect(config.storage).toEqual(DEFAULT_STORAGE_POLICY);
  });

  it("merges an explicit partial policy over defaults", () => {
    expect(resolveStoragePolicy({ min_free_bytes: 123 })).toEqual({
      ...DEFAULT_STORAGE_POLICY,
      min_free_bytes: 123,
    });
  });
});

describe("volume identity", () => {
  it("deduplicates Windows roots on the same drive", () => {
    expect(volumeIdForPath("C:\\worktrees", "win32")).toBe("win32:c:\\");
    expect(volumeIdForPath("c:\\g2m-state", "win32")).toBe("win32:c:\\");
  });

  it("distinguishes Windows drives and normalizes UNC shares", () => {
    expect(volumeIdForPath("D:\\artifacts", "win32")).toBe("win32:d:\\");
    expect(volumeIdForPath("\\\\SERVER\\Share\\folder", "win32")).toBe(
      "win32-unc:\\\\server\\share",
    );
  });

  it("uses device identity on POSIX", () => {
    expect(volumeIdForPath("/worktrees", "linux", 2049)).toBe("posix-dev:2049");
    expect(volumeIdForPath("/artifacts", "linux", 2050)).toBe("posix-dev:2050");
  });

  it("returns one root group per volume", () => {
    const groups = deduplicateVolumeRoots([
      { rootPath: "C:\\worktrees", roles: ["worktree"] },
      { rootPath: "C:\\artifacts", roles: ["artifact"] },
      { rootPath: "D:\\artifacts", roles: ["artifact"] },
    ], { platform: "win32" });

    expect([...groups.entries()].map(([id, roots]) => [id, roots.map((root) => root.rootPath)])).toEqual([
      ["win32:c:\\", ["C:\\worktrees", "C:\\artifacts"]],
      ["win32:d:\\", ["D:\\artifacts"]],
    ]);
  });
});
