# G2M Phase 10 Garbage Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add proof-first, crash-safe historical execution cleanup with durable
tombstones, resumable GC, projection/recovery integration, and a read-only by
default CLI.

**Architecture:** `src/storage/gc-candidate.ts` validates candidates from the
Journal, manifests, leases, reservations, and filesystem. `src/storage/gc.ts`
owns the serialized mutation protocol and fault-injection seam. Tombstones are
durable immutable artifacts that outlive execution Journals. Recovery and
projection treat GC as an explicit durable fact rather than corruption.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Node built-in SQLite,
Vitest, and real child-process Node E2E tests.

---

### Task 0: Freeze the contract

Create `docs/v2/phase-10-garbage-collection.md` with the eligibility matrix,
authoritative evidence sources, ordering, tombstone schema/hash, recovery
semantics, projection semantics, and CLI boundary. This task performs no
deletion.

### Task 1: Tombstones and path safety

Create `src/storage/tombstone.ts` with strict schema validation, canonical
self-hashing, durable write/read helpers, direct-child containment checks, and
top-level `lstat` safety checks. Add unit tests covering valid/invalid hashes,
execution binding, traversal, outside-root paths, symlinks, and reparse-like
targets.

### Task 2: Per-execution Journal close

Add `EventStore.closeExecution(executionId)` and test that closing one writer
does not close another and that the closed execution can be reopened safely.

### Task 3: Read-only candidate planner

Create `src/storage/gc-candidate.ts`. Reconstruct the terminal state from the
Journal, independently derive retention eligibility, validate the manifest,
paths, leases, reservations, and projection cursor, and return immutable
`ELIGIBLE` or `BLOCKED` candidates with deterministic reasons. Add the complete
eligibility matrix tests.

### Task 4: GC run lock

Create `src/storage/gc-lock.ts` using exclusive creation at
`state_root/gc/gc.lock`, durable metadata, heartbeat, same-host dead-PID stale
reclaim, and refusal for live, unknown, or foreign owners. Test stale-handle
release and two-process ownership.

### Task 5: Crash-safe executor

Create `src/storage/gc.ts` implementing revalidation, optional maintenance
lease, `gc.marked`, repository-bound worktree removal, artifact deletion,
tombstone, `gc.completed`, writer close, state-directory cleanup, projection
cleanup, and idempotency. Add failure tests for every ordering boundary.

### Task 6: Interrupted-GC resume

Implement `resumeInterrupted()` and internal fault hooks for marked, worktree
removed, artifacts removed, tombstone written, completed, and pre-state-delete
windows. Resume only the exact marked operation and stop on post-mark state
changes.

### Task 7: Recovery and projection integration

Teach the scanner and rebuild path about GC events/issues and valid/invalid
tombstones. Preserve minimal historical execution rows after Journals are
deleted and never invent artifact/review/recovery rows.

### Task 8: `g2m gc` CLI

Add default dry-run, explicit `--apply`, optional `--execution-id`, structured
output, and no force/bypass options. Prove dry-run leaves Journal, filesystem,
and SQLite unchanged.

### Task 9: SAFE_ORPHAN cleanup

Clean only leftovers bound by a valid tombstone and report unknown orphan
directories without deletion.

### Task 10: Real process E2E and seal docs

Add `tests/process/gc.child.mjs` and `tests/process/gc.process.e2e.mjs` for
race ownership, crash after `gc.marked`, crash after `gc.completed`, and
recovery-critical protection. Update package scripts, README/status docs, and
run all Phase 10 and regression gates.
