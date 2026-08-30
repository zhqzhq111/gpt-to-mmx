# Phase 11 Operational CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only `status` and `doctor` commands plus explicit-apply, allowlisted `repair` operations without invoking the mutating engine startup path.

**Architecture:** A new `src/operations/` layer builds one read-only operational snapshot, derives deterministic doctor checks from it, and dispatches three guarded repair actions. The CLI only parses, calls, and renders; existing Journal, recovery, lease, storage, projection, and GC mechanisms remain the authorities.

**Tech Stack:** TypeScript, Node.js 22 `node:sqlite`, existing G2M Journal/recovery/storage/GC modules, Vitest, JSON-lines/file durability.

---

## File map

- Create `src/operations/snapshot.ts`: operational snapshot types and read-only aggregation.
- Create `src/operations/doctor.ts`: deterministic check and report derivation.
- Create `src/operations/repair-lock.ts`: cross-process exclusive repair lock with bounded metadata.
- Create `src/operations/repair-audit.ts`: immutable plan/start/result audit records.
- Create `src/operations/repair.ts`: allowlisted action planner and dispatcher.
- Create `src/operations/format.ts`: stable text and snake_case JSON rendering.
- Modify `src/cli/index.ts`: delegate `status`, `doctor`, and `repair`; leave existing commands on their current paths.
- Modify `README.md` and `docs/v2/implementation-status.md`: document Phase 11 commands, safety rules, and schemas.
- Create `tests/operations/snapshot.test.ts`, `doctor.test.ts`, `repair-lock.test.ts`, `repair-audit.test.ts`, `repair.test.ts`, `format.test.ts`.
- Modify `tests/cli/cli.e2e.test.ts` or add `tests/cli/operations.e2e.test.ts` for real CLI behavior and byte/mtime invariants.

## Shared contracts

Internal TypeScript names use camelCase. `format.ts` is the only public JSON boundary and emits snake_case. The implementation must define these exact public operation entry points:

```ts
export interface OperationalOptions {
  readonly config: G2MLocalConfig;
  readonly executionId?: string;
  readonly nowMs?: number;
}

export async function buildOperationalSnapshot(
  options: OperationalOptions,
): Promise<OperationalSnapshot>;

export async function runDoctor(
  options: OperationalOptions,
): Promise<DoctorReport>;

export async function planRepair(
  options: RepairOptions,
): Promise<RepairPlan>;

export async function executeRepair(
  options: RepairOptions & { readonly apply: true },
): Promise<RepairResult>;
```

The three schemas must expose `schema_version` values `g2m.status.v1`,
`g2m.doctor.v1`, `g2m.repair-plan.v1`, and `g2m.repair-result.v1`. Every emitted JSON property is snake_case, including nested properties and action results.

### Task 1: Stable contracts and formatting

**Files:**
- Create: `src/operations/format.ts`
- Test: `tests/operations/format.test.ts`

- [ ] **Step 1: Write failing tests for exact JSON and text output.**

```ts
it("renders status JSON with snake_case and stable schema version", () => {
  const value = renderJson({
    schemaVersion: "g2m.status.v1",
    generatedAt: 10,
    stateRoot: { stateRootExists: true },
  });
  expect(JSON.parse(value)).toEqual({
    schema_version: "g2m.status.v1",
    generated_at: 10,
    state_root: { state_root_exists: true },
  });
});

it("renders text without changing the data contract", () => {
  expect(renderText({
    schemaVersion: "g2m.doctor.v1",
    status: "WARN",
    checks: [{ id: "projection.readable", status: "PASS", message: "ok" }],
  })).toContain("WARN");
});
```

- [ ] **Step 2: Run `npx vitest run tests/operations/format.test.ts` and verify it fails because `src/operations/format.ts` is absent.**
- [ ] **Step 3: Implement `renderJson(value)` with an explicit recursive camelCase-to-snake_case mapper and `renderText(value)` with deterministic section/order rendering.** Do not rely on object insertion order for JSON field ordering; build the four top-level schema objects in declared order.
- [ ] **Step 4: Run the focused test and verify it passes.**
- [ ] **Step 5: Commit with `git add src/operations/format.ts tests/operations/format.test.ts && git commit -m "feat: add operational output contracts"`.**

### Task 2: Read-only operational snapshot

**Files:**
- Create: `src/operations/snapshot.ts`
- Test: `tests/operations/snapshot.test.ts`
- Reuse without mutation: `src/events/store.ts`, `src/events/journal.ts`, `src/recovery/scanner.ts`, `src/storage/gc-candidate.ts`, `src/storage/usage.ts`, `src/storage/tombstone.ts`, `src/workspace/lock.ts`, `src/projection/database.ts`

- [ ] **Step 1: Write failing tests for a complete snapshot, missing projection, corrupt projection, missing state directories, GCED execution, filtering, and unchanged filesystem state.** The fixture must record `stat.size` and `stat.mtimeMs` for every existing Journal, SQLite file, lease file, reservation file, tombstone, and artifact before and after `buildOperationalSnapshot()`.
- [ ] **Step 2: Run `npx vitest run tests/operations/snapshot.test.ts` and verify the new tests fail before implementation.**
- [ ] **Step 3: Implement `buildOperationalSnapshot()` with these rules:**
  - Resolve `stateRoot` exactly as CLI currently does: `config.state_root ?? resolve(config.artifact_root, "state")`.
  - Probe `state_root`, `executions`, `locks`, `reservations`, `tombstones`, and projection DB with `existsSync`/`statSync`; never call `mkdir`, `backfillProjection`, `rebuildProjection`, `reconcileStorageReservations`, `rebuildStorageUsageFromManifests`, `resumeInterrupted`, or `configureEngine`.
  - Open `StateDatabase(<stateRoot>/g2m-state.sqlite, { readOnly: true })` only when the file exists; catch open/query failures and mark projection `MISSING` or `UNREADABLE` while continuing other sources.
  - Construct a read-only `EventStore` with `executionDirectory`, `tolerateLoadErrors: true`, and `readOnly: true`. Use `recoveryIssues()`, `getByAttemptId()`, `verifyChain()`, and `reduce`/`replay` to derive Journal status and lifecycle state. A missing Journal is `GCED` only if the execution has a valid final Tombstone; otherwise report `MISSING` or `LOAD_ERROR`.
  - Read lease owners with `scanLeaseOwnersSync()` and classify each configured workspace using `classifyLeasePolicy()` and the existing Phase 7 journal-state mapping. Never reclaim or write lease projections.
  - Read reservation JSON records and storage manifests directly. Derive managed bytes from manifests/filesystem and active reservations from valid records/events; use SQLite only as a cross-check. Read volume free space with the existing provider and produce effective availability after active reservations and policy floors.
  - Call `scanRecovery()` only with read-only dependencies and call `planGcCandidates()` only for status counts. Do not call the GC executor.
  - Close any opened EventStore/StateDatabase in `finally`.
  - Apply `executionId` after all source records are related, retaining the execution and directly related workspace/lease/reservation/recovery/GC data only.
- [ ] **Step 4: Run the focused tests and verify all snapshot invariants pass, including byte/mtime equality.**
- [ ] **Step 5: Commit with `git add src/operations/snapshot.ts tests/operations/snapshot.test.ts && git commit -m "feat: add read-only operational snapshot"`.**

### Task 3: Deterministic doctor report

**Files:**
- Create: `src/operations/doctor.ts`
- Test: `tests/operations/doctor.test.ts`

- [ ] **Step 1: Write failing tests for PASS/WARN/FAIL checks, projection missing/unreadable, stale projection, invalid Journal/tombstone, active recovery safe hold, reservation mismatch, GC interruption, and execution filtering.**
- [ ] **Step 2: Run `npx vitest run tests/operations/doctor.test.ts` and verify expected failures.**
- [ ] **Step 3: Implement `runDoctor()` as a pure transformation over `buildOperationalSnapshot()`. Define `DoctorCheck` with `id`, `category`, `status`, `severity`, `message`, and `evidence`; sort checks by category then id. Use stable status values `PASS`, `WARN`, and `FAIL`, with an overall `PASS`/`WARN`/`FAIL` derived from the worst check. Map `SAFE_HOLD` recovery issues and active `RECOVERY_REQUIRED` executions to `FAIL` and never attempt a repair.**
- [ ] **Step 4: Run the focused tests and verify doctor does not write any source file.**
- [ ] **Step 5: Commit with `git add src/operations/doctor.ts tests/operations/doctor.test.ts && git commit -m "feat: add deterministic operational doctor"`.**

### Task 4: Repair lock and durable audit

**Files:**
- Create: `src/operations/repair-lock.ts`
- Create: `src/operations/repair-audit.ts`
- Test: `tests/operations/repair-lock.test.ts`
- Test: `tests/operations/repair-audit.test.ts`

- [ ] **Step 1: Write failing tests for exclusive lock acquisition, metadata, release, busy refusal, malformed lock refusal, immutable audit plan/result, and reread/hash verification.**
- [ ] **Step 2: Run both focused test files and verify they fail because the modules do not exist.**
- [ ] **Step 3: Implement `acquireRepairLock(stateRoot)` using an exclusive `open(..., "wx")` file under `<stateRoot>/repair/repair.lock`, a JSON metadata record containing `schema_version`, `operation_id`, `pid`, `hostname`, and `created_at`, and a handle with idempotent `release()`. Never reclaim a lock automatically in Phase 11; return a structured busy error.**
- [ ] **Step 4: Implement `writeRepairAudit()` under `<stateRoot>/repair/audit/` using the existing immutable artifact protocol, with `<operation_id>.plan.json`, `<operation_id>.start.json`, and `<operation_id>.result.json`; reread each file and verify the stored SHA-256 before returning.**
- [ ] **Step 5: Run focused tests and verify all audit bytes remain unchanged after reread.**
- [ ] **Step 6: Commit with `git add src/operations/repair-lock.ts src/operations/repair-audit.ts tests/operations/repair-lock.test.ts tests/operations/repair-audit.test.ts && git commit -m "feat: add serialized repair audit"`.**

### Task 5: Allowlisted repair planner and dispatcher

**Files:**
- Create: `src/operations/repair.ts`
- Test: `tests/operations/repair.test.ts`

- [ ] **Step 1: Write failing tests proving dry-run performs zero writes, missing `--apply` never dispatches, unknown actions are refused, forbidden bypass names are rejected, one action is required, and each of the three allowlisted actions delegates only to the trusted mechanism.**
- [ ] **Step 2: Run `npx vitest run tests/operations/repair.test.ts` and verify expected failures.**
- [ ] **Step 3: Implement exact action names `projection-rebuild`, `gc-resume`, and `storage-reconcile`; reject `all`, `--force`, `delete-anyway`, `ignore-journal`, `ignore-recovery`, `ignore-lease`, `trust-sqlite`, and `rewrite-journal`. Build a plan from a fresh doctor/snapshot, record target scope and prerequisites, and return the plan without writing when `apply` is false.**
- [ ] **Step 4: For `apply: true`, acquire the repair lock, write plan/start audit records, perform a fresh precondition check, call only `rebuildProjection({ stateRoot, workspaces, nowMs })`, `resumeInterrupted(gcOptions)`, or `reconcileStorageReservations({ stateRoot, database, eventStore, nowMs })`, write the result audit, and release the lock in `finally`. `gc-resume` must pass the requested execution filter and must not call broad `executeGc` or `cleanupSafeOrphans`.**
- [ ] **Step 5: Close all resources and verify an action cannot run when required projection/database preconditions are unavailable.**
- [ ] **Step 6: Run the focused tests and commit with `git add src/operations/repair.ts tests/operations/repair.test.ts && git commit -m "feat: add allowlisted repair actions"`.**

### Task 6: CLI integration and help

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/cli/operations.e2e.test.ts`

- [ ] **Step 1: Write failing CLI tests for `status`, `doctor`, and `repair` in text and JSON modes, help output, required arguments, explicit `--apply`, execution filtering, forbidden flags, and non-zero structured errors.**
- [ ] **Step 2: Run `npx vitest run tests/cli/operations.e2e.test.ts` and verify failures before wiring.**
- [ ] **Step 3: Add imports and thin command functions that load config, call operations, and emit `renderText()` or `renderJson()`; do not import or call `configureEngine()` from the new command paths.**
- [ ] **Step 4: Add help lines exactly for `g2m status --config <config>`, `g2m doctor --config <config>`, and `g2m repair --config <config> --action <action> [--apply]`; retain existing command behavior and do not add `--watch` or `--all`.**
- [ ] **Step 5: Run CLI tests and verify the subprocess snapshot test shows no Journal/SQLite/lease/reservation/tombstone/artifact byte or mtime change after `status` and `doctor`.**
- [ ] **Step 6: Commit with `git add src/cli/index.ts tests/cli/operations.e2e.test.ts && git commit -m "feat: expose operational cli commands"`.**

### Task 7: Documentation and regression coverage

**Files:**
- Modify: `README.md`
- Modify: `docs/v2/implementation-status.md`
- Test: `tests/cli/cli.e2e.test.ts` if existing command help assertions need extension

- [ ] **Step 1: Add README examples for text and JSON status/doctor, repair dry-run, and explicit apply, including the three action names and the no-force/no-all rule.**
- [ ] **Step 2: Add the Phase 11 completion notes to `docs/v2/implementation-status.md`, recording the read-only boundary and the final schema names.**
- [ ] **Step 3: Run `npm run typecheck`, `npm run build`, and the focused operations/CLI tests; fix documentation or help assertions if they diverge.**
- [ ] **Step 4: Commit with `git add README.md docs/v2/implementation-status.md tests/cli/cli.e2e.test.ts && git commit -m "docs: document phase 11 operational cli"`.**

### Task 8: Full verification and final review

**Files:**
- No new production files; inspect all Phase 11 diffs and test artifacts.

- [ ] **Step 1: Run `npm run typecheck` and require exit code 0.**
- [ ] **Step 2: Run `npm run build` and require exit code 0.**
- [ ] **Step 3: Run `npm test` and record exact passed/skipped/failed counts.**
- [ ] **Step 4: Run `npm run test:lease-process`, `npm run test:process-supervisor`, `npm run test:storage-process`, and `npm run test:gc-process`; require each process suite to pass.**
- [ ] **Step 5: Run `git diff --check` and inspect `git status --short --branch`; ensure no generated state, SQLite, audit, or temporary files are tracked.**
- [ ] **Step 6: Review the diff against the Phase 11 design and verify no Phase 12 code, daemon, watch mode, generic force option, or lease-reclaim action was introduced.**

## Plan self-review

- Spec coverage: status/read-only snapshot, doctor checks, repair/apply boundary, stable schemas, formats, execution filtering, missing/corrupt projection, Journal/lease/storage/recovery/GC reporting, lock/audit, help, and no-force/no-all are covered by Tasks 1–7.
- Mutation boundary: only Task 5's `apply: true` path can call the three existing mutating mechanisms; Tasks 2 and 3 explicitly forbid startup reconciliation.
- Type consistency: `OperationalOptions`, `buildOperationalSnapshot`, `runDoctor`, `planRepair`, and `executeRepair` are defined once in Shared contracts and reused in Tasks 2–6.
- Scope: no daemon, watch mode, generic deletion, lease reclaim, or Phase 12 work is included.
- Placeholder scan: no unfinished placeholder or unspecified implementation step remains in the task list.
