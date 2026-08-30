# Phase 10 — Garbage Collection and Crash-safe Retention Cleanup

Status: implementation in progress from the sealed Phase 9 storage baseline.

## Authority

Execution Journals, manifests, filesystem leases, reservation records, recovery
evidence, and the filesystem are authoritative. SQLite is only a discovery and
projection index; it never authorizes deletion.

An execution is eligible only when all of these are proven:

- the Journal loads with a valid hash chain and ends in `ACCEPTED`, `BLOCKED`,
  `FAILED`, `CANCELLED`, or `TIMED_OUT`;
- the retention class is `NORMAL` and the independently derived terminal time
  plus the configured retention period has passed;
- the projection agrees with the Journal and no `RECOVERY_REQUIRED` evidence
  exists;
- the storage manifest exists, validates, binds to the execution, and its
  deletion targets are safe direct children of the configured roots;
- there is no active workspace lease and no active storage reservation; and
- the artifact and worktree top-level targets are ordinary directories, not
  symlinks, junctions, devices, or other reparse points.

Any uncertainty blocks GC. `REVIEW_PENDING`, `REVISION_REQUESTED`, active
states, corrupt executions, and `RECOVERY_REQUIRED` executions are never
automatically collected, regardless of age.

## Durable mutation protocol

Dry-run is the default and performs no writes, lease acquisition, or deletes.
Only `g2m gc --apply` mutates state, under the per-state-root
`gc/gc.lock` run lock. The mutating sequence is:

```text
revalidate candidate
acquire optional WorkspaceLock maintenance lease
append durable CRITICAL gc.marked
remove repository-bound worktree and prune Git metadata
remove the validated execution artifact directory
write and verify a durable self-hashed tombstone
append durable CRITICAL gc.completed bound to that tombstone
close this execution's Journal writer
remove the execution state directory
remove only released/expired/abandoned reservation records
clear disposable projection rows while retaining the historical execution row
release maintenance and GC locks
```

The execution Journal remains present until `gc.completed` is durable. A
failure after `gc.marked` never rolls back the mark; it is resumed later as
`GC_INTERRUPTED`. A valid tombstone plus `gc.completed` makes state-directory
cleanup idempotent and is reported as `GC_CLEANUP_PENDING` if cleanup is
temporarily unavailable.

## Tombstones

Tombstones are permanent under `state_root/tombstones/<execution-id>.json`.
They contain the task/workspace identity, terminal metadata, retention class,
the marked-event binding, pre-GC byte counts, completion timestamp, and
`self_hash = SHA256(canonical JSON excluding self_hash)`. They are written
artifact-first with the existing immutable-artifact durability protocol.

The `gc.marked` payload stores only validated relative deletion identifiers and
the exact current manifest generation/hash. It never treats an arbitrary
manifest path as a deletion authority. `gc.completed` binds the tombstone
hash and completion timestamp.

## Recovery and projection

Startup may resume only previously marked operations; it never starts a fresh
age-based GC scan. The recovery scanner reports `GC_INTERRUPTED`,
`GC_CLEANUP_PENDING`, invalid tombstones, and uncertain bindings. A marked
operation suppresses ordinary missing-artifact corruption reports for the
targets it authorized, but any lifecycle/recovery event after the mark stops
automatic continuation.

Projection rebuilds accept valid tombstones as minimal historical GC records;
they do not fabricate artifact, review, or recovery rows. Invalid tombstones
are rejected and remain operator-visible. Only tombstone-bound leftovers are
eligible for `SAFE_ORPHAN` cleanup; unknown orphan directories are report-only.

## CLI boundary

Phase 10 adds only:

```text
g2m gc --config <config>
g2m gc --config <config> --apply
g2m gc --config <config> [--apply] --execution-id <execution-id>
```

There is no `--force`, `--ignore-recovery`, `--ignore-lease`, or
`--delete-anyway` escape hatch. Phase 11 operational commands are out of
scope.
