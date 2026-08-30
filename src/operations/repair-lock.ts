import { randomUUID } from "node:crypto";
import { hostname as nodeHostname } from "node:os";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export type RepairPidStatus = "ALIVE" | "DEAD" | "UNKNOWN";

export interface RepairLockDependencies {
  readonly now: () => number;
  readonly hostname: () => string;
  readonly pidProbe: (pid: number) => RepairPidStatus;
}

export class RepairLockBusyError extends Error {
  constructor(readonly path: string, readonly reason: "LIVE" | "UNKNOWN" | "FOREIGN_HOST" | "STALE" | "MALFORMED" = "LIVE") {
    super(`another repair operation owns ${path} (${reason.toLowerCase()})`);
    this.name = "RepairLockBusyError";
  }
}

export class RepairLockOwnershipError extends Error {
  constructor(readonly path: string) {
    super(`repair lock ownership changed: ${path}`);
    this.name = "RepairLockOwnershipError";
  }
}

export interface RepairLockHandle {
  readonly path: string;
  readonly operationId: string;
  refresh(): Promise<void>;
  release(): Promise<void>;
}

interface RepairLockRecord {
  readonly schema_version: "g2m.repair-lock.v1";
  readonly operation_id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly created_at: number;
  readonly heartbeat_at: number;
}

function defaultPidProbe(pid: number): RepairPidStatus {
  if (!Number.isInteger(pid) || pid <= 0) return "UNKNOWN";
  if (pid === process.pid) return "ALIVE";
  try { process.kill(pid, 0); return "ALIVE"; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "DEAD";
    if (code === "EPERM") return "ALIVE";
    return "UNKNOWN";
  }
}

function dependencies(input: Partial<RepairLockDependencies> | undefined, nowMs: number | undefined): RepairLockDependencies {
  return {
    now: input?.now ?? (() => nowMs ?? Date.now()),
    hostname: input?.hostname ?? nodeHostname,
    pidProbe: input?.pidProbe ?? defaultPidProbe,
  };
}

function parseRecord(raw: string): RepairLockRecord {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    value.schema_version !== "g2m.repair-lock.v1" || typeof value.operation_id !== "string" || value.operation_id.length === 0 ||
    typeof value.pid !== "number" || !Number.isInteger(value.pid) || typeof value.hostname !== "string" || value.hostname.length === 0 ||
    typeof value.created_at !== "number" || !Number.isFinite(value.created_at) || typeof value.heartbeat_at !== "number" || !Number.isFinite(value.heartbeat_at)
  ) throw new Error("malformed repair lock");
  return value as unknown as RepairLockRecord;
}

async function readRecord(path: string): Promise<{ readonly record: RepairLockRecord; readonly raw: string }> {
  const raw = await readFile(path, "utf8");
  return { record: parseRecord(raw), raw };
}

async function writeNew(path: string, record: RepairLockRecord): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function replaceRecord(path: string, record: RepairLockRecord, expectedOperationId: string): Promise<void> {
  const current = await readRecord(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RepairLockOwnershipError(path);
    throw error;
  });
  if (current.record.operation_id !== expectedOperationId) throw new RepairLockOwnershipError(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeNew(temporary, record);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function reclaimIfSafe(
  path: string,
  stateRoot: string,
  initial: { readonly record: RepairLockRecord; readonly raw: string },
  options: { readonly staleAfterMs: number; readonly dependencies: RepairLockDependencies },
): Promise<boolean> {
  if (initial.record.hostname !== options.dependencies.hostname()) throw new RepairLockBusyError(path, "FOREIGN_HOST");
  const pidStatus = options.dependencies.pidProbe(initial.record.pid);
  if (pidStatus === "ALIVE") throw new RepairLockBusyError(path, "LIVE");
  if (pidStatus === "UNKNOWN") throw new RepairLockBusyError(path, "UNKNOWN");
  if (options.dependencies.now() - initial.record.heartbeat_at <= options.staleAfterMs) throw new RepairLockBusyError(path, "STALE");
  const guardPath = join(stateRoot, "repair", "repair.lock.reclaim");
  let guard;
  try { guard = await open(guardPath, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RepairLockBusyError(path, "STALE");
    throw error;
  }
  try {
    const current = await readRecord(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (current === undefined) return true;
    if (current.raw !== initial.raw) return false;
    await rm(path, { force: false });
    return true;
  } finally {
    await guard.close().catch(() => undefined);
    await rm(guardPath, { force: true }).catch(() => undefined);
  }
}

export async function acquireRepairLock(
  stateRoot: string,
  options: {
    readonly operationId: string;
    readonly nowMs?: number;
    readonly heartbeatIntervalMs?: number;
    readonly staleAfterMs?: number;
    readonly dependencies?: Partial<RepairLockDependencies>;
  },
): Promise<RepairLockHandle> {
  const directory = join(stateRoot, "repair");
  const path = join(directory, "repair.lock");
  const deps = dependencies(options.dependencies, options.nowMs);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const staleAfterMs = options.staleAfterMs ?? Math.max(heartbeatIntervalMs * 3, 15_000);
  await mkdir(directory, { recursive: true });
  const record: RepairLockRecord = {
    schema_version: "g2m.repair-lock.v1",
    operation_id: options.operationId,
    pid: process.pid,
    hostname: deps.hostname(),
    created_at: deps.now(),
    heartbeat_at: deps.now(),
  };
  while (true) {
    try {
      await writeNew(path, record);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: { readonly record: RepairLockRecord; readonly raw: string };
      try { existing = await readRecord(path); }
      catch { throw new RepairLockBusyError(path, "MALFORMED"); }
      const removed = await reclaimIfSafe(path, stateRoot, existing, { staleAfterMs, dependencies: deps });
      if (!removed) continue;
    }
  }
  let released = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const handle: RepairLockHandle = {
    path,
    operationId: options.operationId,
    async refresh(): Promise<void> {
      if (released) return;
      await replaceRecord(path, { ...record, heartbeat_at: deps.now() }, options.operationId);
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (timer !== undefined) clearInterval(timer);
      const current = await readRecord(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        return undefined;
      });
      if (current?.record.operation_id === options.operationId) await rm(path, { force: false });
    },
  };
  timer = setInterval(() => { void handle.refresh().catch(() => undefined); }, heartbeatIntervalMs);
  timer.unref?.();
  return handle;
}

export async function readRepairLock(path: string): Promise<unknown | undefined> {
  try { return parseRecord(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
