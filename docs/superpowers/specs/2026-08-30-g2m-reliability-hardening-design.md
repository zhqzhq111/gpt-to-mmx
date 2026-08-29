# G2M Reliability Hardening Design

## Goal

Close the three P0 reliability gaps identified in the review: make the exact
accepted patch visible in the Review Bundle, persist execution evidence and
state across process restarts, and make ACCEPT recoverable across crashes.

## Scope and boundaries

- Preserve the existing temporary-worktree boundary and never commit or push
  a user's target repository as part of ACCEPT.
- Treat the binary-capable patch produced by `collectWorktreePatch()` as the
  authoritative artifact. The Review Bundle and workspace evidence reference
  the same patch hash and include its patch text for reviewer inspection.
- Persist events per execution as append-only JSONL, and persist evidence,
  fingerprints, and replay decisions with atomic JSON writes under a configured
  state directory.
- Add an explicit recovery command that loads persisted state, verifies the
  event chain, compares the current workspace to the frozen patch, and records
  `RECOVERY_REQUIRED` when the outcome cannot be proven.
- Model ACCEPT as prepared -> patch applied -> completed. Recovery reconciles
  a prepared or applied action by comparing target HEAD and the frozen patch
  hash before allowing a terminal result.

## Data flow

```text
worker -> verify -> freeze patch -> persist evidence/bundle
                                  |
review ACCEPT -> persist prepared -> apply patch -> persist applied -> completed
                                  |
restart -> load stores -> replay -> compare filesystem -> reconciled/unknown
```

## Error handling and compatibility

- Existing in-memory store constructors remain valid for unit tests.
- Persisted files are validated on load; malformed or broken hash chains stop
  recovery instead of being silently repaired.
- Existing direct review ingress remains supported for pure unit tests, while
  the execution engine uses the explicit ACCEPT transaction events.
- Verification failures, dirty targets, changed worktrees, and unknown crash
  outcomes remain non-accepting states.

## Verification

- Add a regression test proving untracked file content appears in the bundle
  patch and that the bundle patch hash matches the applied patch.
- Add persistence round-trip and corrupted-log tests for every durable store.
- Add restart/recovery tests for clean exit, dirty workspace, prepared ACCEPT,
  applied ACCEPT, and unknown outcomes.
- Keep the complete existing TypeScript test suite and build passing after each
  phase.
