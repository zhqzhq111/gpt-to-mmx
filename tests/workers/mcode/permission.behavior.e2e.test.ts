import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { WorkerInvocation } from "../../../src/workers/coding-worker.js";
import { MCodeAdapter } from "../../../src/workers/mcode/adapter.js";
import { LocalPermissionPolicy } from "../../../src/workers/mcode/permission-mapper.js";
import type { MCodePermissionName } from "../../../src/workers/mcode/permission.js";

const describeReal =
  process.env["G2M_RUN_PERMISSION_PROBE"] === "1" ? describe : describe.skip;

async function runWriteProbe(permission: MCodePermissionName): Promise<{
  readonly changed: boolean;
  readonly content?: string;
  readonly summary: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), `g2m-permission-${permission}-`));
  const previousMCodePath = process.env["G2M_MCODE_PATH"];
  process.env["G2M_MCODE_PATH"] =
    previousMCodePath ?? "C:/Users/zhq/AppData/Roaming/npm/mcode.cmd";
  const policy = new LocalPermissionPolicy({
    mcodeMapping: {
      read_only: permission,
      coding_standard: permission,
      coding_extended: permission,
    },
  });
  const adapter = new MCodeAdapter({ policy });
  const invocation: WorkerInvocation = {
    executionId: `permission-${permission}-${Date.now()}`,
    prompt:
      "Create a file named permission-probe.txt containing exactly PERMISSION_OK followed by a newline. Do not do anything else. Return the required JSON summary.",
    workspacePath: workspace,
    permissionPolicy: "coding_standard",
    requestedCapabilities: { read: true, write: true, test: false, network: false },
    limits: { maxSteps: 8, timeoutMs: 60_000 },
    sessionPolicy: { mode: "new" },
  };

  try {
    await adapter.start(invocation);
    const result = await adapter.collectResult(invocation.executionId);
    const filePath = join(workspace, "permission-probe.txt");
    const changed = await stat(filePath).then(() => true).catch(() => false);
    const content = changed ? await readFile(filePath, "utf8") : undefined;
    return {
      changed,
      ...(content !== undefined ? { content } : {}),
      summary: result.summary,
    };
  } finally {
    if (previousMCodePath === undefined) delete process.env["G2M_MCODE_PATH"];
    else process.env["G2M_MCODE_PATH"] = previousMCodePath;
    await rm(workspace, { recursive: true, force: true });
  }
}

describeReal("mcode 0.2.7 permission behavior", () => {
  it("smart permits a bounded file edit in headless exec", async () => {
    const result = await runWriteProbe("smart");
    expect(result).toMatchObject({ changed: true, content: "PERMISSION_OK\n" });
  }, 120_000);

  it("full permits a bounded file edit in headless exec", async () => {
    const result = await runWriteProbe("full");
    expect(result).toMatchObject({ changed: true, content: "PERMISSION_OK\n" });
  }, 120_000);

  it("off disables approval checks rather than file tools in headless exec", async () => {
    const result = await runWriteProbe("off");
    expect(result).toMatchObject({ changed: true, content: "PERMISSION_OK\n" });
  }, 120_000);
});
