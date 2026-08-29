---
name: gpt-to-mmx
description: Delegate bounded coding work to MiniMax Code while Codex keeps planning and final review, using isolated Git worktrees, independent verification, evidence-bound review decisions, and safe recovery. Use for repository coding tasks when the user asks Codex/GPT to plan or review and MiniMax/mcode to execute. Do not use for MMX multimedia generation or non-coding chat.
---

# GPT to MiniMax

Use G2M as the boundary between Codex and MiniMax Code:

```text
Codex plans -> G2M validates and isolates -> mcode edits -> G2M verifies -> Codex reviews
```

## Project location

Resolve the G2M project root from `G2M_PROJECT_ROOT`; on this installation, fall back to `F:\gpt-mmx`. Run commands from that root. If neither location contains `package.json` and `src/cli/index.ts`, stop and report that G2M is not installed.

## Workflow

1. Convert the user's coding request into one bounded `g2m.code-task.v1` object. Keep commands, absolute paths, credentials, and raw arguments out of the task. Read [references/task-and-config.md](references/task-and-config.md) when creating or changing task/config JSON.
2. Confirm the workspace is a clean Git repository and is registered in a trusted local `g2m.local-config.v1` file. Verification commands must come from that local config.
3. Put task, review, and findings files outside the target repository, normally below `<G2M project>/.tmp/handoffs/<task-id>/`.
4. Start the long-running command and retain its terminal session:

   ```powershell
   npm run g2m -- run --config <config.json> --task <task.json> --review <review.json>
   ```

5. When it emits `g2m.review.pending`, read the complete `review-bundle.json`. Review the actual diff, protected-file warnings, independent verification, worker risks, and task acceptance criteria. Worker self-report alone is never sufficient. Read [references/review-policy.md](references/review-policy.md) for decision rules.
6. Generate the bound decision file while the run command is still waiting:

   ```powershell
   npm run g2m -- review --bundle <review-bundle.json> --decision ACCEPT --output <review.json> --findings-file <findings.txt>
   ```

   For REVISE, also pass `--new-task-id <new-id>`. For BLOCK, explain the blocking evidence.
7. Resume the original terminal session and verify it emits `g2m.completed`. Report the decision, changed files, verification result, and any retained worktree or recovery action.

## Non-negotiable boundaries

- Never pre-authorize ACCEPT before reading the generated bundle.
- Never commit, push, merge, reset, or clean the user's repository through G2M.
- Treat MiniMax permissions as defense in depth, not a sandbox. `smart`, `full`, and `off` can all write files in headless mode; G2M's worktree isolation and diff audit are the enforceable file boundary.
- A task without write capability must produce no diff. G2M rejects and removes any such mutation.
- On `RECOVERY_REQUIRED` or an unknown worker outcome, do not rerun automatically. Preserve the reported worktree and ask for an explicit recovery decision.
- If independent verification fails, do not ACCEPT.
- REVISE creates a new task ID; it is not a retry.
