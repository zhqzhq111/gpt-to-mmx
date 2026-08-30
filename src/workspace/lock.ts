import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, realpath } from "node:fs/promises";
import { hostname as nodeHostname } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";

export type PidStatus = "ALIVE" | "DEAD" | "UNKNOWN";

export interface WorkspaceLeaseDependencies {
  readonly now: () => number;
  readonly hostname: () => string;
  readonly randomUUID: () => string;
  readonly pidProbe: (pid: number) => PidStatus;
}

export interface WorkspaceLockOptions {
  readonly stateRoot?: string;
  readonly workspacePathResolver?: (workspaceId: string) => string;
  readonly leaseProjection?: WorkspaceLeaseProjection;
  readonly heartbeatIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly incompleteLeaseGraceMs?: number;
  readonly reclaimGuardStaleMs?: number;
  readonly dependencies?: Partial<WorkspaceLeaseDependencies>;
}

export interface AcquireWorkspaceLeaseOptions {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly executionId: string;
}

export interface LockHandle {
  readonly workspaceId: string;
  readonly workspaceKey: string;
  readonly executionId: string;
  readonly leaseId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: number;
  readonly ownerPath: string;
  readonly heartbeatPath: string;
}

export interface ValidLeaseOwner {
  readonly lock_version: 1;
  readonly workspace_key: string;
  readonly workspace_id: string;
  readonly execution_id: string;
  readonly lease_id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly created_at: number;
  readonly heartbeat_at: number;
}

export interface ValidHeartbeat {
  readonly heartbeat_version: 1;
  readonly workspace_key: string;
  readonly lease_id: string;
  readonly heartbeat_at: number;
}

export type LeaseOwnerInspection = ValidLeaseOwner | "MISSING" | "INCOMPLETE" | "MALFORMED";
export type LeaseHeartbeatInspection = ValidHeartbeat | "MISSING" | "MALFORMED" | "LEASE_ID_MISMATCH";

export interface LeaseInspection {
  readonly workspaceKey: string;
  readonly owner: LeaseOwnerInspection;
  readonly heartbeat: LeaseHeartbeatInspection;
  readonly pidStatus?: PidStatus;
  readonly ageMs?: number;
  readonly heartbeatAgeMs?: number;
  readonly ownerFileSha256?: string;
  readonly heartbeatFileSha256?: string;
}

export interface InspectWorkspaceLeaseOptions {
  readonly workspaceKey?: string;
  readonly canonicalPath?: string;
}

export interface WorkspaceLeaseProjection {
  readonly upsert: (owner: ValidLeaseOwner) => void;
  readonly removeIfLeaseMatches: (workspaceId: string, leaseId: string) => void;
}

export type LeaseDisposition =
  | "ACTIVE"
  | "STALE_TERMINAL_RECLAIMABLE"
  | "RECOVERY_CRITICAL"
  | "ACTIVE_EXECUTION_STALE_OWNER"
  | "FOREIGN_HOST"
  | "INCOMPLETE"
  | "MALFORMED"
  | "HEARTBEAT_MISMATCH"
  | "UNKNOWN";

export type LeaseJournalState = "ACTIVE" | "TERMINAL" | "RECOVERY_REQUIRED" | "CORRUPT" | "MISSING";

export interface LeasePolicyInput {
  readonly inspection: LeaseInspection;
  readonly journalState: LeaseJournalState;
  readonly staleAfterMs: number;
  readonly currentHostname: string;
}

export interface ReclaimStaleLeaseOptions {
  readonly workspaceKey: string;
  readonly journalState: LeaseJournalState;
  readonly authorization?: "STARTUP_AUTO" | "EXPLICIT_RECOVERY";
  readonly expectedExecutionId?: string;
}

export type RecoveryLeaseProcessStatus =
  | "alive"
  | "unknown"
  | "exited_clean"
  | "exited_error"
  | "crashed";

export interface RecoveryLeaseTakeoverOptions {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly executionId: string;
  readonly processStatus: RecoveryLeaseProcessStatus;
}

export interface StartupLeaseReconciliationReport {
  readonly reclaimedExecutionIds: readonly string[];
  readonly heldExecutionIds: readonly string[];
}

export type WorkspaceLockErrorCode =
  | "INVALID_INPUT"
  | "WORKSPACE_BUSY"
  | "LEASE_IO_FAILED"
  | "LEASE_INCOMPLETE"
  | "LEASE_MALFORMED"
  | "LEASE_INCONSISTENT"
  | "LEASE_NOT_OWNED"
  | "STALE_HANDLE"
  | "LEASE_LOST"
  | "RECLAIM_BUSY"
  | "RECLAIM_NOT_ALLOWED"
  | "FOREIGN_HOST_LEASE"
  | "INVALID_HANDLE"
  | "NOT_HELD";

export class WorkspaceLockError extends Error {
  override readonly cause?: unknown;
  readonly code: WorkspaceLockErrorCode;

  constructor(code: WorkspaceLockErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "WorkspaceLockError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const OWNER_KEYS = [
  "lock_version", "workspace_key", "workspace_id", "execution_id", "lease_id",
  "pid", "hostname", "created_at", "heartbeat_at",
] as const;
const HEARTBEAT_KEYS = ["heartbeat_version", "workspace_key", "lease_id", "heartbeat_at"] as const;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_INCOMPLETE_GRACE_MS = 30_000;
const DEFAULT_RECLAIM_GUARD_STALE_MS = 30_000;
const DEFAULT_STATE_ROOT = process.env.G2M_STATE_ROOT ?? join(process.cwd(), ".g2m-state");
const MAX_LEASE_FILE_BYTES = 64 * 1024;

function defaultPidProbe(pid: number): PidStatus {
  try {
    process.kill(pid, 0);
    return "ALIVE";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "DEAD";
    if (code === "EPERM") return "ALIVE";
    return "UNKNOWN";
  }
}

function defaultDependencies(): WorkspaceLeaseDependencies {
  return {
    now: () => Date.now(),
    hostname: () => nodeHostname(),
    randomUUID: () => nodeRandomUUID(),
    pidProbe: defaultPidProbe,
  };
}

function isWindowsPath(value: string): boolean {
  return process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export function normalizePhysicalWorkspacePath(realPath: string): string {
  const replaced = realPath.replaceAll("\\", "/");
  if (isWindowsPath(realPath)) {
    const normalized = replaced
      .replace(/^([A-Z]):\/+/, (_, drive: string) => `${drive.toLowerCase()}:/`)
      .replace(/\/+/g, "/")
      .toLowerCase();
    return `win32:${normalized}`;
  }
  const normalized = posix.normalize(replaced);
  return `posix:${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

export async function canonicalizePhysicalWorkspacePath(rawPath: string): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || !isAbsolute(rawPath)) {
    throw new WorkspaceLockError("INVALID_INPUT", "canonicalPath must be an absolute path");
  }
  try {
    return normalizePhysicalWorkspacePath(await realpath(rawPath));
  } catch (error) {
    throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot resolve workspace path: ${rawPath}`, error);
  }
}

export async function workspaceKeyForPath(rawPath: string): Promise<string> {
  const normalized = await canonicalizePhysicalWorkspacePath(rawPath);
  return createHash("sha256").update(`g2m-workspace-v1\0${normalized}`, "utf8").digest("hex");
}

export function workspaceKeyForPathSync(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || !isAbsolute(rawPath)) {
    throw new WorkspaceLockError("INVALID_INPUT", "canonicalPath must be an absolute path");
  }
  try {
    const normalized = normalizePhysicalWorkspacePath(realpathSync(rawPath));
    return createHash("sha256").update(`g2m-workspace-v1\0${normalized}`, "utf8").digest("hex");
  } catch (error) {
    throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot resolve workspace path: ${rawPath}`, error);
  }
}

export async function readLeaseOwner(path: string): Promise<LeaseOwnerInspection> {
  const file = await readRegularFile(path);
  if (file.kind === "missing") return "MISSING";
  if (file.kind === "malformed") return "MALFORMED";
  return parseOwner(file.text);
}

export async function scanLeaseOwners(stateRoot: string): Promise<readonly ValidLeaseOwner[]> {
  const locksRoot = join(stateRoot, "locks");
  let entries;
  try { entries = await readdir(locksRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot scan lease directory: ${locksRoot}`, error);
  }
  const owners: ValidLeaseOwner[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;
    const value = await readLeaseOwner(join(locksRoot, entry.name));
    if (typeof value === "object") owners.push(value);
  }
  return owners;
}

export function readLeaseOwnerSync(path: string): LeaseOwnerInspection {
  const file = readRegularFileSync(path);
  if (file.kind === "missing") return "MISSING";
  if (file.kind === "malformed") return "MALFORMED";
  return parseOwner(file.text);
}

export function scanLeaseOwnersSync(stateRoot: string): readonly ValidLeaseOwner[] {
  const locksRoot = join(stateRoot, "locks");
  let entries;
  try { entries = readdirSync(locksRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot scan lease directory: ${locksRoot}`, error);
  }
  const owners: ValidLeaseOwner[] = [];
  for (const name of entries) {
    if (!name.endsWith(".lock")) continue;
    const value = readLeaseOwnerSync(join(locksRoot, name));
    if (typeof value === "object") owners.push(value);
  }
  return owners;
}

type RegularFileRead =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "ok"; readonly text: string };

async function readRegularFile(path: string): Promise<RegularFileRead> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_LEASE_FILE_BYTES) return { kind: "malformed" };
    return { kind: "ok", text: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot read lease file: ${path}`, error);
  }
}

function readRegularFileSync(path: string): RegularFileRead {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_LEASE_FILE_BYTES) return { kind: "malformed" };
    return { kind: "ok", text: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot read lease file: ${path}`, error);
  }
}

function workspaceKeyForLegacyId(workspaceId: string): string {
  return createHash("sha256").update(`g2m-workspace-legacy-v1\0${workspaceId}`, "utf8").digest("hex");
}

function workspaceKeyForResolvedPath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || !isAbsolute(rawPath)) {
    throw new WorkspaceLockError("INVALID_INPUT", "workspace resolver must return an absolute path");
  }
  try {
    const normalized = normalizePhysicalWorkspacePath(realpathSync(rawPath));
    return createHash("sha256").update(`g2m-workspace-v1\0${normalized}`, "utf8").digest("hex");
  } catch (error) {
    throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot resolve workspace path: ${rawPath}`, error);
  }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new WorkspaceLockError("INVALID_INPUT", `${name} must be positive`);
  }
}

function assertLeaseInput(options: AcquireWorkspaceLeaseOptions): void {
  if (typeof options.workspaceId !== "string" || options.workspaceId.trim().length === 0) {
    throw new WorkspaceLockError("INVALID_INPUT", "workspaceId cannot be empty");
  }
  if (typeof options.executionId !== "string" || options.executionId.trim().length === 0) {
    throw new WorkspaceLockError("INVALID_INPUT", "executionId cannot be empty");
  }
}

function ownerJson(owner: ValidLeaseOwner): string { return `${JSON.stringify(owner)}\n`; }
function heartbeatJson(heartbeat: ValidHeartbeat): string { return `${JSON.stringify(heartbeat)}\n`; }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseOwner(text: string): ValidLeaseOwner | "INCOMPLETE" | "MALFORMED" {
  if (text.trim().length === 0) return "INCOMPLETE";
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !hasExactlyKeys(value, OWNER_KEYS)) return "MALFORMED";
    if (
      value.lock_version !== 1 || typeof value.workspace_key !== "string" || value.workspace_key.length === 0 ||
      typeof value.workspace_id !== "string" || value.workspace_id.length === 0 ||
      typeof value.execution_id !== "string" || value.execution_id.length === 0 ||
      typeof value.lease_id !== "string" || value.lease_id.length === 0 ||
      typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 ||
      typeof value.hostname !== "string" || value.hostname.length === 0 ||
      typeof value.created_at !== "number" || !Number.isFinite(value.created_at) ||
      typeof value.heartbeat_at !== "number" || !Number.isFinite(value.heartbeat_at)
    ) return "MALFORMED";
    return value as unknown as ValidLeaseOwner;
  } catch { return "MALFORMED"; }
}

function parseHeartbeat(text: string): ValidHeartbeat | "MALFORMED" {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !hasExactlyKeys(value, HEARTBEAT_KEYS)) return "MALFORMED";
    if (
      value.heartbeat_version !== 1 || typeof value.workspace_key !== "string" || value.workspace_key.length === 0 ||
      typeof value.lease_id !== "string" || value.lease_id.length === 0 ||
      typeof value.heartbeat_at !== "number" || !Number.isFinite(value.heartbeat_at)
    ) return "MALFORMED";
    return value as unknown as ValidHeartbeat;
  } catch { return "MALFORMED"; }
}

export function classifyLeasePolicy(input: LeasePolicyInput): LeaseDisposition {
  const { inspection, journalState, staleAfterMs, currentHostname } = input;
  if (inspection.owner === "INCOMPLETE") return "INCOMPLETE";
  if (inspection.owner === "MALFORMED") return "MALFORMED";
  if (inspection.owner === "MISSING") return "UNKNOWN";
  if (inspection.heartbeat === "MALFORMED" || inspection.heartbeat === "LEASE_ID_MISMATCH") {
    return "HEARTBEAT_MISMATCH";
  }
  if (inspection.owner.hostname !== currentHostname) return "FOREIGN_HOST";
  if (journalState === "CORRUPT" || journalState === "MISSING") return "UNKNOWN";
  if (journalState === "RECOVERY_REQUIRED") return "RECOVERY_CRITICAL";
  const heartbeatAge = inspection.heartbeatAgeMs ?? inspection.ageMs ?? 0;
  const stale = heartbeatAge > staleAfterMs;
  if (journalState === "ACTIVE") return stale ? "ACTIVE_EXECUTION_STALE_OWNER" : "ACTIVE";
  if (inspection.pidStatus !== "DEAD" || !stale) return "ACTIVE";
  return "STALE_TERMINAL_RECLAIMABLE";
}

function ownerMatches(value: LeaseOwnerInspection, expected: ValidLeaseOwner): boolean {
  return typeof value === "object" && JSON.stringify(value) === JSON.stringify(expected);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, data: string): Promise<void> {
  const bytes = Buffer.from(data, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    offset += result.bytesWritten;
  }
}

function safeUnlinkSync(path: string): void {
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function safeUnlinkAsync(path: string): Promise<void> {
  await rm(path, { force: true });
}

export class WorkspaceLock {
  private readonly stateRoot: string;
  private readonly workspacePathResolver: ((workspaceId: string) => string) | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly incompleteLeaseGraceMs: number;
  private readonly reclaimGuardStaleMs: number;
  private readonly dependencies: WorkspaceLeaseDependencies;
  private readonly leaseProjection: WorkspaceLeaseProjection | undefined;
  // This map is only a local handle/timer index. Filesystem owner state is the
  // authority for acquire, release, and every ownership check.
  private readonly localHandles = new Map<string, LockHandle>();
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(options: WorkspaceLockOptions = {}) {
    this.stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT;
    this.workspacePathResolver = options.workspacePathResolver;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.incompleteLeaseGraceMs = options.incompleteLeaseGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS;
    this.reclaimGuardStaleMs = options.reclaimGuardStaleMs ?? DEFAULT_RECLAIM_GUARD_STALE_MS;
    assertPositiveFinite("heartbeatIntervalMs", this.heartbeatIntervalMs);
    assertPositiveFinite("staleAfterMs", this.staleAfterMs);
    assertPositiveFinite("incompleteLeaseGraceMs", this.incompleteLeaseGraceMs);
    assertPositiveFinite("reclaimGuardStaleMs", this.reclaimGuardStaleMs);
    if (this.staleAfterMs < 3 * this.heartbeatIntervalMs) {
      throw new WorkspaceLockError("INVALID_INPUT", "staleAfterMs must be at least 3 heartbeat intervals");
    }
    this.dependencies = { ...defaultDependencies(), ...(options.dependencies ?? {}) };
    this.leaseProjection = options.leaseProjection;
  }

  async acquire(options: AcquireWorkspaceLeaseOptions): Promise<LockHandle>;
  acquire(workspaceId: string, executionId: string): LockHandle;
  acquire(optionsOrWorkspaceId: AcquireWorkspaceLeaseOptions | string, legacyExecutionId?: string): Promise<LockHandle> | LockHandle {
    if (typeof optionsOrWorkspaceId === "string") {
      if (legacyExecutionId === undefined) throw new WorkspaceLockError("INVALID_INPUT", "executionId cannot be empty");
      return this.acquireLegacy(optionsOrWorkspaceId, legacyExecutionId);
    }
    return this.acquireDurable(optionsOrWorkspaceId);
  }

  private async acquireDurable(options: AcquireWorkspaceLeaseOptions): Promise<LockHandle> {
    assertLeaseInput(options);
    const workspaceKey = await workspaceKeyForPath(options.canonicalPath);
    const leaseId = this.dependencies.randomUUID();
    const acquiredAt = this.dependencies.now();
    const ownerPath = this.ownerPath(workspaceKey);
    const heartbeatPath = this.heartbeatPath(workspaceKey, leaseId);
    const owner: ValidLeaseOwner = {
      lock_version: 1, workspace_key: workspaceKey, workspace_id: options.workspaceId,
      execution_id: options.executionId, lease_id: leaseId, pid: process.pid,
      hostname: this.dependencies.hostname(), created_at: acquiredAt, heartbeat_at: acquiredAt,
    };

    await mkdir(dirname(ownerPath), { recursive: true });
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(ownerPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceLockError("WORKSPACE_BUSY", `workspace "${options.workspaceId}" is busy`, error);
      }
      throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot create lease owner: ${ownerPath}`, error);
    }
    try {
      await writeAll(file, ownerJson(owner));
      await file.sync();
      await file.close();
    } catch (error) {
      try { await file.close(); } catch { /* best effort */ }
      try { await safeUnlinkAsync(ownerPath); } catch { /* preserve original failure */ }
      throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot persist lease owner: ${ownerPath}`, error);
    }
    const readBack = await this.readOwnerAsync(ownerPath);
    if (!ownerMatches(readBack, owner)) {
      try { await safeUnlinkAsync(ownerPath); } catch { /* best effort */ }
      throw new WorkspaceLockError("LEASE_INCONSISTENT", `lease owner read-back mismatch: ${ownerPath}`);
    }
    const handle: LockHandle = {
      workspaceId: options.workspaceId, workspaceKey, executionId: options.executionId, leaseId,
      pid: owner.pid, hostname: owner.hostname, acquiredAt, ownerPath, heartbeatPath,
    };
    this.localHandles.set(leaseId, handle);
    await this.writeHeartbeat(handle);
    try { this.leaseProjection?.upsert(owner); } catch { /* filesystem authority remains valid */ }
    this.startHeartbeat(handle);
    return handle;
  }

  private acquireLegacy(workspaceId: string, executionId: string): LockHandle {
    if (workspaceId.trim().length === 0 || executionId.trim().length === 0) {
      throw new WorkspaceLockError("INVALID_HANDLE", "workspaceId and executionId cannot be empty");
    }
    const workspaceKey = this.workspacePathResolver === undefined
      ? workspaceKeyForLegacyId(workspaceId)
      : workspaceKeyForResolvedPath(this.workspacePathResolver(workspaceId));
    const leaseId = this.dependencies.randomUUID();
    const acquiredAt = this.dependencies.now();
    const ownerPath = this.ownerPath(workspaceKey);
    const heartbeatPath = this.heartbeatPath(workspaceKey, leaseId);
    const owner: ValidLeaseOwner = {
      lock_version: 1, workspace_key: workspaceKey, workspace_id: workspaceId,
      execution_id: executionId, lease_id: leaseId, pid: process.pid,
      hostname: this.dependencies.hostname(), created_at: acquiredAt, heartbeat_at: acquiredAt,
    };
    mkdirSync(dirname(ownerPath), { recursive: true });
    let fd: number;
    try {
      fd = openSync(ownerPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceLockError("WORKSPACE_BUSY", `workspace "${workspaceId}" is busy`, error);
      }
      throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot create lease owner: ${ownerPath}`, error);
    }
    try {
      writeFileSync(fd, ownerJson(owner), "utf8");
      fsyncSync(fd);
      closeSync(fd);
    } catch (error) {
      try { closeSync(fd); } catch { /* best effort */ }
      try { safeUnlinkSync(ownerPath); } catch { /* preserve original failure */ }
      throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot persist lease owner: ${ownerPath}`, error);
    }
    const readBack = this.readOwnerSync(ownerPath);
    if (!ownerMatches(readBack, owner)) {
      try { safeUnlinkSync(ownerPath); } catch { /* best effort */ }
      throw new WorkspaceLockError("LEASE_INCONSISTENT", `lease owner read-back mismatch: ${ownerPath}`);
    }
    const handle: LockHandle = {
      workspaceId, workspaceKey, executionId, leaseId, pid: owner.pid,
      hostname: owner.hostname, acquiredAt, ownerPath, heartbeatPath,
    };
    this.localHandles.set(leaseId, handle);
    this.writeHeartbeatSync(handle);
    try { this.leaseProjection?.upsert(owner); } catch { /* filesystem authority remains valid */ }
    this.startHeartbeat(handle);
    return handle;
  }

  release(handle: LockHandle): void {
    this.stopHeartbeat(handle);
    const guardPath = this.reclaimPath(handle.workspaceKey);
    const guardFd = this.acquireReclaimGuardSync(guardPath, handle.workspaceKey);
    try {
      const current = this.readOwnerSync(handle.ownerPath);
      if (current === "MISSING" || current === "INCOMPLETE" || current === "MALFORMED") {
        const code = this.localHandles.has(handle.leaseId) ? "STALE_HANDLE" : "NOT_HELD";
        throw new WorkspaceLockError(code, `lock for workspace "${handle.workspaceId}" is not held by this handle`);
      }
      if (current.lease_id !== handle.leaseId) {
        throw new WorkspaceLockError("STALE_HANDLE", `lease ${handle.leaseId} no longer owns ${handle.ownerPath}`);
      }
      safeUnlinkSync(handle.ownerPath);
      safeUnlinkSync(handle.heartbeatPath);
      try { this.leaseProjection?.removeIfLeaseMatches(handle.workspaceId, handle.leaseId); } catch { /* best effort */ }
      this.localHandles.delete(handle.leaseId);
    } finally {
      try { closeSync(guardFd); } finally { safeUnlinkSync(guardPath); }
    }
  }

  async assertOwned(handle: LockHandle): Promise<void> {
    const current = await this.readOwnerAsync(handle.ownerPath);
    if (current === "MISSING" || current === "INCOMPLETE" || current === "MALFORMED") {
      throw new WorkspaceLockError("LEASE_LOST", `lease owner is no longer valid: ${handle.ownerPath}`);
    }
    if (current.lease_id !== handle.leaseId) {
      this.stopHeartbeat(handle);
      throw new WorkspaceLockError("STALE_HANDLE", `lease ${handle.leaseId} is not current`);
    }
  }

  async heartbeat(handle: LockHandle): Promise<void> {
    await this.writeHeartbeat(handle);
  }

  async inspectWorkspaceLease(options: InspectWorkspaceLeaseOptions): Promise<LeaseInspection> {
    const workspaceKey = options.workspaceKey ?? (
      options.canonicalPath !== undefined ? await workspaceKeyForPath(options.canonicalPath) : undefined
    );
    if (workspaceKey === undefined || workspaceKey.trim().length === 0) {
      throw new WorkspaceLockError("INVALID_INPUT", "workspaceKey or canonicalPath is required");
    }
    const ownerPath = this.ownerPath(workspaceKey);
    const owner = await this.readOwnerAsync(ownerPath);
    const heartbeat = owner === "MISSING" || owner === "INCOMPLETE" || owner === "MALFORMED"
      ? "MISSING"
      : await this.readHeartbeatForOwner(workspaceKey, owner.lease_id);
    const ownerFile = await readRegularFile(ownerPath);
    const heartbeatFile = typeof heartbeat === "object"
      ? await readRegularFile(this.heartbeatPath(workspaceKey, heartbeat.lease_id)) : { kind: "missing" as const };
    const now = this.dependencies.now();
    return {
      workspaceKey, owner, heartbeat,
      ...(owner !== "MISSING" && owner !== "INCOMPLETE" && owner !== "MALFORMED"
        ? { pidStatus: this.dependencies.pidProbe(owner.pid), ageMs: Math.max(0, now - owner.created_at) } : {}),
      ...(typeof heartbeat === "object" ? { heartbeatAgeMs: Math.max(0, now - heartbeat.heartbeat_at) } : {}),
      ...(ownerFile.kind === "ok" ? { ownerFileSha256: sha256Text(ownerFile.text) } : {}),
      ...(heartbeatFile.kind === "ok" ? { heartbeatFileSha256: sha256Text(heartbeatFile.text) } : {}),
    };
  }

  inspectWorkspaceLeaseSync(options: { readonly workspaceKey: string }): LeaseInspection {
    const workspaceKey = options.workspaceKey;
    if (workspaceKey.trim().length === 0) throw new WorkspaceLockError("INVALID_INPUT", "workspaceKey is required");
    const ownerPath = this.ownerPath(workspaceKey);
    const owner = this.readOwnerSync(ownerPath);
    const heartbeat = typeof owner === "object"
      ? this.readHeartbeatForOwnerSync(workspaceKey, owner.lease_id) : "MISSING";
    const now = this.dependencies.now();
    const ownerFile = readRegularFileSync(ownerPath);
    const heartbeatFile = typeof heartbeat === "object"
      ? readRegularFileSync(this.heartbeatPath(workspaceKey, heartbeat.lease_id)) : { kind: "missing" as const };
    return {
      workspaceKey, owner, heartbeat,
      ...(typeof owner === "object" ? {
        pidStatus: this.dependencies.pidProbe(owner.pid),
        ageMs: Math.max(0, now - owner.created_at),
      } : {}),
      ...(typeof heartbeat === "object" ? { heartbeatAgeMs: Math.max(0, now - heartbeat.heartbeat_at) } : {}),
      ...(ownerFile.kind === "ok" ? { ownerFileSha256: sha256Text(ownerFile.text) } : {}),
      ...(heartbeatFile.kind === "ok" ? { heartbeatFileSha256: sha256Text(heartbeatFile.text) } : {}),
    };
  }

  async reclaimStaleLease(options: ReclaimStaleLeaseOptions): Promise<ValidLeaseOwner> {
    if (
      options.journalState !== "TERMINAL" &&
      !(options.authorization === "EXPLICIT_RECOVERY" && options.journalState === "RECOVERY_REQUIRED")
    ) {
      throw new WorkspaceLockError("RECLAIM_NOT_ALLOWED", `journal state ${options.journalState} is not reclaimable`);
    }
    const initial = await this.inspectWorkspaceLease({ workspaceKey: options.workspaceKey });
    if (options.expectedExecutionId !== undefined &&
        (typeof initial.owner !== "object" || initial.owner.execution_id !== options.expectedExecutionId)) {
      throw new WorkspaceLockError("WORKSPACE_BUSY", `lease does not belong to execution ${options.expectedExecutionId}`);
    }
    this.assertReclaimable(initial, options.workspaceKey);
    const guardPath = this.reclaimPath(options.workspaceKey);
    const guardFd = this.acquireReclaimGuardSync(guardPath, options.workspaceKey);
    try {
      const second = await this.inspectWorkspaceLease({ workspaceKey: options.workspaceKey });
      if (
        initial.ownerFileSha256 !== second.ownerFileSha256 ||
        initial.heartbeatFileSha256 !== second.heartbeatFileSha256
      ) {
        throw new WorkspaceLockError("RECLAIM_NOT_ALLOWED", "lease snapshot changed while acquiring reclaim guard");
      }
      this.assertReclaimable(second, options.workspaceKey);
      if (typeof second.owner !== "object") throw new WorkspaceLockError("STALE_HANDLE", "owner disappeared during reclaim");
      safeUnlinkSync(this.ownerPath(options.workspaceKey));
      safeUnlinkSync(this.heartbeatPath(options.workspaceKey, second.owner.lease_id));
      try { this.leaseProjection?.removeIfLeaseMatches(second.owner.workspace_id, second.owner.lease_id); } catch { /* best effort */ }
      return second.owner;
    } finally {
      try { closeSync(guardFd); } finally { safeUnlinkSync(guardPath); }
    }
  }

  async reconcileStartupLeases(
    journalStates: ReadonlyMap<string, LeaseJournalState>,
  ): Promise<StartupLeaseReconciliationReport> {
    const reclaimedExecutionIds: string[] = [];
    const heldExecutionIds: string[] = [];
    for (const owner of await scanLeaseOwners(this.stateRoot)) {
      const journalState = journalStates.get(owner.execution_id) ?? "MISSING";
      if (journalState === "TERMINAL") {
        try {
          await this.reclaimStaleLease({ workspaceKey: owner.workspace_key, journalState: "TERMINAL" });
          reclaimedExecutionIds.push(owner.execution_id);
          continue;
        } catch {
          // Fresh, active, unknown, foreign, or otherwise unsafe evidence is
          // deliberately held for later operator/recovery handling.
        }
      }
      heldExecutionIds.push(owner.execution_id);
    }
    return {
      reclaimedExecutionIds: reclaimedExecutionIds.sort((left, right) => left.localeCompare(right)),
      heldExecutionIds: heldExecutionIds.sort((left, right) => left.localeCompare(right)),
    };
  }

  async takeoverRecoveryLease(options: RecoveryLeaseTakeoverOptions): Promise<LockHandle> {
    if (options.processStatus === "alive" || options.processStatus === "unknown") {
      throw new WorkspaceLockError("RECLAIM_NOT_ALLOWED", `process status ${options.processStatus} does not prove the owner is gone`);
    }
    const workspaceKey = await workspaceKeyForPath(options.canonicalPath);
    const inspection = await this.inspectWorkspaceLease({ workspaceKey });
    if (inspection.owner === "MISSING") throw new WorkspaceLockError("LEASE_NOT_OWNED", `no recovery lease exists for ${options.workspaceId}`);
    if (typeof inspection.owner !== "object") {
      throw new WorkspaceLockError("RECLAIM_NOT_ALLOWED", `recovery owner is ${inspection.owner.toLowerCase()}`);
    }
    if (inspection.owner.execution_id !== options.executionId) {
      throw new WorkspaceLockError("WORKSPACE_BUSY", `workspace is owned by execution ${inspection.owner.execution_id}`);
    }
    await this.reclaimStaleLease({
      workspaceKey,
      journalState: "RECOVERY_REQUIRED",
      authorization: "EXPLICIT_RECOVERY",
      expectedExecutionId: options.executionId,
    });
    return this.acquire({
      workspaceId: options.workspaceId,
      canonicalPath: options.canonicalPath,
      executionId: options.executionId,
    });
  }

  heldWorkspaceIds(): readonly string[] { return Array.from(this.localHandles.values()).map((handle) => handle.workspaceId); }
  isHeld(workspaceId: string): boolean { return Array.from(this.localHandles.values()).some((handle) => handle.workspaceId === workspaceId); }
  get reclaimGuardStaleAfterMs(): number { return this.reclaimGuardStaleMs; }
  get incompleteGraceAfterMs(): number { return this.incompleteLeaseGraceMs; }
  get staleAfter(): number { return this.staleAfterMs; }

  private assertReclaimable(inspection: LeaseInspection, workspaceKey: string): void {
    const owner = inspection.owner;
    if (owner === "MISSING") throw new WorkspaceLockError("LEASE_NOT_OWNED", `no owner exists for ${workspaceKey}`);
    if (owner === "INCOMPLETE") throw new WorkspaceLockError("LEASE_INCOMPLETE", `owner is incomplete for ${workspaceKey}`);
    if (owner === "MALFORMED") throw new WorkspaceLockError("LEASE_MALFORMED", `owner is malformed for ${workspaceKey}`);
    if (owner.hostname !== this.dependencies.hostname()) {
      throw new WorkspaceLockError("FOREIGN_HOST_LEASE", `lease for ${workspaceKey} belongs to ${owner.hostname}`);
    }
    if (inspection.pidStatus !== "DEAD") {
      throw new WorkspaceLockError("RECLAIM_NOT_ALLOWED", `PID ${owner.pid} is ${inspection.pidStatus ?? "UNKNOWN"}`);
    }
    if (inspection.heartbeat === "MALFORMED" || inspection.heartbeat === "LEASE_ID_MISMATCH") {
      throw new WorkspaceLockError("RECLAIM_NOT_ALLOWED", `heartbeat evidence is invalid for ${workspaceKey}`);
    }
    const heartbeatAge = inspection.heartbeatAgeMs ?? inspection.ageMs ?? 0;
    if (heartbeatAge <= this.staleAfterMs) {
      throw new WorkspaceLockError("RECLAIM_NOT_ALLOWED", `lease for ${workspaceKey} is not stale`);
    }
  }

  private ownerPath(workspaceKey: string): string { return join(this.stateRoot, "locks", `${workspaceKey}.lock`); }
  private heartbeatPath(workspaceKey: string, leaseId: string): string { return join(this.stateRoot, "locks", `${workspaceKey}.${leaseId}.heartbeat`); }
  private reclaimPath(workspaceKey: string): string { return join(this.stateRoot, "locks", `${workspaceKey}.reclaim`); }

  private async readOwnerAsync(path: string): Promise<LeaseOwnerInspection> {
    return readLeaseOwner(path);
  }

  private readOwnerSync(path: string): LeaseOwnerInspection {
    const file = readRegularFileSync(path);
    if (file.kind === "missing") return "MISSING";
    if (file.kind === "malformed") return "MALFORMED";
    return parseOwner(file.text);
  }

  private async readHeartbeatForOwner(workspaceKey: string, leaseId: string): Promise<LeaseHeartbeatInspection> {
    try {
      const file = await readRegularFile(this.heartbeatPath(workspaceKey, leaseId));
      if (file.kind === "missing") return "MISSING";
      if (file.kind === "malformed") return "MALFORMED";
      const heartbeat = parseHeartbeat(file.text);
      if (heartbeat === "MALFORMED") return heartbeat;
      if (heartbeat.workspace_key !== workspaceKey || heartbeat.lease_id !== leaseId) return "LEASE_ID_MISMATCH";
      return heartbeat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "MISSING";
      throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot read heartbeat for ${workspaceKey}`, error);
    }
  }

  private readHeartbeatForOwnerSync(workspaceKey: string, leaseId: string): LeaseHeartbeatInspection {
    const file = readRegularFileSync(this.heartbeatPath(workspaceKey, leaseId));
    if (file.kind === "missing") return "MISSING";
    if (file.kind === "malformed") return "MALFORMED";
    const heartbeat = parseHeartbeat(file.text);
    if (heartbeat === "MALFORMED") return heartbeat;
    if (heartbeat.workspace_key !== workspaceKey || heartbeat.lease_id !== leaseId) return "LEASE_ID_MISMATCH";
    return heartbeat;
  }

  private async writeHeartbeat(handle: LockHandle): Promise<void> {
    await this.assertOwned(handle);
    const temporaryPath = `${handle.heartbeatPath}.tmp-${process.pid}-${handle.leaseId}`;
    await mkdir(dirname(handle.heartbeatPath), { recursive: true });
    const file = await open(temporaryPath, "w");
    try {
      await writeAll(file, heartbeatJson({
        heartbeat_version: 1, workspace_key: handle.workspaceKey,
        lease_id: handle.leaseId, heartbeat_at: this.dependencies.now(),
      }));
      await file.sync();
      await file.close();
      await rename(temporaryPath, handle.heartbeatPath);
    } catch (error) {
      try { await file.close(); } catch { /* best effort */ }
      try { await safeUnlinkAsync(temporaryPath); } catch { /* best effort */ }
      throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot update heartbeat: ${handle.heartbeatPath}`, error);
    }
  }

  private writeHeartbeatSync(handle: LockHandle): void {
    const current = this.readOwnerSync(handle.ownerPath);
    if (current === "MISSING" || current === "INCOMPLETE" || current === "MALFORMED" || current.lease_id !== handle.leaseId) {
      throw new WorkspaceLockError("STALE_HANDLE", `lease ${handle.leaseId} is not current`);
    }
    mkdirSync(dirname(handle.heartbeatPath), { recursive: true });
    const temporaryPath = `${handle.heartbeatPath}.tmp-${process.pid}-${handle.leaseId}`;
    const fd = openSync(temporaryPath, "w");
    try {
      writeFileSync(fd, heartbeatJson({
        heartbeat_version: 1, workspace_key: handle.workspaceKey,
        lease_id: handle.leaseId, heartbeat_at: this.dependencies.now(),
      }), "utf8");
      fsyncSync(fd);
      closeSync(fd);
      renameSync(temporaryPath, handle.heartbeatPath);
    } catch (error) {
      try { closeSync(fd); } catch { /* best effort */ }
      try { safeUnlinkSync(temporaryPath); } catch { /* best effort */ }
      throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot update heartbeat: ${handle.heartbeatPath}`, error);
    }
  }

  private startHeartbeat(handle: LockHandle): void {
    this.stopHeartbeat(handle);
    const timer = setInterval(() => {
      void this.writeHeartbeat(handle).catch((error: unknown) => {
        if (error instanceof WorkspaceLockError && error.code === "STALE_HANDLE") this.stopHeartbeat(handle);
      });
    }, this.heartbeatIntervalMs);
    timer.unref?.();
    this.heartbeatTimers.set(handle.leaseId, timer);
  }

  private stopHeartbeat(handle: LockHandle): void {
    const timer = this.heartbeatTimers.get(handle.leaseId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.heartbeatTimers.delete(handle.leaseId);
    }
  }

  private acquireReclaimGuardSync(path: string, workspaceKey: string): number {
    mkdirSync(dirname(path), { recursive: true });
    let fd: number;
    try { fd = openSync(path, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (this.removeStaleGuardSync(path, workspaceKey)) return this.acquireReclaimGuardSync(path, workspaceKey);
        throw new WorkspaceLockError("RECLAIM_BUSY", `reclaim guard is held for ${workspaceKey}`, error);
      }
      throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot create reclaim guard: ${path}`, error);
    }
    try {
      writeFileSync(fd, JSON.stringify({
        reclaim_version: 1, workspace_key: workspaceKey, pid: process.pid,
        hostname: this.dependencies.hostname(), created_at: this.dependencies.now(),
      }) + "\n", "utf8");
      fsyncSync(fd);
      return fd;
    } catch (error) {
      try { closeSync(fd); } catch { /* best effort */ }
      try { safeUnlinkSync(path); } catch { /* best effort */ }
      throw new WorkspaceLockError("LEASE_IO_FAILED", `cannot persist reclaim guard: ${path}`, error);
    }
  }

  private removeStaleGuardSync(path: string, workspaceKey: string): boolean {
    let text: string;
    let modifiedAt: number;
    try {
      text = readFileSync(path, "utf8");
      modifiedAt = statSync(path).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = undefined; }
    if (!isRecord(value)) {
      if (this.dependencies.now() - modifiedAt <= this.incompleteLeaseGraceMs) return false;
      try { safeUnlinkSync(path); return true; } catch { return false; }
    }
    const guardPid = value.pid;
    const guardHost = value.hostname;
    const createdAt = value.created_at;
    if (
      value.reclaim_version !== 1 || value.workspace_key !== workspaceKey ||
      typeof guardPid !== "number" || !Number.isInteger(guardPid) ||
      typeof guardHost !== "string" || typeof createdAt !== "number"
    ) return false;
    if (guardHost !== this.dependencies.hostname()) return false;
    if (this.dependencies.now() - createdAt <= this.reclaimGuardStaleMs) return false;
    if (this.dependencies.pidProbe(guardPid) !== "DEAD") return false;
    try { safeUnlinkSync(path); return true; } catch { return false; }
  }
}
