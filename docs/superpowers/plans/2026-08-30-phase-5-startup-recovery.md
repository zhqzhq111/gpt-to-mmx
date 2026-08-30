# Phase 5 Startup Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or execute the assigned task with strict TDD and self-review. Do not commit or push; Sol owns final review and the phase commit.

**Goal:** Detect durable recovery hazards at startup, place unsafe active executions into RECOVERY_REQUIRED without guessing, and keep unrelated healthy executions usable.

**Architecture:** Add tolerant per-execution Journal loading and a read-only Recovery Scanner that derives issues from Journals, SQLite, event-bound artifacts, outcome files, worktree candidates, and lock candidates. Add a Startup Recovery Coordinator that sends only active, appendable executions through the existing RecoveryResolver with processStatus=unknown, durably appends recovery.required, and projects that event Journal-first. Wire it after Phase 4 backfill and EventStore load, before engine construction.

**Tech Stack:** TypeScript, Node.js filesystem APIs, built-in node:sqlite, existing EventStore/Journal loader, reducer/replay, RecoveryResolver, ExecutionProjector, EvidenceStore, FingerprintRegistry, Vitest.

---

## Frozen Phase 5 boundaries

1. UNKNOWN remains a resolver verdict, never a persisted task state.
2. processStatus=unknown is insufficient proof of process termination and always resolves UNKNOWN before result/diff/workspace heuristics.
3. Recovery never retries, resumes, applies a patch, completes ACCEPT, removes a worktree, deletes a lock, or starts another action.
4. Phase 5 may append only recovery.required for a valid active execution. It never appends to terminal, malformed, broken-chain, or truncated-tail Journals.
5. recovery.required is CRITICAL and Journal-first. SQLite projection follows only after the append flush barrier.
6. A projection failure while projecting recovery.required appends projection.stale; it must not erase the recovery Journal fact.
7. One corrupt execution must not prevent healthy Journals from loading or a new execution from starting.
8. Startup scanning is deterministic: direct execution directories and reported cases are ordered lexically by execution_id, then by issue priority.
9. Scanner classifications are derived from durable evidence and do not themselves need a new Journal event. Repeated startup scans are idempotent.
10. Terminal inconsistencies are reported but do not receive an illegal lifecycle transition.
11. A truncated or corrupt Journal is reported and left untouched for operator repair.
12. Lock files and worktree directories are detection-only in Phase 5. No stale declaration, deletion, kill, reclaim, or git worktree remove occurs before the Phase 7 lease contract and Phase 10 GC.
13. Partial ACCEPT is detection and safe-hold only. Exact target reconciliation and crash-safe ACCEPT remain Phase 6.
14. Scanner validates only event-bound artifacts it can prove: frozen.patch from patch.frozen, review-bundle.json from review.requested, and apply-evidence.json from patch.applied. It does not invent missing paths or hashes.
15. Missing outcome.json is checked for terminal execution state because current CLI artifacts live at artifactRoot/<execution-id>.
16. Phase 4 Startup Backfill runs before Phase 5, so the scanner may use the repaired projection but must still verify Journal evidence independently.

## Recovery issue contract

Create a stable union with these issue kinds:

- JOURNAL_LOAD_ERROR
- JOURNAL_TRUNCATED_TAIL
- NON_TERMINAL_EXECUTION
- UNKNOWN_WORKER
- PROJECTION_STALE
- MISSING_COMMITTED_ARTIFACT
- ARTIFACT_HASH_MISMATCH
- MISSING_OUTCOME
- PARTIAL_ACCEPT_PREPARED
- PARTIAL_ACCEPT_APPLIED
- RETAINED_WORKTREE_CANDIDATE
- LOCK_REQUIRES_VALIDATION

Each issue includes executionId when bound, severity SAFE_HOLD or REPORT_ONLY, a stable reason string, and evidence references without volatile exception stacks.

---

### Task 1: Tolerant EventStore loading and read-only Recovery Scanner

**Files:**

- Modify: src/events/store.ts
- Modify: tests/events/store.test.ts
- Create: src/recovery/scanner.ts
- Create: tests/recovery/scanner.test.ts

**EventStore requirements:**

- Add EventStoreOptions.tolerateLoadErrors?: boolean, default false.
- Extend JournalRecoveryIssue kind to TRUNCATED_TAIL or LOAD_ERROR and include stable reason.
- In tolerant mode catch each execution directory load independently, record LOAD_ERROR, and continue loading later lexical directories.
- Strict default behavior must remain byte-for-byte compatible for existing callers/tests.
- append must refuse any execution that has either issue kind.
- Healthy execution writers and reads remain usable in tolerant mode.
- Legacy flat layout remains strict unless explicitly covered; do not broaden scope without tests.

**Scanner input:**

- stateRoot
- artifactRoot
- worktreeRoot
- StateDatabase
- tolerant EventStore

**Scanner behavior:**

- enumerate direct execution directories lexically;
- use EventStore events/issues and independently replay each healthy execution with fresh FingerprintRegistry;
- determine final TaskState and active/terminal status;
- report EventStore LOAD_ERROR/TRUNCATED_TAIL;
- report NON_TERMINAL_EXECUTION for every active state;
- report UNKNOWN_WORKER when agent.spawn.started exists without a durable terminal worker event;
- report PROJECTION_STALE when SQLite stale meta exists or cursor differs from final valid Journal event;
- validate frozen.patch exact bytes/hash/byte count and safe path containment;
- validate review-bundle.json binding against review.requested payload;
- validate apply-evidence.json exact-byte hash from patch.applied;
- report partial ACCEPT patterns;
- report missing outcome for terminal states;
- list unbound direct worktreeRoot directories as RETAINED_WORKTREE_CANDIDATE without deletion;
- parse/list direct stateRoot/locks files as LOCK_REQUIRES_VALIDATION without claiming stale or deleting;
- never write Journal, SQLite, artifacts, worktrees, or locks.

**Required tests:**

- strict EventStore still throws for a bad Journal;
- tolerant EventStore quarantines one bad Journal and loads a healthy neighbor;
- append to quarantined/truncated execution is refused; append to healthy/new execution succeeds;
- active worker-unknown classification;
- terminal missing outcome;
- partial ACCEPT prepared and applied classifications;
- missing/hash-mismatched patch artifact;
- valid event-bound artifacts do not produce false positives;
- truncated and malformed Journal classification;
- projection cursor/stale classification;
- deterministic issue ordering;
- worktree/lock candidate detection is read-only;
- scanner leaves all source bytes unchanged.

Run targeted event/recovery tests and typecheck. Self-review exact scope. No commit.

---

### Task 2: Startup Recovery Coordinator and resolver integration

**Files:**

- Modify: src/recovery/resolver.ts
- Modify: tests/recovery/resolver.test.ts
- Create: src/recovery/startup.ts
- Create: tests/recovery/startup.test.ts
- Modify: src/cli/index.ts
- Modify only if needed: src/projection/execution-projector.ts

**Resolver correction:**

- processStatus=unknown returns UNKNOWN before terminal/result/workspace reconciliation.
- Existing alive semantics remain unchanged.
- exited_clean, exited_error, and crashed remain proven-gone statuses for the existing explicit recover command.
- Add regression tests proving unknown never auto-reconciles even with clean workspace, final worker result, or terminal caller state.

**Coordinator behavior:**

- receive scanner cases, EventStore, StateDatabase/ExecutionProjector, FingerprintRegistry, and EvidenceStore;
- group issues by execution;
- for each valid active execution with SAFE_HOLD issues and no existing recovery.required:
  - call resolveRecovery with processStatus=unknown;
  - use persisted worker/diff evidence when available but never let it override unknown process status;
  - append recovery.required through EventStore;
  - reduce from replayed current state;
  - project the durable event;
- if projection fails, append projection.stale with failed event binding;
- do not append to terminal, truncated, load-error, already RECOVERY_REQUIRED, or already-marked execution;
- return a report separating detected, transitioned, alreadyHeld, and reportOnly cases;
- repeated invocation appends no duplicate recovery.required.

**CLI integration:**

configureEngine order becomes:

1. open SQLite;
2. Phase 4 backfill;
3. create tolerant EventStore;
4. create EvidenceStore/FingerprintRegistry;
5. scan recovery evidence;
6. run Startup Recovery Coordinator;
7. construct engine.

- run and recover use this path;
- probe/review remain side-effect free;
- scanner/coordinator global failure must not silently continue. Surface a startup recovery error because safety classification itself failed.
- a quarantined unrelated Journal must not prevent a new run.

**Required tests:**

- unknown process semantics;
- active RUNNING becomes RECOVERY_REQUIRED with one CRITICAL event;
- REVIEW_PENDING safe-holds rather than auto-resumes;
- second startup is idempotent;
- projection failure produces projection.stale after recovery.required;
- terminal missing outcome is report-only and Journal unchanged;
- truncated/corrupt execution is report-only and Journal unchanged;
- one quarantined Journal does not block healthy/new execution;
- coordinator never invokes retry/resume/apply/delete behavior.

Run recovery, CLI targeted tests and typecheck. Self-review. No commit.

---

### Task 3: Phase 5 E2E, operational report, and documentation

**Files:**

- Modify: tests/cli/cli.e2e.test.ts
- Modify: docs/v2/implementation-status.md
- Modify: README.md only if existing phase-status text requires it
- Modify Phase 5 implementation only for a proven E2E defect and report it explicitly

**E2E scenarios:**

1. Seed an active execution Journal ending at agent.spawn.started, start a new CLI run, verify old execution receives exactly one recovery.required and projects RECOVERY_REQUIRED before the new execution proceeds.
2. Repeat startup and prove no duplicate recovery.required.
3. Seed a malformed neighboring Journal and prove a new healthy CLI run still completes while the bad execution remains untouched/quarantined.
4. Verify no retry/resume/apply/worktree-delete/lock-delete side effect.
5. Verify terminal missing outcome is reported without illegal append.
6. Confirm all temp data follows project temp policy.

**Documentation:**

Add Phase 5 section covering:

- scanner inputs and issue taxonomy;
- tolerant Journal quarantine;
- resolver unknown-process correction;
- Journal-first safe-hold transition;
- idempotency;
- report-only terminal/corrupt cases;
- Phase 6/7/10 exclusions;
- exact final verification counts.

**Final validation:**

1. npm run typecheck
2. npm run build
3. npm test
4. git diff --check

Self-review the complete Phase 5 diff and report exact test/skipped counts. Do not commit or push.

---

## Phase 5 acceptance checklist

- Startup never guesses worker termination.
- Unsafe valid active executions durably reach RECOVERY_REQUIRED.
- Repeated startup does not duplicate recovery events.
- Terminal/corrupt/truncated Journals are never illegally appended.
- One bad Journal cannot block healthy startup.
- Event-bound artifact inconsistencies are detected from exact evidence.
- Partial ACCEPT is detected but never auto-reconciled.
- Worktree and lock candidates are never deleted or reclaimed.
- Journal-first ordering is preserved.
- Phase 4 backfill behavior remains green.
- Full verification passes with fresh evidence.
