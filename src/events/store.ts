import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { TaskFingerprint } from "../execution/fingerprint.js";
import { sha256 } from "../protocol/hash.js";
import type {
  EventDomain,
  EventDurability,
  TaskEvent,
  TaskEventPayload,
  TaskEventType,
} from "./events.js";
import { JournalWriter, readJournal } from "./journal.js";

export interface TaskEventInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly type: TaskEventType;
  readonly payload: TaskEventPayload;
  readonly fingerprint?: TaskFingerprint;
  readonly timestampMs?: number;
}

export class EventStoreError extends Error {
  readonly code: "SEQ_MISMATCH" | "PREV_HASH_MISMATCH" | "HASH_MISMATCH" | "PERSISTENCE_FAILED";
  constructor(code: EventStoreError["code"], message: string) {
    super(message);
    this.name = "EventStoreError";
    this.code = code;
  }
}

interface PersistedTaskEvent {
  readonly schema_version: 1;
  readonly event_id: string;
  readonly seq: number;
  readonly timestamp_ms: number;
  readonly task_id: string;
  readonly execution_id: string;
  readonly domain: EventDomain;
  readonly type: TaskEventType;
  readonly durability: Exclude<EventDurability, "DIAGNOSTIC">;
  readonly prev_hash: string | null;
  readonly hash: string;
  readonly fingerprint?: TaskFingerprint;
  readonly payload: TaskEventPayload;
}

function eventHashInput(event: Omit<TaskEvent, "hash">): Omit<PersistedTaskEvent, "hash"> {
  return {
    schema_version: event.schemaVersion,
    event_id: event.eventId,
    seq: event.seq,
    timestamp_ms: event.timestampMs,
    task_id: event.taskId,
    execution_id: event.attemptId,
    domain: event.domain,
    type: event.type,
    durability: event.durability as Exclude<EventDurability, "DIAGNOSTIC">,
    prev_hash: event.prevHash,
    ...(event.fingerprint !== undefined ? { fingerprint: event.fingerprint } : {}),
    payload: event.payload,
  };
}

export function computeEventHash(event: Omit<TaskEvent, "hash">): string {
  return sha256(eventHashInput(event));
}

function persistEvent(event: TaskEvent): PersistedTaskEvent {
  return { ...eventHashInput(event), hash: event.hash };
}

function restoreEvent(event: PersistedTaskEvent): TaskEvent {
  if (event.schema_version !== 1) {
    throw new EventStoreError("PERSISTENCE_FAILED", "unsupported journal schema version");
  }
  return {
    schemaVersion: event.schema_version,
    eventId: event.event_id,
    seq: event.seq,
    timestampMs: event.timestamp_ms,
    taskId: event.task_id,
    attemptId: event.execution_id,
    domain: event.domain,
    type: event.type,
    durability: event.durability,
    prevHash: event.prev_hash,
    hash: event.hash,
    ...(event.fingerprint !== undefined ? { fingerprint: event.fingerprint } : {}),
    payload: event.payload,
  };
}

const CRITICAL_TYPES = new Set<TaskEventType>([
  "task.created",
  "task.validation.failed",
  "agent.spawn.started",
  "agent.spawn.failed",
  "agent.completed",
  "agent.failed",
  "agent.timed_out",
  "agent.cancelled",
  "patch.frozen",
  "verification.completed",
  "verification.skipped",
  "verification.failed",
  "review.requested",
  "review.accept.prepared",
  "patch.applied",
  "review.accept.completed",
  "review.decision.accept",
  "review.decision.revise",
  "review.decision.block",
  "recovery.required",
  "recovery.reconciled",
  "gc.marked",
  "gc.completed",
  "projection.stale",
  "projection.repaired",
]);

function defaultDomain(type: TaskEventType): EventDomain {
  if (type.startsWith("gc.")) return "storage";
  if (type.startsWith("projection.")) return "projection";
  if (type === "recovery.reconciled") return "recovery";
  return "lifecycle";
}

function defaultDurability(type: TaskEventType): Exclude<EventDurability, "DIAGNOSTIC"> {
  return CRITICAL_TYPES.has(type) ? "CRITICAL" : "NORMAL";
}

export interface ChainVerificationResult {
  readonly valid: boolean;
  readonly brokenAtSeq?: number;
  readonly brokenAtEventId?: string;
  readonly reason?: "SEQ_MISMATCH" | "PREV_HASH_MISMATCH" | "HASH_MISMATCH";
}

export interface EventStoreOptions {
  readonly executionDirectory?: string;
  /** @deprecated flat journal layout for internal transition only. */
  readonly logDirectory?: string;
}

export interface JournalRecoveryIssue {
  readonly executionId: string;
  readonly path: string;
  readonly kind: "TRUNCATED_TAIL";
}

export class EventStore {
  private readonly events: TaskEvent[] = [];
  private readonly writers = new Map<string, JournalWriter>();
  private readonly issues: JournalRecoveryIssue[] = [];
  private readonly executionDirectory: string | undefined;
  private readonly logDirectory: string | undefined;

  constructor(options: EventStoreOptions = {}) {
    if (options.executionDirectory !== undefined && options.logDirectory !== undefined) {
      throw new EventStoreError("PERSISTENCE_FAILED", "choose one journal directory layout");
    }
    this.executionDirectory = options.executionDirectory;
    this.logDirectory = options.logDirectory;
    if (this.executionDirectory !== undefined) this.loadExecutionJournals();
    if (this.logDirectory !== undefined) this.loadLegacyJournals();
  }

  private loadExecutionJournals(): void {
    const root = this.executionDirectory;
    if (root === undefined) return;
    mkdirSync(root, { recursive: true });
    for (const entry of readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory())) {
      this.loadJournal(entry.name, join(root, entry.name, "state-events.ndjson"));
    }
  }

  private loadLegacyJournals(): void {
    const root = this.logDirectory;
    if (root === undefined) return;
    mkdirSync(root, { recursive: true });
    for (const file of readdirSync(root).filter((item) => item.endsWith(".jsonl")).sort()) {
      this.loadJournal(decodeURIComponent(file.slice(0, -".jsonl".length)), join(root, file));
    }
  }

  private loadJournal(executionId: string, path: string): void {
    const loaded = readJournal<PersistedTaskEvent>(path);
    const events = loaded.records.map(restoreEvent);
    if (events.some((event) => event.attemptId !== executionId)) {
      throw new EventStoreError(
        "PERSISTENCE_FAILED",
        `journal execution binding does not match its directory: ${path}`,
      );
    }
    const verification = verifyChain(events);
    if (!verification.valid) {
      throw new EventStoreError(
        "PERSISTENCE_FAILED",
        `event log chain is invalid in ${path} at sequence ${verification.brokenAtSeq ?? "unknown"}`,
      );
    }
    this.events.push(...events);
    if (loaded.tailStatus === "TRUNCATED_TAIL") {
      this.issues.push({ executionId, path, kind: "TRUNCATED_TAIL" });
    }
  }

  append(input: TaskEventInput): TaskEvent {
    if (this.issues.some((issue) => issue.executionId === input.attemptId)) {
      throw new EventStoreError(
        "PERSISTENCE_FAILED",
        `cannot append to execution ${input.attemptId}: journal has TRUNCATED_TAIL`,
      );
    }
    const attemptEvents = this.events.filter((event) => event.attemptId === input.attemptId);
    const prev = attemptEvents[attemptEvents.length - 1];
    const partial: Omit<TaskEvent, "hash"> = {
      schemaVersion: 1,
      eventId: randomUUID(),
      seq: prev ? prev.seq + 1 : 1,
      prevHash: prev ? prev.hash : null,
      timestampMs: input.timestampMs ?? Date.now(),
      taskId: input.taskId,
      attemptId: input.attemptId,
      domain: defaultDomain(input.type),
      type: input.type,
      durability: defaultDurability(input.type),
      payload: input.payload,
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
    };
    const event: TaskEvent = { ...partial, hash: computeEventHash(partial) };
    const writer = this.writerFor(input.attemptId);
    writer?.append(persistEvent(event), event.durability as Exclude<EventDurability, "DIAGNOSTIC">);
    this.events.push(event);
    return event;
  }

  private writerFor(executionId: string): JournalWriter | undefined {
    if (this.executionDirectory === undefined && this.logDirectory === undefined) return undefined;
    const existing = this.writers.get(executionId);
    if (existing !== undefined) return existing;
    const path = this.executionDirectory !== undefined
      ? join(this.executionDirectory, executionId, "state-events.ndjson")
      : join(this.logDirectory as string, `${encodeURIComponent(executionId)}.jsonl`);
    const writer = new JournalWriter(path);
    this.writers.set(executionId, writer);
    return writer;
  }

  flush(): void { for (const writer of this.writers.values()) writer.flush(); }

  close(): void {
    for (const writer of this.writers.values()) writer.close();
    this.writers.clear();
  }

  recoveryIssues(): readonly JournalRecoveryIssue[] { return this.issues.slice(); }
  list(): readonly TaskEvent[] { return this.events.slice(); }
  getByEventId(eventId: string): TaskEvent | undefined { return this.events.find((e) => e.eventId === eventId); }
  getByTaskId(taskId: string): readonly TaskEvent[] { return this.events.filter((e) => e.taskId === taskId); }
  getByAttemptId(attemptId: string): readonly TaskEvent[] { return this.events.filter((e) => e.attemptId === attemptId); }
  size(): number { return this.events.length; }
}

export function verifyChain(events: readonly TaskEvent[]): ChainVerificationResult {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    const expectedSeq = index + 1;
    if (event.seq !== expectedSeq) {
      return { valid: false, brokenAtSeq: event.seq, brokenAtEventId: event.eventId, reason: "SEQ_MISMATCH" };
    }
    const expectedPrev = index === 0 ? null : events[index - 1]?.hash ?? null;
    if (event.prevHash !== expectedPrev) {
      return { valid: false, brokenAtSeq: event.seq, brokenAtEventId: event.eventId, reason: "PREV_HASH_MISMATCH" };
    }
    if (computeEventHash(event) !== event.hash) {
      return { valid: false, brokenAtSeq: event.seq, brokenAtEventId: event.eventId, reason: "HASH_MISMATCH" };
    }
  }
  return { valid: true };
}
