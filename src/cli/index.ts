#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { EvidenceStore } from "../evidence/store.js";
import { EventStore } from "../events/store.js";
import { reduce } from "../events/reducer.js";
import { G2MExecutionEngine, G2MExecutionEngineError } from "../execution/engine.js";
import { fingerprintHash, FingerprintRegistry } from "../execution/fingerprint.js";
import type { TaskState } from "../execution/state-machine.js";
import { ProfileRegistry } from "../policy/verification.js";
import { StateDatabase } from "../projection/database.js";
import { ExecutionProjector } from "../projection/execution-projector.js";
import { backfillProjection } from "../projection/backfill.js";
import { runAcceptRecovery, isPartialAccept, type AcceptProcessStatus } from "../recovery/accept-reconciler.js";
import { resolveRecovery, type ProcessStatus } from "../recovery/resolver.js";
import { scanRecovery } from "../recovery/scanner.js";
import { runStartupRecovery } from "../recovery/startup.js";
import type { TaskEvent } from "../events/events.js";
import type { Review } from "../review/ingress.js";
import { ReplayGuard } from "../review/replay-guard.js";
import { MCodeAdapter } from "../workers/mcode/adapter.js";
import { WorkspaceLock } from "../workspace/lock.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { captureBaseline } from "../workspace/baseline.js";
import { parseLocalConfig, type G2MLocalConfig } from "./config.js";
import { createReviewForBundle, writeJsonAtomic } from "./review-file.js";

interface ParsedArguments {
  readonly command: string;
  readonly options: ReadonlyMap<string, string>;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0] ?? "help";
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near "${key ?? "end of input"}"`);
    }
    options.set(key.slice(2), value);
  }
  return { command, options };
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`missing required option --${name}`);
  }
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

async function loadConfig(path: string): Promise<G2MLocalConfig> {
  return parseLocalConfig(await readJson(path));
}

interface ConfigureEngineOptions {
  readonly excludeExecutionIds?: readonly string[];
}

function configureEngine(
  config: G2MLocalConfig,
  worker: MCodeAdapter,
  workerVersion: string,
  options: ConfigureEngineOptions = {},
): {
  readonly engine: G2MExecutionEngine;
  readonly eventStore: EventStore;
  readonly evidenceStore: EvidenceStore;
  readonly fingerprintRegistry: FingerprintRegistry;
  readonly replayGuard: ReplayGuard;
  readonly worker: MCodeAdapter;
  readonly projectionDatabase: StateDatabase;
} {
  const stateRoot = stateRootForConfig(config);
  let projectionDatabase: StateDatabase | undefined;
  let eventStore: EventStore | undefined;

  try {
    projectionDatabase = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
    backfillProjection({
      stateRoot,
      database: projectionDatabase,
      workspaces: config.workspaces.map((entry) => ({
        workspaceId: entry.workspace_id,
        canonicalPath: entry.path,
      })),
      nowMs: Date.now(),
    });
    const projection = new ExecutionProjector(projectionDatabase);
    eventStore = new EventStore({
      executionDirectory: join(stateRoot, "executions"),
      tolerateLoadErrors: true,
    });
    const evidenceStore = new EvidenceStore({ directory: join(stateRoot, "evidence") });
    const fingerprintRegistry = new FingerprintRegistry({
      statePath: join(stateRoot, "fingerprints.json"),
    });
    const recoveryReport = scanRecovery({
      stateRoot,
      artifactRoot: config.artifact_root,
      worktreeRoot: config.worktree_root,
      eventStore,
      database: projectionDatabase,
    });
    runStartupRecovery({
      report: recoveryReport,
      eventStore,
      database: projectionDatabase,
      projector: projection,
      evidenceStore,
      fingerprintRegistry,
      ...(options.excludeExecutionIds !== undefined
        ? { excludeExecutionIds: options.excludeExecutionIds }
        : {}),
    });

    const workspaceRegistry = new WorkspaceRegistry();
    for (const workspace of config.workspaces) {
      workspaceRegistry.register(workspace.workspace_id, workspace.path);
    }
    const profileRegistry = new ProfileRegistry();
    for (const profile of config.verification_profiles) {
      profileRegistry.register({
        id: profile.id,
        ...(profile.workspace_id !== undefined
          ? { workspaceId: profile.workspace_id }
          : {}),
        description: profile.description,
        program: profile.program,
        args: profile.args,
        timeoutMs: profile.timeout_ms,
        ...(profile.env !== undefined ? { env: profile.env } : {}),
        registeredAt: 0,
      });
    }
    const replayGuard = new ReplayGuard({ statePath: join(stateRoot, "replay-guard.json") });
    const engine = new G2MExecutionEngine({
      workspaceRegistry,
      workspaceLock: new WorkspaceLock({
        stateRoot,
        workspacePathResolver: (workspaceId) => workspaceRegistry.get(workspaceId).canonicalPath,
        ...(config.workspace_lease?.heartbeat_interval_ms !== undefined
          ? { heartbeatIntervalMs: config.workspace_lease.heartbeat_interval_ms } : {}),
        ...(config.workspace_lease?.stale_after_ms !== undefined
          ? { staleAfterMs: config.workspace_lease.stale_after_ms } : {}),
        ...(config.workspace_lease?.incomplete_lease_grace_ms !== undefined
          ? { incompleteLeaseGraceMs: config.workspace_lease.incomplete_lease_grace_ms } : {}),
        ...(config.workspace_lease?.reclaim_guard_stale_ms !== undefined
          ? { reclaimGuardStaleMs: config.workspace_lease.reclaim_guard_stale_ms } : {}),
        leaseProjection: {
          upsert: (owner) => projection.upsertWorkspaceLease(owner),
          removeIfLeaseMatches: (workspaceId, leaseId) => projection.deleteWorkspaceLease(workspaceId, leaseId),
        },
      }),
      profileRegistry,
      evidenceStore,
      eventStore,
      projection,
      fingerprintRegistry,
      replayGuard,
      worker,
      workerRuntime: { runtime: "mcode", version: workerVersion, model: "configured" },
      adapterContractVersion: "g2m-worker-v1",
      worktreeRoot: config.worktree_root,
      artifactRoot: config.artifact_root,
    });
    return {
      engine,
      eventStore,
      evidenceStore,
      fingerprintRegistry,
      replayGuard,
      worker,
      projectionDatabase,
    };
  } catch (error) {
    eventStore?.close();
    projectionDatabase?.close();
    throw error;
  }
}

function stateRootForConfig(config: G2MLocalConfig): string {
  return config.state_root ?? resolve(config.artifact_root, "state");
}

async function waitForReview(path: string, timeoutMs: number): Promise<Review> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await stat(path).then(() => true).catch(() => false);
    if (exists) {
      const raw = await readJson(path);
      if (raw === null || typeof raw !== "object") {
        throw new Error("review file must contain a JSON object");
      }
      return raw as Review;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`timed out waiting for review file after ${timeoutMs}ms: ${path}`);
}

async function runCommand(options: ReadonlyMap<string, string>): Promise<void> {
  const configPath = resolve(required(options, "config"));
  const taskPath = resolve(required(options, "task"));
  const reviewPath = resolve(required(options, "review"));
  const config = await loadConfig(configPath);
  const previousMCodePath = process.env["G2M_MCODE_PATH"];
  let eventStoreToClose: EventStore | undefined;
  let projectionDatabaseToClose: StateDatabase | undefined;
  if (config.mcode_path !== undefined) process.env["G2M_MCODE_PATH"] = config.mcode_path;

  try {
    const worker = new MCodeAdapter();
    const runtime = await worker.probe();
    const { engine, eventStore, evidenceStore, projectionDatabase } = configureEngine(
      config,
      worker,
      runtime.version ?? "unknown",
    );
    eventStoreToClose = eventStore;
    projectionDatabaseToClose = projectionDatabase;
    emit({ type: "g2m.runtime.ready", runtime });
    const pending = await engine.execute(await readJson(taskPath));
    const runRoot = resolve(config.artifact_root, pending.executionId);
    const bundlePath = resolve(runRoot, "review-bundle.json");
    const evidencePath = resolve(runRoot, "evidence.json");
    const eventsPath = resolve(runRoot, "events.json");
    await Promise.all([
      writeJsonAtomic(bundlePath, pending.bundle),
      writeJsonAtomic(evidencePath, evidenceStore.getByExecution(pending.executionId)),
      writeJsonAtomic(eventsPath, eventStore.getByAttemptId(pending.executionId)),
    ]);
    emit({
      type: "g2m.review.pending",
      task_id: pending.task.task_id,
      execution_id: pending.executionId,
      bundle_path: bundlePath,
      review_path: reviewPath,
      worktree_path: pending.worktree.worktreePath,
    });

    const review = await waitForReview(reviewPath, config.review_timeout_ms);
    const completed = await engine.applyReview(pending, review);
    const outcomePath = resolve(runRoot, "outcome.json");
    // Phase 6 §28: outcome.json is now an immutable execution artifact frozen
    // by the engine BEFORE `patch.applied` is appended. The CLI no longer
    // writes it here — it only mirrors the events journal for the caller.
    await writeJsonAtomic(eventsPath, eventStore.getByAttemptId(pending.executionId));
    emit({ type: "g2m.completed", outcome_path: outcomePath, ...completed });
  } finally {
    eventStoreToClose?.close();
    projectionDatabaseToClose?.close();
    if (previousMCodePath === undefined) delete process.env["G2M_MCODE_PATH"];
    else process.env["G2M_MCODE_PATH"] = previousMCodePath;
  }
}

async function reviewCommand(options: ReadonlyMap<string, string>): Promise<void> {
  const bundlePath = resolve(required(options, "bundle"));
  const outputPath = resolve(required(options, "output"));
  const decision = required(options, "decision").toUpperCase();
  if (decision !== "ACCEPT" && decision !== "REVISE" && decision !== "BLOCK") {
    throw new Error("--decision must be ACCEPT, REVISE, or BLOCK");
  }
  const bundle = (await readJson(bundlePath)) as Parameters<
    typeof createReviewForBundle
  >[0];
  const findingsFile = options.get("findings-file");
  const findings =
    findingsFile !== undefined
      ? await readFile(resolve(findingsFile), "utf8")
      : options.get("findings");
  const review = createReviewForBundle(bundle, {
    decision,
    ...(findings !== undefined ? { findings: findings.trim() } : {}),
    ...(options.get("new-task-id") !== undefined
      ? { newTaskId: options.get("new-task-id")! }
      : {}),
    reviewerId: options.get("reviewer-id") ?? "codex",
  });
  await writeJsonAtomic(outputPath, review);
  emit({ type: "g2m.review.written", review_path: outputPath, decision });
}

function parseProcessStatus(value: string): ProcessStatus {
  const allowed: readonly ProcessStatus[] = [
    "alive",
    "exited_clean",
    "exited_error",
    "crashed",
    "unknown",
  ];
  if (!allowed.includes(value as ProcessStatus)) {
    throw new Error("--process-status must be one of: " + allowed.join(", "));
  }
  return value as ProcessStatus;
}

function replayAcceptState(
  events: readonly TaskEvent[],
  fingerprintRegistry: FingerprintRegistry,
): TaskState | null {
  let state: TaskState | null = null;
  for (const event of events) {
    try {
      state = reduce(state, event, { fingerprintRegistry });
    } catch {
      return state;
    }
  }
  return state;
}

async function recoverCommand(options: ReadonlyMap<string, string>): Promise<void> {
  const config = await loadConfig(resolve(required(options, "config")));
  const executionId = required(options, "execution-id");
  const processStatus = parseProcessStatus(required(options, "process-status"));
  let eventStoreToClose: EventStore | undefined;
  let projectionDatabaseToClose: StateDatabase | undefined;
  try {
    const worker = new MCodeAdapter();
    const configured = configureEngine(config, worker, "recovery", {
      excludeExecutionIds: [executionId],
    });
    const { eventStore, evidenceStore, fingerprintRegistry, replayGuard, projectionDatabase } = configured;
    eventStoreToClose = eventStore;
    projectionDatabaseToClose = projectionDatabase;
  const events = eventStore.getByAttemptId(executionId);
  if (events.length === 0) throw new Error("no persisted execution found: " + executionId);
  const taskEvent = events.find((event) => event.type === "task.created");
  const task = taskEvent?.payload["task"];
  if (task === undefined || typeof task !== "object" || task === null) {
    throw new Error("execution " + executionId + " has no persisted task payload");
  }
  const taskId = (task as { task_id?: unknown }).task_id;
  const workspaceId = (task as { workspace_scope?: { workspace_id?: unknown } }).workspace_scope?.workspace_id;
  if (typeof taskId !== "string" || typeof workspaceId !== "string") {
    throw new Error("execution " + executionId + " has an invalid persisted task payload");
  }
  const workspace = config.workspaces.find((entry) => entry.workspace_id === workspaceId);
  if (workspace === undefined) throw new Error("workspace not found in config: " + workspaceId);

  const executionEvidence = evidenceStore.getByExecution(executionId);
  const workerEvidence = executionEvidence.find((entry) => entry.type === "worker");
  const workspaceEvidence = executionEvidence.find((entry) => entry.type === "workspace");
  const fingerprintEvent = [...events]
    .reverse()
    .find((event) => event.fingerprint !== undefined);
  const frozen = fingerprintRegistry.get(taskId);
  const fingerprintMatch =
    fingerprintEvent?.fingerprint !== undefined &&
    frozen !== undefined &&
    fingerprintHash(fingerprintEvent.fingerprint) === fingerprintHash(frozen);
  const currentBaseline = await captureBaseline(workspace.path);

  const bundlePath = resolve(config.artifact_root, executionId, "review-bundle.json");
  const bundle = await readJson(bundlePath).catch(() => undefined) as
    | {
        workspaceEvidence?: {
          diff?: { diffHash?: unknown };
          patch?: {
            patchBlobHash?: unknown;
            patchHash?: unknown;
            changeSetHash?: unknown;
            changedFiles?: unknown;
          };
        };
      }
    | undefined;
  const prepared = events.find((event) => event.type === "review.accept.prepared");
  const patchApplied = events.find((event) => event.type === "patch.applied");
  const completed = events.find((event) => event.type === "review.accept.completed");
  if ((prepared !== undefined || patchApplied !== undefined) && completed === undefined) {
    // Phase 6 Task 4: delegate partial ACCEPT recovery to the Accept
    // Reconciler (plan §43-§44). It owns resume / reconcile / refuse
    // based on durable Frozen Patch + Journal + target classification.
    void bundle; void currentBaseline; void fingerprintEvent; void frozen; void fingerprintMatch;
    const { ExecutionProjector } = await import("../projection/execution-projector.js");
    const { runAcceptRecovery, isPartialAccept } = await import("../recovery/accept-reconciler.js");
    const replayedState = replayAcceptState(events, fingerprintRegistry);
    if (!isPartialAccept(replayedState)) {
      // Falls through to the generic recovery resolver below.
    } else {
      const projector = new ExecutionProjector(projectionDatabase);
      const result = await runAcceptRecovery({
        executionId,
        processStatus: processStatus as AcceptProcessStatus,
        events,
        repositoryPath: workspace.path,
        artifactRoot: config.artifact_root,
        temporaryRoot: resolve(config.artifact_root, executionId),
        eventStore,
        projector,
        replayGuard,
        fingerprintRegistry,
      });
      emit({
        type: "g2m.recovery.resolved",
        execution_id: executionId,
        task_id: taskId,
        verdict: result.verdict,
        reason: result.reason,
        target_state: result.targetState,
        original_state: result.originalState,
        final_state: result.finalState,
        appended_events: result.appendedEvents,
        ...(result.applyEvidenceHash !== undefined ? { apply_evidence_hash: result.applyEvidenceHash } : {}),
        ...(result.outcomeHash !== undefined ? { outcome_hash: result.outcomeHash } : {}),
      });
      return;
    }
  }

  const resolution = resolveRecovery({
    currentState: null,
    events,
    processStatus,
    workerResult: workerEvidence?.type === "worker" ? workerEvidence.workerResult : null,
    diff: workspaceEvidence?.type === "workspace" ? workspaceEvidence.diff : null,
    fingerprintMatch,
    workspaceDirty: currentBaseline.dirty,
  });

  if (resolution.verdict === "UNKNOWN") {
    eventStore.append({
      taskId,
      attemptId: executionId,
      type: "recovery.required",
      payload: { reason: resolution.reason },
      ...(frozen !== undefined ? { fingerprint: frozen } : {}),
    });
  }
  emit({
    type: "g2m.recovery.resolved",
    execution_id: executionId,
    task_id: taskId,
    ...resolution,
  });
  } finally {
    eventStoreToClose?.close();
    projectionDatabaseToClose?.close();
  }
}

async function probeCommand(options: ReadonlyMap<string, string>): Promise<void> {
  const config = await loadConfig(required(options, "config"));
  const previousMCodePath = process.env["G2M_MCODE_PATH"];
  if (config.mcode_path !== undefined) process.env["G2M_MCODE_PATH"] = config.mcode_path;
  try {
    emit({ type: "g2m.runtime.probe", runtime: await new MCodeAdapter().probe() });
  } finally {
    if (previousMCodePath === undefined) delete process.env["G2M_MCODE_PATH"];
    else process.env["G2M_MCODE_PATH"] = previousMCodePath;
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "G2M — Codex plans/reviews, MiniMax Code executes",
      "",
      "Commands:",
      "  g2m probe  --config <g2m.config.json>",
      "  g2m run    --config <config> --task <task.json> --review <review.json>",
      "  g2m recover --config <config> --execution-id <id> --process-status <status>",
      "  g2m review --bundle <review-bundle.json> --decision <ACCEPT|REVISE|BLOCK>",
      "             --output <review.json> [--findings-file <path>] [--new-task-id <id>]",
      "",
    ].join("\n"),
  );
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(argv);
  switch (parsed.command) {
    case "run":
      await runCommand(parsed.options);
      return;
    case "review":
      await reviewCommand(parsed.options);
      return;
    case "recover":
      await recoverCommand(parsed.options);
      return;
    case "probe":
      await probeCommand(parsed.options);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`unknown command "${parsed.command}"`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((error: unknown) => {
    const recovery =
      error instanceof G2MExecutionEngineError && error.recovery !== undefined
        ? {
            state: error.recovery.state,
            worktree_path: error.recovery.worktree.worktreePath,
          }
        : undefined;
    emit({
      type: "g2m.error",
      name: error instanceof Error ? error.name : "Error",
      code:
        error instanceof G2MExecutionEngineError ? error.code : "CLI_FAILED",
      message: error instanceof Error ? error.message : String(error),
      ...(recovery !== undefined ? { recovery } : {}),
    });
    process.exitCode = 1;
  });
}
