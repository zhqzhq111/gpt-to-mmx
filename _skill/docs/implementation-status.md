# G2M v1 实施状态

**日期：** 2026-08-29  
**状态：** v1 Coding Orchestrator 实现完成。

## 已完成闭环

```text
Codex Task
  -> schema / policy / workspace validation
  -> temporary Git worktree
  -> mcode exec
  -> worker + diff + verification evidence
  -> hash-bound Review Bundle
  -> Codex ACCEPT / REVISE / BLOCK
  -> accepted patch applied as uncommitted source changes
```

同时完成：event hash chain、fingerprint freeze、anti-stale/anti-replay、UNKNOWN resolver、RECOVERY_REQUIRED、Windows process-tree cancellation、outer watchdog、read-only diff enforcement、CLI handoff 和 Codex Skill。

## 实测层级

- Fake/fixture unit + integration suite：默认运行，不消耗 MiniMax 额度。
- 真实 read-only adapter：通过。
- 真实 MiniMax 修改并修复 failing test：通过。
- `smart/full/off` 写入行为：三者均通过写入夹具，证明都不是只读 sandbox。
- CLI run/review handoff：通过。

## v1 明确不做

- 后台服务或 DAG；
- OpenCode Worker；
- MMX 多模态；
- ACP Client（复评后无必要）；
- Agent Team（无稳定 External Interface）；
- 自动 commit、push、merge；
- UNKNOWN 自动 retry/resume。

这些是范围决定，不是 v1 未完成项。需要时按 ADR 和 Adapter 边界进入后续版本。
