# GPT-to-MiniMax (G2M)

> Codex 负责高质量规划与最终复核，MiniMax Code 作为 Coding Worker 执行，G2M 负责隔离、权限边界、证据和恢复。

```text
Codex 想 -> G2M 守 -> MiniMax Code 写 -> G2M 验 -> Codex 判
```

## 状态

G2M v1.0.0 Coding Orchestrator 已完成：

- `g2m.code-task.v1` 严格任务协议与禁止字段；
- Workspace Registry、单工作区锁、Clean Worktree 检查；
- MiniMax Code 0.2.7 Resolver、stream-json Parser、Result Normalizer；
- Temporary Git Worktree 隔离与 binary-capable patch；
- Worker / Workspace / Verification 三类证据；
- 独立 Verification Profile（统一 ProcessSupervisor、无 shell）；
- Event Hash Chain、State Machine、task fingerprint；
- Review Bundle、六字段绑定、anti-stale / anti-replay；
- ACCEPT / REVISE / BLOCK；
- UNKNOWN Resolver 与 RECOVERY_REQUIRED；
- Unified ProcessSupervisor：Windows process-tree、POSIX process-group、超时/取消终止确认；
- `read_only` 任务的真实 diff 强制审计；
- 可交互 `g2m run` / `g2m review` 命令；
- 已安装的 `$gpt-to-mmx` Codex Skill。

完整状态见 [_skill/docs/implementation-status.md](/F:/gpt-mmx/_skill/docs/implementation-status.md)，架构基线见 [_skill/docs/GPT-to-MMX-v1-实施计划书.md](/F:/gpt-mmx/_skill/docs/GPT-to-MMX-v1-实施计划书.md)。

## 已验证

```text
npm run typecheck  -> pass
npm run build      -> pass
npm test           -> 329 passed / 5 skipped (334 total)
npm audit          -> 0 vulnerabilities
```

默认跳过的 5 条会消耗 MiniMax 额度，已在本机分别显式运行通过：

- 真实 mcode 只读 Adapter Smoke；
- 真实 mcode 修改并修复 failing test 的完整 Engine E2E；
- `smart` / `full` / `off` 三种 permission 写入行为。

CLI 的 run -> review pending -> bound BLOCK -> completed 交接也在默认测试中通过。

## 使用

要求 Node.js >= 22.19、Git，以及已登录可用的 `mcode`。

```powershell
npm install
npm run build
npm run g2m -- probe --config <g2m.config.json>
```

本地配置可从 [examples/g2m.config.example.json](/F:/gpt-mmx/examples/g2m.config.example.json) 开始。任务、review 和 findings 文件应放在目标仓库外，例如 `.tmp/handoffs/<task-id>/`。

可选的 `state_root` 用于保存跨进程恢复所需的事件、证据、指纹和 Review 防重放状态；未配置时默认使用 `<artifact_root>/state`。

本仓库的测试临时目录统一位于工程内的 `.tmp/test-runs/`，不会再使用
Windows 系统临时目录；该目录已加入 `.gitignore`。实际运行产生的
state、artifact 和 worktree 仍由配置中的 `state_root`、`artifact_root`
和 `worktree_root` 决定，建议将它们配置到工程内的 `.tmp/` 目录。

启动执行并等待 Codex 复核：

```powershell
npm run g2m -- run --config <config.json> --task <task.json> --review <review.json>
```

看到 `g2m.review.pending` 后，读取输出的 `review-bundle.json`，再生成绑定决定：

```powershell
npm run g2m -- review --bundle <review-bundle.json> --decision ACCEPT --output <review.json> --findings-file <findings.txt>
```

原 `run` 进程读取 review 文件后完成 ACCEPT / REVISE / BLOCK。ACCEPT 只把冻结补丁作为未提交改动应用到主工作区；不会 commit、push 或 merge。

如果 `run` 进程在执行中断，可使用以下命令读取持久化状态并进行恢复裁定。`--process-status` 必须由外部进程监管者如实提供：

```powershell
npm run g2m -- recover --config <config.json> --execution-id <execution-id> --process-status crashed
```

## Codex Skill

Skill 源码位于 [_skill/gpt-to-mmx/SKILL.md](/F:/gpt-mmx/_skill/gpt-to-mmx/SKILL.md)，个人安装位置通过目录链接指向该源码：

```text
C:\Users\zhq\.codex\skills\gpt-to-mmx
  -> F:\gpt-mmx\_skill\gpt-to-mmx
```

以后可直接说：

> 使用 `$gpt-to-mmx`，由你规划和复核，把编码执行交给 MiniMax Code。

## 安全边界

- `smart`、`full`、`off` 在本机 headless 实测中都能写文件；它们不是只读 sandbox。
- G2M 的可执行文件边界来自临时 worktree、capability diff audit、独立 verification 和 Codex review。
- `requested_capabilities.network=false` 目前是传给 Worker 的策略与提示约束，不是操作系统级网络沙箱。
- 验证失败不能 ACCEPT。
- UNKNOWN 不得自动重试；G2M 转入 RECOVERY_REQUIRED 并保留隔离现场。
- REVISE 会创建新 task ID 并保留隔离 worktree；当前 v1 不自动执行下一轮 revision。
- ACCEPT 使用 `review.accept.prepared`、`patch.applied`、`review.accept.completed` 三阶段事件；恢复时只会对账已冻结 patch，不会自动重试未知结果。

## 最近修复

- diff 指纹现在基于规范化的工作区文件内容，不会因新增文件从未跟踪变为已暂存而误报 worktree 变化。
- 独立验证完成后会重新采集最终 diff，验证过程中生成的文件会进入 review evidence 和冻结 patch。

## G2M v2 Phase 0

v2 的十项持久化、恢复、证据一致性、跨进程协调和存储契约已冻结于 [Phase 0 Spec Freeze](docs/v2/phase-0-spec-freeze.md)。未完成该规范对应的评审前，不进入 v2 Phase 1 实现。

v2 实施进度见 [Implementation Status](docs/v2/implementation-status.md)。

当前分支已完成并封存 Phase 7 Cross-process Workspace Lease：底层
filesystem lease、Engine 的 `REVIEW_PENDING` 保租约、启动协调、显式恢复
接管、Scanner 分类和真实双 Node 进程竞争 E2E 均已通过最终 Gate。

Phase 8 Unified Process Supervisor 已完成：MCode 和 Verification 共用统一
进程生命周期接口；Windows 使用 `taskkill /T` 后升级 `/F`，POSIX 使用
detached process group 的 `SIGTERM` → `SIGKILL`；timeout/cancel 只有在终止
得到确认后才会成为确定结果。Verification 的终止无法确认时，Engine 会进入
`RECOVERY_REQUIRED`，保留 Lease/worktree，并禁止收集 patch/final diff。

Phase 8 最终 Gate：`npm run typecheck`、`npm run build`、`git diff --check`
通过；`npm test` 为 `479 passed / 5 skipped / 0 failed`；Lease process E2E
为 `3/3`，Process Supervisor parent→grandchild E2E 为 `3/3`。

Phase 9 Storage Manager 已完成：策略配置保持旧配置兼容；Storage Manager
按卷执行逻辑容量预留，使用 `BEGIN IMMEDIATE` 防止并发 G2M 进程重复预留；
usage scanner 使用 symlink-safe traversal，manifest 原子更新且可重建；
storage reservation Journal/projection 支持启动恢复；Worker 和 Verification
均受运行时磁盘监控保护。详细契约见
[docs/v2/phase-9-storage-manager.md](/F:/gpt-mmx/docs/v2/phase-9-storage-manager.md)。

## 目录

```text
src/
├── cli/                       本地 config、run/review CLI
├── protocol/                  Task schema、validator、hash
├── policy/                    Permission / Verification Profile
├── workspace/                 Registry、Lock、Baseline、Temporary Worktree
├── process/                   统一外部进程与进程树监管
├── evidence/                  Diff、Verification、Evidence Store
├── events/                    Event types、Hash Chain Store、Replay、Reducer
├── execution/                 State Machine、Fingerprint、Execution Engine
├── review/                    Bundle、Ingress、Replay Guard
├── recovery/                  UNKNOWN / RECOVERY_REQUIRED Resolver
└── workers/mcode/             Resolver、Adapter、Parser、Normalizer

_skill/
├── docs/                      架构、Probe、实施状态与复评
└── gpt-to-mmx/                可安装 Codex Skill
```

## v1 范围结论

ACP 已复评为当前闭环不需要；Agent Team 暂无稳定 External Interface，因此 v1 不接入。详见 [_skill/docs/phase12-13-evaluation.md](/F:/gpt-mmx/_skill/docs/phase12-13-evaluation.md)。

```text
Plans cross the boundary as data.
Results cross the boundary as evidence.
Commands never cross the boundary.
```
