# G2M v2 Phase 12 — Runtime Hardening

**Base:** `e494cb961abfb109f45ea05d2c2763c9470e3a5a`
**Branch:** `codex/phase-12-runtime-hardening`
**Scope:** Tasks 0–5 before the MID GATE. Tasks 6–12 and Phase 13 are out of scope until an explicit review approval.

## Goal

Make runtime identity, external output, protocol parsing, protected policy,
verification executables, and repair reclaim guards observable, bounded, and
safe under environment drift or process crashes. This phase does not add new
agents, workers, repair actions, daemons, ACP, OpenCode, or CI automation.

## Authority and compatibility

- The Journal remains lifecycle and recovery authority.
- Frozen patches remain patch authority for ACCEPT recovery.
- SQLite remains a rebuildable projection.
- Filesystem `runtime-identity.json`, `protected-policy.json`, and
  `fingerprint.json` are immutable execution evidence bound by Journal events.
- Current config is comparison input, not historical runtime authority.
- Phase 0–11 executions remain readable and recoverable under legacy semantics.
  No historical artifact is fabricated and no old Journal/fingerprint is
  rewritten.
- A runtime change before Worker spawn is deterministic `RUNTIME_DRIFT` and
  must not spawn. A malformed/overflowed Worker control stream after spawn is
  protocol uncertainty and enters `RECOVERY_REQUIRED` while retaining the
  Worktree and Lease. Verification diagnostics remain bounded without changing
  exit-code authority.

## Runtime hardening configuration

`runtime_hardening` and `mcode_model` are optional local-config fields. Missing
runtime hardening configuration uses these defaults:

```json
{
  "max_worker_stdout_bytes": 33554432,
  "max_worker_stderr_bytes": 8388608,
  "max_stream_json_line_bytes": 4194304,
  "max_worker_events": 100000,
  "max_verification_stdout_bytes": 16777216,
  "max_verification_stderr_bytes": 16777216,
  "max_probe_output_bytes": 2097152,
  "repair_reclaim_guard_stale_ms": 30000
}
```

All limits are positive safe integers below a documented reasonable maximum.
`mcode_model` is optional. When absent, new runtime identity records
`model: null` and `model_pinned: false`; Doctor warns but does not fail solely
for an unpinned model.

## Runtime identity

The runtime identity records the actual resolved launcher, not merely the PATH
input or version string:

```json
{
  "schema_version": 1,
  "runtime": "mcode",
  "runtime_version": "...",
  "node_version": "...",
  "platform": "win32",
  "arch": "x64",
  "launch_kind": "cmd",
  "resolved_executable_path": "...",
  "executable_sha256": "...",
  "executable_bytes": 0,
  "resolved_via": "trusted-override",
  "help_sha256": "...",
  "exec_help_sha256": "...",
  "capability_snapshot_hash": "...",
  "adapter_contract_version": "g2m-worker-v2",
  "invocation_contract_version": "g2m-mcode-invocation-v2",
  "worker_summary_schema_hash": "...",
  "model": null,
  "model_pinned": false,
  "identity_hash": "sha256"
}
```

`identity_hash` excludes timestamps, probe duration, temporary paths, and PID.
The executable hash is a streaming SHA-256 over the canonical realpath target
bytes. Probe identity is frozen once and recomputed once immediately before
spawn; any mismatch returns `RUNTIME_DRIFT` and starts no Worker.

The probe must use the unified Process Supervisor for `--version`, `--help`,
and `exec --help`, with shell disabled, bounded output, bounded timeout, and
confirmed termination. `--output-schema` must be verified from actual
`mcode exec --help`, not only from documented capabilities.

## Protected policy

New executions freeze an immutable `protected-policy.json` before Worker spawn.
It binds task/execution identity, workspace and root mappings, permission and
limits, verification program identity, output limits, storage policy hash,
lease policy hash, and `runtime_identity_hash`. Verification environment values
are never persisted; only variable names and a canonical environment hash are
stored. A changed workspace/root binding blocks destructive recovery mutation.
Verification-profile drift warns Doctor when patch-only recovery does not need
to rerun verification. Current MCode drift alone must not block patch-only
ACCEPT recovery.

## Fingerprint v2 and artifact order

New executions use `fingerprint_version: 2` and bind:

- `runtime_identity_hash`
- `protected_policy_hash`
- `worker_summary_schema_hash`
- immutable artifact hashes for runtime identity, protected policy, and the
  fingerprint itself

The artifact-first order is:

```text
resolve runtime
→ build runtime identity
→ build protected policy
→ build fingerprint v2
→ freeze runtime-identity.json
→ freeze protected-policy.json
→ freeze fingerprint.json
→ recheck runtime identity
→ spawn Worker
→ append agent.spawn.started with all bindings
```

Existing fingerprint v1 records remain untouched and readable.

## Bounded and strict protocol

Every external stream uses a bounded collector. Worker stdout is control
protocol: total bytes, line bytes, and event count overflow terminate the Worker
through Process Supervisor and produce an incomplete protocol result that enters
`RECOVERY_REQUIRED`. Worker stderr and Verification stdout/stderr retain only a
bounded prefix, continue draining, and record captured bytes, total bytes,
truncation, and captured-byte hash. Verification exit code remains the pass/fail
authority.

The incremental NDJSON decoder preserves a partial line until newline or EOF;
there is no timer-based partial flush. EOF parses the final unterminated line
once. Empty lines may be ignored, unknown event types are retained as raw
events, and known event types with invalid required fields/enums are protocol
errors. New Worker runs require exact JSON worker summaries under
`g2m.worker-summary.v1`; Markdown/fence/first-object heuristics are legacy-only.

## Verification identity

Before verification, resolve the configured program to a canonical host
launcher path and stream-hash its bytes. Freeze the path/hash in protected
policy, then recheck once immediately before running it. A mismatch returns
`VERIFICATION_RUNTIME_DRIFT` and does not run the changed executable. Workspace
files such as `package.json` and test sources are not part of host executable
identity.

## Repair reclaim guard

Phase 12 hardens the Phase 11 `repair.lock.reclaim` window using the verified
Phase 7 guard semantics. A guard may be removed only when it is same-host,
older than the configured threshold, and its PID is proven dead. Live, unknown,
foreign, and fresh malformed guards remain protected. No recursive guard for a
guard is introduced; the existing ownership protocol is reused directly.

## Doctor and Status

Status and Doctor remain zero-mutation. They may hash and compare existing
artifacts/configuration but must not probe MCode, spawn verification, create a
repair guard, or rewrite an artifact. Phase 12 adds runtime identity, protected
policy, model pinning, output-limit, legacy, and reclaim-guard observations.
Terminal legacy executions are informational; active or recovery-critical
legacy executions receive an evidence-limited warning rather than fabricated
Phase 12 artifacts.

## MID GATE

After Tasks 0–5, stop for review. Required checks are:

```text
npm run typecheck
npm run build
npm test
git diff --check
```

The review must specifically confirm legacy v1 readability, immutable artifact
semantics, runtime drift prevention before spawn, Journal authority, absence of
Phase 13 work, and unchanged Phase 0–11 authority rules before Tasks 6–12 may
begin.
