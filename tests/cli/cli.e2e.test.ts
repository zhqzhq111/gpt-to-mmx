import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { main } from "../../src/cli/index.js";
import { StateDatabase } from "../../src/projection/database.js";
import { ExecutionProjector } from "../../src/projection/execution-projector.js";

const execFileAsync = promisify(execFile);
const describeWindows = process.platform === "win32" ? describe : describe.skip;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, windowsHide: true });
  return stdout.trim();
}

async function waitForBundle(
  artifactRoot: string,
  excluded: readonly string[] = [],
): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const entries = await readdir(artifactRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(artifactRoot, entry.name, "review-bundle.json");
      if (excluded.includes(candidate)) continue;
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
      expect(outcome).toMatchObject({ state: "BLOCKED", patch_status: "discarded" });
      expect(await git(repo, ["status", "--porcelain"])).toBe("");
      const executionDirectories = await readdir(join(state, "executions"));
      expect(executionDirectories.length).toBeGreaterThan(0);
      expect(
        await readFile(
          join(state, "executions", executionDirectories[0]!, "state-events.ndjson"),
          "utf8",
        ),
      ).toContain('"schema_version":1');
      const projectionDatabase = new StateDatabase(join(state, "g2m-state.sqlite"));
      expect(
        new ExecutionProjector(projectionDatabase).execution(executionDirectories[0]!),
      ).toMatchObject({ state: "BLOCKED" });
      projectionDatabase.close();
      expect((await readdir(join(state, "evidence"))).length).toBeGreaterThan(0);
      expect((await readFile(join(state, "replay-guard.json"), "utf8")).trim()).not.toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("repairs a stale SQLite execution projection before the next CLI run", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-cli-backfill-e2e-"));
    const repo = join(root, "repo");
    const artifacts = join(root, "artifacts");
    const state = join(root, "state");
    const worktrees = join(root, "worktrees");
    const firstReviewPath = join(root, "first-review.json");
    const secondReviewPath = join(root, "second-review.json");
    const configPath = join(root, "config.json");
    const probeConfigPath = join(root, "probe-config.json");
    const taskPath = join(root, "task.json");
    const secondTaskPath = join(root, "second-task.json");
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
      const config = {
        protocol_version: "g2m.local-config.v1",
        workspaces: [{ workspace_id: "cli-demo", path: repo }],
        verification_profiles: [],
        worktree_root: worktrees,
        artifact_root: artifacts,
        state_root: state,
        mcode_path: mockPath,
        review_timeout_ms: 20_000,
      };
      await writeFile(configPath, JSON.stringify(config), "utf8");
      await writeFile(
        probeConfigPath,
        JSON.stringify({ ...config, state_root: join(root, "probe-state") }),
        "utf8",
      );
      await writeFile(
        taskPath,
        JSON.stringify({
          protocol_version: "g2m.code-task.v1",
          task_id: "cli-backfill-task",
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
      const firstTask = JSON.parse(await readFile(taskPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        secondTaskPath,
        JSON.stringify({ ...firstTask, task_id: "cli-backfill-task-2" }),
        "utf8",
      );

      const firstRunning = main([
        "run",
        "--config",
        configPath,
        "--task",
        taskPath,
        "--review",
        firstReviewPath,
      ]);
      const firstBundlePath = await waitForBundle(artifacts);
      await main([
        "review",
        "--bundle",
        firstBundlePath,
        "--decision",
        "BLOCK",
        "--output",
        firstReviewPath,
      ]);
      await firstRunning;

      const firstRunDirectory = (await readdir(artifacts, { withFileTypes: true }))
        .find((entry) => entry.isDirectory());
      expect(firstRunDirectory).toBeDefined();
      const executionId = firstRunDirectory!.name;
      const journalPath = join(state, "executions", executionId, "state-events.ndjson");
      const journalBefore = await readFile(journalPath);
      const journalRecords = journalBefore
        .toString("utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { hash: string; seq: number });
      const finalJournalRecord = journalRecords.at(-1)!;

      const corruptedDatabase = new StateDatabase(join(state, "g2m-state.sqlite"));
      corruptedDatabase.run(
        "UPDATE executions SET state = ?, updated_at = ? WHERE execution_id = ?",
        "PLANNED",
        0,
        executionId,
      );
      corruptedDatabase.setMeta(`execution:${executionId}:last_event_hash`, "corrupt-hash");
      corruptedDatabase.setMeta(`execution:${executionId}:last_event_seq`, "0");
      corruptedDatabase.close();

      const secondRunning = main([
        "run",
        "--config",
        configPath,
        "--task",
        secondTaskPath,
        "--review",
        secondReviewPath,
      ]);
      const secondBundlePath = await waitForBundle(artifacts, [firstBundlePath]);
      await main([
        "review",
        "--bundle",
        secondBundlePath,
        "--decision",
        "BLOCK",
        "--output",
        secondReviewPath,
      ]);
      await secondRunning;

      const repairedDatabase = new StateDatabase(join(state, "g2m-state.sqlite"));
      try {
        const repaired = new ExecutionProjector(repairedDatabase).execution(executionId);
        expect(repaired).toMatchObject({ execution_id: executionId, state: "BLOCKED" });
        expect(repairedDatabase.getMeta(`execution:${executionId}:last_event_hash`))
          .toBe(finalJournalRecord.hash);
        expect(repairedDatabase.getMeta(`execution:${executionId}:last_event_seq`))
          .toBe(String(finalJournalRecord.seq));
        expect(repairedDatabase.getMeta("backfill_status")).toBe("complete");
        expect(repairedDatabase.getMeta("backfill_at")).toMatch(/^\d+$/);
      } finally {
        repairedDatabase.close();
      }

      const journalAfter = await readFile(journalPath);
      expect(journalAfter).toEqual(journalBefore);
      expect(journalAfter.toString("utf8")).not.toContain("projection.repaired");
      expect(journalAfter.toString("utf8")).not.toContain("recovery.required");

      await main(["probe", "--config", probeConfigPath]);
      const standaloneReviewPath = join(root, "standalone-review.json");
      await main([
        "review",
        "--bundle",
        firstBundlePath,
        "--decision",
        "BLOCK",
        "--output",
        standaloneReviewPath,
      ]);
      await expect(readFile(join(root, "probe-state", "g2m-state.sqlite"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("continues a healthy new run when an unrelated Journal is quarantined", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-cli-quarantine-e2e-"));
    const repo = join(root, "repo");
    const artifacts = join(root, "artifacts");
    const state = join(root, "state");
    const worktrees = join(root, "worktrees");
    const reviewPath = join(root, "review.json");
    const configPath = join(root, "config.json");
    const taskPath = join(root, "task.json");
    const mockPath = join(root, "mcode.cmd");
    const quarantinedJournal = join(state, "executions", "unrelated-corrupt", "state-events.ndjson");

    try {
      await mkdir(repo, { recursive: true });
      await git(repo, ["init", "--initial-branch=main"]);
      await git(repo, ["config", "user.email", "g2m@test.local"]);
      await git(repo, ["config", "user.name", "G2M Test"]);
      await writeFile(join(repo, "README.md"), "# fixture\n", "utf8");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "baseline"]);
      await mkdir(join(state, "executions", "unrelated-corrupt"), { recursive: true });
      await writeFile(quarantinedJournal, "not-json\n", "utf8");
      const quarantinedBefore = await readFile(quarantinedJournal);
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
          task_id: "cli-quarantine-task",
          workspace_scope: {
            workspace_id: "cli-demo",
            base_revision: "HEAD",
            require_clean_worktree: true,
          },
          goal: "Inspect the repository without changing it.",
          constraints: ["Do not modify files."],
          requested_capabilities: { read: true, write: false, test: false, network: false },
          permission_policy: "read_only",
          limits: { max_steps: 5, timeout_ms: 30_000 },
          verification_profile: "none",
          acceptance_criteria: ["No files change."],
          session_policy: { mode: "new" },
        }),
        "utf8",
      );

      const running = main(["run", "--config", configPath, "--task", taskPath, "--review", reviewPath]);
      const bundlePath = await waitForBundle(artifacts);
      await main(["review", "--bundle", bundlePath, "--decision", "BLOCK", "--output", reviewPath]);
      await running;

      const runDirectories = await readdir(artifacts, { withFileTypes: true });
      const runDirectory = runDirectories.find((entry) => entry.isDirectory());
      expect(runDirectory).toBeDefined();
      expect(JSON.parse(await readFile(join(artifacts, runDirectory!.name, "outcome.json"), "utf8")))
        .toMatchObject({ state: "BLOCKED" });
      expect(await readFile(quarantinedJournal)).toEqual(quarantinedBefore);
      expect(await readdir(join(state, "executions"))).toEqual(
        expect.arrayContaining(["unrelated-corrupt", runDirectory!.name]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("safe-holds an active Journal once before allowing a healthy run", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-cli-recovery-e2e-"));
    const repo = join(root, "repo");
    const artifacts = join(root, "artifacts");
    const state = join(root, "state");
    const worktrees = join(root, "worktrees");
    const reviewPath = join(root, "review.json");
    const configPath = join(root, "config.json");
    const taskPath = join(root, "task.json");
    const mockPath = join(root, "mcode.cmd");
    const oldExecutionId = "old-active-execution";
    const secondTaskPath = join(root, "second-task.json");
    const oldTaskId = "old-active-task";

    try {
      await mkdir(repo, { recursive: true });
      await git(repo, ["init", "--initial-branch=main"]);
      await git(repo, ["config", "user.email", "g2m@test.local"]);
      await git(repo, ["config", "user.name", "G2M Test"]);
      await writeFile(join(repo, "README.md"), "# fixture\n", "utf8");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "baseline"]);

      const oldEvents = new EventStore({
        executionDirectory: join(state, "executions"),
      });
      oldEvents.append({
        taskId: oldTaskId,
        attemptId: oldExecutionId,
        type: "task.created",
        payload: { task: { task_id: oldTaskId } },
        timestampMs: 1,
      });
      oldEvents.append({ taskId: oldTaskId, attemptId: oldExecutionId, type: "task.validation.started", payload: {} });
      oldEvents.append({ taskId: oldTaskId, attemptId: oldExecutionId, type: "task.validation.passed", payload: {} });
      oldEvents.append({ taskId: oldTaskId, attemptId: oldExecutionId, type: "workspace.lock.requested", payload: {} });
      oldEvents.append({ taskId: oldTaskId, attemptId: oldExecutionId, type: "workspace.lock.acquired", payload: {} });
      oldEvents.append({ taskId: oldTaskId, attemptId: oldExecutionId, type: "agent.spawn.started", payload: {} });
      oldEvents.close();
      const oldJournalPath = join(state, "executions", oldExecutionId, "state-events.ndjson");
      const oldJournalBefore = await readFile(oldJournalPath);

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
          task_id: "healthy-after-recovery",
          workspace_scope: { workspace_id: "cli-demo", base_revision: "HEAD", require_clean_worktree: true },
          goal: "Inspect the repository without changing it.",
          constraints: ["Do not modify files."],
          requested_capabilities: { read: true, write: false, test: false, network: false },
          permission_policy: "read_only",
          limits: { max_steps: 5, timeout_ms: 30_000 },
          verification_profile: "none",
          acceptance_criteria: ["No files change."],
          session_policy: { mode: "new" },
        }),
        "utf8",
      );

      const running = main(["run", "--config", configPath, "--task", taskPath, "--review", reviewPath]);
      const bundlePath = await waitForBundle(artifacts);
      await main(["review", "--bundle", bundlePath, "--decision", "BLOCK", "--output", reviewPath]);
      await running;

      const journalAfterFirst = await readFile(oldJournalPath);
      expect(journalAfterFirst).not.toEqual(oldJournalBefore);
      const firstRecords = journalAfterFirst.toString("utf8").trim().split(/\r?\n/)
        .map((line) => JSON.parse(line) as { type: string; durability: string });
      expect(firstRecords.filter((record) => record.type === "recovery.required")).toHaveLength(1);
      expect(firstRecords.at(-1)).toMatchObject({ type: "recovery.required", durability: "CRITICAL" });

      const projection = new StateDatabase(join(state, "g2m-state.sqlite"));
      expect(new ExecutionProjector(projection).execution(oldExecutionId)).toMatchObject({
        state: "RECOVERY_REQUIRED",
      });
      projection.close();

      const secondTask = JSON.parse(await readFile(taskPath, "utf8")) as Record<string, unknown>;
      secondTask["task_id"] = "healthy-after-recovery-second";
      await writeFile(secondTaskPath, JSON.stringify(secondTask), "utf8");
      const secondRunning = main(["run", "--config", configPath, "--task", secondTaskPath, "--review", reviewPath]);
      const secondBundle = await waitForBundle(artifacts, [bundlePath]);
      await main(["review", "--bundle", secondBundle, "--decision", "BLOCK", "--output", reviewPath]);
      await secondRunning;

      const journalAfterSecond = await readFile(oldJournalPath);
      const secondRecords = journalAfterSecond.toString("utf8").trim().split(/\r?\n/)
        .map((line) => JSON.parse(line) as { type: string });
      expect(secondRecords.filter((record) => record.type === "recovery.required")).toHaveLength(1);
      expect(journalAfterSecond).not.toContain("retry");
      expect(journalAfterSecond).not.toContain("resume");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
