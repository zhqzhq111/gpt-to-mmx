# GPT-to-MiniMax / G2M v2.0

## Phase 0 — Specification Freeze

**Status:** FROZEN — Amendment 1
**Spec Revision:** 1
**Reviewed:** yes
**Target:** G2M v2.0.0
**Supersedes:** Initial freeze at commit `2356a89`
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
5. SQLite can be deleted and rebuilt from Journal, immutable Artifacts, lease
   and reservation records, and trusted local workspace configuration.
6. Recovery never guesses; insufficient evidence becomes RECOVERY_REQUIRED.
7. REVIEW_PENDING, REVISION_REQUESTED, and RECOVERY_REQUIRED are never auto-GCed.
8. Every CRITICAL Journal event binds the exact artifact or state fact it commits.
9. Storage and recovery events are durable but do not drive lifecycle state transitions.

## 1. Persistence Ordering Diagram

### Normal execution

~~~text
validate task
  -> atomically write task.json
  -> append task.created (CRITICAL) and flush
  -> create worktree
  -> append worktree.created (NORMAL)
  -> resolve runtime and verification profile
  -> atomically write fingerprint.json
  -> re-read and verify fingerprint hash
  -> append fingerprint.frozen (CRITICAL) and flush
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
  -> re-read and verify review-bundle hash
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
  -> atomically write apply-evidence.json and outcome.json
  -> re-read and verify apply evidence and outcome hashes
  -> append patch.applied (CRITICAL) and flush
  -> append review.accept.completed (CRITICAL) and flush
~~~

Journal events never contain placeholder hashes. A CRITICAL event is appended
only after every artifact named by its payload exists, is closed, and has been
re-read with its expected hash.

Required bindings include:

~~~json
{
  "type": "patch.frozen",
  "payload": {
    "artifact_id": "artifact-001",
    "artifact_path": "frozen.patch",
    "patch_blob_hash": "sha256",
    "change_set_hash": "sha256",
    "base_revision": "commit",
    "patch_bytes": 12345
  }
}
~~~

review.requested binds review_bundle_id, review_bundle_hash, task_hash, and
result_hash. patch.applied binds patch_blob_hash, expected_change_set_hash,
actual_change_set_hash, and apply_evidence_hash.

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
    "path": "old.ts",
    "kind": "deleted",
    "mode": null,
    "content_sha256": null
  },
  {
    "path": "new.ts",
    "kind": "file",
    "mode": "100644",
    "content_sha256": "..."
  }
]
~~~

The final state representation is independent of Git rename heuristics:
rename equals deleted old path plus added new path. The array contains one
entry for every changed final path and uses these rules:

- path is repository-relative, uses `/`, preserves case, rejects empty paths,
  `.` and `..` components, and is UTF-8 text without Unicode normalization;
- kind is one of `file`, `symlink`, `gitlink`, or `deleted`;
- regular file content_sha256 hashes exact file bytes;
- symlink content_sha256 hashes the exact link target bytes;
- gitlink content_sha256 is the referenced commit ID;
- deleted entries have mode and content_sha256 set to null;
- mode-only changes keep the same content hash and carry the new mode;
- entries are sorted by UTF-8 byte order of normalized path, then kind.

The result is hashed as canonical JSON:

~~~text
change_set_hash = SHA256(canonical_json(change_set))
~~~

ACCEPT verifies patch_blob_hash before apply and change_set_hash after apply.
Any mismatch is PATCH_RESULT_MISMATCH and enters RECOVERY_REQUIRED.

The immutable artifacts are task.json, fingerprint.json, worker-summary.json,
verification.json, frozen.patch, frozen-patch.json, review-bundle.json,
review.json, apply-evidence.json, and outcome.json. They are write-once; a
revision creates a new artifact.

storage-manifest.json is a rebuildable mutable snapshot, not Evidence Truth.
It is atomically replaced and includes generation and updated_at. Its values
may change as worktree and artifact usage are rescanned.

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

### Projection Source Matrix

| SQLite projection | Authoritative source |
|---|---|
| executions | execution Journal plus immutable execution artifacts |
| workspaces | trusted local config plus workspace binding snapshot |
| workspace_locks | lease files |
| reviews | review artifact plus Journal |
| artifacts | immutable artifacts and storage manifests |
| storage_usage | filesystem rescan plus manifests |
| storage_reservations | reservation Journal events plus reservation records |
| recovery_cases | Journal |
| projection_meta | rebuild-generated metadata |

If a source row is unavailable or contradictory, rebuilding marks the affected
projection as stale; it invents no missing fact.

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

Lease lifecycle is explicit:

- create the owner file with exclusive create and write metadata through a
  temporary file followed by atomic rename;
- an empty, malformed, or missing-metadata lock is INCOMPLETE_LEASE and is not
  silently deleted; it enters stale-reclaim handling after the configured age;
- the immutable owner file is not rewritten for heartbeats;
- heartbeat is an atomically replaced sidecar at
  `<workspace_hash>.<lease_id>.heartbeat` containing lease_id and heartbeat_at;
- release reads the current owner and deletes the lock only when lease_id
  matches; an old process can never delete a newer owner's lease.

## 6. Storage Reservation Contract

Before creating a worktree, G2M reserves a logical byte budget in SQLite:

~~~text
effective_available =
  physical_free - min_free_bytes - safety_margin_bytes - active_reservations
~~~

Reading free space, summing active reservations, checking limits, and inserting
the reservation occur in one SQLite transaction. Admission requires the
requested reservation to be no greater than effective_available. A reservation
is a logical budget, not a physical disk reservation.

Reservations have states ACTIVE, RELEASED, EXPIRED, and ABANDONED. An ACTIVE
reservation for an UNKNOWN or RECOVERY_REQUIRED execution is never released
solely because expires_at passed; it requires recovery evidence or an explicit
operator action. A confirmed dead, terminal execution may release it.

Reservations are per volume. If worktree_root and artifact_root are on
different volumes, each volume has its own free-space calculation and logical
reservation row.

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
│     ├─ apply-evidence.json
│     ├─ outcome.json
│     ├─ storage-manifest.json
│     └─ tmp/
├─ locks/
├─ backups/
├─ tombstones/
└─ tmp/
~~~

Each immutable artifact is first written below the execution tmp directory,
flushed, closed, re-read and hash-checked, then atomically renamed to its final
path. fingerprint.json is written and verified before agent.started. The
execution directory also contains apply-evidence.json between patch.applied
and review.accept.completed.

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
  "domain": "lifecycle",
  "type": "patch.frozen",
  "durability": "CRITICAL",
  "prev_hash": "hex-or-null",
  "hash": "hex",
  "payload": {}
}
~~~

The event hash is SHA256 of canonical JSON containing every field except hash.
CRITICAL events require a flush barrier. A CRITICAL flush barrier returns
success only after that event and every preceding queued NORMAL event in the
same execution journal are durably written in physical append order. NORMAL
events may otherwise be batched.
DIAGNOSTIC events go to worker-events.ndjson and never drive state.

domain is one of lifecycle, recovery, storage, or projection. Only lifecycle
events drive Task State. Storage events such as gc.marked/gc.completed and
projection events such as projection.repaired remain durable Journal facts but
are ignored by the lifecycle reducer.

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

The projection source matrix above defines the complete rebuild inputs; no
projection row may require SQLite as its only source.

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

gc.marked and gc.completed use domain=storage and do not pass through the
lifecycle Task State reducer. The execution Journal remains until gc.completed
is durably written. After an execution is GCed, a tombstone containing
execution_id, final_state, and gc_completed_at remains so a projection rebuild
can represent intentional historical deletion without fabricating evidence.

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

## Amendment history

| Revision | Commit | Change |
|---|---|---|
| 0 | `2356a89` | Initial Phase 0 contract freeze |
| 1 | Amendment 1 | Bound critical events to artifacts, clarified hashes and sources, and resolved lease, storage, and GC lifecycle gaps |
