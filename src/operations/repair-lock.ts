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

interface RepairReclaimGuardRecord {
  readonly schema_version: "g2m.repair-lock-reclaim.v1";
  readonly guard_id: string;
  readonly operation_id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly created_at: number;
  readonly heartbeat_at: number;
}

interface RepairReclaimGuardHandle {
  readonly record: RepairReclaimGuardRecord;
  readonly raw: string;
  readonly file: Awaited<ReturnType<typeof open>>;
}

const DEFAULT_RECLAIM_GUARD_STALE_MS = 30_000;

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
    typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.hostname !== "string" || value.hostname.length === 0 ||
    typeof value.created_at !== "number" || !Number.isSafeInteger(value.created_at) || typeof value.heartbeat_at !== "number" || !Number.isSafeInteger(value.heartbeat_at)
  ) throw new Error("malformed repair lock");
  return value as unknown as RepairLockRecord;
}

function parseReclaimGuardRecord(raw: string): RepairReclaimGuardRecord {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const keys = Object.keys(value).sort().join("|");
  if (keys !== ["created_at", "guard_id", "heartbeat_at", "hostname", "operation_id", "pid", "schema_version"].join("|")) {
    throw new Error("malformed repair reclaim guard");
  }
  if (
    value.schema_version !== "g2m.repair-lock-reclaim.v1" ||
    typeof value.guard_id !== "string" || value.guard_id.length === 0 ||
    typeof value.operation_id !== "string" || value.operation_id.length === 0 ||
    typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
    typeof value.hostname !== "string" || value.hostname.length === 0 ||
    typeof value.created_at !== "number" || !Number.isSafeInteger(value.created_at) ||
    typeof value.heartbeat_at !== "number" || !Number.isSafeInteger(value.heartbeat_at)
  ) throw new Error("malformed repair reclaim guard");
  return value as unknown as RepairReclaimGuardRecord;
}

async function readRecord(path: string): Promise<{ readonly record: RepairLockRecord; readonly raw: string }> {
  const raw = await readFile(path, "utf8");
  return { record: parseRecord(raw), raw };
}

async function readReclaimGuard(path: string): Promise<{ readonly record: RepairReclaimGuardRecord; readonly raw: string }> {
  const raw = await readFile(path, "utf8");
  return { record: parseReclaimGuardRecord(raw), raw };
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

async function writeReclaimGuard(path: string, record: RepairReclaimGuardRecord): Promise<RepairReclaimGuardHandle> {
  const file = await open(path, "wx");
  const raw = `${JSON.stringify(record)}\n`;
  try {
    await file.writeFile(raw, "utf8");
    await file.sync();
    return { file, record, raw };
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

function reclaimAge(nowMs: number, heartbeatAt: number): number {
  return Math.max(0, nowMs - heartbeatAt);
}

function assertRepairOwnerReclaimable(
  path: string,
  record: RepairLockRecord,
  options: { readonly staleAfterMs: number; readonly dependencies: RepairLockDependencies },
): void {
  if (record.hostname !== options.dependencies.hostname()) throw new RepairLockBusyError(path, "FOREIGN_HOST");
  const pidStatus = options.dependencies.pidProbe(record.pid);
  if (pidStatus === "ALIVE") throw new RepairLockBusyError(path, "LIVE");
  if (pidStatus === "UNKNOWN") throw new RepairLockBusyError(path, "UNKNOWN");
  if (reclaimAge(options.dependencies.now(), record.heartbeat_at) <= options.staleAfterMs) throw new RepairLockBusyError(path, "STALE");
}

async function removeGuardIfUnchanged(
  path: string,
  expected: { readonly record: RepairReclaimGuardRecord; readonly raw: string },
): Promise<boolean> {
  let current: { readonly record: RepairReclaimGuardRecord; readonly raw: string };
  try { current = await readReclaimGuard(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw new RepairLockBusyError(path, "MALFORMED");
  }
  if (current.raw !== expected.raw || current.record.guard_id !== expected.record.guard_id) return false;
  const confirmation = await readReclaimGuard(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RepairLockBusyError(path, "MALFORMED");
  });
  if (confirmation === undefined) return true;
  if (confirmation.raw !== expected.raw || confirmation.record.guard_id !== expected.record.guard_id) return false;
  try {
    await rm(path, { force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

async function acquireReclaimGuard(
  path: string,
  operationId: string,
  options: { readonly reclaimGuardStaleMs: number; readonly dependencies: RepairLockDependencies },
): Promise<RepairReclaimGuardHandle> {
  while (true) {
    const nowMs = options.dependencies.now();
    const record: RepairReclaimGuardRecord = {
      schema_version: "g2m.repair-lock-reclaim.v1",
      guard_id: randomUUID(),
      operation_id: operationId,
      pid: process.pid,
      hostname: options.dependencies.hostname(),
      created_at: nowMs,
      heartbeat_at: nowMs,
    };
    try {
      return await writeReclaimGuard(path, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let existing: { readonly record: RepairReclaimGuardRecord; readonly raw: string };
    try { existing = await readReclaimGuard(path); }
    catch { throw new RepairLockBusyError(path, "MALFORMED"); }
    if (existing.record.hostname !== options.dependencies.hostname()) throw new RepairLockBusyError(path, "FOREIGN_HOST");
    const pidStatus = options.dependencies.pidProbe(existing.record.pid);
    if (pidStatus === "ALIVE") throw new RepairLockBusyError(path, "LIVE");
    if (pidStatus === "UNKNOWN") throw new RepairLockBusyError(path, "UNKNOWN");
    if (reclaimAge(options.dependencies.now(), existing.record.heartbeat_at) <= options.reclaimGuardStaleMs) throw new RepairLockBusyError(path, "STALE");
    if (await removeGuardIfUnchanged(path, existing)) continue;
  }
}

async function releaseReclaimGuard(path: string, guard: RepairReclaimGuardHandle): Promise<void> {
  await guard.file.close().catch(() => undefined);
  const current = await readReclaimGuard(path).catch(() => undefined);
  if (current?.raw === guard.raw && current.record.guard_id === guard.record.guard_id) {
    await rm(path, { force: false }).catch(() => undefined);
  }
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
  options: {
    readonly staleAfterMs: number;
    readonly reclaimGuardStaleMs: number;
    readonly operationId: string;
    readonly dependencies: RepairLockDependencies;
  },
): Promise<boolean> {
  assertRepairOwnerReclaimable(path, initial.record, options);
  const guardPath = join(stateRoot, "repair", "repair.lock.reclaim");
  const guard = await acquireReclaimGuard(guardPath, options.operationId, options);
  try {
    const current = await readRecord(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RepairLockBusyError(path, "MALFORMED");
    });
    if (current === undefined) return true;
    if (current.raw !== initial.raw) return false;
    assertRepairOwnerReclaimable(path, current.record, options);
    const confirmation = await readRecord(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RepairLockBusyError(path, "MALFORMED");
    });
    if (confirmation === undefined) return true;
    if (confirmation.raw !== current.raw) return false;
    await rm(path, { force: false }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return true;
  } finally { await releaseReclaimGuard(guardPath, guard); }
}

export async function acquireRepairLock(
  stateRoot: string,
  options: {
    readonly operationId: string;
    readonly nowMs?: number;
    readonly heartbeatIntervalMs?: number;
    readonly staleAfterMs?: number;
    readonly reclaimGuardStaleMs?: number;
    readonly dependencies?: Partial<RepairLockDependencies>;
  },
): Promise<RepairLockHandle> {
  const directory = join(stateRoot, "repair");
  const path = join(directory, "repair.lock");
  const deps = dependencies(options.dependencies, options.nowMs);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const staleAfterMs = options.staleAfterMs ?? Math.max(heartbeatIntervalMs * 3, 15_000);
  const reclaimGuardStaleMs = options.reclaimGuardStaleMs ?? DEFAULT_RECLAIM_GUARD_STALE_MS;
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
      const removed = await reclaimIfSafe(path, stateRoot, existing, { staleAfterMs, reclaimGuardStaleMs, operationId: options.operationId, dependencies: deps });
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
