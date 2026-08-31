# G2M v2 Phase 13 — CI / Regression Spec Freeze

**Status:** SPEC FROZEN

**Phase 12 sealed base:** `1f729852f3d82a215bff0f45236a97f2098583c3`

Phase 13 begins only from the sealed Phase 12 commit above. All Phase 13
agents must use independent branches/worktrees from that exact SHA.

## Supported CI environment

The required CI matrix is:

- Windows
- Linux
- Node.js 22.x satisfying `>=22.19.0`

Windows is required for Windows-specific process-tree semantics. Linux is
required for POSIX process-group termination semantics.

## CI must not require

Default CI must not require:

- MiniMax credentials;
- a logged-in `mcode`;
- API keys;
- ACP;
- Agent Team;
- paid model calls.

Existing real-MCode tests remain explicit/manual and skipped by default.

## CI authority

CI validates source code and regression behavior only. It does not become
execution or recovery authority. Journal and Frozen Patch semantics remain
unchanged.

## Required CI gate families

The final CI must cover:

- lockfile installation with `npm ci`;
- TypeScript typecheck;
- production build;
- Vitest suite;
- Workspace Lease process E2E;
- Process Supervisor process E2E;
- Storage Reservation process E2E;
- GC process E2E;
- Operations process E2E;
- clean repository and diff hygiene.

## Parallel ownership freeze

The following agents start from the same sealed Phase 12 SHA and must not
merge each other's branches during development:

| Agent | Ownership | Branch |
|---|---|---|
| F | `.github/workflows/**` CI infrastructure | `agent/p13-ci` |
| G | Runtime / Worker / Verification regression | `agent/p13-runtime-regression` |
| H | Persistence / Journal / Recovery / ACCEPT regression | `agent/p13-recovery-regression` |
| I | Workspace / Storage / GC / Operations regression | `agent/p13-ops-regression` |

`package.json`, `package-lock.json`, `README.md`,
`docs/v2/implementation-status.md`, and this document are reserved for the
final Integrator. If a worker believes one of these shared files must change,
it reports the required change instead of editing it.

## Scope boundaries

Phase 13 adds CI and regression coverage. It must not weaken or replace:

- Frozen Patch as apply authority;
- Journal as lifecycle and recovery authority;
- SQLite as a rebuildable Projection;
- cross-process Workspace Lease ownership;
- proven process termination;
- bounded storage and output;
- proof-before-delete GC;
- zero-mutation Status/Doctor;
- allowlisted Repair;
- frozen and revalidated runtime identity;
- strict Worker protocol;
- identity-bound Verification;
- legacy readability;
- the rule that UNKNOWN is never automatically retried.

No ACP, OpenCode, Agent Team, daemon, new Worker type, new repair action, or
MiniMax-quota-consuming default CI path is permitted.

## Phase 13 completion gate

After F/G/H/I are integrated, the final Integrator must verify clean install,
typecheck, build, unit tests, all process E2E suites, CLI smoke coverage, and
both Windows and Linux CI results. The phase is not complete while either
platform is failing. The final result must report exact pass/skip/fail counts,
skipped tests and reasons, known limitations, and the final commit SHA.
