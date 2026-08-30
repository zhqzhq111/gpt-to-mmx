# Phase 4 Startup Projection Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair a missing, stale, or partially written per-execution SQLite projection from authoritative execution Journals before a CLI command constructs the execution engine.

**Architecture:** Add an atomic per-execution replacement operation to `ExecutionProjector`, then build a `backfillProjection` service that scans execution directories, independently validates and reduces each Journal in physical order, compares its cursor and reduced state with SQLite, and replaces only divergent execution rows. Wire the service into `configureEngine` after opening SQLite and before constructing `EventStore`; Phase 5 recovery scanning remains explicitly out of scope.

**Tech Stack:** TypeScript, Node.js 22 filesystem APIs, built-in `node:sqlite`, Vitest, existing `EventStore`, `loadSingleExecutionJournal`, reducer, `FingerprintRegistry`, and `ExecutionProjector`.

---

## Frozen behavioral decisions

1. Journals and immutable artifacts remain authoritative; backfill writes SQLite only and never appends or modifies Journal events.
2. Scan every direct child directory under `stateRoot/executions` in lexical order. Do not rely only on existing SQLite rows because a missing terminal execution row must also be repairable.
3. Load each execution independently with `loadSingleExecutionJournal`. One unreadable, malformed, hash-broken, schema-incompatible, or directory-mismatched Journal must not abort healthy executions.
4. Reduce events in physical file order with a fresh `FingerprintRegistry` per execution. Do not sort by sequence or timestamp.
5. The comparison cursor is the final valid Journal event, including `projection.*` events. A replayed `projection.stale` advances projection cursor metadata but does not create lifecycle rows.
6. An execution is current only when all of these hold: no stale marker; SQLite cursor sequence and hash equal the final valid Journal event; an execution row exists; and its `state`, `task_id`, and `updated_at` equal the reduced Journal result.
7. Repair replaces all execution-scoped derived rows atomically: `artifacts`, `reviews`, `recovery_cases`, `storage_usage`, `storage_reservations`, `executions`, and `execution:*` metadata. `workspaces` and `workspace_locks` are not execution-Journal projections and are not deleted.
8. A valid `TRUNCATED_TAIL` replays the valid prefix, stores `execution:<id>:stale = TRUNCATED_TAIL`, and remains reportable as stale.
9. Empty or invalid Journals cannot justify existing projection rows. Atomically remove execution-scoped rows and retain only an `execution:<id>:stale` reason in projection metadata.
10. Each execution repair is one SQLite transaction. A crash or exception cannot expose a half-deleted/half-replayed execution.
11. Startup backfill is best effort per execution. A database-wide/open failure still follows the existing projection-unavailable fallback so the durable Journal path remains usable.
12. Phase 4 must not invoke `RecoveryResolver`, inspect processes, reclaim locks, reconcile ACCEPT, or append `recovery.required`; those belong to Phase 5 and Phase 6.

## Report contract

Create this public report shape in `src/projection/backfill.ts`:

```ts
export interface BackfillProjectionReport {
  readonly scannedExecutions: number;
  readonly repairedExecutions: number;
  readonly currentExecutions: number;
  readonly staleExecutions: number;
  readonly truncatedTails: number;
  readonly failureReasons: ReadonlyArray<{
    readonly executionId: string;
    readonly reason: string;
  }>;
}
```

`repairedExecutions` counts valid Journals whose execution-scoped projection was atomically replaced. A valid-prefix truncated Journal counts as both repaired and stale. Invalid/empty Journals count as stale but not repaired.

---

### Task 1: Atomic per-execution projection replacement

**Files:**

- Modify: `src/projection/execution-projector.ts`
- Modify: `tests/projection/execution-projector.test.ts`

- [ ] **Step 1: Add failing tests for an atomic full replacement**

Add tests proving that replacement:

- deletes old execution, artifact, review, recovery, storage, and execution-meta rows;
- replays supplied `{ event, state, metadata? }` steps into fresh rows;
- preserves unrelated executions, `workspaces`, and `workspace_locks`;
- rolls back all deletes and writes when any replay step throws;
- treats `projection.stale` as cursor-only: lifecycle state is unchanged, but `last_event_hash` and `last_event_seq` advance.

Use real `StateDatabase`, `EventStore`, and SQL assertions. Do not mock SQLite.

- [ ] **Step 2: Run the targeted tests and confirm RED**

Run:

```powershell
npm test -- --run tests/projection/execution-projector.test.ts
```

Expected: new tests fail because `replaceExecution` and cursor-only projection handling do not exist.

- [ ] **Step 3: Introduce the replay-step contract**

Add:

```ts
export interface ProjectionReplayStep {
  readonly event: TaskEvent;
  readonly state: TaskState;
  readonly metadata?: ProjectionMetadata;
}
```

Refactor `project()` so its current SQL logic lives in a private transaction-free helper. `project()` must retain one transaction per live event.

- [ ] **Step 4: Make projection-domain events cursor-only**

Inside the transaction-free helper, when `event.domain === "projection"`, update only:

```text
execution:<id>:last_event_hash
execution:<id>:last_event_seq
```

Then return without touching execution, artifact, review, or recovery rows.

- [ ] **Step 5: Implement atomic replacement**

Add:

```ts
replaceExecution(executionId: string, steps: readonly ProjectionReplayStep[]): void
invalidateExecution(executionId: string, reason: string): void
```

Both methods must run one `StateDatabase.transaction`. Validate every step is bound to `executionId` before deleting anything. Shared deletion must use parameterized SQL and remove execution-scoped rows plus metadata matching `execution:<id>:%`. `replaceExecution` then replays all steps through the transaction-free helper and clears stale metadata. `invalidateExecution` deletes derived rows and writes only the stale reason.

- [ ] **Step 6: Run targeted tests and confirm GREEN**

Run the Task 1 test command. Expected: all projector tests pass.

- [ ] **Step 7: Run typecheck**

Run `npm run typecheck`. Expected: exit 0.

Do not commit; Sol performs the phase commit after independent review.

---

### Task 2: Journal-to-SQLite startup backfill core

**Files:**

- Create: `src/projection/backfill.ts`
- Create: `tests/projection/backfill.test.ts`
- Modify only if needed to remove exact duplication: `src/projection/rebuild.ts`

- [ ] **Step 1: Add failing tests for the report and scan contract**

Cover these cases with real execution directories and real SQLite:

1. A valid Journal missing from SQLite is repaired.
2. A cursor-and-state-identical projection is reported current and is not rewritten.
3. A forged/wrong execution state with matching or stale cursor is corrected from Journal replay.
4. A Journal ending in `projection.stale` repairs the execution and advances cursor to that event without changing lifecycle state.
5. A truncated final line repairs the valid prefix and leaves `TRUNCATED_TAIL` stale metadata.
6. A malformed or broken-chain Journal invalidates only that execution while a healthy execution is still repaired.
7. An empty Journal invalidates an existing projection row and reports a stable reason.
8. A reducer contradiction invalidates only that execution and does not abort the scan.
9. Lexical directory scanning produces deterministic `failureReasons` ordering.
10. Trusted workspace seeds are refreshed even when no execution needs repair.

- [ ] **Step 2: Run the targeted test and confirm RED**

Run:

```powershell
npm test -- --run tests/projection/backfill.test.ts
```

Expected: module-not-found or missing-export failure for `backfillProjection`.

- [ ] **Step 3: Implement source scanning and reduction**

Export:

```ts
export interface BackfillProjectionOptions {
  readonly stateRoot: string;
  readonly database: StateDatabase;
  readonly workspaces: readonly WorkspaceSeed[];
  readonly nowMs: number;
}

export function backfillProjection(
  options: BackfillProjectionOptions,
): BackfillProjectionReport
```

Implementation rules:

- ensure `stateRoot/executions` exists;
- enumerate direct child directories only and sort by directory name;
- use `loadSingleExecutionJournal(path, executionId)`;
- create a fresh in-memory `FingerprintRegistry` for each valid Journal;
- call `reduce` on events in returned physical order and collect `ProjectionReplayStep[]`;
- treat an empty event list as stale rather than as a valid execution;
- compare the final step and SQLite cursor/row using the frozen currentness rules;
- call `replaceExecution` only for divergent valid Journals;
- call `invalidateExecution` for load/reducer failures;
- after a successful truncated-prefix replacement, set its stale reason to `TRUNCATED_TAIL` in a transaction-safe way;
- seed trusted workspaces through `ExecutionProjector.seedWorkspaces`;
- set `backfill_status=complete` and `backfill_at=<nowMs>` after the full scan;
- do not append Journal events and do not invoke recovery logic.

If common scan/reduce code can be extracted from `rebuild.ts` without changing Phase 3 behavior, keep it narrowly typed and prove all existing rebuild tests remain green. Otherwise leave `rebuild.ts` unchanged; duplication is preferable to a broad Phase 3 regression.

- [ ] **Step 4: Run targeted tests and confirm GREEN**

Run the Task 2 test command. Expected: all backfill tests pass.

- [ ] **Step 5: Run projection regression tests**

Run:

```powershell
npm test -- --run tests/projection
npm run typecheck
```

Expected: all projection tests pass and typecheck exits 0.

Do not commit; Sol performs the phase commit after independent review.

---

### Task 3: CLI startup integration, regression proof, and status documentation

**Files:**

- Modify: `src/cli/index.ts`
- Modify: `tests/cli/cli.e2e.test.ts`
- Modify: `docs/v2/implementation-status.md`
- Modify if Phase 4 behavior is user-facing: `README.md`

- [ ] **Step 1: Add a failing CLI restart/backfill E2E test**

Construct a persisted execution Journal, deliberately delete or stale its SQLite execution row/cursor, invoke a CLI path that calls `configureEngine`, then assert before any new execution work that the database reflects the authoritative Journal. Prefer the hermetic fake `mcode.cmd` fixture already used by CLI E2E. Do not require the real mcode binary.

Also assert that no recovery event is appended by startup backfill.

- [ ] **Step 2: Run the CLI test and confirm RED**

Run:

```powershell
npm test -- --run tests/cli/cli.e2e.test.ts
```

Expected: stale/missing projection remains unrepaired before integration.

- [ ] **Step 3: Wire backfill into startup**

In `configureEngine`:

1. resolve `stateRoot`;
2. open `StateDatabase`;
3. call `backfillProjection` with trusted workspace seeds and `Date.now()`;
4. construct `ExecutionProjector`, `EventStore`, and engine only after backfill returns;
5. preserve the current projection-unavailable fallback when database open/backfill throws globally;
6. avoid double workspace seeding;
7. return the report only if it is useful to tests or structured output—do not expand public CLI output without need.

`run` and `recover` already pass through `configureEngine`; `probe` and standalone `review` must remain side-effect free with respect to startup backfill.

- [ ] **Step 4: Update implementation status**

Add `Phase 4 — Startup Backfill` to `docs/v2/implementation-status.md`, documenting:

- source of truth and scan scope;
- exact currentness comparison;
- per-execution atomic replacement and invalidation behavior;
- `projection.stale` cursor handling;
- truncated-tail and corrupted-Journal semantics;
- startup integration points;
- explicit Phase 5 exclusions;
- actual verification counts from the final run, without guessing.

- [ ] **Step 5: Run all verification gates**

Run, in this order:

```powershell
npm run typecheck
npm run build
npm test
git diff --check
```

Expected: all commands exit 0; the five real-mcode tests may remain skipped under their existing explicit environment gates.

- [ ] **Step 6: Self-review the complete diff**

Check for accidental Phase 5 recovery work, Journal mutation, hard-coded drive paths, C-drive temp use, unbounded process-global state, nested SQLite transactions, and unrelated refactors. Report changed files, fresh test counts, and any remaining concern.

Do not commit or push. Sol performs independent review, fixes any accepted findings through a fresh Luna task, reruns all gates, then creates the Phase 4 commit.

---

## Phase 4 acceptance checklist

- Startup repairs divergent SQLite rows only from validated Journal prefixes.
- Current executions are not unnecessarily rewritten.
- A single bad execution cannot block healthy projection repairs.
- Invalid sources cannot leave apparently authoritative derived rows.
- Per-execution replacement is atomic and rollback-tested.
- `projection.stale` triggers one repair and does not cause an endless repair loop.
- Truncated tails remain explicitly stale after valid-prefix replay.
- No Journal event is added, changed, sorted, or fabricated.
- No Recovery Scanner or ACCEPT reconciliation is introduced.
- Project-generated temporary files remain under the project-controlled temp root, except the documented non-Git workspace fixture.
- Typecheck, build, complete tests, and whitespace checks pass with fresh evidence.
