import { randomUUID as nodeRandomUUID } from "node:crypto";
import { hostname as nodeHostname } from "node:os";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PidStatus } from "../workspace/lock.js";

export interface GcLockMetadata {
  readonly lock_version: 1;
  readonly gc_run_id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly created_at: number;
  readonly heartbeat_at: number;
}

export interface GcLockDependencies {
  readonly now: () => number;
  readonly hostname: () => string;
  readonly pid: number;
  readonly randomUUID: () => string;
  readonly pidProbe: (pid: number) => PidStatus;
}

export interface GcRunLockOptions {
  readonly stateRoot: string;
  readonly staleAfterMs?: number;
  readonly dependencies?: Partial<GcLockDependencies>;
}

export interface GcRunLockHandle {
  readonly path: string;
  readonly runId: string;
  readonly metadata: GcLockMetadata;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export type GcLockErrorCode = "GC_LOCK_BUSY" | "GC_LOCK_INVALID" | "GC_LOCK_STALE_HANDLE" | "GC_LOCK_IO";

export class GcLockError extends Error {
  override readonly cause?: unknown;

  constructor(readonly code: GcLockErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "GcLockError";
    if (cause !== undefined) this.cause = cause;
  }
}

const LOCK_FILE = "gc.lock";
const TRANSIENT_READ_RETRIES = 5;
const TRANSIENT_READ_DELAY_MS = 10;

function defaults(overrides: Partial<GcLockDependencies> | undefined): GcLockDependencies {
  return {
    now: Date.now,
    hostname: nodeHostname,
    pid: process.pid,
    randomUUID: nodeRandomUUID,
    pidProbe: (pid) => {
      try {
        process.kill(pid, 0);
        return "ALIVE";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ESRCH" ? "DEAD" : code === "EPERM" ? "ALIVE" : "UNKNOWN";
      }
    },
    ...overrides,
  };
}

function parseMetadata(raw: string): GcLockMetadata {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(value).sort().join("|");
    if (keys !== ["created_at", "gc_run_id", "heartbeat_at", "hostname", "lock_version", "pid"].join("|")) throw new Error("keys");
    if (
      value.lock_version !== 1 ||
      typeof value.gc_run_id !== "string" || value.gc_run_id.length === 0 ||
      typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.hostname !== "string" || value.hostname.length === 0 ||
      typeof value.created_at !== "number" || !Number.isSafeInteger(value.created_at) ||
      typeof value.heartbeat_at !== "number" || !Number.isSafeInteger(value.heartbeat_at)
    ) throw new Error("fields");
    return value as unknown as GcLockMetadata;
  } catch (error) {
    throw new GcLockError("GC_LOCK_INVALID", "GC lock metadata is malformed", error);
  }
}

async function readExisting(path: string): Promise<{ readonly raw: string; readonly metadata: GcLockMetadata } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return { raw, metadata: parseMetadata(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof GcLockError) throw error;
    throw new GcLockError("GC_LOCK_IO", "cannot read GC lock", error);
  }
}

async function readExistingAfterCreateRace(path: string): Promise<{ readonly raw: string; readonly metadata: GcLockMetadata } | undefined> {
  let lastInvalid: GcLockError | undefined;
  for (let attempt = 0; attempt < TRANSIENT_READ_RETRIES; attempt += 1) {
    try {
      return await readExisting(path);
    } catch (error) {
      if (!(error instanceof GcLockError) || error.code !== "GC_LOCK_INVALID") throw error;
      lastInvalid = error;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_READ_DELAY_MS));
    }
  }
  throw lastInvalid;
}

async function writeNew(path: string, metadata: GcLockMetadata): Promise<boolean> {
  try {
    const file = await open(path, "wx");
    try {
      await file.writeFile(JSON.stringify(metadata) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new GcLockError("GC_LOCK_IO", "cannot create GC lock", error);
  }
}

function stale(metadata: GcLockMetadata, deps: GcLockDependencies, staleAfterMs: number): boolean {
  return metadata.hostname === deps.hostname() &&
    deps.pidProbe(metadata.pid) === "DEAD" &&
    Math.max(0, deps.now() - metadata.heartbeat_at) > staleAfterMs;
}

async function updateOwned(path: string, current: GcLockMetadata, deps: GcLockDependencies): Promise<GcLockMetadata> {
  const existing = await readExisting(path);
  if (existing === undefined || existing.metadata.gc_run_id !== current.gc_run_id || existing.metadata.pid !== current.pid || existing.metadata.hostname !== current.hostname) {
    throw new GcLockError("GC_LOCK_STALE_HANDLE", "GC lock is no longer owned by this handle");
  }
  const next = { ...current, heartbeat_at: deps.now() };
  const temporary = path + "." + deps.pid + ".heartbeat.tmp";
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(JSON.stringify(next) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof GcLockError) throw error;
    throw new GcLockError("GC_LOCK_IO", "cannot heartbeat GC lock", error);
  }
  return next;
}

export async function acquireGcRunLock(options: GcRunLockOptions): Promise<GcRunLockHandle> {
  const deps = defaults(options.dependencies);
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) throw new GcLockError("GC_LOCK_INVALID", "staleAfterMs must be positive");
  const path = join(options.stateRoot, "gc", LOCK_FILE);
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const metadata: GcLockMetadata = {
      lock_version: 1,
      gc_run_id: deps.randomUUID(),
      pid: deps.pid,
      hostname: deps.hostname(),
      created_at: deps.now(),
      heartbeat_at: deps.now(),
    };
    if (await writeNew(path, metadata)) {
      let current = metadata;
      return {
        path,
        runId: metadata.gc_run_id,
        get metadata() { return current; },
        async heartbeat() { current = await updateOwned(path, current, deps); },
        async release() {
          const existing = await readExisting(path);
          if (existing === undefined) return;
          if (existing.metadata.gc_run_id !== current.gc_run_id || existing.metadata.pid !== current.pid || existing.metadata.hostname !== current.hostname) {
            throw new GcLockError("GC_LOCK_STALE_HANDLE", "GC lock is no longer owned by this handle");
          }
          await rm(path, { force: true });
        },
      };
    }
    const existing = await readExistingAfterCreateRace(path);
    if (existing === undefined) continue;
    if (!stale(existing.metadata, deps, staleAfterMs)) {
      throw new GcLockError("GC_LOCK_BUSY", "another GC mutation is in progress");
    }
    const confirmation = await readExisting(path);
    if (confirmation === undefined || confirmation.raw !== existing.raw) continue;
    await rm(path, { force: true });
  }
  throw new GcLockError("GC_LOCK_BUSY", "GC lock changed while reclaiming a stale owner");
}
