# Phase 8 — Unified Process Supervisor

**Status:** FROZEN for implementation

Phase 8 gives every long-running external command started by G2M one common
owner for its operating-system process lifecycle. The supervisor owns process
trees and termination proof; adapters own protocol and logical-result
semantics.

## Frozen contracts

1. A kill request is not termination proof. `confirmedGone` is true only after
   the platform-specific tree/group probe confirms that the process tree is
   gone within a bounded wait.
2. Timeout and cancellation may become terminal outcomes only after
   termination is confirmed. If termination cannot be confirmed, the result is
   `UNKNOWN` and the engine enters `RECOVERY_REQUIRED`.
3. Verification with unconfirmed termination is a safe-hold condition. The
   engine records the verification evidence and `recovery.required`, preserves
   the worktree and lease, and does not collect a patch or final diff while a
   verification descendant may still be writing.
4. Supervisor launches use `program + argv` with `shell: false`; no caller may
   pass a compound shell command.

## Ownership and platform strategy

`ProcessSupervisor` is the only G2M component allowed to terminate a managed
OS process. On Windows it uses `taskkill /T`, waits, escalates to
`taskkill /T /F`, and probes the root PID. On POSIX it launches a detached
process group, sends `SIGTERM` to the negative PGID, waits, escalates to
`SIGKILL`, and probes the group. Both strategies have bounded graceful and
forced waits.

MCode keeps its native `--timeout` as an inner protocol timeout. The
supervisor owns the outer deadline and cleans up a lingering launcher after
`exec.completed` without waiting for natural wrapper exit. Verification moves
from `execFile` timeout handling to the same supervisor while preserving its
stdout/stderr separation and result hashing.

## Terminal and race rules

- `terminate()` is idempotent: concurrent or repeated calls share one
  termination promise.
- The first terminal cause among natural exit, timeout, cancel, and logical
  completion wins; cleanup executes once.
- Normal exit and non-zero exit remain ordinary outcomes.
- Confirmed timeout maps to `TIMED_OUT`/`timed_out` according to the existing
  caller contract. Unconfirmed termination maps to `UNKNOWN` and then the
  existing `RECOVERY_REQUIRED` path.
- No new task lifecycle states or heartbeat journal events are introduced.

## Validation gates

Tasks 0–4 end at one intermediate Gate:

```text
npm run typecheck
npm run build
npm run test:process-supervisor
npm test
```

After that Gate, Tasks 5–9 proceed continuously and finish with the existing
lease-process test, real process-tree E2E, full suite, and `git diff --check`.
