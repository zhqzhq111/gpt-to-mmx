# G2M Phase 11 Operational CLI Design

**Date:** 2026-08-30
**Branch:** `codex/phase-11-operational-cli`
**Base:** `406906e8e93983bd35f5a73f4b88fd105eff4297`
**Scope:** Phase 11 only; Phase 12 is explicitly out of scope.

## Goal

Expose the persisted G2M state through safe, understandable, scriptable
`status`, `doctor`, and `repair` commands. Observation must never repair or
reconcile state merely because it was observed.

## Design

The CLI remains a thin adapter: parse arguments, call an operation, and render
the result. A new `src/operations/` layer owns operational behavior:

- `snapshot.ts` builds a read-only operational snapshot from filesystem,
  Journal, projection, lease, reservation, recovery, and GC sources.
- `doctor.ts` converts a snapshot into deterministic checks and a report.
- `repair.ts` creates a plan and dispatches only allowlisted actions.
- `repair-lock.ts` serializes repair mutations across processes.
- `repair-audit.ts` durably records repair plans and results.
- `format.ts` renders stable text and JSON output.

`status` and `doctor` must not call `configureEngine()`, `backfillProjection()`,
startup recovery, lease reconciliation, storage reconciliation, usage rebuild,
interrupted-GC resume, or any other mutating startup path. They open the
projection database read-only when it exists and continue with filesystem and
Journal sources when the database is missing or unreadable.

The snapshot is the shared read model. Doctor does not re-read mutable sources
with different rules, and repair does not infer arbitrary deletion from a
diagnostic. Existing read-only mechanisms and classification rules are reused:
`scanRecovery()`, `planGcCandidates()`, Journal chain verification,
`classifyLeasePolicy()`, tombstone validation, and filesystem/reservation
inspection.

## Commands and safety boundary

Supported commands are:

```text
g2m status  --config <config> [--execution-id <id>] [--format text|json]
g2m doctor  --config <config> [--execution-id <id>] [--format text|json]
g2m repair  --config <config> --action <action> [--execution-id <id>]
             [--format text|json] [--apply]
```

The default format is text. JSON uses snake_case and stable top-level schema
versions:

- `g2m.status.v1`
- `g2m.doctor.v1`
- `g2m.repair-plan.v1`
- `g2m.repair-result.v1`

No `--watch`, `--all`, `--force`, `--delete-anyway`, journal/recovery/lease
bypass, SQLite trust override, or Journal rewrite option is implemented.

The Phase 11 repair allowlist is intentionally limited to existing trusted
mechanisms:

1. `projection-rebuild` — rebuild the projection through the existing guarded
   rebuild path; only with `--apply`.
2. `gc-resume` — resume an already-marked/interrupted GC operation through the
   existing crash-safe GC executor; it never broadens deletion targets; only
   with `--apply`.
3. `storage-reconcile` — reconcile durable storage reservations through the
   existing reconciliation rules; only with `--apply`.

Without `--apply`, repair produces a plan and performs zero mutations. Unknown
actions and unsafe conditions are refused with operator guidance. There is no
generic force path and no lease-reclaim action in this phase.

## Snapshot shape

The public snapshot uses camelCase internally and is rendered to the stable
snake_case JSON contract:

```ts
interface OperationalSnapshot {
  schemaVersion: "g2m.status.v1";
  generatedAt: number;
  stateRoot: StateRootStatus;
  executions: ExecutionStatus[];
  workspaces: WorkspaceStatus[];
  projection: ProjectionStatus;
  storage: StorageStatus;
  recovery: RecoveryStatus;
  gc: GcStatus;
}
```

State-root checks report existence only and never create directories. Execution
records include identity, state, Journal status, retention, measured artifact
and worktree bytes, plus lease, reservation, recovery, and GC status. A missing
Journal is reported as `GCED` only when a valid final Tombstone proves the
execution was collected; otherwise it is `MISSING`/an operational issue.

Projection states distinguish missing, unreadable, and readable databases and
include metadata such as schema version, rebuild status/time, stale execution
count, and stale-event count. Projection failure does not suppress the rest of
the snapshot.

Lease status reuses Phase 7 classification values. Storage totals are derived
from filesystem/manifests and reservation records/events first; SQLite is a
cross-check and acceleration source, never the only authority. Recovery uses
the read-only scanner. GC uses the read-only candidate planner and validated
tombstones.

An execution filter retains only the selected execution and directly related
workspace, lease, reservation, recovery, and GC information.

## Doctor checks

Doctor evaluates deterministic checks over one snapshot. Each check has an
identifier, category, severity/status, human message, and evidence references.
The report distinguishes pass, warning, and failure, and contains a stable
exit classification without mutating state. Checks cover Journal integrity,
projection readability/staleness, lease consistency, reservation integrity,
storage accounting, recovery safe holds, GC consistency, and cross-source
identity/byte/hash mismatches.

Doctor must expose safe holds such as `RECOVERY_REQUIRED`, invalid or
unreadable Journals, unsafe leases, invalid tombstones, and projection stale
state as evidence-backed findings rather than attempting to correct them.

## Repair lifecycle

Repair first obtains a read-only snapshot and doctor report, then derives a
plan for exactly one requested allowlisted action. The plan records the action,
target scope, prerequisites, reasons, and whether apply is permitted. Applying
requires the explicit `--apply` flag, a fresh precondition check, the
cross-process repair lock, and durable audit records for plan/start/result.

The action calls the existing mechanism with its existing safety checks. It
does not delete arbitrary paths, rewrite Journals, bypass recovery, or reclaim
leases. The result records applied/skipped/refused outcome, evidence, and
operator guidance. A subsequent `doctor` is the verification step; repair
does not silently run observation-time startup reconciliation.

## Error handling and compatibility

Malformed CLI arguments, forbidden flags, unknown actions, missing config, and
unreadable required config fail with a structured `g2m.error` response and a
non-zero exit code. Operational partial reads remain representable: missing or
corrupt projection data produces a degraded snapshot rather than hiding valid
Journal/filesystem facts. Existing `probe`, `run`, `review`, `recover`, and
`gc` behavior remains unchanged.

## Testing strategy

Tests are added before implementation for:

- CLI parsing/help and stable text/JSON schemas;
- status and doctor zero-mutation snapshots, including byte/mtime invariants;
- missing/unreadable projection with continued filesystem reporting;
- Journal states, tombstone-backed `GCED`, execution filtering, and reused
  lease/recovery/GC classifications;
- repair dry-run zero mutation, explicit-apply enforcement, unknown/forbidden
  action rejection, lock serialization, audit durability, and each allowlisted
  action's delegation boundary;
- regression coverage proving operational commands never invoke
  `configureEngine()` or startup reconciliation.

The Phase 10 baseline must remain green, and final verification includes
typecheck, build, the full test suite, relevant process suites, and
`git diff --check`.
