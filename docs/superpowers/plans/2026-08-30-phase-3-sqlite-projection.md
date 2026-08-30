# Phase 3 SQLite Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared, rebuildable SQLite projection that is always updated after the authoritative execution Journal.

**Architecture:** Use Node's built-in `node:sqlite` `DatabaseSync`, avoiding a native npm dependency. `StateDatabase` owns connection pragmas, migrations, and transactions; `ExecutionProjector` reduces one execution Journal into query rows; `rebuildProjection` recreates only projection data from execution journals and immutable artifacts without inventing missing facts.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Vitest, filesystem NDJSON Journals.

---

### Task 1: Shared database and frozen schema

**Files:**
- Create: `src/projection/database.ts`
- Create: `src/projection/schema.ts`
- Test: `tests/projection/database.test.ts`

- [ ] **Step 1: Write the failing connection and schema test**

```ts
const database = new StateDatabase(join(root, "g2m-state.sqlite"));
expect(database.pragma("journal_mode")).toBe("wal");
expect(database.tableNames()).toEqual(expect.arrayContaining([
  "executions", "workspaces", "workspace_locks", "reviews", "artifacts",
  "storage_usage", "storage_reservations", "recovery_cases", "projection_meta",
]));
database.close();
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npm test -- --run tests/projection/database.test.ts`
Expected: FAIL because `src/projection/database.ts` does not exist.

- [ ] **Step 3: Implement the connection contract and migration**

```ts
const database = new DatabaseSync(path, { timeout: 5_000 });
database.exec("PRAGMA journal_mode = WAL");
database.exec("PRAGMA synchronous = NORMAL");
database.exec("PRAGMA busy_timeout = 5000");
database.exec(FROZEN_SCHEMA_SQL);
```

`FROZEN_SCHEMA_SQL` must create the nine tables from Phase 0 exactly, use `STRICT` tables, and store `schema_version=1` in `projection_meta`.

- [ ] **Step 4: Run the focused test**

Run: `npm test -- --run tests/projection/database.test.ts`
Expected: PASS.

### Task 2: Journal-first execution projection

**Files:**
- Create: `src/projection/execution-projector.ts`
- Modify: `src/execution/engine.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/projection/execution-projector.test.ts`
- Test: `tests/execution/engine.test.ts`

- [ ] **Step 1: Write failing projection tests**

```ts
projector.project(event, { workspaceId: "workspace-1" });
expect(database.execution(event.attemptId)).toMatchObject({
  execution_id: event.attemptId,
  task_id: event.taskId,
  state: "PLANNED",
});
```

Also inject a projection failure after a durably appended CRITICAL event and assert that the Journal retains the lifecycle event and receives a `projection.stale` fact without converting the worker result into failure.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- --run tests/projection/execution-projector.test.ts tests/execution/engine.test.ts`
Expected: FAIL because no projector exists.

- [ ] **Step 3: Implement transaction projection**

```ts
database.transaction(() => {
  upsertExecution.run(executionId, taskId, workspaceId, state, createdAt, updatedAt);
  upsertMeta.run(`execution:${executionId}:last_event_hash`, event.hash);
});
```

The engine sequence must remain `EventStore.append()` (CRITICAL flush when required), then reducer, then projector transaction. Projection failures append `projection.stale` and return the valid lifecycle result.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run tests/projection/execution-projector.test.ts tests/execution/engine.test.ts`
Expected: PASS.

### Task 3: Deterministic projection rebuild

**Files:**
- Create: `src/projection/rebuild.ts`
- Test: `tests/projection/rebuild.test.ts`

- [ ] **Step 1: Write failing delete-and-rebuild test**

```ts
await rebuildProjection({ stateRoot, workspaceConfig });
expect(openProjection(stateRoot).execution(executionId)?.state).toBe("REVIEW_PENDING");
expect(openProjection(stateRoot).meta("rebuild_status")).toBe("complete");
```

Add contradictory and truncated Journal cases and assert the execution is marked stale instead of receiving fabricated rows.

- [ ] **Step 2: Run focused rebuild tests and verify failure**

Run: `npm test -- --run tests/projection/rebuild.test.ts`
Expected: FAIL because `rebuildProjection` does not exist.

- [ ] **Step 3: Implement authority-only rebuild**

```ts
for (const execution of scanExecutionJournals(stateRoot)) {
  const replayed = replay(execution.events, context);
  projector.rebuildExecution(execution, replayed.state, immutableArtifacts);
}
```

Rebuild into a temporary SQLite file, close it, atomically replace the old projection, and retain a timestamped backup. Missing or contradictory sources set stale metadata and never invent artifact, lease, reservation, or review facts.

- [ ] **Step 4: Run focused rebuild tests**

Run: `npm test -- --run tests/projection/rebuild.test.ts`
Expected: PASS.

### Task 4: Phase verification and commit

**Files:**
- Modify: `docs/v2/implementation-status.md`

- [ ] **Step 1: Run all verification gates**

Run: `npm run typecheck; npm run build; npm test; git diff --check`
Expected: all commands exit 0.

- [ ] **Step 2: Update implementation evidence**

Record the schema, pragmas, Journal-first ordering, stale handling, rebuild behavior, test counts, and any skipped platform tests in `docs/v2/implementation-status.md`.

- [ ] **Step 3: Commit Phase 3**

```text
git add src/projection tests/projection src/execution/engine.ts src/cli/index.ts docs/v2/implementation-status.md
git commit -m "feat: add rebuildable sqlite projection"
```
