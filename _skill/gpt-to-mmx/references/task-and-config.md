# Task and local config

## Task handoff

Use `g2m.code-task.v1`. The task describes intent, never a command:

```json
{
  "protocol_version": "g2m.code-task.v1",
  "task_id": "unique-task-id",
  "workspace_scope": {
    "workspace_id": "registered-project",
    "base_revision": "HEAD",
    "require_clean_worktree": true
  },
  "goal": "Describe the required code outcome.",
  "constraints": ["Keep changes minimal.", "Do not commit or push."],
  "requested_capabilities": {
    "read": true,
    "write": true,
    "test": true,
    "network": false
  },
  "permission_policy": "coding_standard",
  "limits": { "max_steps": 30, "timeout_ms": 600000 },
  "verification_profile": "targeted_tests",
  "acceptance_criteria": [
    "The targeted test passes.",
    "No unrelated files change."
  ],
  "session_policy": { "mode": "new" }
}
```

Allowed semantic permission policies are `read_only`, `coding_standard`, and `coding_extended`. Use the least capability compatible with the goal.

Never include `command`, `shell`, `raw_argv`, `powershell`, `cmd`, credentials, API keys, the mcode executable, or an absolute workspace path in a task.

## Trusted local config

Use `g2m.local-config.v1`. This file may contain trusted absolute paths and verification programs because it stays on the local side of the boundary. Start from `examples/g2m.config.example.json` in the G2M project.

- `workspaces`: maps an opaque `workspace_id` to a canonical local path.
- `verification_profiles`: maps a profile ID to a program and argument array. No shell is used.
- `worktree_root`: must be outside registered repositories.
- `artifact_root`: receives patches, evidence, bundles, and outcomes; keep it outside Worker workspaces.
- `mcode_path`: optional trusted launcher override.
- `review_timeout_ms`: how long `g2m run` waits for Codex's decision file.

Use `verification_profile: "none"` only when skipping independent verification is intentional and reviewable.
