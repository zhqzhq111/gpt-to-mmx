# Review policy

## ACCEPT

Choose ACCEPT only when all are true:

- The six binding fields and bundle hash are intact.
- The diff directly implements the goal and acceptance criteria.
- No unrelated or unexplained file changed.
- Independent verification is `passed`, or it is explicitly `skipped` for a justified low-risk task.
- Protected files, tests, build configuration, and deletions were examined.
- Worker-reported risks and blocked reasons are resolved or acceptable.

ACCEPT applies the frozen binary-capable patch to the clean source workspace as uncommitted changes. It never commits or pushes.

## REVISE

Choose REVISE when the approach is recoverable but evidence shows a concrete defect, omission, or scope problem. Findings must be specific and independently checkable. Supply a new task ID; revision is not an automatic retry.

The current CLI records the revision decision and retains the isolated worktree. Do not claim the revision has executed until a follow-up task explicitly continues or replays that retained work.

## BLOCK

Choose BLOCK when the requested change is unsafe, the evidence is insufficient, the task conflicts with local policy, or the implementation should be discarded. G2M removes the isolated worktree and leaves the source workspace unchanged.

## Failure and recovery

- `FAILED`: normal bounded failure; inspect the final event and message.
- `TIMED_OUT`: outer watchdog stopped the process tree; the isolated worktree is preserved for inspection.
- `RECOVERY_REQUIRED`: outcome is unknown. Do not rerun, resume, accept, or continue to another task automatically.
- Dirty source workspace at review time: ACCEPT is not consumed; clean or reconcile the unrelated change before retrying the same review.
