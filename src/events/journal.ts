import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { DurableStateError } from "../persistence/durable-state.js";
import type { EventDurability } from "./events.js";

export type JournalTailStatus = "COMPLETE" | "TRUNCATED_TAIL";

export interface JournalReadResult<T> {
  readonly records: readonly T[];
  readonly tailStatus: JournalTailStatus;
}

/** NORMAL records may be queued; CRITICAL creates a durable flush barrier. */
export class JournalWriter {
  private readonly pending: string[] = [];
  private closed = false;
  private failed = false;

  constructor(readonly path: string) {}

  append(value: unknown, durability: Exclude<EventDurability, "DIAGNOSTIC">): void {
    this.assertOpen();
    this.pending.push(`${JSON.stringify(value)}\n`);
    if (durability === "CRITICAL") this.flush();
  }

  flush(): void {
    this.assertOpen();
    if (this.pending.length === 0) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const descriptor = openSync(this.path, "a");
      try {
        appendFileSync(descriptor, this.pending.join(""), "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      this.pending.splice(0);
    } catch (error) {
      this.failed = true;
      throw new DurableStateError("WRITE_FAILED", `cannot flush journal: ${this.path}`, error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DurableStateError("WRITE_FAILED", `journal is closed: ${this.path}`);
    }
    if (this.failed) {
      throw new DurableStateError("WRITE_FAILED", `journal is in an uncertain failed state: ${this.path}`);
    }
  }
}

/** Reads complete NDJSON lines and reports an unterminated crash tail. */
export function readJournal<T>(path: string): JournalReadResult<T> {
  if (!existsSync(path)) return { records: [], tailStatus: "COMPLETE" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new DurableStateError("READ_FAILED", `cannot read journal: ${path}`, error);
  }

  const terminated = raw.length === 0 || raw.endsWith("\n");
  const lines = raw.split("\n");
  lines.pop(); // trailing empty line, or final unterminated record

  const records: T[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.replace(/\r$/, "");
    if (line === undefined || line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (error) {
      throw new DurableStateError(
        "INVALID_JSON",
        `invalid journal JSON at ${path}:${index + 1}`,
        error,
      );
    }
  }

  return { records, tailStatus: terminated ? "COMPLETE" : "TRUNCATED_TAIL" };
}
