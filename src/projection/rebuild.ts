/**
 * Projection Rebuild — plan Phase 3 / Task 3
 *
 * Recreates the disposable SQLite projection from execution Journals and
 * trusted workspace configuration. The Journal is the authoritative source
 * of truth; this module only re-derives queryable rows. It must:
 *
 *  - Hold an exclusive process-level lock for the duration of the rebuild.
 *    A second `rebuildProjection` call against the same `stateRoot` fails
 *    fast with `RebuildLockHeldError`. This is the chosen concurrency
 *    strategy: the two-rename swap is not OS-atomic, so we serialize
 *    rebuilds and rely on the operator keeping concurrent readers away
 *    (documented below).
 *  - Scan `stateRoot/executions/<execution-id>/state-events.ndjson` and
 *    replay each execution in physical file order (no re-sorting by
 *    timestamp or sequence). A failure loading one execution is recorded
 *    as stale and does not abort the rest of the rebuild.
 *  - Use a fresh `FingerprintRegistry` per execution so rebuild cannot
 *    inherit runtime state.
 *  - Keep a valid Journal prefix when the tail was truncated; mark the
 *    execution as `TRUNCATED_TAIL` and never invent facts.
 *  - Mark any contradictory history stale (first event is not
 *    `task.created`, terminal state receives an event, broken chain,
 *    unsupported `schema_version`) and never fabricate execution / review
 *    / artifact / recovery rows.
 *  - Before moving the old `g2m-state.sqlite` to `backups/`, open the
 *    old database and `PRAGMA wal_checkpoint(TRUNCATE)`. This flushes
 *    any uncheckpointed WAL data into the main file so the `-wal` and
 *    `-shm` siblings can be safely removed. If the open / checkpoint
 *    fails, the rebuild aborts with `RebuildOldDatabaseUnsettledError`
 *    rather than risk destroying a database another process is still
 *    writing to. The lock is released either way.
 *  - Build into a temporary SQLite file, checkpoint WAL, then atomically
 *    replace the existing projection; the previous database (if any) is
 *    moved into `stateRoot/backups/`. If the second rename throws, the
 *    previous database is restored from the backup so the official
 *    `g2m-state.sqlite` is never observed empty (within the documented
 *    rebuild window).
 *
 * Concurrency contract:
 *  - Two rebuilds against the same `stateRoot` cannot overlap (exclusive
 *    lock).
 *  - Concurrent readers of `g2m-state.sqlite` are NOT safe during a
 *    rebuild. There is a small window between the first rename (old DB
 *    moves into `backups/`) and the second rename (new DB moves into
 *    place) where a brand-new reader would see "file not found". New
 *    readers should retry; readers that already hold a file handle
 *    continue to read the old file (now at `backups/`) until they
 *    close it. The rebuild lock prevents a second rebuild from
 *    compounding this window.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import { loadSingleExecutionJournal } from "../events/store.js";
import type { TaskEvent } from "../events/events.js";
import { reduce } from "../events/reducer.js";
import { FingerprintRegistry } from "../execution/fingerprint.js";
import type { TaskState } from "../execution/state-machine.js";
import { scanLeaseOwners } from "../workspace/lock.js";
import { StateDatabase } from "./database.js";
import { ExecutionProjector, type WorkspaceSeed } from "./execution-projector.js";
import { EventStore } from "../events/store.js";
import { rebuildStorageUsageFromManifests } from "../storage/usage.js";
import { reconcileStorageReservations } from "../storage/reservation.js";

export interface RebuildWorkspaceConfig {
  readonly workspaceId: string;
  readonly canonicalPath: string;
}

function toWorkspaceSeeds(workspaces: readonly RebuildWorkspaceConfig[]): readonly WorkspaceSeed[] {
  return workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    canonicalPath: workspace.canonicalPath,
  }));
}

export interface RebuildOptions {
  readonly stateRoot: string;
  readonly workspaces: readonly RebuildWorkspaceConfig[];
  readonly nowMs: number;
}

export interface RebuildFailureReason {
  readonly executionId: string;
  readonly reason: string;
}

export interface RebuildReport {
  readonly rebuiltExecutions: number;
  readonly staleExecutions: number;
  readonly truncatedTails: number;
  readonly failureReasons: readonly RebuildFailureReason[];
  readonly backupPath: string;
}

export interface CommitReplaceOptions {
  readonly oldPath: string;
  readonly newPath: string;
  readonly backupPath: string;
  readonly backupsRoot: string;
  /** Dependency-injected for tests; defaults to `fs.renameSync`. */
  readonly rename?: (source: string, destination: string) => void;
}

export class RebuildLockHeldError extends Error {
  override readonly cause?: unknown;
  constructor(stateRoot: string, cause?: unknown) {
    super(`rebuild projection: another rebuild is in progress for ${stateRoot}`);
    this.name = "RebuildLockHeldError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class RebuildOldDatabaseUnsettledError extends Error {
  override readonly cause?: unknown;
  constructor(stateRoot: string, cause: unknown) {
    super(
      `rebuild projection: cannot settle the old database at ${stateRoot} ` +
        `(another process may still hold a connection); aborting to preserve data`,
    );
    this.name = "RebuildOldDatabaseUnsettledError";
    this.cause = cause;
  }
}

const STALE_META_PREFIX = "execution:";
const STALE_META_SUFFIX = ":stale";
const TRUNCATED_TAIL_MARKER = "TRUNCATED_TAIL";
const REBUILD_LOCK_FILE_NAME = "g2m-state.sqlite.lock";

type ExecutionScan =
  | { readonly kind: "ok"; readonly events: readonly TaskEvent[]; readonly isTruncated: boolean }
  | { readonly kind: "load-error"; readonly error: string };

function listExecutionDirectories(stateRoot: string): string[] {
  const executionsDir = join(stateRoot, "executions");
  if (!existsSync(executionsDir)) return [];
  return readdirSync(executionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Scan every execution directory independently. One corrupted journal
 * (invalid JSON, broken chain, attempt-id mismatch, unsupported
 * `schema_version`, missing file) is recorded as `load-error` for that
 * execution; the loop does not abort.
 */
function scanExecutions(stateRoot: string): ReadonlyMap<string, ExecutionScan> {
  const result = new Map<string, ExecutionScan>();
  for (const executionId of listExecutionDirectories(stateRoot)) {
    const path = join(stateRoot, "executions", executionId, "state-events.ndjson");
    const loaded = loadSingleExecutionJournal(path, executionId);
    if (loaded.kind === "ok") {
      result.set(executionId, {
        kind: "ok",
        events: loaded.events,
        isTruncated: loaded.tailStatus === "TRUNCATED_TAIL",
      });
    } else {
      result.set(executionId, { kind: "load-error", error: loaded.error });
    }
  }
  return result;
}

function staleMetaKey(executionId: string): string {
  return `${STALE_META_PREFIX}${executionId}${STALE_META_SUFFIX}`;
}

function replayAndProject(
  projector: ExecutionProjector,
  events: readonly TaskEvent[],
): {
  readonly rebuilt: boolean;
  readonly reducerError: string | null;
} {
  const fingerprintRegistry = new FingerprintRegistry();
  let state: TaskState | null = null;
  let reducerError: string | null = null;
  for (const event of events) {
    try {
      state = reduce(state, event, { fingerprintRegistry });
    } catch (error) {
      reducerError = error instanceof Error ? error.message : String(error);
      break;
    }
    try {
      projector.project(event, state);
    } catch (error) {
      reducerError = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  return {
    rebuilt: reducerError === null,
    reducerError,
  };
}

function writeWorkspaces(projector: ExecutionProjector, workspaces: readonly RebuildWorkspaceConfig[], nowMs: number): void {
  projector.seedWorkspaces(toWorkspaceSeeds(workspaces), nowMs);
}

function cleanupWalShadows(databasePath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    const shadow = `${databasePath}${suffix}`;
    if (existsSync(shadow)) {
      rmSync(shadow, { force: true });
    }
  }
}

function removeIfExists(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

/**
 * Acquire the process-level rebuild lock. Returns the lock file path on
 * success, throws `RebuildLockHeldError` if another rebuild is already
 * running. The lock is a `wx`-opened 0-byte file: O_EXCL semantics make
 * the second opener fail.
 */
function acquireRebuildLock(stateRoot: string): string {
  const lockPath = join(stateRoot, REBUILD_LOCK_FILE_NAME);
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    throw new RebuildLockHeldError(stateRoot, error);
  }
  closeSync(fd);
  return lockPath;
}

function releaseRebuildLock(lockPath: string): void {
  if (existsSync(lockPath)) {
    rmSync(lockPath, { force: true });
  }
}

/**
 * Open the old database and `PRAGMA wal_checkpoint(TRUNCATE)`. This
 * forces any uncheckpointed WAL data into the main file. If the open or
 * the checkpoint throws, the rebuild aborts (the caller catches the
 * error, releases the lock, and propagates the failure). After this
 * call returns, the `-wal` and `-shm` siblings (if any) are empty and
 * safe to delete.
 */
function settleOldDatabase(oldPath: string, stateRoot: string): void {
  if (!existsSync(oldPath)) return;
  let db: StateDatabase | null = null;
  try {
    db = new StateDatabase(oldPath);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    throw new RebuildOldDatabaseUnsettledError(stateRoot, error);
  } finally {
    if (db !== null) {
      try { db.close(); } catch { /* swallow close error during cleanup */ }
    }
  }
}

/**
 * Move the previous projection (if any) into `backups/`, then move the
 * freshly-built replacement into the official path. If the second rename
 * throws, the previous database is restored from the backup so the
 * official projection is never observed empty (within the documented
 * rebuild window). The temporary file is removed either way.
 *
 * This helper does NOT touch the `-wal` / `-shm` siblings; the caller
 * must checkpoint the old database first (`settleOldDatabase`) and then
 * remove the (now-empty) siblings before invoking this function.
 *
 * Exported for direct unit testing of the rollback path.
 */
export function commitDatabaseReplace(options: CommitReplaceOptions): string {
  const rename = options.rename ?? renameSync;
  let oldPathMoved = false;
  if (existsSync(options.oldPath)) {
    mkdirSync(options.backupsRoot, { recursive: true });
    rename(options.oldPath, options.backupPath);
    oldPathMoved = true;
  }
  try {
    rename(options.newPath, options.oldPath);
  } catch (error) {
    if (oldPathMoved) {
      try {
        rename(options.backupPath, options.oldPath);
      } catch {
        // Best-effort restore: we still want to surface the original
        // error and clean up the temp file. The backup is preserved on
        // disk for operator-driven recovery.
      }
    }
    removeIfExists(options.newPath);
    throw error;
  }
  return oldPathMoved ? options.backupPath : "";
}

export async function rebuildProjection(options: RebuildOptions): Promise<RebuildReport> {
  const { stateRoot, workspaces, nowMs } = options;
  const databasePath = join(stateRoot, "g2m-state.sqlite");
  const tempPath = join(stateRoot, `g2m-state.sqlite.rebuild-${nowMs}.tmp`);
  const backupsRoot = join(stateRoot, "backups");
  const backupPath = join(backupsRoot, `g2m-state-${nowMs}.sqlite`);

  removeIfExists(tempPath);
  // We do NOT clean up the old `-wal` / `-shm` siblings here. If the old
  // database is unreachable (corrupted, or another process is writing
  // to it), we must abort WITHOUT having touched anything on disk. The
  // WAL/SHM siblings are cleaned up only after `settleOldDatabase`
  // confirms the old database is safe to move.

  // Acquire the process-level rebuild lock before any state mutation. The
  // lock is released in a `finally` so a mid-rebuild error does not leave
  // it pinned.
  const lockPath = acquireRebuildLock(stateRoot);

  let rebuiltExecutions = 0;
  let staleExecutions = 0;
  let truncatedTails = 0;
  const failureReasons: RebuildFailureReason[] = [];
  let tempDatabase: StateDatabase | null = null;

  try {
    const executions = scanExecutions(stateRoot);

    try {
      tempDatabase = new StateDatabase(tempPath);
      const projector = new ExecutionProjector(tempDatabase);
      writeWorkspaces(projector, workspaces, nowMs);

      // The filesystem owner files are authoritative. SQLite receives only
      // strictly valid lease metadata and can therefore be deleted/rebuilt
      // without changing ownership decisions.
      const leaseOwners = await scanLeaseOwners(stateRoot);
      tempDatabase.transaction(() => {
        for (const owner of leaseOwners) projector.upsertWorkspaceLease(owner);
      });

      for (const [executionId, scan] of executions) {
        if (scan.kind === "load-error") {
          failureReasons.push({ executionId, reason: scan.error });
          tempDatabase.setMeta(staleMetaKey(executionId), scan.error);
          staleExecutions += 1;
          continue;
        }
        if (scan.isTruncated) truncatedTails += 1;
        const { rebuilt, reducerError } = replayAndProject(projector, scan.events);
        if (rebuilt) {
          rebuiltExecutions += 1;
          if (scan.isTruncated) {
            tempDatabase.setMeta(staleMetaKey(executionId), TRUNCATED_TAIL_MARKER);
            staleExecutions += 1;
          }
          continue;
        }
        const reason = reducerError ?? "unknown projection failure";
        failureReasons.push({ executionId, reason });
        tempDatabase.setMeta(staleMetaKey(executionId), reason);
        if (!scan.isTruncated) staleExecutions += 1;
      }

      rebuildStorageUsageFromManifests({ stateRoot, database: tempDatabase, nowMs });
      const storageEvents = new EventStore({
        executionDirectory: join(stateRoot, "executions"),
        tolerateLoadErrors: true,
      });
      await reconcileStorageReservations({
        stateRoot,
        database: tempDatabase,
        eventStore: storageEvents,
        nowMs,
        releaseTerminal: false,
      });
      storageEvents.close();

      tempDatabase.setMeta("rebuild_status", "complete");
      tempDatabase.setMeta("rebuild_at", String(nowMs));
      tempDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      tempDatabase.close();
      tempDatabase = null;
    } catch (error) {
      if (tempDatabase !== null) {
        try { tempDatabase.close(); } catch { /* swallow close error during cleanup */ }
      }
      removeIfExists(tempPath);
      throw error;
    }

    // Before moving the old database out of the way, prove that no
    // uncheckpointed WAL data exists (and that the old DB is openable).
    // If the open / checkpoint fails, the rebuild aborts to preserve data;
    // the lock is released in the `finally` and no files have been
    // deleted or renamed.
    settleOldDatabase(databasePath, stateRoot);

    // WAL is now empty; the `-wal` and `-shm` siblings can be safely
    // deleted. The actual rename is just the two file moves.
    cleanupWalShadows(databasePath);

    const resolvedBackupPath = commitDatabaseReplace({
      oldPath: databasePath,
      newPath: tempPath,
      backupPath,
      backupsRoot,
    });

    // The new DB was checkpointed before close, so any `-wal` / `-shm`
    // shadows that ended up at the official path are empty and safe to
    // delete.
    cleanupWalShadows(databasePath);

    return {
      rebuiltExecutions,
      staleExecutions,
      truncatedTails,
      failureReasons,
      backupPath: resolvedBackupPath,
    };
  } finally {
    releaseRebuildLock(lockPath);
  }
}
