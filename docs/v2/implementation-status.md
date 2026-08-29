# G2M v2 Implementation Status

## Phase 0 — Specification Freeze

Status: complete at Amendment 1 (`746a942`).

## Phase 1 — Frozen Patch Authority

Status: complete in the Phase 1 implementation commit.

Implemented:

- immutable Artifact Writer using temporary file, file flush, atomic rename,
  re-read, and exact-byte SHA-256 verification;
- exact `frozen.patch` and `frozen-patch.json` artifacts per execution;
- `patch_blob_hash` over exact patch bytes;
- canonical `change_set_hash` with rename represented as delete plus add;
- regular file, deletion, executable-mode, symlink, gitlink, nested path, new
  file, and binary patch coverage;
- Review Bundle bindings for artifact identity, both hashes, patch bytes, and
  canonical change-set entries;
- CRITICAL `patch.frozen` event binding artifact ID/path, both hashes, base
  revision, and byte count;
- ACCEPT post-apply change-set verification and immutable
  `apply-evidence.json` before `patch.applied`;
- Recovery comparison updated to use `change_set_hash` rather than legacy diff
  identity.

Verification:

- targeted Phase 1 tests pass;
- complete suite: 351 passed, 5 skipped after Phase 2;
- typecheck and build passed.

## Phase 2 — Durable Journal

Status: complete in the Phase 2 implementation commit.

Implemented:

- a unified `JournalWriter` with `append`, `flush`, and `close` operations;
- NORMAL-event batching and a CRITICAL flush barrier that durably writes every
  preceding queued event in physical append order;
- the frozen v2 snake_case event schema, including schema version, execution
  identity, domain, durability, sequence, and complete hash-chain bindings;
- per-execution `executions/<execution-id>/state-events.ndjson` journals;
- domain separation so storage, recovery, and projection facts cannot drive
  lifecycle state transitions;
- valid-prefix replay with explicit `TRUNCATED_TAIL` reporting for a final
  unterminated line;
- hard failure for malformed middle or completed lines and broken hash chains;
- write refusal after a truncated tail so recovery evidence cannot be appended
  over an uncertain journal;
- a deprecated flat-directory adapter for existing internal callers while CLI
  writes use only the v2 execution-directory layout.

Verification:

- targeted Journal, persistence, reducer, Review ingress, and CLI E2E tests
  pass;
- complete suite: 351 passed, 5 skipped;
- typecheck and build passed.

## Remaining phases

Phase 3 SQLite Projection is next, followed by Startup Backfill, Recovery,
crash-safe ACCEPT, cross-process lease, Process Supervisor, Storage Manager,
GC, operational CLI, runtime hardening, and CI matrices.
