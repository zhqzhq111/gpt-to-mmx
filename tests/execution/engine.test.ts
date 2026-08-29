import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  G2MExecutionEngine,
  G2MExecutionEngineError,
} from "../../src/execution/engine.js";
import { EventStore } from "../../src/events/store.js";
import { EvidenceStore } from "../../src/evidence/store.js";
import { FingerprintRegistry } from "../../src/execution/fingerprint.js";
import { ProfileRegistry } from "../../src/policy/verification.js";
import { buildReview } from "../../src/review/ingress.js";
import { ReplayGuard } from "../../src/review/replay-guard.js";
import type { CodeTaskV1 } from "../../src/protocol/code-task.v1.schema.js";
import type {
  CodingWorkerAdapter,
  ExecutionId,
  RuntimeCapabilitySnapshot,
  WorkerInvocation,
  WorkerPrompt,
  WorkerResult,
} from "../../src/workers/coding-worker.js";
import { FakeMCodeAdapter } from "../../src/workers/mcode/fake.js";
import { WorkspaceLock } from "../../src/workspace/lock.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    windowsHide: true,
  });
  return stdout.trim();
}

class EditingWorker implements CodingWorkerAdapter {
  private readonly executions = new Map<ExecutionId, WorkerInvocation>();
  constructor(private readonly replacement: string = "fixed\n") {}

  probe(): Promise<RuntimeCapabilitySnapshot> {
    return Promise.resolve({
      runtime: "fake",
      available: true,
      version: "editing-worker-1",
      documentedCapabilities: {
        headlessExec: true,
        jsonOutput: true,
        streamJson: true,
        outputSchema: true,
        sessions: true,
        timeout: true,
        maxSteps: true,
        acp: false,
      },
      locallyVerified: {
        jsonContract: true,
        streamJsonContract: true,
        sessionIdExtraction: true,
        permissionMapping: true,
        timeoutBehavior: true,
      },
    });
  }

  async start(invocation: WorkerInvocation): Promise<void> {
    this.executions.set(invocation.executionId, invocation);
    await writeFile(join(invocation.workspacePath, "source.txt"), this.replacement, "utf8");
  }

  collectResult(executionId: ExecutionId): Promise<WorkerResult> {
    if (!this.executions.has(executionId)) throw new Error("not started");
    return Promise.resolve({
      executionId,
      sessionId: `fake-${executionId}`,
      summary: "Edited source.txt",
      filesChanged: ["source.txt"],
      testsAttempted: [],
      remainingRisks: [],
    });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  resume(
    _executionId: ExecutionId,
    _verifiedSessionId: string,
    _prompt: WorkerPrompt,
  ): Promise<void> {
    return Promise.reject(new Error("not implemented"));
  }
}

describe("G2MExecutionEngine", () => {
  let tempRoot: string;
  let repositoryPath: string;
  let worktreeRoot: string;
  let artifactRoot: string;
  let workspaceRegistry: WorkspaceRegistry;
  let workspaceLock: WorkspaceLock;
  let profileRegistry: ProfileRegistry;
  let evidenceStore: EvidenceStore;
  let eventStore: EventStore;
  let fingerprintRegistry: FingerprintRegistry;
  let replayGuard: ReplayGuard;
  let task: CodeTaskV1;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "g2m-engine-"));
    repositoryPath = join(tempRoot, "main repo");
    worktreeRoot = join(tempRoot, "worktrees");
    artifactRoot = join(tempRoot, "artifacts");
    await mkdir(repositoryPath, { recursive: true });
    await git(repositoryPath, ["init", "--initial-branch=main"]);
    await git(repositoryPath, ["config", "user.email", "g2m@test.local"]);
    await git(repositoryPath, ["config", "user.name", "G2M Test"]);
    await writeFile(join(repositoryPath, "source.txt"), "broken\n", "utf8");
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, ["commit", "-m", "baseline"]);

    workspaceRegistry = new WorkspaceRegistry();
    workspaceRegistry.register("demo", repositoryPath);
    workspaceLock = new WorkspaceLock();
    profileRegistry = new ProfileRegistry();
    profileRegistry.register({
      id: "targeted_tests",
      workspaceId: "demo",
      description: "source must be fixed",
      program: process.execPath,
      args: [
        "-e",
        "const fs=require('fs');process.exit(fs.readFileSync('source.txt','utf8').includes('fixed')?0:1)",
      ],
      timeoutMs: 10_000,
      registeredAt: 0,
    });
    evidenceStore = new EvidenceStore();
    eventStore = new EventStore();
    fingerprintRegistry = new FingerprintRegistry();
    replayGuard = new ReplayGuard();
    task = {
      protocol_version: "g2m.code-task.v1",
      task_id: "task-demo-1",
      workspace_scope: {
        workspace_id: "demo",
        base_revision: "HEAD",
        require_clean_worktree: true,
      },
      goal: "Fix source.txt",
      constraints: ["Only edit source.txt", "Do not commit or push"],
      requested_capabilities: {
        read: true,
        write: true,
        test: true,
        network: false,
      },
      permission_policy: "coding_standard",
      limits: { max_steps: 10, timeout_ms: 60_000 },
      verification_profile: "targeted_tests",
      acceptance_criteria: ["source.txt contains fixed"],
      session_policy: { mode: "new" },
    };
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  function engine(worker: CodingWorkerAdapter = new EditingWorker()): G2MExecutionEngine {
    return new G2MExecutionEngine({
      workspaceRegistry,
      workspaceLock,
      profileRegistry,
      evidenceStore,
      eventStore,
      fingerprintRegistry,
      replayGuard,
      worker,
      workerRuntime: { runtime: "fake", version: "editing-worker-1", model: "fake" },
      adapterContractVersion: "g2m-worker-v1",
      worktreeRoot,
      artifactRoot,
    });
  }

  it("executes in an isolated worktree and returns a bound review bundle", async () => {
    const pending = await engine().execute(task);

    expect(pending.state).toBe("REVIEW_PENDING");
    expect(await readFile(join(repositoryPath, "source.txt"), "utf8")).toMatch(/^broken\r?\n$/);
    expect(await readFile(join(pending.worktree.worktreePath, "source.txt"), "utf8")).toBe("fixed\n");
    expect(evidenceStore.getByExecution(pending.executionId)).toHaveLength(3);
    expect(pending.bundle.taskId).toBe(task.task_id);
    expect(pending.bundle.workspaceEvidence.diff.changedFiles).toEqual([
      { path: "source.txt", status: "M" },
    ]);
    expect(eventStore.getByTaskId(task.task_id).map((event) => event.type)).toEqual([
      "task.created",
      "task.validation.started",
      "task.validation.passed",
      "workspace.lock.requested",
      "workspace.lock.acquired",
      "agent.spawn.started",
      "agent.completed",
      "evidence.diff.collected",
      "verification.completed",
      "review.requested",
    ]);
    expect(workspaceLock.isHeld("demo")).toBe(false);
  });

  it("applies the reviewed patch only after an ACCEPT decision", async () => {
    const runner = engine();
    const pending = await runner.execute(task);
    const review = buildReview({
      taskId: pending.bundle.taskId,
      executionId: pending.bundle.executionId,
      reviewBundleId: pending.bundle.bundleId,
      taskHash: pending.bundle.taskHash,
      resultHash: pending.bundle.resultHash,
      reviewBundleHash: pending.bundle.reviewBundleHash,
      decision: "ACCEPT",
      findings: "Verified",
    });

    const completed = await runner.applyReview(pending, review);

    expect(completed.state).toBe("ACCEPTED");
    expect(completed.patchStatus).toBe("applied");
    expect((await readFile(join(repositoryPath, "source.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("fixed\n");
    await expect(stat(pending.worktree.worktreePath)).rejects.toBeTruthy();
  });

  it("does not consume an ACCEPT review when the target becomes dirty", async () => {
    const runner = engine();
    const pending = await runner.execute(task);
    const review = buildReview({
      taskId: pending.bundle.taskId,
      executionId: pending.bundle.executionId,
      reviewBundleId: pending.bundle.bundleId,
      taskHash: pending.bundle.taskHash,
      resultHash: pending.bundle.resultHash,
      reviewBundleHash: pending.bundle.reviewBundleHash,
      decision: "ACCEPT",
      findings: "Verified",
    });
    await writeFile(join(repositoryPath, "user-note.txt"), "unrelated user change\n", "utf8");

    await expect(runner.applyReview(pending, review)).rejects.toMatchObject({
      code: "DIRTY_TARGET",
    });

    expect(replayGuard.size()).toBe(0);
    expect(eventStore.getByTaskId(task.task_id).at(-1)?.type).toBe("review.requested");
    expect(await readFile(join(repositoryPath, "source.txt"), "utf8")).toMatch(/^broken\r?\n$/);
    await expect(stat(pending.worktree.worktreePath)).resolves.toBeTruthy();
  });

  it("discards the isolated worktree after BLOCK without changing main", async () => {
    const runner = engine();
    const pending = await runner.execute(task);
    const review = buildReview({
      taskId: pending.bundle.taskId,
      executionId: pending.bundle.executionId,
      reviewBundleId: pending.bundle.bundleId,
      taskHash: pending.bundle.taskHash,
      resultHash: pending.bundle.resultHash,
      reviewBundleHash: pending.bundle.reviewBundleHash,
      decision: "BLOCK",
      findings: "Reject patch",
    });

    const completed = await runner.applyReview(pending, review);

    expect(completed.state).toBe("BLOCKED");
    expect(completed.patchStatus).toBe("discarded");
    expect(await readFile(join(repositoryPath, "source.txt"), "utf8")).toMatch(/^broken\r?\n$/);
    await expect(stat(pending.worktree.worktreePath)).rejects.toBeTruthy();
  });

  it("keeps the worktree after REVISE and does not apply its patch", async () => {
    const runner = engine();
    const pending = await runner.execute(task);
    const review = buildReview({
      taskId: pending.bundle.taskId,
      executionId: pending.bundle.executionId,
      reviewBundleId: pending.bundle.bundleId,
      taskHash: pending.bundle.taskHash,
      resultHash: pending.bundle.resultHash,
      reviewBundleHash: pending.bundle.reviewBundleHash,
      decision: "REVISE",
      newTaskId: "task-demo-2",
      findings: "Needs another change",
    });

    const completed = await runner.applyReview(pending, review);

    expect(completed.state).toBe("REVISION_REQUESTED");
    expect(completed.patchStatus).toBe("retained_for_revision");
    await expect(stat(pending.worktree.worktreePath)).resolves.toBeTruthy();
    expect(await readFile(join(repositoryPath, "source.txt"), "utf8")).toMatch(/^broken\r?\n$/);
  });

  it("fails safely, cleans the worktree, and releases the lock when verification fails", async () => {
    const runner = engine(new EditingWorker("still broken\n"));

    await expect(runner.execute(task)).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });
    expect(workspaceLock.isHeld("demo")).toBe(false);
    expect(await readFile(join(repositoryPath, "source.txt"), "utf8")).toMatch(/^broken\r?\n$/);
    expect(eventStore.getByTaskId(task.task_id).at(-1)?.type).toBe("verification.failed");
  });

  it("rejects and cleans any workspace mutation produced by a read-only task", async () => {
    const runner = engine();
    const readOnlyTask: CodeTaskV1 = {
      ...task,
      task_id: "task-read-only-1",
      requested_capabilities: {
        read: true,
        write: false,
        test: false,
        network: false,
      },
      permission_policy: "read_only",
      verification_profile: "none",
    };

    await expect(runner.execute(readOnlyTask)).rejects.toMatchObject({
      code: "CAPABILITY_VIOLATION",
    });

    expect(workspaceLock.isHeld("demo")).toBe(false);
    expect(await readFile(join(repositoryPath, "source.txt"), "utf8")).toMatch(/^broken\r?\n$/);
    expect(eventStore.getByTaskId(readOnlyTask.task_id).at(-1)?.type).toBe(
      "verification.failed",
    );
  });

  it("rejects invalid task input before acquiring a workspace lock", async () => {
    await expect(engine().execute({ protocol_version: "wrong" })).rejects.toBeInstanceOf(
      G2MExecutionEngineError,
    );
    expect(workspaceLock.heldWorkspaceIds()).toEqual([]);
  });

  it("maps a worker timeout to TIMED_OUT instead of generic FAILED", async () => {
    const runner = engine(new FakeMCodeAdapter({ behavior: "timeout" }));

    await expect(runner.execute(task)).rejects.toMatchObject({
      code: "WORKER_TIMED_OUT",
    });
    expect(eventStore.getByTaskId(task.task_id).at(-1)?.type).toBe("agent.timed_out");
  });

  it("moves an unknown worker outcome to RECOVERY_REQUIRED and preserves the worktree", async () => {
    const runner = engine(new FakeMCodeAdapter({ behavior: "processCrash" }));
    let caught: unknown;
    try {
      await runner.execute(task);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "RECOVERY_REQUIRED" });
    const recovery = (caught as G2MExecutionEngineError).recovery;
    expect(recovery?.state).toBe("RECOVERY_REQUIRED");
    await expect(stat(recovery?.worktree.worktreePath ?? "")).resolves.toBeTruthy();
    expect(eventStore.getByTaskId(task.task_id).at(-1)?.type).toBe("recovery.required");
  });
});
