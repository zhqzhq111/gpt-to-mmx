import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/index.js";

const execFileAsync = promisify(execFile);
const describeWindows = process.platform === "win32" ? describe : describe.skip;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, windowsHide: true });
  return stdout.trim();
}

async function waitForBundle(artifactRoot: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const entries = await readdir(artifactRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(artifactRoot, entry.name, "review-bundle.json");
      const exists = await readFile(candidate, "utf8").then(() => true).catch(() => false);
      if (exists) return candidate;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("review bundle was not produced");
}

describeWindows("G2M CLI handoff E2E", () => {
  it("runs until review pending, accepts a bound BLOCK file, and completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-cli-e2e-"));
    const repo = join(root, "repo");
    const artifacts = join(root, "artifacts");
    const state = join(root, "state");
    const worktrees = join(root, "worktrees");
    const reviewPath = join(root, "review.json");
    const configPath = join(root, "config.json");
    const taskPath = join(root, "task.json");
    const mockPath = join(root, "mcode.cmd");

    try {
      await mkdir(repo, { recursive: true });
      await git(repo, ["init", "--initial-branch=main"]);
      await git(repo, ["config", "user.email", "g2m@test.local"]);
      await git(repo, ["config", "user.name", "G2M Test"]);
      await writeFile(join(repo, "README.md"), "# fixture\n", "utf8");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "baseline"]);
      await writeFile(
        mockPath,
        [
          "@echo off",
          "if \"%~1\"==\"--version\" (echo 0.2.7-test& exit /b 0)",
          "if \"%~1\"==\"--help\" (echo Usage: mcode ^<command^>& exit /b 0)",
          "if \"%~1\"==\"exec\" if \"%~2\"==\"--help\" (echo Usage: mcode exec& exit /b 0)",
          "if \"%~1\"==\"exec\" goto :exec",
          "exit /b 1",
          ":exec",
          "echo {\"schemaVersion\":1,\"sequence\":1,\"timestampMs\":1,\"runId\":\"run-cli\",\"sessionId\":\"mvs_cli\",\"turnId\":\"turn-cli\",\"type\":\"exec.started\"}",
          "echo {\"schemaVersion\":1,\"sequence\":2,\"timestampMs\":2,\"runId\":\"run-cli\",\"sessionId\":\"mvs_cli\",\"turnId\":\"turn-cli\",\"type\":\"exec.completed\",\"result\":{\"schemaVersion\":1,\"type\":\"exec.result\",\"runId\":\"run-cli\",\"sessionId\":\"mvs_cli\",\"turnId\":\"turn-cli\",\"status\":\"succeeded\",\"output\":\"{\\\"summary\\\":\\\"No changes\\\",\\\"files_changed\\\":[],\\\"tests\\\":[],\\\"remaining_risks\\\":[]}\",\"model\":{},\"usage\":{},\"durationMs\":1}}",
          "exit /b 0",
          "",
        ].join("\r\n"),
        "utf8",
      );
      await writeFile(
        configPath,
        JSON.stringify({
          protocol_version: "g2m.local-config.v1",
          workspaces: [{ workspace_id: "cli-demo", path: repo }],
          verification_profiles: [],
          worktree_root: worktrees,
          artifact_root: artifacts,
          state_root: state,
          mcode_path: mockPath,
          review_timeout_ms: 20_000,
        }),
        "utf8",
      );
      await writeFile(
        taskPath,
        JSON.stringify({
          protocol_version: "g2m.code-task.v1",
          task_id: "cli-e2e-task",
          workspace_scope: {
            workspace_id: "cli-demo",
            base_revision: "HEAD",
            require_clean_worktree: true,
          },
          goal: "Inspect the repository without changing it.",
          constraints: ["Do not modify files."],
          requested_capabilities: {
            read: true,
            write: false,
            test: false,
            network: false,
          },
          permission_policy: "read_only",
          limits: { max_steps: 5, timeout_ms: 30_000 },
          verification_profile: "none",
          acceptance_criteria: ["No files change."],
          session_policy: { mode: "new" },
        }),
        "utf8",
      );

      const running = main([
        "run",
        "--config",
        configPath,
        "--task",
        taskPath,
        "--review",
        reviewPath,
      ]);
      const bundlePath = await waitForBundle(artifacts);
      await main([
        "review",
        "--bundle",
        bundlePath,
        "--decision",
        "BLOCK",
        "--output",
        reviewPath,
        "--findings",
        "CLI handoff verified",
      ]);
      await running;

      const runDirectories = await readdir(artifacts, { withFileTypes: true });
      const runDirectory = runDirectories.find((entry) => entry.isDirectory());
      expect(runDirectory).toBeDefined();
      const outcome = JSON.parse(
        await readFile(join(artifacts, runDirectory!.name, "outcome.json"), "utf8"),
      ) as { state: string; patchStatus: string };
      expect(outcome).toMatchObject({ state: "BLOCKED", patchStatus: "discarded" });
      expect(await git(repo, ["status", "--porcelain"])).toBe("");
      expect((await readdir(join(state, "events"))).length).toBeGreaterThan(0);
      expect((await readdir(join(state, "evidence"))).length).toBeGreaterThan(0);
      expect((await readFile(join(state, "replay-guard.json"), "utf8")).trim()).not.toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
