import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; config: string }> {
  const root = await mkdtemp(join(tmpdir(), "g2m-cli-operations-"));
  roots.push(root);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    protocol_version: "g2m.local-config.v1",
    workspaces: [{ workspace_id: "ws-1", path: join(root, "workspace") }],
    verification_profiles: [], worktree_root: join(root, "worktrees"), artifact_root: join(root, "artifacts"), state_root: join(root, "state"),
  }), "utf8");
  return { root, config };
}

async function runCli(args: readonly string[]): Promise<string> {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try { await main(args); return write.mock.calls.map(([value]) => String(value)).join(""); }
  finally { write.mockRestore(); }
}

describe("operational CLI", () => {
  it("renders status JSON with the stable schema", async () => {
    const f = await fixture();
    const output = JSON.parse(await runCli(["status", "--config", f.config, "--format", "json"]));
    expect(output.schema_version).toBe("g2m.status.v1");
    expect(output.state_root.state_root_exists).toBe(false);
  });

  it("renders doctor text and keeps repair dry-run read-only", async () => {
    const f = await fixture();
    expect(await runCli(["doctor", "--config", f.config])).toContain("g2m.doctor.v1");
    const output = JSON.parse(await runCli(["repair", "--config", f.config, "--action", "projection-rebuild", "--format", "json"]));
    expect(output.schema_version).toBe("g2m.repair-plan.v1");
    await expect(readFile(join(f.root, "state", "repair"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
