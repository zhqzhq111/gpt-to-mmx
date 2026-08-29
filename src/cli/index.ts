#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { EvidenceStore } from "../evidence/store.js";
import { EventStore } from "../events/store.js";
import { G2MExecutionEngine, G2MExecutionEngineError } from "../execution/engine.js";
import { FingerprintRegistry } from "../execution/fingerprint.js";
import { ProfileRegistry } from "../policy/verification.js";
import type { Review } from "../review/ingress.js";
import { ReplayGuard } from "../review/replay-guard.js";
import { MCodeAdapter } from "../workers/mcode/adapter.js";
import { WorkspaceLock } from "../workspace/lock.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
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

function configureEngine(
  config: G2MLocalConfig,
  worker: MCodeAdapter,
  workerVersion: string,
): {
  readonly engine: G2MExecutionEngine;
  readonly eventStore: EventStore;
  readonly evidenceStore: EvidenceStore;
  readonly worker: MCodeAdapter;
} {
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
  const eventStore = new EventStore();
  const evidenceStore = new EvidenceStore();
  const engine = new G2MExecutionEngine({
    workspaceRegistry,
    workspaceLock: new WorkspaceLock(),
    profileRegistry,
    evidenceStore,
    eventStore,
    fingerprintRegistry: new FingerprintRegistry(),
    replayGuard: new ReplayGuard(),
    worker,
    workerRuntime: { runtime: "mcode", version: workerVersion, model: "configured" },
    adapterContractVersion: "g2m-worker-v1",
    worktreeRoot: config.worktree_root,
    artifactRoot: config.artifact_root,
  });
  return { engine, eventStore, evidenceStore, worker };
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
  if (config.mcode_path !== undefined) process.env["G2M_MCODE_PATH"] = config.mcode_path;

  try {
    const worker = new MCodeAdapter();
    const runtime = await worker.probe();
    const { engine, eventStore, evidenceStore } = configureEngine(
      config,
      worker,
      runtime.version ?? "unknown",
    );
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
    await Promise.all([
      writeJsonAtomic(outcomePath, completed),
      writeJsonAtomic(eventsPath, eventStore.getByAttemptId(pending.executionId)),
    ]);
    emit({ type: "g2m.completed", outcome_path: outcomePath, ...completed });
  } finally {
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
