# Phase 9 — Storage Manager Contract

Status: Task 0–5 foundation contract. Engine admission and runtime guard are
deliberately not wired in this checkpoint.

## Authority and boundaries

Phase 9 accounts for and protects managed storage. It does not delete
historical executions, worktrees, artifacts, manifests, or reservation
records; deletion belongs to Phase 10 GC. Journals and immutable reservation
records are authoritative. SQLite tables are disposable projections.

The future execution order is:

```text
SQLite open → projection backfill → startup recovery → lease reconciliation
→ storage-reservation reconciliation → storage-usage rescan → Engine
```

Storage events use `domain: "storage"`, are `CRITICAL`, and never advance the
lifecycle reducer.

## Policy

`storage` is optional in `g2m.local-config.v1`; old configurations remain
valid. The parser fills these defaults:

| Field | Default | Meaning |
| --- | ---: | --- |
| `min_free_bytes` | 1 GiB | physical free-space floor |
| `safety_margin_bytes` | 512 MiB | emergency write margin |
| `default_execution_reservation_bytes` | 1 GiB | logical budget per root volume |
| `max_total_bytes` | 0 | disabled when zero |
| `max_artifact_bytes` | 0 | disabled when zero |
| `max_worktree_bytes` | 0 | disabled when zero |
| `completed_retention_days` | 30 | retention projection input |
| `reservation_ttl_ms` | 24 hours | diagnostic expiry only |
| `monitor_interval_ms` | 5 seconds | future runtime probe interval |

Planner input does not choose an arbitrary reservation. G2M resolves and
authorizes the policy locally.

Admission uses, per volume:

```text
effective_available = physical_free - min_free_bytes
                    - safety_margin_bytes - active_reservations
```

The requested reservation must not exceed `effective_available`. Managed
usage plus active reservations plus the new request must also remain under
`max_total_bytes` when that limit is non-zero. A state-root free-space sanity
check is required for Journal/SQLite writes, but state-root is not assigned a
large managed reservation in this phase.

## Volume identity and root accounting

Reservations are per volume. Windows drive roots normalize to
`win32:c:\\`; UNC roots normalize to `win32-unc:\\\\server\\share`.
POSIX roots use the filesystem device number as `posix-dev:<dev>`, not the
path `/`. Multiple configured roots on one volume share one reservation row;
different volumes have independent capacity buckets.

## Reservation record and states

Before future worktree creation, an immutable record is written at:

```text
<state_root>/reservations/<reservation-set-id>.json
```

It contains `schema_version: 1`, execution identity, process ownership
(`pid`, `hostname`), creation/expiry timestamps, and one entry per volume:
`reservation_id`, `volume_id`, `reserved_bytes`, and roles.

SQLite `storage_reservations` rows mirror the record and support:
`ACTIVE`, `RELEASED`, `EXPIRED`, and `ABANDONED`. Normal operation uses
`ACTIVE` and `RELEASED`; expiry is diagnostic state, not permission to
release.

Admission is one `BEGIN IMMEDIATE` transaction: read physical free space,
sum active rows, read managed usage, validate every volume and limit, then
insert all rows or roll back all rows. A failed Journal append leaves the
record and SQLite reservation conservatively active for reconciliation.

## Journal and projection rules

The supported storage facts are:

```text
storage.reservation.created
storage.reservation.released
storage.reservation.expired
storage.reservation.abandoned
```

Creation and release are Journal-first. A release event is durable before the
conditional `ACTIVE → RELEASED` projection update. Replaying storage events
must preserve lifecycle state. If the projection fails, the Journal remains
the source and the next rebuild repairs SQLite.

## Usage and manifest

The scanner measures logical file bytes (`lstat.size`). It counts regular
files and symlink entries but never follows symlinks, junctions, or reparse
points into another directory. Missing worktree/artifact roots count as zero.
Traversal is bounded/serial rather than an unbounded `Promise.all` over all
files.

Each execution may have a mutable, rebuildable:

```text
<state_root>/executions/<execution-id>/storage-manifest.json
```

The versioned manifest contains `schema_version`, `execution_id`,
`generation`, `updated_at`, artifact/worktree/total bytes, paths,
`retention_class`, and `gc_eligible_at`. Updates write a temporary file,
flush/close it, and replace the manifest atomically. `generation` increases
from the prior manifest. A successful manifest is evidence for the
`storage_usage` UPSERT; SQLite is never the only source.

Usage checkpoints are lifecycle-controlled (worktree creation, worker or
verification completion, frozen patch, review pending, terminal result, and
startup reconciliation). The free-space probe is read-only; Phase 9 does not
write a manifest or Journal entry on every monitor tick.

## Startup and retention semantics

After SQLite deletion, reservation records plus storage Journal facts rebuild
`storage_reservations`; manifests/filesystem scans rebuild `storage_usage`.
Corrupt or incomplete Journal evidence never authorizes destructive cleanup.
`RECOVERY_REQUIRED` always retains `ACTIVE`, even when `expires_at` is past.
Only a proven-safe known terminal execution may release a leaked active row;
startup uses `EXPIRED` only as an explicit conservative diagnostic result.

Retention projection remains:

```text
ACCEPTED/BLOCKED/FAILED/CANCELLED/TIMED_OUT → NORMAL
REVIEW_PENDING/REVISION_REQUESTED          → RETAINED
RECOVERY_REQUIRED                          → RECOVERY_CRITICAL
```

`gc_eligible_at` is derived metadata, populated only for eligible NORMAL
terminal executions as `terminal_timestamp + completed_retention_days`; it
is not authority and Phase 9 never performs GC.

## Explicit phase boundary

This checkpoint implements only the storage foundation: policy, volume
identity, usage/manifest, reservation primitive, storage events/projection,
and startup/rebuild reconciliation. It intentionally does not implement
Engine admission ordering, Runtime Storage Guard, terminal/recovery lifecycle
integration, real two-process reservation E2E, or Phase 10 GC/release
documentation.
