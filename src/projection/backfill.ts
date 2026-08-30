import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadSingleExecutionJournal } from "../events/store.js";
import type { TaskEvent } from "../events/events.js";
import { reduce } from "../events/reducer.js";
import { FingerprintRegistry } from "../execution/fingerprint.js";
import { StateDatabase } from "./database.js";
import {
  ExecutionProjector,
  type ProjectionReplayStep,
  type WorkspaceSeed,
} from "./execution-projector.js";

export interface BackfillProjectionOptions {
  readonly stateRoot: string;
  readonly database: StateDatabase;
  readonly workspaces: readonly WorkspaceSeed[];
  readonly nowMs: number;
  readonly completedRetentionDays?: number;
}

export interface BackfillProjectionReport {
  readonly scannedExecutions: number;
  readonly repairedExecutions: number;
  readonly currentExecutions: number;
  readonly staleExecutions: number;
  readonly truncatedTails: number;
  readonly failureReasons: ReadonlyArray<{
    readonly executionId: string;
    readonly reason: string;
  }>;
}

const TRUNCATED_TAIL_REASON = "TRUNCATED_TAIL";

function executionDirectories(stateRoot: string): readonly string[] {
  const executionsRoot = join(stateRoot, "executions");
  mkdirSync(executionsRoot, { recursive: true });
  return readdirSync(executionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function stableLoadReason(error: string): string {
  if (error.includes("journal file is missing")) return "MISSING_JOURNAL";
  if (error.includes("invalid journal JSON")) return "INVALID_JOURNAL";
  if (error.includes("event log chain is invalid")) return "BROKEN_CHAIN";
  if (error.includes("execution binding does not match")) return "EXECUTION_MISMATCH";
  if (error.includes("unsupported journal schema version")) return "SCHEMA_INCOMPATIBLE";
  return "JOURNAL_LOAD_ERROR";
}

function stableReplayReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `REDUCER_ERROR: ${message}`;
}

function replaySteps(events: readonly TaskEvent[]): {
  readonly steps: readonly ProjectionReplayStep[];
  readonly finalState: ProjectionReplayStep["state"];
  readonly taskId: string;
  readonly updatedAt: number;
} {
  const fingerprintRegistry = new FingerprintRegistry();
  let state: Parameters<typeof reduce>[0] = null;
  let taskId: string | undefined;
  let updatedAt: number | undefined;
  const steps: ProjectionReplayStep[] = [];

  for (const event of events) {
    state = reduce(state, event, { fingerprintRegistry });
    steps.push({ event, state });
    if (event.type === "task.created") taskId = event.taskId;
    if (event.domain !== "projection") updatedAt = event.timestampMs;
  }

  if (state === null || taskId === undefined || updatedAt === undefined || steps.length === 0) {
    throw new Error("replay produced no execution state");
  }
  return { steps, finalState: state, taskId, updatedAt };
}

function isCurrent(
  projector: ExecutionProjector,
  database: StateDatabase,
  executionId: string,
  replay: ReturnType<typeof replaySteps>,
  finalEvent: TaskEvent,
): boolean {
  const row = projector.execution(executionId);
  return database.getMeta(`execution:${executionId}:stale`) === undefined
    && database.getMeta(`execution:${executionId}:last_event_hash`) === finalEvent.hash
    && database.getMeta(`execution:${executionId}:last_event_seq`) === String(finalEvent.seq)
    && row !== undefined
    && row.state === replay.finalState
    && row.task_id === replay.taskId
    && row.updated_at === replay.updatedAt;
}

export function backfillProjection(options: BackfillProjectionOptions): BackfillProjectionReport {
  const { stateRoot, database, workspaces, nowMs } = options;
  const projector = new ExecutionProjector(database, {
    ...(options.completedRetentionDays !== undefined
      ? { completedRetentionDays: options.completedRetentionDays }
      : {}),
  });
  projector.seedWorkspaces(workspaces, nowMs);

  let repairedExecutions = 0;
  let currentExecutions = 0;
  let staleExecutions = 0;
  let truncatedTails = 0;
  const failureReasons: Array<{ executionId: string; reason: string }> = [];
  const executionIds = executionDirectories(stateRoot);

  for (const executionId of executionIds) {
    const journalPath = join(stateRoot, "executions", executionId, "state-events.ndjson");
    const loaded = loadSingleExecutionJournal(journalPath, executionId);

    if (loaded.kind === "load-error") {
      const reason = stableLoadReason(loaded.error);
      projector.invalidateExecution(executionId, reason);
      failureReasons.push({ executionId, reason });
      staleExecutions += 1;
      continue;
    }

    if (loaded.events.length === 0) {
      const reason = "EMPTY_JOURNAL";
      projector.invalidateExecution(executionId, reason);
      failureReasons.push({ executionId, reason });
      staleExecutions += 1;
      continue;
    }

    let replay: ReturnType<typeof replaySteps>;
    try {
      replay = replaySteps(loaded.events);
    } catch (error) {
      const reason = stableReplayReason(error);
      projector.invalidateExecution(executionId, reason);
      failureReasons.push({ executionId, reason });
      staleExecutions += 1;
      continue;
    }

    const finalEvent = replay.steps[replay.steps.length - 1]?.event;
    if (finalEvent === undefined) {
      const reason = "EMPTY_JOURNAL";
      projector.invalidateExecution(executionId, reason);
      failureReasons.push({ executionId, reason });
      staleExecutions += 1;
      continue;
    }

    const isTruncated = loaded.tailStatus === "TRUNCATED_TAIL";
    if (!isTruncated && isCurrent(projector, database, executionId, replay, finalEvent)) {
      currentExecutions += 1;
      continue;
    }

    try {
      projector.replaceExecution(
        executionId,
        replay.steps,
        isTruncated ? { staleReason: TRUNCATED_TAIL_REASON } : {},
      );
    } catch (error) {
      const reason = stableReplayReason(error);
      projector.invalidateExecution(executionId, reason);
      failureReasons.push({ executionId, reason });
      staleExecutions += 1;
      continue;
    }

    repairedExecutions += 1;
    if (isTruncated) {
      truncatedTails += 1;
      staleExecutions += 1;
      failureReasons.push({ executionId, reason: TRUNCATED_TAIL_REASON });
    }
  }

  database.setMeta("backfill_status", "complete");
  database.setMeta("backfill_at", String(nowMs));

  return {
    scannedExecutions: executionIds.length,
    repairedExecutions,
    currentExecutions,
    staleExecutions,
    truncatedTails,
    failureReasons,
  };
}
