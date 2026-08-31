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
- Phase 10 proof-first GC：只读默认的 `g2m gc`、跨进程 GC lock、Crash-safe
  `gc.marked` / Tombstone / `gc.completed` 顺序、可重建历史投影；
- UNKNOWN Resolver 与 RECOVERY_REQUIRED；
- Unified ProcessSupervisor：Windows process-tree、POSIX process-group、超时/取消终止确认；
- `read_only` 任务的真实 diff 强制审计；
- 可交互 `g2m run` / `g2m review` 命令；
- 已安装的 `$gpt-to-mmx` Codex Skill。

完整状态见 [_skill/docs/implementation-status.md](_skill/docs/implementation-status.md)，架构基线见 [_skill/docs/GPT-to-MMX-v1-实施计划书.md](_skill/docs/GPT-to-MMX-v1-实施计划书.md)。

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

本地配置可从 [examples/g2m.config.example.json](examples/g2m.config.example.json) 开始。任务、review 和 findings 文件应放在目标仓库外，例如 `.tmp/handoffs/<task-id>/`。

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

历史执行清理默认只做只读候选审查；只有显式 `--apply` 才会删除，并且
不会提供绕过恢复、Lease 或路径校验的 `--force` 选项：

```powershell
npm run g2m -- gc --config <config.json>
npm run g2m -- gc --config <config.json> --apply
```

运维命令提供统一的状态、诊断和受限修复接口。`status` 与 `doctor` 都是
严格只读的，不会触发 Engine startup recovery、Projection backfill、Lease
reconciliation、Storage reconciliation 或 GC resume：

```powershell
npm run g2m -- status --config <config.json>
npm run g2m -- status --config <config.json> --format json
npm run g2m -- doctor --config <config.json> --format json
```

`repair` 默认只生成计划；只有显式 `--apply` 才会执行一个白名单动作：
`projection-rebuild`、`gc-resume` 或 `storage-reconcile`。不支持
`--all`、`--force` 或任何绕过 Journal、Recovery、Lease、SQLite 校验的选项。
apply 会在 Repair Lock 内重新生成并校验 plan；如果锁前后的持久状态发生
变化，会返回 `REPAIR_PLAN_STALE`，不会执行旧 plan。Repair Lock 带有
heartbeat、同主机 dead-PID stale reclaim 和 operation ownership 校验；live、
unknown 或 foreign owner 都会被拒绝。修复后应再次运行 `doctor`：

```powershell
npm run g2m -- repair --config <config.json> --action projection-rebuild
npm run g2m -- repair --config <config.json> --action projection-rebuild --apply --format json
```

## Codex Skill

Skill 源码位于 [_skill/gpt-to-mmx/SKILL.md](_skill/gpt-to-mmx/SKILL.md)，个人安装位置通过目录链接指向该源码：

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
[docs/v2/phase-9-storage-manager.md](docs/v2/phase-9-storage-manager.md)。

Phase 10 Garbage Collection 已完成：GC 候选必须通过 Journal、Manifest、
Lease、Reservation、Recovery 与文件系统的交叉证明；`gc.marked` 在所有
破坏性操作前持久化，Tombstone 自校验且永久保留，`gc.completed` 后才关闭
Journal writer 并删除 execution state。中断操作可在下次启动或显式 `g2m gc
--apply` 时幂等续做；`RECOVERY_REQUIRED`、未知孤儿目录和不确定的
worktree 绑定永不自动删除。详细契约见
[docs/v2/phase-10-garbage-collection.md](docs/v2/phase-10-garbage-collection.md)。

Phase 11 Operational CLI 与 Phase 12 Runtime Hardening 已在当前集成分支
完成。Phase 12 固化 Runtime Identity、Protected Policy、Fingerprint v2、
模型 pin、Worker/Verification 输出与协议边界、运行时 drift、Repair reclaim
guard，以及只读 Status/Doctor 和 legacy ACCEPT recovery 证据边界。最终
Phase 12 gate 的单元测试为 `637 passed / 6 skipped / 0 failed`；五组真实
process E2E 分别为 `3/3`、`3/3`、`3/3`、`1/1`、`6/6`。Phase 13 CI /
Regression 已完成本地实现：F/G/H/I 的 CI、Runtime、Recovery、Lease/
Storage/GC/Operations 回归已集成，workflow 覆盖 Ubuntu/Windows 与 Node.js
22.x。当前本机最终验证为 `659 passed / 6 skipped / 0 failed`，process E2E
为 `4/4`、`3/3`、`3/3`、`1/1`、`6/6`；云端 GitHub Actions 尚未触发，因而
当前是 `G2M v2 FINAL RELEASE CANDIDATE`，待双平台 CI 和最终 Reviewer 批准。

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
├── operations/                status / doctor / allowlisted repair
└── workers/mcode/             Resolver、Adapter、Parser、Normalizer

_skill/
├── docs/                      架构、Probe、实施状态与复评
└── gpt-to-mmx/                可安装 Codex Skill
```

## v1 范围结论

ACP 已复评为当前闭环不需要；Agent Team 暂无稳定 External Interface，因此 v1 不接入。详见 [_skill/docs/phase12-13-evaluation.md](_skill/docs/phase12-13-evaluation.md)。

```text
Plans cross the boundary as data.
Results cross the boundary as evidence.
Commands never cross the boundary.
```
