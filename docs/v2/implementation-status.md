# G2M v2 Implementation Status

## Phase 0 — Specification Freeze

Status: complete at Amendment 1 (`746a942`).

## Phase 1 — Frozen Patch Authority

Status: complete in the Phase 1 implementation commit.

Implemented:

- immutable Artifact Writer using temporary file, file flush, atomic rename,
  re-read, and exact-byte SHA-256 verification;
- exact `frozen.patch` and `frozen-patch.json` artifacts per execution;
- `patch_blob_hash` over exact patch bytes;
- canonical `change_set_hash` with rename represented as delete plus add;
- regular file, deletion, executable-mode, symlink, gitlink, nested path, new
  file, and binary patch coverage;
- Review Bundle bindings for artifact identity, both hashes, patch bytes, and
  canonical change-set entries;
- CRITICAL `patch.frozen` event binding artifact ID/path, both hashes, base
  revision, and byte count;
- ACCEPT post-apply change-set verification and immutable
  `apply-evidence.json` before `patch.applied`;
- Recovery comparison updated to use `change_set_hash` rather than legacy diff
  identity.

Verification:

- targeted Phase 1 tests pass;
- complete suite: 351 passed, 5 skipped after Phase 2;
- typecheck and build passed.

## Phase 2 — Durable Journal

Status: complete in the Phase 2 implementation commit.

Implemented:

- a unified `JournalWriter` with `append`, `flush`, and `close` operations;
- NORMAL-event batching and a CRITICAL flush barrier that durably writes every
  preceding queued event in physical append order;
- the frozen v2 snake_case event schema, including schema version, execution
  identity, domain, durability, sequence, and complete hash-chain bindings;
- per-execution `executions/<execution-id>/state-events.ndjson` journals;
- domain separation so storage, recovery, and projection facts cannot drive
  lifecycle state transitions;
- valid-prefix replay with explicit `TRUNCATED_TAIL` reporting for a final
  unterminated line;
- hard failure for malformed middle or completed lines and broken hash chains;
- write refusal after a truncated tail so recovery evidence cannot be appended
  over an uncertain journal;
- a deprecated flat-directory adapter for existing internal callers while CLI
  writes use only the v2 execution-directory layout.

Verification:

- targeted Journal, persistence, reducer, Review ingress, and CLI E2E tests
  pass;
- complete suite: 351 passed, 5 skipped;
- typecheck and build passed.

## Phase 3 — Rebuildable SQLite Projection

Status: complete in the Phase 3 implementation commit.

### Architecture

A disposable SQLite index that mirrors the authoritative execution Journals.
The Journal is the source of truth; the projection can always be regenerated
from `stateRoot/executions/<execution-id>/state-events.ndjson` plus the
trusted local workspace configuration. The projection never invents facts
that the Journal did not record.

### Files

- `src/projection/schema.ts` — frozen schema (see below), `PROJECTION_SCHEMA_VERSION = 1`.
- `src/projection/database.ts` — `StateDatabase` connection wrapper: applies
  the frozen schema, owns the connection pragmas, and exposes a typed
  `transaction()` helper using `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.
- `src/projection/execution-projector.ts` — `ExecutionProjector` reduces one
  Journal into queryable rows. Also owns `seedWorkspaces(workspaces, nowMs)`
  so the CLI and the rebuild function share the same workspace-seeding
  UPSERT.
- `src/projection/rebuild.ts` — `rebuildProjection({ stateRoot, workspaces, nowMs })`
  recreates the projection from scratch.
- `src/cli/index.ts` — `configureEngine` opens `stateRoot/g2m-state.sqlite`,
  constructs the projector, and seeds the `workspaces` table from
  `config.workspaces` on every CLI invocation.

### Frozen schema (Phase 0 / Phase 3)

Nine tables, all `STRICT`:

| Table | Purpose |
|-------|---------|
| `executions` | one row per `execution_id`; state, task binding, base revision, runtime/model/fingerprint, retention class |
| `workspaces` | one row per `workspace_id`; `canonical_path` and `updated_at` |
| `workspace_locks` | (reserved; not yet projected — in-memory `WorkspaceLock` is authoritative) |
| `reviews` | one row per `review_bundle_id`; decision, `review_id`, `review_hash`, `applied_at` |
| `artifacts` | one row per `artifact_id`; `kind`, `path`, `sha256`, `bytes`, `immutable` |
| `storage_usage` | (reserved for Storage Manager) |
| `storage_reservations` | (reserved for Storage Manager) |
| `recovery_cases` | one row per `execution_id`; `status` (`OPEN` / `RESOLVED`), `reason`, `created_at`, `resolved_at` |
| `projection_meta` | key/value pairs; stores `schema_version`, `rebuild_status`, `rebuild_at`, and per-execution `execution:<id>:last_event_hash`, `execution:<id>:last_event_seq`, `execution:<id>:stale` |

`PROJECTION_SCHEMA_VERSION = 1`. `FROZEN_SCHEMA_SQL` is the canonical
schema source — the rebuild function and the live `StateDatabase` both apply
it verbatim, and a `schema_version` row in `projection_meta` records the
version of any open database.

### Connection pragmas (frozen)

Every `StateDatabase` opens with:

```text
PRAGMA journal_mode = WAL
PRAGMA synchronous  = NORMAL
PRAGMA busy_timeout = 5000
```

`WAL` lets the engine append a CRITICAL event while a query runs in another
connection. `synchronous = NORMAL` pairs with WAL for crash-safe durability
at near-full speed. `busy_timeout = 5000` lets short-lived readers wait out
a writer instead of immediately erroring. `timeout: 5_000` is also passed
to `new DatabaseSync(path, { timeout })` so unhandled waiters fail
deterministically.

### Journal-first ordering

The engine sequence for every lifecycle transition is:

1. `eventStore.append(...)` — for a CRITICAL event, the underlying
   `JournalWriter` flushes the entire pending NORMAL queue and `fsync`s the
   descriptor before returning.
2. `reduce(state, event, { fingerprintRegistry })` — pure function in
   `src/events/reducer.ts`, returns the new lifecycle state.
3. `projectDurable(event, state)` — runs **only** when
   `event.durability === "CRITICAL"`. Skips NORMAL events entirely.

This guarantees that no SQLite write can lead the Journal: a CRITICAL event
is durable on disk before the projector sees it. `recovery.required` is
intentionally a `lifecycle` event so it drives the state machine; only
`recovery.reconciled` is in the `recovery` domain and is filtered out by
the reducer (`if (event.domain !== "lifecycle") return state`). Storage,
recovery, and projection domain events never advance the lifecycle state.

### Projection surface

`ExecutionProjector.project(event, state, metadata)` writes the following
inside a single `BEGIN IMMEDIATE` transaction:

- `task.created` → `createExecution` (workspace_id and base_revision read
  from the event payload, not metadata).
- Subsequent events → `updateExecution` (state, updated_at, runtime,
  artifact_path, worktree_path, review_bundle_id, retention class).
- `patch.frozen` → `artifacts` row with `kind='frozen.patch'`,
  `immutable=1`, full `sha256`/`bytes`/path binding.
- `review.requested` and any `review.decision.*` → `reviews` row keyed by
  `review_bundle_id`. Decision is parsed from the event type suffix
  (`review.decision.accept` → `decision='ACCEPT'`).
- `recovery.required` → opens a `recovery_cases` row with `status='OPEN'`.
- `recovery.reconciled` → sets the matching row to `status='RESOLVED'` with
  the reconciliation timestamp.
- `projection.*` domain events → projector returns immediately
  (`if (event.domain === "projection") return;`), so the stale markers
  never become rows.
- After every event, two meta keys are recorded:
  `execution:<id>:last_event_hash` and `execution:<id>:last_event_seq`.

### `projection.stale` handling

`projectDurable` is wrapped in a `try { ... } catch` that re-throws only
if the marker cannot be appended. The recovery rule is:

- A failed projection must not break the engine result. The `reduce()` step
  already produced the correct state, and the CRITICAL event is already in
  the Journal. So the catch handler appends a CRITICAL
  `projection.stale` event to the same execution's journal with
  `{ failed_event_id, failed_event_hash, reason }` and lets the engine
  continue. The next CRITICAL append's `projectDurable` will then succeed
  if the SQLite issue was transient, or it will produce another
  `projection.stale` if it persists.
- The `rebuildProjection` function will re-derive the truth from the
  Journal and re-write the projection atomically. The accumulation of
  `projection.stale` events in the Journal is the canonical signal that
  the projection is out of date.

`Engine keeps the durable lifecycle result when SQLite projection fails`
is covered by `tests/execution/engine.test.ts` — the test injects a
projection that always throws and asserts that `pending.state` is still
`REVIEW_PENDING` and a `projection.stale` event with the injected reason
is in the Journal.

### Rebuild behaviour (`rebuildProjection`)

`rebuildProjection({ stateRoot, workspaces, nowMs })` is the only way to
create the projection from scratch and is also the recovery tool for a
corrupted or missing `g2m-state.sqlite`. Algorithm:

1. **Acquire the process-level rebuild lock.** A new exclusive
   `stateRoot/g2m-state.sqlite.lock` is created with `openSync(path, "wx")`
   (O_EXCL). If the lock already exists, the rebuild fails fast with
   `RebuildLockHeldError`. The lock is released in a `finally` block
   so a mid-rebuild error never pins it.
2. **Per-execution scan.** The rebuild enumerates
   `stateRoot/executions/<id>/` directories (sorted lexically) and loads
   each journal independently via
   `loadSingleExecutionJournal(path, expectedExecutionId)`. A single
   corrupted journal (invalid JSON, broken chain, `attemptId` mismatch,
   unsupported `schema_version`, missing file) is recorded as a
   per-execution `load-error` and the remaining executions are still
   rebuilt. The load function is wrapped in a single `try / catch` so
   any throw (including `restoreEvent` rejecting an unsupported
   `schema_version`) is funnelled into the per-execution error bucket
   instead of aborting the whole rebuild.
3. For each execution that loaded cleanly:
   - Build a **fresh** `FingerprintRegistry` (rebuild must never inherit
     runtime state).
   - Replay events in physical file order (no re-sorting by timestamp or
     `seq`).
   - For each event: `state = reduce(state, event, { fingerprintRegistry })`
     then `projector.project(event, state)`. The projector only fills rows
     that the Journal already justified.
   - If the journal tail was `TRUNCATED_TAIL`, keep the valid-prefix
     rows that were projected, then set
     `execution:<id>:stale = "TRUNCATED_TAIL"`. The execution row itself
     is preserved (it is real, the suffix is what was uncertain).
4. Seed the `workspaces` table from the trusted config (UPSERT; never
   deletes rows the caller omitted).
5. Set `rebuild_status = "complete"` and `rebuild_at = String(nowMs)`.
6. `PRAGMA wal_checkpoint(TRUNCATE)` on the temp database, then close it.
7. **Settle the old database.** Before mutating any file at the
   official path, `settleOldDatabase` opens the existing
   `g2m-state.sqlite` and runs `PRAGMA wal_checkpoint(TRUNCATE)`. This
   flushes any uncheckpointed WAL data into the main file. If the open
   or the checkpoint throws (corrupted file, or another process is
   still writing to the database), the rebuild aborts with
   `RebuildOldDatabaseUnsettledError`. **The `-wal` / `-shm` siblings
   are never touched** in this branch — the old database is left
   exactly as it was, and the lock is released before the error
   propagates.
8. **Safe cleanup + atomic replace with rollback.** Only after the
   settle succeeds do we delete the (now empty) `-wal` and `-shm`
   siblings at the old path. Then `commitDatabaseReplace` does the two
   renames:
   - If `g2m-state.sqlite` exists, move it to
     `backups/g2m-state-<nowMs>.sqlite`.
   - Rename `g2m-state.sqlite.rebuild-<nowMs>.tmp` → `g2m-state.sqlite`.
   - If the second rename throws, the previous database is **restored
     from the backup** to the official path, the temp file is removed,
     and the original error is rethrown. The official
     `g2m-state.sqlite` is never observed empty (within the documented
     rebuild window).
9. The new DB was checkpointed before close, so any `-wal` / `-shm`
   shadows that ended up at the official path are empty and safe to
   delete.

The function never invents execution, review, artifact, recovery_case, or
storage rows that are not in the Journal. A contradictory journal
(non-`task.created` first event, terminal state receiving an event,
incomplete artifact binding) is recorded as
`execution:<id>:stale = <reducer error message>` and a `{ executionId,
reason }` entry in `failureReasons`. No execution row is created for an
execution whose Journal is fundamentally contradictory.

### Concurrency strategy (explicit choice)

The two-rename swap (old → `backups/`, then new → official path) is not
OS-atomic. Three options were considered:

- A. **Process-level exclusive lock around the rebuild** (chosen).
- B. Platform-level atomic replace (`MoveFileTransact` on Windows,
  `renameat2(RENAME_EXCHANGE)` on Linux).
- C. Soft contract: rebuild is single-process; readers are warned away.

Option A is the chosen strategy. It does not require OS-specific code,
it is portable across the supported test matrix, and it composes
naturally with the rebuild's other failure paths (every error in the
rebuild releases the lock in a single `finally` block). The lock file
at `stateRoot/g2m-state.sqlite.lock` is opened with
`openSync(path, "wx")` (O_EXCL) — the second opener fails. The lock
serializes rebuilds; it is not a guarantee about concurrent readers.

The documented reader contract is: do not open `g2m-state.sqlite`
during a rebuild. There is a small window between the first rename
(old DB moves into `backups/`) and the second rename (new DB moves
into place) where a brand-new reader would see "file not found".
New readers should retry; readers that already hold a file handle
continue to read the old file (now at `backups/`) until they close
it. The rebuild lock prevents a second rebuild from compounding
this window.

Rebuild report shape:

```ts
interface RebuildReport {
  readonly rebuiltExecutions: number;    // executions that produced an executions row
  readonly staleExecutions: number;      // executions marked stale (truncated tail OR reducer failure)
  readonly truncatedTails: number;       // subset of staleExecutions flagged TRUNCATED_TAIL
  readonly failureReasons: ReadonlyArray<{ executionId: string; reason: string }>;
  readonly backupPath: string;           // path of the previous DB in backups/, "" if none
}
```

`tests/projection/rebuild.test.ts` covers:

- Happy path: valid journal through `task.created … review.requested`
  rebuilds to `REVIEW_PENDING` with `review_bundle_id="bundle-1"`,
  `rebuild_status="complete"`, and a previous DB is moved into `backups/`.
- Truncated tail: a non-`task.created` last line keeps the valid prefix
  (one `task.created` → `PLANNED` row) and is marked
  `execution:<id>:stale = "TRUNCATED_TAIL"`.
- Contradictory history: a first event that is not `task.created` is
  caught by the reducer; no execution row is created, the meta is
  populated, and the failure is reported in `failureReasons`.

### Verification

- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `npm test` → **372 passed, 5 skipped, 0 failed** across 37 test files
  (34 passed, 3 skipped). The 4 newest tests are:
  - `rebuildProjection > treats a journal with an unsupported
    schema_version as a per-execution load error` (Fix 1: `restoreEvent`
    throwing for an unsupported `schema_version` is caught by
    `loadSingleExecutionJournal` and reported as a per-execution stale
    entry, not as a rebuild-wide failure).
  - `rebuildProjection > acquires and releases the process-level rebuild
    lock on the happy path`.
  - `rebuildProjection > rejects a concurrent rebuild while another holds
    the lock` (the second caller fails with `RebuildLockHeldError`).
  - `rebuildProjection > aborts with RebuildOldDatabaseUnsettledError when
    the old DB cannot be settled` (Fix 3: the rebuild refuses to delete
    `-wal` / `-shm` siblings or rename a database it cannot open +
    checkpoint, and releases the lock before propagating the error).
- `git diff --check` → no whitespace conflicts (only the normal
  Windows `LF will be replaced by CRLF` checkout warning).
- Phase 1 / Phase 2 suites (`tests/projection`, `tests/execution`,
  `tests/cli`) all green; no behaviour regression.

The 5 skipped tests are **all** pre-existing "real mcode" suites that
require the real mcode binary and a host-level opt-in env flag. They are
not skipped because of bugs or flakiness; they are gated so the default
test run stays hermetic. The exact list:

| Test file | Gate | Tests |
|-----------|------|-------|
| `tests/execution/real-mcode.engine.e2e.test.ts` | `G2M_RUN_REAL_MODIFY_E2E=1` | 1 |
| `tests/workers/mcode/real-adapter.smoke.test.ts` | `G2M_RUN_REAL_E2E=1` | 1 |
| `tests/workers/mcode/permission.behavior.e2e.test.ts` | `G2M_RUN_PERMISSION_PROBE=1` | 3 |

These same 5 tests were already skipped under the Phase 2 baseline
("351 passed, 5 skipped"). They are unchanged by Phase 3 and remain
skipped on developer machines unless the corresponding env flag is
explicitly set.

### Designed exception: `F:\.g2m-workspace-tests`

`tests/setup.ts` routes `os.tmpdir()` to
`F:\gpt-mmx\.tmp\test-runs\` so that ordinary test fixtures live inside
the project workspace (per the "no C: drive temp files" rule). This
unfortunately puts every `mkdtemp`-created directory **inside** the G2M
git repository, so a test that creates a non-git subdirectory under the
default temp and expects `git rev-parse HEAD` to fail there will
inadvertently find the parent G2M repository.

Two Phase 1 tests are vulnerable to this and were updated in Phase 3:

- `tests/workspace/clean-check.test.ts` — `"throws NOT_GIT_REPO for a non-git directory"`
- `tests/workspace/workspace.test.ts` — `"throws NOT_GIT_REPO for a non-git directory"`

Both now resolve `repositoryRoot` from `import.meta.url`, then allocate
their `plainDir` under `resolve(repositoryRoot, "..", ".g2m-workspace-tests")`
— a sibling of the G2M repository at the drive root that is **not**
inside any git repository. The test suite does `mkdir -p` on the parent
once and cleans the per-test subdirectory in `afterAll`. The parent
directory is left in place across runs (intentional — it is the
dedicated location for the NOT_GIT_REPO fixture).

## Remaining phases

Startup Backfill, Recovery, crash-safe ACCEPT, cross-process lease,
Process Supervisor, Storage Manager, GC, operational CLI, runtime
hardening, and CI matrices.
