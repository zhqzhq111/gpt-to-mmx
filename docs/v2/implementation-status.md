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
- complete suite: 340 passed, 5 skipped;
- typecheck and build passed.

## Remaining phases

Phase 2 Durable Journal is next, followed by SQLite Projection, Startup
Backfill, Recovery, crash-safe ACCEPT, cross-process lease, Process Supervisor,
Storage Manager, GC, operational CLI, runtime hardening, and CI matrices.
