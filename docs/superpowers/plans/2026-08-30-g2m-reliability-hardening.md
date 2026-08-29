# G2M Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Review Evidence authoritative, persist execution state, and make ACCEPT crash-recoverable.

**Architecture:** Freeze one binary-capable patch after verification and include its text and hash in the Review Bundle. Add opt-in durable stores that retain the current in-memory APIs, then add explicit ACCEPT transaction events and a recovery command that reconciles persisted evidence with the target repository.

**Tech Stack:** TypeScript, Node.js `fs`/`crypto`, JSONL and atomic JSON files, Git CLI through `execFile`, Vitest.

---

### Task 1: Freeze the authoritative review patch

**Files:**
- Modify: `src/workspace/worktree.ts`
- Modify: `src/review/bundle.ts`
- Modify: `src/execution/engine.ts`
- Test: `tests/review/bundle.test.ts`
- Test: `tests/workspace/worktree.test.ts`
- Test: `tests/execution/engine.test.ts`

- [ ] Add `patchText` to `WorktreePatch` and expose the exact binary-capable patch text returned by `collectWorktreePatch()`.
- [ ] Add required `FrozenPatchEvidence` to `ReviewBundle.workspaceEvidence`, bind it into `resultHash` and `reviewBundleHash`, and pass only `baseRevision`, `patchHash`, `patchText`, `changedFiles`, and `empty`.
- [ ] Collect the patch before the final diff so untracked files are staged into the same representation that reviewers see and ACCEPT applies.
- [ ] Assert the bundle patch hash and patch text equal the patch artifact used by the engine.
- [ ] Run `npm test -- --run tests/review/bundle.test.ts tests/workspace/worktree.test.ts tests/execution/engine.test.ts`.

### Task 2: Add durable stores and persistence configuration

**Files:**
- Create: `src/persistence/durable-state.ts`
- Modify: `src/events/store.ts`
- Modify: `src/evidence/store.ts`
- Modify: `src/review/replay-guard.ts`
- Modify: `src/execution/fingerprint.ts`
- Modify: `src/cli/config.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/persistence/durable-state.test.ts`

- [ ] Implement atomic JSON writes and append-only JSONL writes with parent-directory creation and load-time validation.
- [ ] Add optional persistence paths to EventStore, EvidenceStore, ReplayGuard, and FingerprintRegistry without changing in-memory behavior.
- [ ] Persist each mutation before publishing it in memory; reject malformed JSON, duplicate IDs, broken event chains, and hash mismatches.
- [ ] Add optional `state_root` to local config and wire CLI stores to `state_root` or `<artifact_root>/state`.
- [ ] Add round-trip, corruption, and restart-load tests.
- [ ] Run the complete store and CLI test groups.

### Task 3: Add restart recovery

**Files:**
- Modify: `src/recovery/resolver.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/events/events.ts`
- Test: `tests/recovery/cli-recovery.test.ts`

- [ ] Persist the validated task in the initial event payload and retain execution evidence by execution ID.
- [ ] Add `g2m recover --config <config> --execution-id <id> --process-status <status>`.
- [ ] Load events/evidence/fingerprint state, replay the execution, capture current workspace state, and call `resolveRecovery()`.
- [ ] Emit a machine-readable resolution; for UNKNOWN append `recovery.required` with the latest matching fingerprint and preserve the worktree.
- [ ] Cover clean, dirty, malformed-log, and unknown recovery outcomes.

### Task 4: Make ACCEPT crash-recoverable

**Files:**
- Modify: `src/events/events.ts`
- Modify: `src/execution/state-machine.ts`
- Modify: `src/execution/engine.ts`
- Modify: `src/review/ingress.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/execution/engine.test.ts`
- Test: `tests/review/ingress.test.ts`

- [ ] Add `ACCEPT_PREPARED`, `PATCH_APPLIED`, and corresponding event transitions while retaining pure ingress compatibility.
- [ ] Persist `review.accept.prepared` before applying the patch, `patch.applied` immediately after, and `review.accept.completed` after the binding/replay record succeeds.
- [ ] Make repeated completion idempotent and reject conflicting review IDs or patch hashes.
- [ ] On restart, compare target HEAD, target diff, frozen patch hash, and persisted transaction phase before reconciling or entering `RECOVERY_REQUIRED`.
- [ ] Add crash-window tests around each transaction boundary.

### Task 5: Full verification and delivery

**Files:**
- Modify: `README.md`

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test` and record the exact pass/skip counts.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check` and inspect the complete diff for unrelated changes.
- [ ] Update README usage and recovery limitations.
- [ ] Commit each completed phase with a focused message and report commit hashes.
