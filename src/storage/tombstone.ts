import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { isTerminal, type TaskState } from "../execution/state-machine.js";
import { writeImmutableArtifact } from "../persistence/artifact-writer.js";

export interface TombstoneInput {
  readonly executionId: string;
  readonly taskId: string;
  readonly workspaceId: string | null;
  readonly finalState: TaskState;
  readonly createdAt: number;
  readonly terminalAt: number;
  readonly retentionClass: string;
  readonly gcMarkedEventId: string;
  readonly gcMarkedEventHash: string;
  readonly gcCompletedAt: number;
  readonly artifactBytesBeforeGc: number;
  readonly worktreeBytesBeforeGc: number;
}

export interface Tombstone extends TombstoneInput {
  readonly schemaVersion: 1;
  readonly selfHash: string;
}

export type TombstoneErrorCode = "TOMBSTONE_INVALID" | "TOMBSTONE_IO" | "GC_PATH_UNSAFE";

export class TombstoneError extends Error {
  override readonly cause?: unknown;

  constructor(readonly code: TombstoneErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "TombstoneError";
    if (cause !== undefined) this.cause = cause;
  }
}

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`).join(",")}}`;
}

function diskInput(input: TombstoneInput): JsonObject {
  return {
    schema_version: 1,
    execution_id: input.executionId,
    task_id: input.taskId,
    workspace_id: input.workspaceId,
    final_state: input.finalState,
    created_at: input.createdAt,
    terminal_at: input.terminalAt,
    retention_class: input.retentionClass,
    gc_marked_event_id: input.gcMarkedEventId,
    gc_marked_event_hash: input.gcMarkedEventHash,
    gc_completed_at: input.gcCompletedAt,
    artifact_bytes_before_gc: input.artifactBytesBeforeGc,
    worktree_bytes_before_gc: input.worktreeBytesBeforeGc,
  };
}

export function computeTombstoneHash(input: TombstoneInput): string {
  // Importing the shared hash helper would accept arbitrary JSON formatting;
  // tombstones deliberately use a stable key order so the hash survives a
  // Journal removal and can be checked by a future projection rebuild.
  return createHash("sha256").update(canonicalize(diskInput(input)), "utf8").digest("hex");
}

export function prepareTombstone(input: TombstoneInput): Tombstone {
  if (input.executionId.length === 0 || input.executionId.includes("/") || input.executionId.includes("\\")) {
    throw new TombstoneError("TOMBSTONE_INVALID", "tombstone execution id is not a safe path component");
  }
  if (!isTerminal(input.finalState) || !["NORMAL", "RETAINED", "RECOVERY_CRITICAL"].includes(input.retentionClass)) {
    throw new TombstoneError("TOMBSTONE_INVALID", "tombstone state or retention class is invalid");
  }
  return Object.freeze({ ...input, schemaVersion: 1, selfHash: computeTombstoneHash(input) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseTombstone(raw: unknown): Tombstone {
  if (!isRecord(raw)) throw new TombstoneError("TOMBSTONE_INVALID", "tombstone must be an object");
  const keys = [
    "schema_version", "execution_id", "task_id", "workspace_id", "final_state",
    "created_at", "terminal_at", "retention_class", "gc_marked_event_id",
    "gc_marked_event_hash", "gc_completed_at", "artifact_bytes_before_gc",
    "worktree_bytes_before_gc", "self_hash",
  ].sort();
  if (Object.keys(raw).sort().join("\0") !== keys.join("\0")) {
    throw new TombstoneError("TOMBSTONE_INVALID", "tombstone schema keys are invalid");
  }
  const strings = [
    "execution_id", "task_id", "final_state", "retention_class",
    "gc_marked_event_id", "gc_marked_event_hash", "self_hash",
  ];
  if (strings.some((key) => typeof raw[key] !== "string" || (raw[key] as string).length === 0)) {
    throw new TombstoneError("TOMBSTONE_INVALID", "tombstone string fields are invalid");
  }
  if (raw.workspace_id !== null && typeof raw.workspace_id !== "string") {
    throw new TombstoneError("TOMBSTONE_INVALID", "tombstone.workspace_id must be string or null");
  }
  for (const key of [
    "created_at", "terminal_at", "gc_completed_at", "artifact_bytes_before_gc", "worktree_bytes_before_gc",
  ]) {
    if (!nonNegativeInteger(raw[key])) throw new TombstoneError("TOMBSTONE_INVALID", `tombstone.${key} must be a non-negative integer`);
  }
  if (raw.schema_version !== 1 || !/^[0-9a-f]{64}$/i.test(raw.self_hash as string)) {
    throw new TombstoneError("TOMBSTONE_INVALID", "tombstone version or self_hash is invalid");
  }
  if (!isTerminal(raw.final_state as TaskState) || !["NORMAL", "RETAINED", "RECOVERY_CRITICAL"].includes(raw.retention_class as string)) {
    throw new TombstoneError("TOMBSTONE_INVALID", "tombstone state or retention class is invalid");
  }
  const input: TombstoneInput = {
    executionId: raw.execution_id as string,
    taskId: raw.task_id as string,
    workspaceId: raw.workspace_id as string | null,
    finalState: raw.final_state as TaskState,
    createdAt: raw.created_at as number,
    terminalAt: raw.terminal_at as number,
    retentionClass: raw.retention_class as string,
    gcMarkedEventId: raw.gc_marked_event_id as string,
    gcMarkedEventHash: raw.gc_marked_event_hash as string,
    gcCompletedAt: raw.gc_completed_at as number,
    artifactBytesBeforeGc: raw.artifact_bytes_before_gc as number,
    worktreeBytesBeforeGc: raw.worktree_bytes_before_gc as number,
  };
  if (computeTombstoneHash(input) !== raw.self_hash) {
    throw new TombstoneError("TOMBSTONE_INVALID", "tombstone self_hash does not match its content");
  }
  return Object.freeze({ ...input, schemaVersion: 1, selfHash: raw.self_hash as string });
}

export async function readTombstone(path: string): Promise<Tombstone | undefined> {
  try {
    return parseTombstone(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof TombstoneError) throw error;
    throw new TombstoneError("TOMBSTONE_IO", `cannot read tombstone: ${path}`, error);
  }
}

export function readTombstoneSync(path: string): Tombstone | undefined {
  try {
    return parseTombstone(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof TombstoneError) throw error;
    throw new TombstoneError("TOMBSTONE_IO", `cannot read tombstone: ${path}`, error);
  }
}

export async function writeTombstone(path: string, input: TombstoneInput): Promise<Tombstone> {
  return writePreparedTombstone(path, prepareTombstone(input));
}

export async function writePreparedTombstone(path: string, prepared: Tombstone): Promise<Tombstone> {
  const existing = await readTombstone(path);
  if (existing !== undefined) {
    if (existing.selfHash !== prepared.selfHash) {
      throw new TombstoneError("TOMBSTONE_INVALID", `existing tombstone conflicts with requested content: ${path}`);
    }
    return existing;
  }
  const bytes = Buffer.from(`${JSON.stringify({ ...diskInput(prepared), self_hash: prepared.selfHash }, null, 2)}\n`, "utf8");
  try {
    await writeImmutableArtifact(path, bytes);
  } catch (error) {
    if (error instanceof Error && /already exists/.test(error.message)) {
      const raced = await readTombstone(path);
      if (raced !== undefined) return raced;
    }
    throw new TombstoneError("TOMBSTONE_IO", `cannot write tombstone: ${path}`, error);
  }
  const written = await readTombstone(path);
  if (written === undefined) throw new TombstoneError("TOMBSTONE_IO", `tombstone disappeared after write: ${path}`);
  if (written.selfHash !== prepared.selfHash) throw new TombstoneError("TOMBSTONE_INVALID", `tombstone hash changed after write: ${path}`);
  return written;
}

export function assertDirectChild(root: string, candidate: string): string {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    throw new TombstoneError("GC_PATH_UNSAFE", "path is not a safe direct child");
  }
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const child = relative(resolvedRoot, resolvedCandidate);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child) || child.includes(sep)) {
    throw new TombstoneError("GC_PATH_UNSAFE", `path must be the execution direct child of ${resolvedRoot}`);
  }
  return resolvedCandidate;
}

export function assertDirectExecutionChild(root: string, candidate: string, executionId: string): string {
  if (executionId.length === 0 || executionId.includes("/") || executionId.includes("\\")) {
    throw new TombstoneError("GC_PATH_UNSAFE", "execution id is not a safe path component");
  }
  const resolvedCandidate = assertDirectChild(root, candidate);
  if (relative(resolve(root), resolvedCandidate) !== executionId) {
    throw new TombstoneError("GC_PATH_UNSAFE", "path is not bound to this execution");
  }
  return resolvedCandidate;
}

export async function assertSafeDeletionTarget(path: string): Promise<"MISSING" | "DIRECTORY"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TombstoneError("GC_PATH_UNSAFE", `deletion target is not an ordinary directory: ${path}`);
    }
    return "DIRECTORY";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "MISSING";
    if (error instanceof TombstoneError) throw error;
    throw new TombstoneError("GC_PATH_UNSAFE", `cannot inspect deletion target: ${path}`, error);
  }
}

export function assertSafeDeletionTargetSync(path: string): "MISSING" | "DIRECTORY" {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TombstoneError("GC_PATH_UNSAFE", `deletion target is not an ordinary directory: ${path}`);
    }
    return "DIRECTORY";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "MISSING";
    if (error instanceof TombstoneError) throw error;
    throw new TombstoneError("GC_PATH_UNSAFE", `cannot inspect deletion target: ${path}`, error);
  }
}
