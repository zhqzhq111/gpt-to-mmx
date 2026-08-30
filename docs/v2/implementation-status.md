# G2M v2 Implementation Status

## Phase 0 — Specification Freeze

Status: complete at Amendment 2.

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
| `workspace_locks` | filesystem lease projection; owner files remain authoritative and rows are lease_id-conditional |
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

## Phase 4 — Startup Backfill

Status: complete for the Phase 4 Task 3 implementation.

### Architecture and source-of-truth rules

Startup Backfill treats each execution Journal at
`stateRoot/executions/<execution-id>/state-events.ndjson` as authoritative.
It scans only direct execution directories, in lexical directory-name order,
and never sorts or rewrites Journal records. The trusted workspace seeds come
from the current local CLI configuration; the Journal remains authoritative for
execution facts.

Each execution is loaded and reduced independently. A fresh in-memory
`FingerprintRegistry` is created for every valid Journal, so backfill never
inherits runtime fingerprint state. The reducer runs in physical Journal order
and produces the replay steps used by the projector.

An execution is current only when all of these conditions hold:

- its execution row exists;
- its `execution:<id>:stale` marker is absent;
- `execution:<id>:last_event_hash` equals the final Journal event hash;
- `execution:<id>:last_event_seq` equals the final Journal event sequence;
- the projected `task_id` equals the replayed task ID;
- the projected lifecycle state equals the replayed final state; and
- `updated_at` equals the timestamp of the final non-projection-domain event.

Any divergence causes a per-execution atomic replacement. The replacement
deletes execution-scoped derived rows and execution metadata, replays the
validated steps, and commits the reset and replay in one SQLite transaction.
Invalid sources are atomically invalidated instead: their execution-scoped
rows and metadata are removed and only a stale reason is retained. One bad
execution therefore cannot prevent healthy executions from being repaired.

Projection-domain events, including `projection.stale`, are cursor-only for
the projector. They advance the execution event hash/sequence cursor but do
not change lifecycle state or create artifact, review, or recovery rows. A
backfill therefore repairs the projection once without appending a
`projection.repaired` event or entering a recovery loop.

A Journal with a `TRUNCATED_TAIL` has its valid prefix replayed and replaced,
then receives the `TRUNCATED_TAIL` stale marker in the same replacement
transaction. Missing, malformed, broken-chain, execution-mismatched, or
unsupported-schema Journals invalidate only the affected execution. An empty
Journal invalidates any existing projection as `EMPTY_JOURNAL`. A contradictory
history or incomplete replay is reduced independently, recorded as a stable
reducer error, and invalidated without aborting the directory scan.

### CLI integration and scope boundary

`configureEngine` resolves `stateRoot`, opens `g2m-state.sqlite`, runs
`backfillProjection` with the configured workspace seeds and `Date.now()`, and
only then constructs the live `ExecutionProjector`, `EventStore`, and engine.
Both `run` and `recover` pass through this startup path. Phase 5 adds a
fail-closed recovery classification after this backfill; a database-open,
backfill, scan, or coordinator failure no longer starts an engine without a
recovery decision. The `run` and `recover` paths close their EventStore and
projection database. `probe` and standalone `review` do not call
`configureEngine`, so they do not create or open a startup state database and
their public output contracts are unchanged.
Startup Backfill never appends Journal events, invokes `RecoveryResolver`,
inspects processes, reclaims leases, or reconciles ACCEPT transactions.

Phase 5 remains explicitly out of scope here: Recovery Scanner and process
supervision, cross-process leases and reclaim, Storage
Manager, GC, operational CLI expansion, runtime hardening, and CI matrices are
not implemented by this phase.

### Verification

The complete test run for this Task 3 checkpoint reported **392 passed, 5
skipped, 0 failed** across **38 test files** (**35 passed, 3 skipped**). The
five skips are the existing explicitly gated real-mcode tests: one real
modify E2E, one real adapter smoke test, and three permission-behavior probes.
The new Windows-hermetic CLI E2E covers two run-to-BLOCK executions, stale
SQLite repair from the old Journal, byte-for-byte Journal preservation, no
recovery/projection-repair event, completed backfill metadata, and probe /
standalone-review exclusion.

## Phase 5 — Startup Recovery

Status: complete after the Phase 5 startup recovery implementation.

### Recovery Scanner

`EventStore` now has an opt-in tolerant execution-directory load mode. Strict
loading remains the default. In tolerant mode, one malformed, missing,
schema-incompatible, execution-mismatched, or hash-broken Journal becomes a
per-execution `LOAD_ERROR`; other Journals remain readable and new healthy
executions can still start. A truncated tail remains a separate
`TRUNCATED_TAIL` issue and neither kind can be appended to.

`scanRecovery` is read-only and derives deterministic issues from the
authoritative Journal, the Phase 4 projection, event-bound artifact bytes and
hashes, outcome files, direct worktree candidates, and lock-file candidates.
It reports active/non-terminal executions, unknown workers, projection drift,
missing or mismatched frozen patch/review/apply artifacts, missing terminal
outcomes, partial ACCEPT sequences, retained worktrees, and locks that require
lease validation. It never edits Journals or SQLite, deletes worktrees or lock
files, runs Git, kills processes, or calls the resolver.

### Safe-hold integration

`resolveRecovery` now treats `processStatus = "unknown"` as insufficient proof
that a worker exited. This check precedes terminal, result, and clean-workspace
heuristics, so startup cannot guess a successful or unsuccessful outcome.
`runStartupRecovery` groups SAFE_HOLD issues by execution, skips corrupt,
truncated, terminal, and report-only cases, and appends at most one CRITICAL
`recovery.required` event for each valid active execution. The order is
Journal append/flush, reducer transition to `RECOVERY_REQUIRED`, then SQLite
projection. A projection failure records `projection.stale` after retaining
the durable recovery event.

Startup recovery is idempotent: a later scan sees the terminal
`RECOVERY_REQUIRED` state and appends no duplicate. Explicit
`g2m recover --execution-id X` excludes X from automatic startup safe-hold so
its user-supplied `--process-status` remains meaningful; other unsafe
executions are still classified. Startup closes EventStore and SQLite on
failure. A quarantined unrelated Journal does not block a healthy new run.

Terminal missing-outcome cases, malformed or truncated Journals, and lock or
worktree candidates are report-only in this phase. They remain untouched for
operator handling and later phases. Phase 5 does not retry, resume, apply or
complete ACCEPT, reclaim leases, delete worktrees/locks, run ProcessSupervisor,
or perform Storage Manager/GC operations. Those remain Phase 6, Phase 7,
Phase 8, Phase 9, and Phase 10 work respectively.

### Verification

The fresh final suite reports **415 passed, 5 skipped, 0 failed** across
**37 test files passed and 3 skipped**. `npm run typecheck`, `npm run build`,
and `git diff --check` also pass. The suite retains the five explicit
real-mcode skips: one real modify E2E, one adapter smoke test, and three
permission-behavior probes. The Phase 5 CLI E2E covers an active Journal being
safe-held exactly once, healthy runs continuing, and repeated startup avoiding
duplicate recovery events.

## Phase 6 — Crash-safe ACCEPT

Status: complete.

### Architecture

Crash-safe ACCEPT closes the last correctness gap in the G2M v2 lifecycle:
a partial ACCEPT execution — one whose previous process died after writing
`review.accept.prepared` but before `review.accept.completed` is durable —
must be provably correctable on restart. Phase 6 introduces the **Accept
Reconciler** and the new durable `patch.apply.started` event, and binds
every correctness-critical artifact (review, frozen patch, apply-evidence,
outcome) to the Journal by hash.

The recovery scanner now classifies three partial-ACCEPT kinds
(`PARTIAL_ACCEPT_PREPARED`, `PARTIAL_ACCEPT_APPLY_STARTED`,
`PARTIAL_ACCEPT_APPLIED`) so the startup path can distinguish them. The
startup safe-hold deliberately defers partial ACCEPT to the explicit
`g2m recover --execution-id X` flow — auto-`recovery.required` would make
`ACCEPTED` unreachable, since the terminal event has not yet been written.
Startup reports `acceptRecoveryBlockedWorkspaces` so the CLI can refuse
new G2M runs against an unresolved partial ACCEPT in the same workspace
without blocking unrelated workspaces (plan §40-§42).

### Files

- `src/events/events.ts` — added `patch.apply.started` to the
  `TaskEventType` union.
- `src/events/store.ts` — added `patch.apply.started` to the
  `CRITICAL_TYPES` set so every CRITICAL barrier flushes it.
- `src/execution/state-machine.ts` — `ACCEPT_PREPARED` now self-loops on
  `patch.apply.started`, preserving the "still in ACCEPT_PREPARED" status
  while the apply runs.
- `src/workspace/worktree.ts` — split `applyAcceptedPatch` into
  `preflightAcceptedPatch` (read-only target / patch validation) and
  `applyPreflightedPatch` (the actual `git apply` + change-set verify).
  `applyAcceptedPatch` is now a thin wrapper for backward compatibility
  with the engine and existing tests. The apply step pipes
  `preflight.patchBytes` to `git apply --check --binary -` /
  `git apply --binary -` via stdin so the bytes that were hash-verified in
  preflight are exactly the bytes that get applied (P0#3). After apply,
  the function now verifies the **full** working-tree change set (no
  pathspec) so an unrelated user edit or untracked file in the target
  workspace flips the comparison to DIVERGED, never silently accepted
  (P0#4).
- `src/workspace/change-set.ts` — added
  `computeFullWorkingTreeChangeSet`, which stages `git add -A` (no
  pathspec) against the frozen base so the reconciler can detect
  unrelated user edits, partial patch writes, or extra files.
- `src/recovery/accept-reconciler.ts` — the Phase 6 Accept Reconciler.
  Implements the full disposition table from plan §17:
  `NOT_PARTIAL_ACCEPT`, `ALREADY_ACCEPTED`, `PROCESS_NOT_PROVEN_GONE`,
  `RESUMED_AND_ACCEPTED`, `RECONCILED_AND_ACCEPTED`, `RECOVERY_REQUIRED`.
  Zero mutations when `processStatus ∈ {alive, unknown}`. SHA-256 verifies
  every correctness-critical artifact before any target write.

  - P0#1 — a partial ACCEPT with `patch.apply.started` durable and the
    target at `EXACT_EXPECTED_CHANGE_SET` is auto-reconciled: the
    reconciler freezes the missing artifacts, appends `patch.applied`
    and `review.accept.completed`, and records the ReplayGuard. Without
    this disposition, the most common crash window
    (apply succeeded, journal tail lost before `patch.applied`) would
    be wrongly classified as `RECOVERY_REQUIRED`.
  - P0#2 — `PATCH_APPLIED` recovery is verify-only. When the Journal
    already contains `patch.applied`, the reconciler hashes the
    on-disk `apply-evidence.json` and `outcome.json`, requires them to
    match the `patch.applied` payload bindings, and only appends
    `review.accept.completed`. The two artifacts are never overwritten
    by the recovery path; mismatch or missing artifacts
    → `RECOVERY_REQUIRED`.
  - P1#1 — every `RECOVERY_REQUIRED` verdict whose previous process
    is gone is also persisted to the Journal as `recovery.required`
    (CRITICAL), so the safe-hold is durable, not just a string
    returned to the caller. Phase 6.1 unifies every proven-gone
    failure path (missing prepared binding, missing
    `review_bundle_hash`, verify* failures, classifyTarget failure,
    HEAD_MOVED, DIVERGED, …) through a single `failAcceptRecovery`
    helper. Projection failure during the helper now appends
    `projection.stale` (mirroring `appendReduceProject`) instead of
    being silently swallowed. The three zero-mutation early-exits
    (ALREADY_ACCEPTED, PROCESS_NOT_PROVEN_GONE, NOT_PARTIAL_ACCEPT)
    are explicitly excluded from this helper, per plan §19.
  - P1#2 — the projection's `artifact_path` is now
    `<artifactRoot>/<executionId>` (absolute), passed explicitly into
    `appendReduceProject`. Previously it was `attemptId` alone, which
    produced a relative path that did not match the actual artifact
    directory.
  - Phase 6.2 — orphan pre-commit artifact recovery. The normal
    ACCEPT order writes `apply-evidence.json` then `outcome.json`
    then `patch.applied`. A crash anywhere in the middle used to be
    ambiguous: the pre-existing artifact's `recovery_mode: false` and
    `applied_at: <real ts>` legitimately differ from what Recovery
    would synthesize, so a byte-equality check would wrongly refuse.
    The reconciler now classifies the on-disk state into
    `both_missing` / `evidence_only` / `both_present` /
    `order_violation` / `semantic_mismatch`. The first three reuse
    the existing artifact bytes (preserving the audit fields) and
    bind their exact SHA-256 in the journal. The last two
    → `RECOVERY_REQUIRED`. Case A (RESUMED) additionally refuses to
    re-apply when `apply-evidence.json` is already on disk while the
    target is `CLEAN_BASE` — the previous apply was externally undone,
    so re-applying would silently clobber a workspace the user has
    already modified.
- `src/recovery/scanner.ts` — added `PARTIAL_ACCEPT_APPLY_STARTED` to
  `RecoveryIssueKind` and `ISSUE_PRIORITY`, and tightened the
  partial-accept classifier so it now reports
  `apply.started && !applied` separately from
  `prepared && !apply.started`.
- `src/recovery/startup.ts` — added `PartialAcceptKind`,
  `AcceptRecoveryBlockedWorkspace`, and
  `acceptRecoveryBlockedWorkspaces` on the report. The startup
  safe-hold now skips partial ACCEPT (no auto-`recovery.required`).
- `src/cli/index.ts` — `g2m recover` now delegates to
  `runAcceptRecovery` when the execution is in `ACCEPT_PREPARED` or
  `PATCH_APPLIED`, emitting the new `g2m.accept.recovery` event shape.
  All non-partial executions still fall back to `resolveRecovery`.
- `src/execution/engine.ts` — refactored the ACCEPT branch:
  - Freezes `review.json` as an immutable execution artifact BEFORE
    `review.accept.prepared`.
  - Emits `patch.apply.started` (CRITICAL) BETWEEN preflight and the
    real `git apply` so a crash mid-apply is distinguishable from
    "apply never started".
  - Pipes `preflight.patchBytes` to `git apply` via stdin (P0#3) and
    verifies the **full** working-tree change set after apply (P0#4).
  - Freezes `apply-evidence.json` and `outcome.json` BEFORE
    `patch.applied`, satisfying Phase 0 Artifact-First (plan §28-§30).
  - `review.accept.completed` payload now binds the full result
    (review + patch + apply-evidence + outcome hashes).
  - `ReplayGuard.record` moved AFTER `review.accept.completed` is
    durable (plan §32-§33). The guard is a derived anti-replay cache;
    the Journal is the authority. A failure here is best-effort
    maintenance (P1#3) and does not surface as a failed ACCEPT.
  - `removeTemporaryWorktree` after `review.accept.completed` is also
    best-effort (P1#3); ACCEPT is already durable, so a cleanup
    failure cannot reverse it. The leftover worktree will surface as
    a `RETAINED_WORKTREE_CANDIDATE` for the operator.
  - REVISE / BLOCK decisions now also freeze `outcome.json` so the
    scanner's `MISSING_OUTCOME` check is satisfied for every terminal
    execution.
- `src/projection/execution-projector.ts` — `projectArtifact` now also
  records the `apply-evidence.json` and `outcome.json` artifacts when
  `patch.applied` is projected. State cursor and reducer advance
  unchanged.

### Journal ordering (plan §5)

The normal ACCEPT path is now:

```
validateReview → freeze review.json → review.accept.prepared (CRITICAL)
→ preflight → patch.apply.started (CRITICAL) → git apply --check
→ git apply --binary → apply-evidence.json → outcome.json
→ patch.applied (CRITICAL) → review.accept.completed (CRITICAL)
→ ReplayGuard.record (AFTER journal) → best-effort worktree cleanup.
```

### Recovery disposition table (plan §20-§25 + Phase 6.2)

```
state              target                    verdict
ACCEPT_PREPARED    CLEAN_BASE                RESUMED_AND_ACCEPTED
                       (no apply-evidence.json on disk; git apply re-runs)
ACCEPT_PREPARED    CLEAN_BASE                RECOVERY_REQUIRED (Phase 6.2)
                       (apply-evidence.json exists; workspace externally
                        modified after previous apply; operator decision)
ACCEPT_PREPARED +  EXACT_EXPECTED_CHANGE_SET RECONCILED_AND_ACCEPTED (P0#1 +
  apply.started                                    Phase 6.2 orphan)
  - both_missing:  create both recovery artifacts
  - evidence_only: preserve evidence; create outcome
  - both_present:  preserve both; reuse their hashes
  - order_violation / semantic_mismatch: RECOVERY_REQUIRED
PATCH_APPLIED      EXACT_EXPECTED_CHANGE_SET RECONCILED_AND_ACCEPTED (P0#2)
                       (verify-only; never overwrite artifacts)
ACCEPT_PREPARED    EXACT_EXPECTED_CHANGE_SET RECOVERY_REQUIRED
                       (no apply.started → cannot prove G2M applied the change)
PATCH_APPLIED      CLEAN_BASE                RECOVERY_REQUIRED
                       (applied result unprovable)
PATCH_APPLIED/...  DIVERGED                  RECOVERY_REQUIRED
PATCH_APPLIED/...  HEAD_MOVED                RECOVERY_REQUIRED
any                alive / unknown           PROCESS_NOT_PROVEN_GONE
any                review.accept.completed   ALREADY_ACCEPTED (no-op)
```

Every `RECOVERY_REQUIRED` verdict with a proven-gone process is also
persisted to the Journal as `recovery.required` (CRITICAL, P1#1 +
Phase 6.1 unified helper). The safe-hold is durable, not just a
string returned to the caller.

### Verification

- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `npm test` → **438 passed, 5 skipped, 0 failed** across **38 test files
  passed and 3 skipped** (20 new tests in
  `tests/recovery/accept-reconciler.test.ts` cover the full disposition
  table, frozen-patch tampering, review.json tampering, idempotent
  recovery, P0#1 / P0#2 / P1#1 / Phase 6.1 unified safe-hold, and
  Phase 6.2 orphan pre-commit artifact handling; 2 new tests in
  `tests/workspace/worktree.test.ts` cover P0#3 stdin apply and P0#4
  full change set).
- The five pre-existing real-mcode skips remain unchanged.

## Phase 7A — Durable Lease Foundation

Status: **COMPLETE / SEALED** on branch `codex/phase-7-durable-lease`.

Phase 7A implements the bottom lease layer and Engine lifecycle integration:

- filesystem owner leases use physical workspace identity and `open("wx")`;
- heartbeat sidecars use atomic replacement;
- release and stale reclaim use a shared reclaim guard and second ownership check;
- lease inspection refuses automatic reclaim for active, unknown, foreign-host,
  and `RECOVERY_REQUIRED` evidence;
- `workspace_locks` is a rebuildable SQLite projection;
- Engine holds the same lease through `REVIEW_PENDING`, reuses it in
  `applyReview()`, releases only after terminal Journal durability, and retains
  it for `RECOVERY_REQUIRED`.
- Startup reconciliation reclaims only stale terminal leases with dead PIDs;
  explicit recovery uses guarded takeover with a new lease ID for the same
  execution; the recovery scanner remains read-only and classifies malformed,
  incomplete, foreign-host, stale, heartbeat-mismatch, recovery-blocked, and
  orphan-heartbeat cases.
- Real child-process E2E covers concurrent acquire, release/retry, and
  concurrent stale-terminal reclaim with exactly one winner.

Final verification: `npm run typecheck`, `npm run build`, and `npm test` pass
with **463 passed, 5 skipped, 0 failed**; `npm run test:lease-process` passes
all 3 real process tests; and `git diff --check` passes. The five skips are
the existing real-mcode tests. Phase 7 is now sealed; later work is limited to
the explicitly separate Phase 8+ operational and runtime phases.

## Phase 8 — Unified Process Supervisor

Status: **COMPLETE / SEALED** on branch `codex/phase-8-process-supervisor`.

Implemented:

- `src/process/supervisor.ts` owns managed process lifecycle, bounded timeout,
  idempotent termination, spawn errors, and exactly-once timeout handling.
- `src/process/platform.ts` provides Windows `taskkill /T` → `/F` escalation
  and POSIX detached process-group `SIGTERM` → `SIGKILL` escalation, both with
  termination confirmation and bounded waits.
- `MCodeAdapter` no longer contains OS kill/watchdog helpers. It delegates
  process lifecycle to the Supervisor while preserving stream-json logical
  completion and prompt wrapper cleanup.
- Verification uses the same Supervisor, preserves stdout/stderr separation,
  records termination evidence, and distinguishes confirmed timeout from
  `termination_unconfirmed`.
- Engine records `recovery.required` and safe-holds the worktree and Lease when
  Verification termination cannot be confirmed; patch/final diff collection is
  skipped in that path.
- Real parent→grandchild process E2E covers cancellation, timeout, and
  Verification timeout on Windows.

Final Gate evidence:

- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `npm test` → **479 passed, 5 skipped, 0 failed** across **43 test files
  passed and 3 skipped**.
- `npm run test:lease-process` → **3/3** real lease process tests passed.
- `npm run test:process-supervisor` → **3/3** real parent→grandchild process
  tests passed.
- `git diff --check` → exit 0.

## Phase 9 — Storage Manager and Storage Admission

Status: **COMPLETE / SEALED** on branch `codex/phase-9-storage-manager`.

Implemented:

- backward-compatible storage policy configuration with minimum free space,
  safety margin, per-execution and managed-storage limits, reservation TTL,
  monitor interval, and retention inputs;
- cross-platform volume identity for Windows drives/UNC shares and POSIX
  device numbers, with same-volume root deduplication;
- symlink-safe logical-byte usage scanning and versioned atomic
  `storage-manifest.json` updates;
- durable reservation records under `state_root/reservations`, SQLite
  `BEGIN IMMEDIATE` admission, all-or-nothing multi-volume inserts,
  conditional idempotent release, and rebuildable `storage_reservations`;
- CRITICAL storage-domain reservation events that never advance lifecycle
  state, plus startup reconciliation that retains `RECOVERY_REQUIRED` rows and
  releases only proven-safe terminal leaks;
- Engine admission before validation passes, reservation release on known
  terminal paths, Worker/Verification storage-cause propagation, exact
  pre-freeze usage checkpoints, and terminal manifest refreshes;
- retention projection (`NORMAL` terminal states receive
  `terminal_timestamp + completed_retention_days`; `RETAINED` and
  `RECOVERY_CRITICAL` remain ineligible), durable reservation-record
  fsync/rename/reread verification, and conservative pre-commit orphan
  reconciliation;
- real two-process reservation race, release/retry, and independent-volume
  E2E coverage.

Final verification on the Phase 9 branch:

- `npm run typecheck` → pass;
- `npm run build` → pass;
- `npm test` → **512 passed, 6 skipped, 0 failed**;
- `npm run test:lease-process` → **3/3**;
- `npm run test:process-supervisor` → **3/3**;
- `npm run test:storage-process` → **3/3**;
- `git diff --check` → pass.

Phase 9 does not perform historical GC; deletion remains a Phase 10 concern.

## Phase 10 — Garbage Collection and Crash-safe Retention Cleanup

Status: **COMPLETE / IMPLEMENTED** on branch `codex/phase-10-garbage-collection`;
Phase 10.1 seal fix included.

Implemented:

- proof-first read-only candidate planning from Journal replay, independently
  derived terminal retention, manifest bytes/hash, path containment, top-level
  `lstat`, workspace Lease, storage Reservation, and projection cross-checks;
- durable self-hashed Tombstones under `state_root/tombstones`, with the
  existing immutable artifact write protocol and permanent retention;
- per-execution `EventStore.closeExecution` so Windows can remove an execution
  directory only after `gc.completed` is durable;
- cross-process `state_root/gc/gc.lock` ownership with metadata, heartbeat,
  same-host dead-PID stale reclaim, and foreign/unknown/live refusal;
- sequential Crash-safe executor ordering: `gc.marked`, repository-bound
  worktree removal, artifact removal, in-memory Tombstone preparation,
  `gc.completed` durable hash commit, exact Tombstone write, writer close, state
  cleanup, and projection cleanup;
- idempotent interrupted-GC resume for mark-only, half-deleted,
  completed-before-Tombstone, pre-completed Tombstone, and
  completed-with-leftover-state windows, plus deterministic fault injection
  hooks used only by tests;
- Recovery Scanner classification and missing-artifact suppression for marked
  operations; projection rebuild from valid Tombstones with no fabricated
  artifact/review/recovery rows and invalid-Tombstone rejection;
- explicit `g2m gc` CLI with read-only default, `--apply`, optional execution
  filter, and no force/bypass flags; only Tombstone-bound SAFE_ORPHAN cleanup;
- real process coverage for two-owner races, crash after `gc.marked`, crash
  after `gc.completed`, and `RECOVERY_REQUIRED` protection.

Final verification:

- `npm run typecheck` → pass;
- `npm run build` → pass;
- `npm test` → **544 passed, 6 skipped, 0 failed** at the Phase 10.1 seal gate;
- `npm run test:gc-process` → **1/1** real process suite passed;
- `git diff --check` → pass.

The six existing skips remain the real mcode/permission probes. Phase 10 does
not add a background GC daemon, generic force deletion, broad orphan cleanup,
or Phase 11 operational commands.

## Phase 11 — Operational CLI

Status: **COMPLETE / SEALED** on branch `codex/phase-11-operational-cli`.

The operational layer exposes read-only `g2m status` and `g2m doctor`, plus
explicit-apply `g2m repair`. Snapshot collection never calls
`configureEngine()` or its mutating startup sequence. It reads Journal,
filesystem manifests, lease files, reservation records, projection metadata,
Recovery Scanner results, and GC candidate results without creating missing
directories or repairing state merely by observing it.

Repair is serialized and durably audited. The lock heartbeat is refreshed during
long repairs; reclaim requires same-host stale evidence plus a proven-dead PID,
and release is conditional on the current operation ID. A fresh plan is built
after lock acquisition and compared with the pre-lock precondition hash, so a
changed plan returns `REPAIR_PLAN_STALE` without dispatching the stale action.
The only Phase 11 actions are
`projection-rebuild`, `gc-resume`, and `storage-reconcile`; there is no generic
force option, `--all`, Journal rewrite, or lease reclaim action. JSON output uses
the stable `g2m.status.v1`, `g2m.doctor.v1`, `g2m.repair-plan.v1`, and
`g2m.repair-result.v1` schemas with snake_case fields. Doctor evaluates raw
volume availability, reservation load, configured free-space floors, and
managed-storage maximums rather than a clamped derived value.

## Phase 12 — Runtime Hardening

Status: **COMPLETE / SEALED** on the integrated
`codex/phase-12-runtime-hardening` HEAD.

Implemented:

- immutable Runtime Identity, Protected Policy, and Fingerprint v2 artifacts;
  PATH/trusted-override launcher revalidation and pinned-model binding;
- strict bounded Worker stream protocol with bounded stdout, stderr, line, and
  event handling; bounded Verification streams with byte-prefix hashes and
  executable revalidation;
- deterministic `RUNTIME_DRIFT` and `VERIFICATION_RUNTIME_DRIFT` handling;
- guarded Repair reclaim with same-host, stale, dead-PID, and ownership
  revalidation;
- zero-mutation Status/Doctor observations, legacy v1 readability, patch-only
  ACCEPT recovery, and evidence-preserving refusal of fabricated history.

The final gate recorded `npm run typecheck` and `npm run build` as
passing, `npm test` as **637 passed, 6 skipped, 0 failed**, and the five real
process suites as **3/3**, **3/3**, **3/3**, **1/1**, and **6/6** respectively
for lease, Process Supervisor, Storage, GC, and Operations. A first full unit
run encountered one Windows `EBUSY` cleanup contention; the controlled failing
test reproduced the probe-lifecycle cause, the minimal settlement fix passed,
and the subsequent original `npm test` rerun passed with zero failures.

Phase 13 — CI / Regression remains explicitly unstarted.

## Remaining phases

- Phase 13 — CI / Regression
