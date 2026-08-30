# Phase 7 Durable Workspace Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the process-local workspace lock authority with a filesystem-backed lease while keeping Engine lifecycle integration out of Tasks 0–5.

**Architecture:** `WorkspaceLock` owns the filesystem lease protocol. The owner `.lock` file created with `open("wx")` is the ownership commit point; immutable owner metadata identifies the lease and an atomically replaced sidecar carries heartbeats. A reclaim guard serializes release/reclaim and every destructive path revalidates the lease ID. SQLite remains a rebuildable projection of valid owner files.

**Tech Stack:** Node.js 22 `fs/promises` and `node:sqlite`, TypeScript, Vitest, injected clock/UUID/PID dependencies, Windows-compatible path normalization.

---

### Task 0: Contract amendment

**Files:**
- Modify: `docs/v2/phase-0-spec-freeze.md`
- Test: documentation review only

- [ ] Add Amendment 2 freezing owner `wx` + same-handle write/sync/close and heartbeat temp-file + atomic rename.
- [ ] State that owner `heartbeat_at` is only the initial heartbeat and the sidecar is authoritative thereafter.
- [ ] Check the amendment against `INCOMPLETE_LEASE` semantics.

### Task 1: Durable owner primitive

**Files:**
- Modify: `src/workspace/lock.ts`
- Test: `tests/workspace/lease.test.ts`

- [ ] Define canonical physical workspace identity, strict owner schema, error codes, injected dependencies, and the new async acquire API.
- [ ] Keep the old two-argument API as a compatibility adapter, but make it use the same filesystem owner path and `wx` commit point.
- [ ] Add failing tests for identity, exclusive acquire, metadata read-back, input errors, and write cleanup.
- [ ] Implement the minimum code and run the focused tests.

### Task 2: Heartbeat

**Files:**
- Modify: `src/workspace/lock.ts`
- Test: `tests/workspace/lease.test.ts`

- [ ] Add atomic sidecar writes, timer lifecycle, `unref`, injected clock, and lease-ID ownership checks.
- [ ] Cover stale-handle detection, malformed sidecars, and transient heartbeat I/O errors.
- [ ] Run focused lease tests before continuing.

### Task 3: Guarded release and reclaim

**Files:**
- Modify: `src/workspace/lock.ts`
- Test: `tests/workspace/lease.test.ts`

- [ ] Add exclusive `.reclaim` metadata and stale-guard policy.
- [ ] Make release and reclaim share the guard and perform a second owner inspection before deletion.
- [ ] Cover old-owner deletion races, alive/unknown/foreign guard holders, and conditional cleanup.

### Task 4: Inspector and policy

**Files:**
- Modify: `src/workspace/lock.ts` or focused workspace lease helper
- Create/modify: `src/recovery/scanner.ts` only if the existing read-only issue model needs a narrow lease classification hook
- Test: `tests/workspace/lease.test.ts`, relevant recovery tests

- [ ] Implement read-only inspection and PID/host policy without deletion.
- [ ] Ensure active Journal and `RECOVERY_REQUIRED` never become auto-reclaimable.
- [ ] Cover `ALIVE`, `DEAD`, `UNKNOWN`, foreign host, stale heartbeat, and malformed/incomplete owner states.

### Task 5: SQLite projection

**Files:**
- Modify: `src/projection/execution-projector.ts`
- Modify: `src/projection/rebuild.ts`
- Modify: `src/projection/backfill.ts` only if required by the existing startup projection boundary
- Test: `tests/projection/lease-projection.test.ts`, `tests/projection/rebuild.test.ts`

- [ ] Add lease upsert and lease-ID-conditional delete helpers.
- [ ] Scan valid owner files during rebuild and never grant ownership from SQLite.
- [ ] Verify deleting the SQLite database and rebuilding restores valid lease rows while malformed owners create no invented rows.

### Gate after Task 0–5

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run the focused Phase 7 lease tests.
- [ ] Run `npm test`.
- [ ] Run `git diff --check`.
- [ ] Confirm `src/execution/engine.ts` is unchanged.
- [ ] Stop and report results before Task 6.
