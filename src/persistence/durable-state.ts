import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export class DurableStateError extends Error {
  readonly code: "READ_FAILED" | "WRITE_FAILED" | "INVALID_JSON";
  override readonly cause?: unknown;

  constructor(
    code: DurableStateError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "DurableStateError";
    this.code = code;
    this.cause = cause;
  }
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function appendJsonLine(path: string, value: unknown): void {
  try {
    ensureParent(path);
    const descriptor = openSync(path, "a");
    try {
      const line = `${JSON.stringify(value)}\n`;
      appendFileSync(descriptor, line, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    throw new DurableStateError("WRITE_FAILED", `cannot append durable state: ${path}`, error);
  }
}

export function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new DurableStateError("READ_FAILED", `cannot read durable state: ${path}`, error);
  }

  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const values: T[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch (error) {
      throw new DurableStateError(
        "INVALID_JSON",
        `invalid JSONL at ${path}:${index + 1}`,
        error,
      );
    }
  }
  return values;
}

export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new DurableStateError("INVALID_JSON", `invalid JSON file: ${path}`, error);
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  try {
    ensureParent(path);
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    throw new DurableStateError("WRITE_FAILED", `cannot atomically write durable state: ${path}`, error);
  }
}
