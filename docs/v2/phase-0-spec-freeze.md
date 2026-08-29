# GPT-to-MiniMax / G2M v2.0

## Phase 0 — Specification Freeze

**Status:** FROZEN
**Target:** G2M v2.0.0
**Scope:** Durable execution, crash recovery, evidence consistency, cross-process coordination, and bounded storage.

This document freezes the ten contracts required before v2 implementation.
The filesystem Journal and immutable Artifacts are authoritative. SQLite is a
rebuildable projection and is never the sole copy of correctness-critical facts.

## Non-goals

Phase 0 does not add OpenCode, Agent Team, DAG scheduling, remote execution,
cloud services, multimodal workflows, or deep ACP integration.

## Core invariants

1. No correctness-critical fact exists only in process memory.
2. Artifacts are complete and hash-verified before a Journal event claims them.
3. Reviewer Patch equals Applied Patch byte-for-byte.
4. Journal order is physical append order; replay never sorts events.
5. SQLite can be deleted and rebuilt from Journal plus Artifacts.
6. Recovery never guesses; insufficient evidence becomes RECOVERY_REQUIRED.
7. REVIEW_PENDING, REVISION_REQUESTED, and RECOVERY_REQUIRED are never auto-GCed.

## 1. Persistence Ordering Diagram

### Normal execution

~~~text
validate task
  -> atomically write task.json
  -> append task.created (CRITICAL) and flush
  -> create worktree
  -> append worktree.created (NORMAL)
  -> append agent.started (CRITICAL) and flush
  -> run Worker
  -> atomically write worker-summary.json and diagnostics
  -> append agent.completed (CRITICAL) and flush
  -> atomically write verification outputs and logs
  -> append verification.completed (CRITICAL) and flush
  -> create exact frozen.patch
  -> calculate patch_blob_hash and change_set_hash
  -> atomically write frozen.patch and frozen-patch.json
  -> re-read and verify both hashes
  -> append patch.frozen (CRITICAL) and flush
  -> atomically write review-bundle.json
  -> append review.requested (CRITICAL) and flush
~~~

### ACCEPT

~~~text
atomically write review.json
  -> append review.accept.prepared (CRITICAL) and flush
  -> verify target HEAD, clean state, and patch_blob_hash
  -> append patch.apply.started (CRITICAL) and flush
  -> git apply --check --binary frozen.patch
  -> apply frozen.patch
  -> calculate target change_set_hash
  -> atomically write apply evidence
  -> append patch.applied (CRITICAL) and flush
  -> append review.accept.completed (CRITICAL) and flush
  -> atomically write outcome.json
~~~

Journal events never contain placeholder hashes. If an artifact cannot be
written and verified, its commit event is not appended.

## 2. Crash Point / Recovery Table

| Crash point | Durable evidence | Recovery result |
|---|---|---|
| Before Worker spawn | task and validation events | Not started; no automatic retry |
| After spawn, before result | agent.started | UNKNOWN -> RECOVERY_REQUIRED |
| Worker changed files, result absent | worktree only | UNKNOWN -> RECOVERY_REQUIRED |
| Result exists, diff absent | worker summary | Rescan only with proven process termination |
| Frozen patch temp partial | only tmp file | ORPHAN_ARTIFACT; never accept |
| Patch complete, patch.frozen absent | artifact without Journal fact | Mark orphan; never accept automatically |
| patch.frozen exists, patch missing | Journal without artifact | Evidence inconsistency -> RECOVERY_REQUIRED |
| Verification running | no verification commit | UNKNOWN unless supervisor proves outcome |
| Review bundle partial | no committed bundle | Ignore partial file; keep prior evidence |
| accept.prepared without apply | review and frozen patch | Verify target; never blindly retry |
| apply started, patch.applied absent | target may be partial | Compare change set; exact match only can reconcile |
| patch.applied without accept.completed | target and patch evidence | Exact match -> RECOVERY_RECONCILED; else RECOVERY_REQUIRED |
| Journal final line truncated | valid prefix | Mark TRUNCATED_TAIL; never auto-accept |
| SQLite projection update fails | Journal durable | PROJECTION_STALE; rebuild later |
| GC marked, remove interrupted | gc.marked | Next GC resumes idempotently |
| Two processes acquire workspace | exclusive lease create | Exactly one wins |
| Two processes reserve storage | SQLite transaction | Capacity is counted once |
| Recovery evidence ages out | recovery-critical state | Never auto-delete |

## 3. Frozen Artifact Hash Contract

### Patch blob hash

~~~text
patch_blob_hash = SHA256(exact bytes of frozen.patch)
~~~

No newline conversion, encoding conversion, sorting, or regenerated patch is
allowed after hashing. Review and Apply consume the same frozen.patch bytes.

### Change set hash

~~~json
[
  {
    "path": "src/example.ts",
    "status": "M",
    "mode": "100644",
    "content_sha256": "..."
  }
]
~~~

The array is sorted by normalized repository-relative path and hashed as
canonical JSON:

~~~text
change_set_hash = SHA256(canonical_json(change_set))
~~~

ACCEPT verifies patch_blob_hash before apply and change_set_hash after apply.
Any mismatch is PATCH_RESULT_MISMATCH and enters RECOVERY_REQUIRED.

The immutable artifacts are task.json, fingerprint.json, frozen.patch,
frozen-patch.json, review-bundle.json, review.json, outcome.json, and
storage-manifest.json. They are write-once; a revision creates a new artifact.

## 4. SQLite Cross-process Contract

G2M_STATE_ROOT/g2m-state.sqlite is shared by all G2M processes on one machine.
SQLite is a projection, not authority.

Required connection settings:

~~~sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
~~~

Ordering is Journal durable -> reducer -> SQLite projection transaction.
Projection failure is recorded as PROJECTION_STALE and never changes a valid
Journal fact into a Worker failure.

## 5. Workspace Lease Contract

The authoritative lease is:

~~~text
G2M_STATE_ROOT/locks/<workspace_hash>.lock
~~~

Acquisition uses exclusive create with fs.open(path, "wx"). Metadata:

~~~json
{
  "lock_version": 1,
  "workspace_id": "project",
  "execution_id": "exec-001",
  "lease_id": "uuid",
  "pid": 1234,
  "hostname": "host",
  "created_at": 0,
  "heartbeat_at": 0
}
~~~

Only lease_id identifies ownership. Reclaim requires hostname, PID state,
heartbeat age, Journal state, and SQLite state. A separate exclusive reclaim
file serializes stale-lock removal and the second stale check.

## 6. Storage Reservation Contract

Before creating a worktree, G2M reserves a logical byte budget in SQLite:

~~~text
effective_available =
  physical_free - active_reservations - safety_margin
~~~

Reading free space, summing active reservations, checking limits, and inserting
the reservation occur in one SQLite transaction. A reservation is a logical
budget, not a physical disk reservation.

Required policy fields:

~~~text
min_free_bytes
safety_margin_bytes
default_execution_reservation_bytes
max_total_bytes
max_artifact_bytes
max_worktree_bytes
completed_retention_days
~~~

## 7. Execution Directory Contract

~~~text
G2M_STATE_ROOT/
├─ g2m-state.sqlite
├─ executions/
│  └─ <execution-id>/
│     ├─ execution.json
│     ├─ task.json
│     ├─ fingerprint.json
│     ├─ state-events.ndjson
│     ├─ worker-events.ndjson
│     ├─ worker-summary.json
│     ├─ worker.stderr.log
│     ├─ evidence.json
│     ├─ verification.json
│     ├─ verification.stdout.log
│     ├─ verification.stderr.log
│     ├─ frozen.patch
│     ├─ frozen-patch.json
│     ├─ review-bundle.json
│     ├─ review.json
│     ├─ outcome.json
│     ├─ storage-manifest.json
│     └─ tmp/
├─ locks/
├─ backups/
└─ tmp/
~~~

Each artifact is first written below the execution tmp directory, flushed,
closed, re-read and hash-checked, then atomically renamed to its final path.

## 8. Journal Event Schema

state-events.ndjson is append-only and physically ordered:

~~~json
{
  "schema_version": 1,
  "event_id": "uuid",
  "seq": 12,
  "timestamp_ms": 0,
  "task_id": "task-001",
  "execution_id": "exec-001",
  "type": "patch.frozen",
  "durability": "CRITICAL",
  "prev_hash": "hex-or-null",
  "hash": "hex",
  "payload": {}
}
~~~

The event hash is SHA256 of canonical JSON containing every field except hash.
CRITICAL events require a flush barrier. NORMAL events may be batched.
DIAGNOSTIC events go to worker-events.ndjson and never drive state.

Only a final incomplete line may be classified as TRUNCATED_TAIL. A broken
middle line or hash chain is an inconsistency and cannot be silently repaired.

## 9. SQLite Schema

SQLite migrations create these projection tables:

~~~sql
executions(execution_id PRIMARY KEY, task_id, workspace_id, state,
  created_at, updated_at, base_revision, runtime, runtime_version, model,
  fingerprint_hash, artifact_path, worktree_path, review_bundle_id,
  retention_class, gc_eligible_at)
workspaces(workspace_id PRIMARY KEY, canonical_path, updated_at)
workspace_locks(workspace_id PRIMARY KEY, execution_id, lease_id, pid,
  hostname, heartbeat_at)
reviews(review_bundle_id PRIMARY KEY, execution_id, review_id, decision,
  review_hash, applied_at)
artifacts(artifact_id PRIMARY KEY, execution_id, kind, path, sha256, bytes,
  immutable)
storage_usage(execution_id PRIMARY KEY, artifact_bytes, worktree_bytes, updated_at)
storage_reservations(reservation_id PRIMARY KEY, execution_id, volume_id,
  reserved_bytes, created_at, expires_at, state)
recovery_cases(execution_id PRIMARY KEY, status, reason, created_at, resolved_at)
projection_meta(key PRIMARY KEY, value)
~~~

The Journal and manifests are sufficient to rebuild all projection rows.

## 10. Retention / GC Contract

| State | Retention class | Automatic GC |
|---|---|---|
| ACCEPTED | NORMAL | Eligible after configured retention |
| BLOCKED / FAILED / CANCELLED | NORMAL | Eligible after diagnostics retention |
| REVIEW_PENDING / REVISION_REQUESTED | RETAINED | Never automatic |
| RECOVERY_REQUIRED | RECOVERY_CRITICAL | Never automatic |

Default completed artifact retention is 30 days. ACCEPTED and BLOCKED
worktrees are removed after their terminal Journal event. Failed and cancelled
worktrees are removed only after diagnostics are committed.

GC requires terminal state, eligible class, age threshold, no active lease,
valid manifest, and no recovery-critical flag. It is itself journaled:

~~~text
gc.marked (CRITICAL)
  -> git worktree remove --force
  -> remove disposable artifacts
  -> gc.completed (CRITICAL)
~~~

Interrupted GC is idempotently resumed. SAFE_ORPHAN may be collected only when
Journal, manifest, and state prove it disposable. UNKNOWN_ORPHAN becomes
RECOVERY_REQUIRED.

## Phase 0 Definition of Done

- All ten contracts above are explicit and mutually consistent.
- Every correctness-critical artifact has an artifact-first ordering.
- Every CRITICAL Journal fact has a defined flush point.
- Frozen Patch has exact-byte and change-set hashes.
- SQLite is explicitly rebuildable.
- Workspace Lease and Storage Reservation are cross-process contracts.
- Recovery-critical evidence is excluded from automatic GC.
- Phase 1 may begin only after this document is reviewed and accepted.
