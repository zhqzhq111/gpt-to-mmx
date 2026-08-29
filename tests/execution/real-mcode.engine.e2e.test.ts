import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { EvidenceStore } from "../../src/evidence/store.js";
import { EventStore } from "../../src/events/store.js";
import { G2MExecutionEngine } from "../../src/execution/engine.js";
import { FingerprintRegistry } from "../../src/execution/fingerprint.js";
import { ProfileRegistry } from "../../src/policy/verification.js";
import { buildReview } from "../../src/review/ingress.js";
import { ReplayGuard } from "../../src/review/replay-guard.js";
import { MCodeAdapter } from "../../src/workers/mcode/adapter.js";
import { WorkspaceLock } from "../../src/workspace/lock.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const execFileAsync = promisify(execFile);
const describeReal =
  process.env["G2M_RUN_REAL_MODIFY_E2E"] === "1" ? describe : describe.skip;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    windowsHide: true,
    shell: false,
  });
  return stdout.trim();
}

describeReal("real mcode execution engine E2E", () => {
  it("lets MiniMax fix a failing test in isolation and applies only an ACCEPTed patch", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "g2m-real-engine-"));
    const repositoryPath = join(tempRoot, "main repo");
    const previousMCodePath = process.env["G2M_MCODE_PATH"];
    process.env["G2M_MCODE_PATH"] =
      previousMCodePath ?? "C:/Users/zhq/AppData/Roaming/npm/mcode.cmd";

    try {
      await mkdir(join(repositoryPath, "src"), { recursive: true });
      await git(repositoryPath, ["init", "--initial-branch=main"]);
      await git(repositoryPath, ["config", "user.email", "g2m@test.local"]);
      await git(repositoryPath, ["config", "user.name", "G2M Test"]);
      await writeFile(
        join(repositoryPath, "src", "math.mjs"),
        "export function add(a, b) { return a - b; }\n",
        "utf8",
      );
      await writeFile(
        join(repositoryPath, "test.mjs"),
        [
          "import assert from 'node:assert/strict';",
          "import { add } from './src/math.mjs';",
          "assert.equal(add(2, 3), 5);",
          "console.log('PASS');",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(repositoryPath, "README.md"),
        "# Fixture\nRun `node test.mjs`. Only src/math.mjs may be changed.\n",
        "utf8",
      );
      await git(repositoryPath, ["add", "."]);
      await git(repositoryPath, ["commit", "-m", "failing baseline"]);

      const workspaceRegistry = new WorkspaceRegistry();
      workspaceRegistry.register("real-engine-fixture", repositoryPath);
      const profileRegistry = new ProfileRegistry();
      profileRegistry.register({
        id: "node_test",
        workspaceId: "real-engine-fixture",
        description: "Run the fixture test",
        program: process.execPath,
        args: ["test.mjs"],
        timeoutMs: 15_000,
        registeredAt: 0,
      });
      const evidenceStore = new EvidenceStore();
      const eventStore = new EventStore();
      const worker = new MCodeAdapter();
      const runtime = await worker.probe();
      const engine = new G2MExecutionEngine({
        workspaceRegistry,
        workspaceLock: new WorkspaceLock(),
        profileRegistry,
        evidenceStore,
        eventStore,
        fingerprintRegistry: new FingerprintRegistry(),
        replayGuard: new ReplayGuard(),
        worker,
        workerRuntime: {
          runtime: "mcode",
          version: runtime.version ?? "unknown",
          model: "MiniMax-M3",
        },
        adapterContractVersion: "g2m-worker-v1",
        worktreeRoot: join(tempRoot, "worktrees"),
        artifactRoot: join(tempRoot, "artifacts"),
      });

      const pending = await engine.execute({
        protocol_version: "g2m.code-task.v1",
        task_id: "real-fix-add-1",
        workspace_scope: {
          workspace_id: "real-engine-fixture",
          base_revision: "HEAD",
          require_clean_worktree: true,
        },
        goal: "Fix the implementation so node test.mjs passes.",
        constraints: [
          "Only modify src/math.mjs.",
          "Do not modify tests or README.md.",
          "Run node test.mjs after the change.",
          "Do not commit or push.",
        ],
        requested_capabilities: {
          read: true,
          write: true,
          test: true,
          network: false,
        },
        permission_policy: "coding_standard",
        limits: { max_steps: 12, timeout_ms: 90_000 },
        verification_profile: "node_test",
        acceptance_criteria: [
          "node test.mjs exits with status 0",
          "Only src/math.mjs is changed",
        ],
        session_policy: { mode: "new" },
      });

      expect(pending.bundle.workspaceEvidence.diff.changedFiles).toEqual([
        { path: "src/math.mjs", status: "M" },
      ]);
      expect(pending.bundle.verificationEvidence.verification.status).toBe("passed");
      expect(await readFile(join(repositoryPath, "src", "math.mjs"), "utf8")).toContain(
        "a - b",
      );

      const review = buildReview({
        taskId: pending.bundle.taskId,
        executionId: pending.bundle.executionId,
        reviewBundleId: pending.bundle.bundleId,
        taskHash: pending.bundle.taskHash,
        resultHash: pending.bundle.resultHash,
        reviewBundleHash: pending.bundle.reviewBundleHash,
        decision: "ACCEPT",
        findings: "Independent node_test verification passed and scope is exact.",
        reviewerId: "g2m-e2e",
      });
      const completed = await engine.applyReview(pending, review);

      expect(completed.state).toBe("ACCEPTED");
      const finalRun = await execFileAsync(process.execPath, ["test.mjs"], {
        cwd: repositoryPath,
        windowsHide: true,
        shell: false,
      });
      expect(finalRun.stdout).toContain("PASS");
      expect(await git(repositoryPath, ["diff", "--name-only"])).toBe("src/math.mjs");
    } finally {
      if (previousMCodePath === undefined) delete process.env["G2M_MCODE_PATH"];
      else process.env["G2M_MCODE_PATH"] = previousMCodePath;
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
