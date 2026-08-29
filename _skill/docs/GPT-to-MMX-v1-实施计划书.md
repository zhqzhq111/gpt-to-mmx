# GPT-to-MiniMax（G2M）项目完整实施计划书

## —— Codex Planner/Reviewer + MiniMax Code Coding Sub-Agent

**版本：** v1 Architecture & MVP Implementation Baseline
**状态：** v1 实施完成；阶段 01–36 已执行或按 ADR 完成复评（详见 `implementation-status.md`）
**MVP Worker：** MiniMax Code `mcode exec`
**后续 Worker 接口：** `CodingWorkerAdapter` 可插拔
**核心原则：**

> Codex 负责想，MiniMax Code 负责写，G2M 负责守住中间的边界。

---

# 一、项目真实目标

GPT-to-MiniMax，简称：

```text
G2M
```

不是一个新的 Coding Agent（编码智能体）。

G2M 的目标是：

> 让 Codex 的高智力模型作为 Planner（规划者）和 Reviewer（审核者），把具体编码任务委派给 MiniMax Code；MiniMax Code 作为真正的 Coding Sub-Agent（编码子智能体），直接读取仓库、修改代码、运行测试并返回执行结果。

最终工作流：

```text
用户
 ↓
Codex 高智力模型
Planner
 ↓
结构化 Coding Task
 ↓
G2M
 ↓
MiniMax Code
mcode exec
 ↓
读取项目
修改代码
运行测试
处理失败
 ↓
Worker Result
+
真实 Git Diff
+
独立 Verification
 ↓
G2M Review Bundle
 ↓
Codex 高智力模型
Reviewer
 ↓
ACCEPT
/
REVISE
/
BLOCK
```

---

# 二、MiniMax 官方能力确认

## 2.1 `mcode exec`

MiniMax 官方当前明确：

```text
mcode exec
```

用于：

* Automation（自动化）
* Batch Processing（批处理）
* Reproducible Evaluation（可重复评测）
* CI（持续集成）

并且提供：

```text
--cwd <path>
--file <path>
--model <provider/model>

--session <id>
--continue

--permission <policy>
当前 `mcode exec` 版本的可用值：`smart` / `full` / `off`；`ask` 仅适用于 TUI / ACP。

--timeout <duration>
--max-steps <count>

--output-format text
--output-format json
--output-format stream-json

--output-schema <json>

--input -
--input-format text | json
```

机器可读结果进入：

```text
stdout
```

诊断信息进入：

```text
stderr
```

这是官方明确公开的 CLI Contract（命令行契约）。

因此：

> **`mcode exec` 已经足以成为 G2M MVP 的 Coding Worker。**

G2M 不需要自己实现 MiniMax 的 Agent Loop（智能体循环）。

---

# 三、MiniMax Code 本身已经是完整 Coding Agent

官方说明 MiniMax Code 会：

```text
读取项目规则
↓
理解目录结构
↓
定位相关实现
↓
寻找测试入口
↓
使用文件、搜索、终端工具
↓
修改代码
↓
运行测试/检查
↓
处理失败
↓
总结修改、证据和剩余风险
```

因此 G2M 不重新实现：

```text
read_file
search_files
apply_patch
run_test
terminal
```

这些属于：

```text
MiniMax Code Coding Harness
```

而不是 G2M。

---

# 四、`mcode acp` 官方边界

MiniMax 官方当前明确：

```text
mcode acp
```

会将 MiniMax Code 运行成：

> ACP v1 Agent Server

通信方式：

```text
stdin / stdout
NDJSON
```

并且 ACP 可以投射：

```text
Assistant response

Thinking

Tool status

File locations

Diff

Permission prompts

Question selection

Cancellation
```

到客户端。

因此：

> `mcode acp` 是正式外部接口，不是内部隐藏能力。

但是：

## MVP 不使用 ACP。

原因不是 ACP 不好，而是：

```text
mcode exec
```

已经足够验证核心架构。

ACP 留到第二阶段。

---

# 五、Agent Team 公开能力边界

MiniMax 官方当前公开的 Agent Team 能够：

```text
任务拆解

专业 Agent 协作

执行

进度跟踪

Verification

最终综合

并行探索
```

官方描述是：

> 用户给出一个 Goal，MiniMax Code 协调 decomposition、execution、progress tracking 和 final synthesis。

但是目前公开文档没有提供类似：

```text
mcode team exec

spawn_team()

Agent Team REST API

Agent Team SDK
```

这样的外部控制接口。

因此 G2M v1：

```text
不依赖 Agent Team
```

以后如果 MiniMax 发布正式外部接口：

```text
Phase 3
```

再研究。

---

# 六、MiniMax Code GitHub 仓库边界

当前：

```text
MiniMax-AI/minimax-code
```

公开仓库 README 明确说明：

> 这个仓库用于收集 MiniMax Code Desktop 的 Issue。

当前主要只有：

```text
.github
README
README.zh-CN
```

等内容，并不是完整 MiniMax Code / Agent Team 源码。

因此项目必须严格区分：

```text
官方 CLI 文档
=
可以依赖

官方 Agent Team 文档
=
可以参考能力设计

官方 GitHub Issue
=
行为线索

未公开内部实现
=
不得假设
```

即使未来 MiniMax Code CLI 开源，也不应该让 G2M 的公共协议依赖内部类名或私有实现。

---

# 七、最终总体架构

```text
┌──────────────────────────────┐
│             User             │
└──────────────┬───────────────┘
               ↓
┌──────────────────────────────┐
│      Codex High Model        │
│                              │
│ Planner                      │
│ Reviewer                     │
└──────────────┬───────────────┘
               │
        g2m.code-task.v1
               ↓
┌────────────────────────────────────────┐
│               G2M Core                 │
│                                        │
│ Protocol Validator                     │
│ Semantic Validator                     │
│ Workspace Registry                     │
│ Workspace Lock                         │
│ Policy Engine                          │
│ Lifecycle Engine                       │
│ Event Store                            │
│ Recovery Resolver                      │
│ Evidence Collector                     │
│ Verification Runner                    │
│ Review Manager                         │
└───────────────────┬────────────────────┘
                    │
           CodingWorkerAdapter
                    │
                    ▼
┌────────────────────────────────────────┐
│             MCodeAdapter               │
│                                        │
│ Runtime Probe                          │
│ CLI Resolver                           │
│ Exec Argument Builder                  │
│ stdout Event Parser                    │
│ stderr Collector                       │
│ Session Metadata                       │
└───────────────────┬────────────────────┘
                    │
                    ▼
               mcode exec
                    │
                    ▼
┌────────────────────────────────────────┐
│           MiniMax Code Agent           │
│                                        │
│ Repository Exploration                 │
│ File Editing                           │
│ Search                                 │
│ Terminal                               │
│ Testing                                │
│ Context / Session                      │
└───────────────────┬────────────────────┘
                    │
                    ▼
               MiniMax Model
                    │
                    ▼
              Local Workspace
```

---

# 八、为什么仍然保留 Worker Adapter

虽然 MVP 只实现：

```text
MCodeAdapter
```

但 G2M Core 不应：

```text
直接在各个模块里调用 mcode
```

正确关系：

```text
G2M Core
   ↓
CodingWorkerAdapter
   ↓
MCodeAdapter
   ↓
mcode exec
```

接口保持很小即可。

概念上：

```text
probe()

start()

cancel()

collectResult()

resume()    // optional
```

以后如果需要：

```text
OpenCodeAdapter
```

只是新增实现。

不需要修改：

```text
Task Protocol
Workspace
Policy
Evidence
Review
Recovery
```

原则：

> **架构可插拔，但 MVP 不贪多。**

---

# 九、OpenCode 在 MVP 中的角色

正式规定：

```text
OpenCode = 不参与 MVP
```

不：

```text
调用 OpenCode

维护 OpenCode Adapter

写 OpenCode Event Parser

维护两套权限映射
```

以后只有在：

```text
mcode 出现实际限制
```

或者：

```text
希望做 Worker A/B Benchmark
```

时再增加 OpenCode。

---

# 十、核心任务协议

重新定义：

```text
g2m.code-task.v1
```

目标是描述：

> 一个 Coding Agent 应该完成什么。

而不是告诉 Agent：

> 应该执行什么 Shell。

建议结构：

```json
{
  "protocol_version": "g2m.code-task.v1",

  "task_id": "task-001",

  "workspace_scope": {
    "workspace_id": "robot-arm-project",
    "base_revision": "HEAD",
    "require_clean_worktree": true
  },

  "goal": "Fix the failing trajectory planning test without changing the public API.",

  "constraints": [
    "Keep the patch minimal.",
    "Do not change public APIs.",
    "Do not modify unrelated files.",
    "Do not commit or push."
  ],

  "requested_capabilities": {
    "read": true,
    "write": true,
    "test": true,
    "network": false
  },

  "permission_policy": "coding_standard",

  "limits": {
    "max_steps": 20,
    "timeout_ms": 600000
  },

  "verification_profile": "targeted_tests",

  "acceptance_criteria": [
    "The target test passes.",
    "No related regression is introduced.",
    "Public interfaces remain unchanged."
  ],

  "session_policy": {
    "mode": "new"
  }
}
```

---

# 十一、Task 中明确禁止出现的字段

禁止：

```text
command

shell

raw_argv

powershell

cmd

api_key

token

credential

mcode_executable

absolute_workspace_path
```

Codex Planner 只能描述：

```text
Goal

Constraints

Capabilities

Acceptance Criteria
```

不能决定本地执行细节。

---

# 十二、Planner 与 G2M 权限关系

正式原则：

```text
Planner requests.

G2M authorizes.
```

例如 Codex：

```text
network = true
```

本地 Policy：

```text
network = false
```

最终：

```text
false
```

Codex 可以要求更少权限。

Codex 不能强制扩大权限。

---

# 十三、Workspace Registry

Codex 不直接知道：

```text
C:\Users\...
D:\project\...
```

而使用：

```text
workspace_id
```

例如：

```text
robot-arm-project
```

G2M Local Config：

```text
robot-arm-project
→
D:\robotics\arm_ws
```

所以：

```text
Codex
↓
workspace_id
↓
G2M
↓
canonical trusted path
↓
mcode --cwd
```

---

# 十四、`--cwd` 不是完整安全边界

虽然官方 `mcode exec` 提供：

```text
--cwd
```

但：

```text
cwd
```

不能天然防止 Agent：

```text
访问父目录

使用绝对路径

通过符号链接逃逸

Terminal 访问外部目录
```

因此安全不能只依赖 `--cwd`。

真正安全模型是多层的：

```text
Workspace Registry
+
Workspace Lock
+
MCode Permission
+
Git Isolation
+
Timeout
+
Max Steps
+
Diff Audit
+
Sensitive Path Policy
+
Independent Verification
```

---

# 十五、Workspace Lock

MVP 必须实现：

> 一个 `workspace_id` 同时只能存在一个 Active Coding Execution。

例如：

```text
Workspace A

Worker 1
RUNNING

Worker 2
→ WORKSPACE_BUSY
```

原因：

如果两个 Agent 同时工作：

```text
Git Diff 混合
文件覆盖
测试结果混合
恢复状态混乱
```

Workspace Lock 属于：

```text
G2M Core
```

而不是 MCodeAdapter。

---

# 十六、MVP Clean Worktree

第一版要求：

```text
require_clean_worktree = true
```

执行前：

```text
git status
```

必须确认没有现有用户修改。

否则：

```text
BLOCKED
```

原因：

```text
Worker Diff
```

必须能明确归因给 MiniMax。

---

# 十七、正式版 Temporary Git Worktree

MVP 后第一项重要增强应该是：

```text
Temporary Git Worktree
```

结构：

```text
Main Repository
       │
       ├── User Workspace
       │
       └── G2M Temporary Worktree
                    ↓
                mcode exec
                    ↓
               MiniMax edits
                    ↓
               Verification
                    ↓
                Codex Review
                    ↓
              ACCEPT / REVISE
```

只有 ACCEPT 后：

```text
Patch
```

才应用回主工作区。

这将明显增强：

```text
隔离

回滚

恢复

Diff 准确度

Revision
```

但不阻塞 MVP。

---

# 十八、Permission Policy

MiniMax 官方当前 `mcode exec` 支持：

```text
--permission
```

当前版本的 `mcode exec --help` 列出：

```text
smart
full
off
```

但 G2M Protocol 不直接暴露这些字符串。

协议使用：

```text
read_only

coding_standard

coding_extended
```

由：

```text
MCodeAdapter
```

根据本机实际版本映射。

---

# 十九、为什么权限语义必须实测

本机 `mcode 0.2.7` 的 exec help 公开了：

```text
smart / full / off
```

`ask` 只适用于：

```text
TUI / ACP
```

因此 G2M 不应该自行推测：

```text
smart
到底等于什么
```

Phase 0 必须实际测试。

在没有测试清楚前：

> Permission Mapping 属于 `UNVERIFIED`。

---

# 二十、Runtime Probe 是 Phase 0

Phase 0 已经在本机完成核心 Contract 实测。完整结果记录于
`_skill/docs/phase0-runtime-probe.md`；后续仍需单独验证权限语义、timeout、
output-schema、ACP 和跨任务 Session 续接。

正式开发 Adapter 之前必须先做：

```text
Runtime Probe
```

这是整个项目第一步。

Probe 内容：

```text
mcode 是否存在

mcode path

mcode version

mcode --help

mcode exec --help

mcode acp --help
```

以及：

```text
JSON 是否正常

stream-json 事件是什么

Session ID 在哪里

权限策略行为

timeout 行为

max-steps 行为

Cancel 行为
```

---

# 二十一、Runtime Capability Snapshot

探测后保存类似：

```json
{
  "runtime": "mcode",

  "available": true,

  "version": "0.2.7",

  "documented_capabilities": {
    "headless_exec": true,
    "json_output": true,
    "stream_json": true,
    "output_schema": true,
    "sessions": true,
    "timeout": true,
    "max_steps": true,
    "acp": true
  },

  "locally_verified": {
    "json_contract": true,
    "stream_json_contract": true,
    "session_id_extraction": true,
    "permission_mapping": false,
    "timeout_behavior": false
  }
}
```

必须区分：

```text
Documented
```

和：

```text
Locally Verified
```

---

# 二十二、Session ID 不允许靠猜

官方明确支持：

```text
--session <id>
--continue
```

但是当前公开文档没有保证：

```text
mcode exec --output-format json
```

中的 Session ID 固定字段叫什么。

所以：

```text
session_id
```

在 G2M v1 Result 中：

```text
Optional
```

只有 Runtime Probe 证明当前版本能稳定提取后才使用。

---

# 二十三、MVP 不允许依赖 `--continue`

`--continue` 的含义是：

```text
继续最近 Session
```

如果同一工作区有人使用过其他 MiniMax Session：

```text
可能继续错任务
```

因此：

```text
--continue
```

不作为可靠自动 Revision 机制。

只有：

```text
已明确获得 Session ID
```

时才允许：

```text
--session <id>
```

自动继续。

---

# 二十四、Worker Prompt Builder

Codex 输出的是：

```text
结构化任务
```

G2M 再生成 Worker Prompt。

例如：

```text
GOAL
Fix the failing trajectory-planning test.

SCOPE
Work only inside the provided workspace.

CONSTRAINTS
- Keep the patch minimal.
- Do not change public interfaces.
- Do not modify unrelated files.
- Do not commit or push.

VALIDATION
Run the relevant tests allowed by the environment.

DELIVERABLE
Return:
1. summary
2. files changed
3. tests attempted
4. test results
5. remaining risks
```

重要：

> Codex Task 不是 MiniMax System Prompt。

G2M 自己负责规范化 Worker Instructions。

---

# 二十五、`--output-schema`

这是 mcode 方案非常有价值的一项官方能力。

MiniMax 当前明确支持：

```text
mcode exec --output-schema <json>
```

用于验证最终 JSON 结果。

所以 Worker 最终 Summary 可以要求：

```json
{
  "summary": "...",

  "files_changed": [
    "..."
  ],

  "tests_attempted": [
    {
      "name": "...",
      "status": "passed"
    }
  ],

  "remaining_risks": [],

  "blocked_reason": null
}
```

但是：

> Worker Summary 只是 Worker Self-report（执行者自述）。

不能当作最终证据。

---

# 二十六、Evidence Model

G2M 将证据分成三类：

```text
Worker Evidence

Workspace Evidence

Verification Evidence
```

---

## Worker Evidence

来自 MiniMax：

```text
Final Summary

Reported Files

Reported Tests

stream-json Events

Session ID
```

---

## Workspace Evidence

G2M 自己采集：

```text
Base Revision

git status

Changed Files

Full Git Diff

Diff Stat

Untracked Files

Deleted Files

Diff Hash
```

---

## Verification Evidence

G2M 自己运行：

```text
Verification Profile

Exit Code

Duration

stdout/stderr logs

Pass / Fail
```

Reviewer 默认主要相信后两者。

---

# 二十七、Git Baseline

运行 Worker 前：

```text
git rev-parse HEAD

git status
```

记录：

```text
base_revision

baseline_status
```

运行后：

```text
git status

git diff

git diff --stat
```

收集真实修改。

---

# 二十八、测试证据不能只相信 MiniMax

即使 MiniMax 最后说：

```text
“All tests passed.”
```

也只属于：

```text
reported_tests
```

G2M 应在 Worker 完成后：

```text
独立运行 Verification
```

形成真正 Reviewer Evidence。

---

# 二十九、Verification Profile

Codex Task 中只能写：

```text
verification_profile = targeted_tests
```

不能写：

```text
verification_command = "pytest ... && ..."
```

真正命令来自：

```text
Local Workspace Config
```

例如：

```text
targeted_tests
→
python -m pytest tests/trajectory
```

内部仍应表示：

```text
program
+
argv[]
```

而不是 Shell String。

---

# 三十、Verification 配置也属于可信边界

需要检查 Worker 是否修改了：

```text
tests/**

package.json

pyproject.toml

CMakeLists.txt

pytest.ini

GitHub Actions

build scripts
```

否则：

```text
Worker 修改测试
↓
验证通过
```

可能产生假阳性。

Review Bundle 必须显示：

```text
Production Files Changed

Test Files Changed

Build/Config Files Changed
```

---

# 三十一、Protected Paths

Workspace Policy 可以定义：

```text
protected_paths
```

例如：

```text
tests/**

package.json

CMakeLists.txt

.github/workflows/**
```

任务可以请求修改这些文件。

但是最终：

```text
Local Policy
```

决定：

```text
allow

deny

manual confirmation
```

---

# 三十二、Process Invocation

G2M 不构造：

```text
"mcode exec " + prompt
```

必须使用：

```text
program
+
argv[]
```

概念上：

```text
  mcode
  exec

--cwd
<trusted path>

--permission
<effective policy>

--timeout
<effective timeout>

--max-steps
<effective steps>

--output-format
stream-json

--input
-

--input-format
text

<prompt written to stdin and then closed>
```

Prompt 永远是：

```text
data
```

并通过 `--input -` 的 stdin 传输，不放入 Windows shell-sensitive argv。

不是：

```text
shell
```

---

# 三十三、Windows Resolver

Windows 不允许假设：

```text
mcode.exe
```

Resolver 必须支持实际安装情况：

```text
mcode.exe

mcode.cmd

mcode.ps1

或者安装器生成的其他可信启动器
```

MiniMax 官方 Windows 安装流程当前使用 PowerShell Installer，并要求安装完成后通过：

```text
mcode --version
mcode --help
```

确认 PATH。

---

# 三十四、Windows Resolver 顺序

```text
1. Local trusted override

2. PATH 原始顺序

3. 找到 mcode candidate

4. mcode --version

5. mcode --help

6. mcode exec --help

7. Cache Launch Descriptor
```

禁止：

```text
硬编码 AppData

硬编码用户目录

猜安装路径
```

---

# 三十五、`.cmd` / `.ps1`

逻辑原则：

```text
shell = false
```

优先让成熟 Process Runner 正确调用 Launcher。

如果最终需要 `.ps1`：

```text
powershell.exe

-NoLogo
-NoProfile
-NonInteractive
-File
<mcode.ps1>
```

禁止：

```text
PowerShell -Command <模型内容>
```

并且不自动：

```text
ExecutionPolicy Bypass
```

---

# 三十六、中文路径和空格路径

必须测试：

```text
D:\机械臂项目\ROS 2 Workspace\
```

整个路径作为：

```text
一个 argv item
```

不能字符串拼接。

Windows CI 必测：

```text
中文 workspace

带空格 workspace

中文 Prompt

UTF-8

CRLF
```

---

# 三十七、stdout 与 stderr

依据官方契约：

```text
stdout
=
machine-readable output

stderr
=
diagnostic
```

因此：

```text
stdout JSON parser
```

和：

```text
stderr diagnostics collector
```

必须完全分离。

不能：

```text
stdout + stderr 拼一起再 JSON.parse
```

---

# 三十八、`stream-json` 作为 MVP 默认

开发阶段优先：

```text
--output-format stream-json
```

原因：

希望实测：

```text
事件类型

工具进度

Session

最终消息

失败行为
```

等真实契约。

如果稳定版本最终只需要 Final Result：

```text
json
```

也可以支持。

但内部最好保留：

```text
Raw Worker Event Log
```

用于调试和 Recovery。

---

# 三十九、Timeout 双层设计

官方：

```text
--timeout
```

已经存在。

但 G2M 仍要有：

```text
Outer Watchdog
```

例如：

```text
mcode timeout
=
10 min

G2M watchdog
=
11 min
```

防止 CLI 自身异常挂起。

---

# 四十、Max Steps

Codex 可以提出：

```text
max_steps = 30
```

但本地：

```text
max_steps_limit = 20
```

则：

```text
effective_max_steps = 20
```

最终映射：

```text
--max-steps 20
```

---

# 四十一、生命周期

正式建议：

```text
PLANNED
 ↓
VALIDATING
 ↓
READY
 ↓
WAITING_WORKSPACE_LOCK
 ↓
SPAWNING_AGENT
 ↓
RUNNING
 ↓
COLLECTING_EVIDENCE
 ↓
VERIFYING
 ↓
EXECUTION_SUCCEEDED
 ↓
REVIEW_PENDING
 ├────────→ ACCEPTED
 ├────────→ REVISION_REQUESTED
 └────────→ BLOCKED
```

异常：

```text
SPAWNING_AGENT
RUNNING
COLLECTING_EVIDENCE
VERIFYING

↓
FAILED
TIMED_OUT
CANCELLED
RECOVERY_REQUIRED
```

---

# 四十二、MVP 不把 Tool Call 变成 Task State

即使 `stream-json` 可以看到内部动作：

```text
Read
Search
Edit
Terminal
```

G2M MVP 也不要创建：

```text
TOOL_CALLING
```

这种频繁 State Transition。

这些属于：

```text
Worker Event
```

不是 Task State。

---

# 四十三、Execution Success

必须满足：

```text
mcode Process 正常结束

最终结果可解析

Workspace Evidence 可采集

没有无法解释的越界修改

Verification 已执行或按 Policy 明确跳过

结果完整落盘
```

才：

```text
EXECUTION_SUCCEEDED
```

但是：

```text
EXECUTION_SUCCEEDED
≠
ACCEPTED
```

---

# 四十四、Review Success

只有 Codex Reviewer 检查：

```text
Task Goal

Constraints

Diff

Verification

Worker Summary

Remaining Risks
```

后确认：

```text
Acceptance Criteria
```

满足，才：

```text
ACCEPTED
```

---

# 四十五、Review Bundle

定义：

```text
g2m.code-review-bundle.v1
```

包含：

```text
Original Task

Worker Runtime
Worker Version
Model

Session ID
if available

Worker Summary

Base Revision

Changed Files

Full Diff

Diff Hash

Test Files Changed

Build Config Changed

Independent Verification

Warnings

Remaining Risks
```

默认不塞入：

```text
全部 Thinking

全部 Terminal Logs

全部 Tool Events
```

这些只保存 Reference。

---

# 四十六、Review Protocol

Codex 返回：

```text
g2m.review.v1
```

Decision：

```text
ACCEPT

REVISE

BLOCK
```

并继续保留以前设计的：

```text
anti-stale

anti-replay
```

Review 必须绑定：

```text
task_id

execution_id

review_bundle_id

task_hash

result_hash

review_bundle_hash
```

并且新 Review 只允许在：

```text
REVIEW_PENDING
```

状态应用。

---

# 四十七、Revision

Reviewer：

```text
REVISE
```

后创建：

```text
新的 task_id
```

并：

```text
revision_of = previous_task
```

不是：

```text
自动 Retry
```

---

# 四十八、Session Revision

如果 Phase 0 证明 Session ID 可以可靠获得：

```text
mcode exec
--session <id>
```

继续。

Reviewer Findings 转成新的 Worker Prompt：

```text
Review findings:

1. ...
2. ...

Revise the current implementation.

Do not redo already-correct work.

Run verification again.
```

---

# 四十九、没有可靠 Session 时

不要使用：

```text
--continue
```

自动恢复。

改成：

```text
新 mcode exec
+
当前 Workspace
+
Previous Task Summary
+
Current Diff
+
Reviewer Findings
```

MiniMax 重新读取真实仓库状态。

---

# 五十、Retry

Retry 只适用于：

```text
明确未进入 Agent Execution 的启动失败

明确没有产生 Workspace 修改的瞬时失败
```

如果：

```text
Agent 已开始运行
```

则执行失败后必须先检查：

```text
Diff
Process
Result
Session
```

不能无脑重跑。

---

# 五十一、UNKNOWN 与 RECOVERY_REQUIRED

继续采用以前冻结的严格定义。

## UNKNOWN

不是持久化 State。

而是：

```text
Recovery Resolver Verdict
```

表示：

> 当前证据不足以判断真实执行结果。

例如：

```text
G2M Crash
↓
mcode process 不存在
↓
Workspace 有修改
↓
没有 Final Result
↓
无法判断 Agent 完成还是半途中断
```

Resolver：

```text
UNKNOWN
```

---

## RECOVERY_REQUIRED

正式持久化 State。

```text
UNKNOWN
↓
无法安全 reconcile
↓
RECOVERY_REQUIRED
```

此状态：

```text
禁止自动重跑

禁止自动继续下一个 Task

需要人工或明确恢复流程
```

---

# 五十二、Event Log

继续使用：

```text
events.jsonl
```

Append-only（仅追加）。

禁止 Replay 排序。

物理文件顺序就是事件顺序。

`seq` 只用于：

```text
验证
```

不是：

```text
排序
```

这部分沿用之前已经冻结的 Event / Hash Chain 规则。

---

# 五十三、task_fingerprint

Coding Task 的本地 Fingerprint 应包含：

```text
task_hash

workspace_id

base_revision

mcode version

model

permission profile

max_steps

timeout

adapter contract version

runtime capability snapshot hash
```

首次 Agent Execution 开始后冻结。

如果 Recovery 时发现：

```text
fingerprint changed
```

则：

```text
RECOVERY_REQUIRED
```

---

# 五十四、取消任务

流程：

```text
User/Codex Cancel
↓
G2M request graceful process interruption
↓
wait
↓
necessary → kill process tree
↓
collect workspace evidence
```

然后：

如果状态明确：

```text
CANCELLED
```

如果文件可能处于不确定写入状态：

```text
RECOVERY_REQUIRED
```

---

# 五十五、Windows 子进程树

必须考虑：

```text
mcode
↓
node/runtime
↓
shell/test processes
↓
child processes
```

只杀掉父进程可能留下：

```text
pytest

npm

compiler

其他 child process
```

所以 Process Supervisor 必须支持：

```text
graceful interrupt
↓
timeout
↓
terminate process tree
```

这属于 Windows MVP 可靠性重点。

---

# 五十六、API Key

Task Protocol 永远不能出现：

```text
api_key

token

credential
```

MiniMax 官方支持：

```text
mcode login
```

以及 Provider Configuration。

认证全部属于：

```text
Local MiniMax Configuration
```

G2M 不保存模型 Secret。

---

# 五十七、敏感路径

即使 Worker 运行在项目目录，也需要对 Evidence 检查：

```text
.env

*.pem

*.key

SSH credentials

cloud credentials

token files
```

如果 Worker 修改/新增敏感路径：

```text
BLOCKED
```

或：

```text
RECOVERY_REQUIRED / manual review
```

取决于情况。

---

# 五十八、旧版 G2M 设计修改清单

## 保留

```text
Structured Task Protocol

Plan Ingress

Review Egress

JSON Schema

Workspace Scope

Local Policy > Planner

Artifact/Evidence Store

Event Log

Recovery

UNKNOWN / RECOVERY_REQUIRED

Retry / Revision separation

task_hash

task_fingerprint

Review anti-stale

Review anti-replay

No API Key

No Raw Shell
```

---

## 删除

```text
text.generate

image.generate

search.query

MMX CLI 作为 Coding Worker

G2M MiniMax API Agent Loop

G2M read_file Tool Gateway

G2M apply_patch Tool Gateway

MMX Error Code 作为 Coding Runtime 错误模型
```

---

## 重命名

```text
MMX Adapter
→
MCode Adapter

MMX Result
→
Code Result

Artifact Store
→
Evidence Store

MMX Capability
→
Coding Worker Capability
```

---

## 新增

```text
CodingWorkerAdapter

MCodeAdapter

Runtime Probe

Workspace Lock

Git Baseline

Diff Collector

Verification Profiles

Protected Paths

Worker Summary Schema

Session Metadata

Windows Process Supervisor
```

---

## 延期

```text
mcode acp

Agent Team

OpenCodeAdapter

mmx multimodal

Temporary Worktree

Multi Worker

Parallel Execution

DAG
```

其中：

```text
Temporary Worktree
```

优先级高于其他延期功能。

---

# 五十九、`mmx` CLI 的新角色

MVP：

```text
完全不使用 mmx
```

以后：

```text
G2M
├─ Coding Worker
│   └─ mcode
│
└─ Multimodal Capability
    └─ mmx
```

例如：

```text
image
video
speech
```

才由 `mmx` 提供。

因此项目名字建议：

```text
GPT-to-MiniMax
```

而不是把：

```text
MMX
```

理解成某个具体 CLI。

---

# 六十、目录结构

```text
gpt-to-minimax/
│
├─ README.md
├─ package.json
├─ tsconfig.json
│
├─ docs/
│  ├─ architecture.md
│  ├─ protocol.md
│  ├─ lifecycle.md
│  ├─ security.md
│  ├─ recovery.md
│  ├─ windows.md
│  ├─ mcode.md
│  └─ adr.md
│
├─ schemas/
│  ├─ code-task.v1.schema.json
│  ├─ code-result.v1.schema.json
│  ├─ code-review-bundle.v1.schema.json
│  ├─ review.v1.schema.json
│  └─ event.v1.schema.json
│
├─ src/
│  ├─ cli/
│  │
│  ├─ protocol/
│  │  ├─ schema-validator.ts
│  │  ├─ semantic-validator.ts
│  │  ├─ canonicalize.ts
│  │  └─ hash.ts
│  │
│  ├─ workers/
│  │  ├─ coding-worker.ts
│  │  └─ mcode/
│  │     ├─ adapter.ts
│  │     ├─ resolver.ts
│  │     ├─ probe.ts
│  │     ├─ args.ts
│  │     ├─ event-parser.ts
│  │     ├─ result-parser.ts
│  │     └─ session.ts
│  │
│  ├─ workspace/
│  │  ├─ registry.ts
│  │  ├─ resolver.ts
│  │  ├─ lock.ts
│  │  ├─ baseline.ts
│  │  └─ audit.ts
│  │
│  ├─ policy/
│  │  ├─ permissions.ts
│  │  ├─ limits.ts
│  │  ├─ protected-paths.ts
│  │  └─ verification.ts
│  │
│  ├─ execution/
│  │  ├─ engine.ts
│  │  ├─ process-supervisor.ts
│  │  ├─ state-machine.ts
│  │  └─ fingerprint.ts
│  │
│  ├─ evidence/
│  │  ├─ diff.ts
│  │  ├─ git.ts
│  │  ├─ verification.ts
│  │  └─ store.ts
│  │
│  ├─ events/
│  │  ├─ store.ts
│  │  ├─ replay.ts
│  │  └─ reducer.ts
│  │
│  ├─ recovery/
│  │  └─ resolver.ts
│  │
│  └─ review/
│     ├─ bundle.ts
│     ├─ ingress.ts
│     └─ replay-guard.ts
│
└─ tests/
   ├─ fake-mcode/
   ├─ protocol/
   ├─ workspace/
   ├─ policy/
   ├─ events/
   ├─ recovery/
   ├─ evidence/
   ├─ review/
   ├─ windows/
   └─ e2e/
```

---

# 六十一、Phase 0 —— Runtime Probe

这是下一步。

还不写完整 G2M。

首先确认本机 MiniMax Code 的真实 Contract。

执行：

```text
mcode --version

mcode --help

mcode exec --help

mcode acp --help
```

然后做三个真实实验。

---

## Probe A：只读

目标：

```text
读取仓库
寻找模块入口
不得修改
```

确认：

```text
JSON 格式

stream-json Events

权限行为

是否真的没有修改

Session ID
```

---

## Probe B：小修改

目标：

```text
改一个小函数

不改 API

运行相关测试
```

确认：

```text
修改质量

Git Diff

Final JSON

Reported Tests

实际 Tests
```

---

## Probe C：失败测试修复

目标：

```text
运行失败测试
↓
定位根因
↓
修改
↓
重新测试
```

这是最接近真实 G2M Worker 的实验。

---

# 六十二、Phase 1 —— Protocol Foundation

实现：

```text
g2m.code-task.v1

g2m.code-result.v1

g2m.code-review-bundle.v1

g2m.review.v1

g2m.event.v1
```

并：

```text
JSON Schema

Semantic Validation

task_hash
```

---

# 六十三、Phase 2 —— Workspace Core

实现：

```text
Workspace Registry

Canonical Path

Workspace Lock

Clean Worktree Check

Git Baseline

Protected Path Rules
```

此阶段先不调用真实 MiniMax。

---

# 六十四、Phase 3 —— Fake MCode

Fake Agent 模拟：

```text
Success

Failure

Timeout

Malformed JSON

Partial stream-json

Writes files

Writes unexpected files

Process crash

Hangs

No final result
```

在不花 MiniMax 额度的情况下完善 G2M Runtime。

---

# 六十五、Phase 4 —— MCodeAdapter

实现：

```text
MCode Resolver

Runtime Probe

Permission Mapper

Argument Builder

Process Supervisor

stdout Parser

stderr Collector

stream-json Collector

Worker Result Normalizer
```

---

# 六十六、Phase 5 —— Evidence

实现：

```text
Git Baseline

Changed Files

Full Diff

Diff Hash

Untracked Files

Protected-file Detection
```

MiniMax 自述与真实 Git 证据分离。

---

# 六十七、Phase 6 —— Independent Verification

实现：

```text
Verification Profile

program + argv

timeout

stdout/stderr

exit code

duration
```

禁止 Planner 自行构造测试 Shell。

---

# 六十八、Phase 7 —— Reviewer Bundle

构建：

```text
Task
+
Worker Summary
+
Diff
+
Verification
+
Warnings
```

然后交给 Codex Reviewer。

---

# 六十九、Phase 8 —— Review Loop

支持：

```text
ACCEPT

REVISE

BLOCK
```

实现：

```text
Review anti-stale

Review anti-replay

Revision Task

Session continuation
if verified
```

---

# 七十、Phase 9 —— Reliability

实现：

```text
Timeout

Cancel

Windows process-tree termination

Event Log

Crash Recovery

UNKNOWN Resolver

RECOVERY_REQUIRED
```

---

# 七十一、Phase 10 —— Real E2E

拿真实 Git 仓库进行：

```text
Codex Plan
↓
G2M
↓
mcode exec
↓
MiniMax 修改
↓
Git Evidence
↓
Verification
↓
Codex Review
```

完整闭环。

---

# 七十二、Phase 11 —— Temporary Git Worktree

MVP 跑通后优先增加：

```text
Temporary Worktree Isolation
```

这是正式版最重要的安全/可靠性增强。

---

# 七十三、Phase 12 —— 是否需要 ACP

只有 MVP 跑完之后再问：

> `mcode exec` 目前究竟缺什么？

如果缺：

```text
实时 Permission

实时 Tool Status

中途 Steering

实时 Diff

强 Session 生命周期控制

更可靠 Cancellation
```

再实现：

```text
ACP Client
↓
mcode acp
```

不要为了“以后可能用到”提前增加 ACP 复杂度。

---

# 七十四、Phase 13 —— Agent Team

只有出现官方正式 External Interface：

```text
CLI

ACP extension

API

SDK
```

后才研究。

当前：

```text
不依赖
```

---

# 七十五、关键自动化测试不变量

必须写成测试：

```text
Planner cannot specify absolute workspace.

Planner cannot specify API key.

Planner cannot specify raw shell.

Workspace has at most one active execution.

Dirty workspace blocks MVP.

Unknown worker state never auto-retries.

RECOVERY_REQUIRED never auto-retries.

Review requires REVIEW_PENDING.

Stale review is rejected.

Exact review replay is idempotent.

Changed protected files are surfaced.

Worker-reported tests are not trusted as independent verification.

Runtime-documented capability is not automatically locally-verified capability.

Session continuation requires verified session ID.
```

---

# 七十六、MVP 完成标准

必须全部满足：

## Worker

```text
mcode exec
✓

JSON / stream-json
✓

max steps
✓

timeout
✓

permission mapping verified
✓
```

## Workspace

```text
Registry
✓

Lock
✓

Clean baseline
✓

Diff
✓
```

## Evidence

```text
Worker Summary
✓

Real Git Diff
✓

Independent Verification
✓
```

## Lifecycle

```text
State Machine
✓

Event Log
✓

Recovery
✓
```

## Review

```text
ACCEPT
✓

REVISE
✓

BLOCK
✓

anti-stale
✓

anti-replay
✓
```

## Windows

```text
mcode launcher
✓

Unicode paths
✓

spaces
✓

timeout
✓

cancel
✓

process tree
✓
```

---

# 七十七、最终 MVP Demo

Codex Planner：

```text
Goal:
Fix the failing MoveIt trajectory execution test.

Constraints:
- Do not change the public API.
- Keep changes minimal.
- Do not modify unrelated modules.

Verification:
targeted_tests

Acceptance:
- Target test passes.
- No related regression.
```

G2M：

```text
Validate
↓
Resolve workspace
↓
Acquire lock
↓
Check clean Git
↓
Resolve MCode
↓
Apply local permission policy
↓
Start mcode exec
```

MiniMax Code：

```text
Inspect repository
↓
Read relevant code
↓
Modify implementation
↓
Run tests
↓
Return summary
```

G2M：

```text
Collect Git Diff
↓
Audit protected files
↓
Run independent verification
↓
Build Review Bundle
```

Codex Reviewer：

```text
Diff looks correct.
Tests pass.
No unrelated changes.

ACCEPT
```

或者：

```text
REVISE:

The fix addresses the normal case,
but the empty trajectory case remains unsafe.
```

随后：

```text
New Revision Task
↓
same verified session or new session
↓
mcode exec
```

---

# 七十八、正式 ADR

建议冻结：

```text
ADR-001
G2M 是独立项目。

ADR-002
Codex 是 Planner + Reviewer。

ADR-003
MiniMax Code 是 MVP Coding Worker。

ADR-004
MVP 使用 mcode exec。

ADR-005
mcode acp 延期到 Phase 2。

ADR-006
Agent Team 不作为当前依赖。

ADR-007
G2M Core 通过 CodingWorkerAdapter 调用 Worker。

ADR-008
MVP 只实现 MCodeAdapter。

ADR-009
OpenCode 不参与 MVP。

ADR-010
Planner 不得提交 Shell。

ADR-011
Planner 不得指定绝对工作区。

ADR-012
Workspace 必须本地映射。

ADR-013
一个 Workspace 同时一个 Execution。

ADR-014
MVP 要求 Clean Worktree。

ADR-015
正式版优先增加 Temporary Worktree。

ADR-016
mcode permission 只是纵深防御的一层。

ADR-017
Worker 自述不等于证据。

ADR-018
Git Diff 由 G2M 独立采集。

ADR-019
测试由 G2M 独立 Verification。

ADR-020
Verification 命令只能来自 Local Profile。

ADR-021
未知 Session ID 不得猜测。

ADR-022
未经验证不得依赖 --continue。

ADR-023
Execution Success ≠ Review Success。

ADR-024
Retry ≠ Revision。

ADR-025
UNKNOWN 是 Recovery Verdict。

ADR-026
RECOVERY_REQUIRED 是正式安全停驻状态。

ADR-027
未知执行状态禁止自动重新调用 mcode。

ADR-028
API Key 始终由 MiniMax 本地配置管理。

ADR-029
Windows 必须测试完整 Process Tree。

ADR-030
Runtime 文档能力与本地验证能力分开记录。
```

---

# 七十九、最终开发顺序

交给本地 Codex 时，建议严格执行：

```text
01. Runtime Probe
02. 记录当前 mcode 真实 Contract
03. 三个手工 Probe Task
04. 冻结实际 JSON Event Contract

05. Repo Skeleton
06. CodingWorkerAdapter Interface
07. Protocol Schemas
08. Semantic Validator

09. Workspace Registry
10. Workspace Lock
11. Clean Worktree Baseline
12. Git Diff Collector

13. Fake MCode

14. MCode Resolver
15. Permission Mapper
16. MCode Exec Adapter
17. stream-json Parser
18. Worker Result Normalizer

19. Evidence Store
20. Verification Profiles
21. Independent Verification

22. State Machine
23. Event Log
24. task_fingerprint
25. Recovery

26. Reviewer Bundle
27. Review Ingress
28. Revision

29. Windows Tests
30. Fake E2E

31. Real mcode Read-only E2E
32. Real mcode Modify E2E
33. Real mcode Fix-test E2E

34. Temporary Worktree

35. Re-evaluate ACP
36. Re-evaluate Agent Team
```

截至 2026-08-29，上述顺序已完成。Phase 35 的结论是 v1 不需要 ACP Client；Phase 36 的结论是当前无稳定 Agent Team External Interface，因此不作为依赖。详见 `phase12-13-evaluation.md`。

不得提前跑去实现：

```text
OpenCode

MMX Multimodal

Multi-Agent

DAG

Background Server
```

---

# 八十、项目最终定义

GPT-to-MiniMax（G2M）不是：

> 一个新的 Coding Agent。

它是：

> **一个让高智力 Codex 能够安全、可靠地把编码工作委派给 MiniMax Code，并用真实工程证据重新审核结果的本地 Coding Orchestrator（编码编排器）。**

最终架构哲学：

```text
Codex decides what should be done.

G2M decides what is allowed.

MiniMax Code performs the coding work.

G2M collects what actually happened.

Codex decides whether it is good enough.
```

中文：

> **Codex 决定应该做什么；G2M 决定允许怎么做；MiniMax Code 真正完成编码；G2M 收集实际发生了什么；Codex 最终决定结果够不够好。**

---

# 八十一、当前下一步

架构到这里停止扩展。

下一阶段正式进入：

# Phase 0 — MiniMax Code Runtime Probe

第一目标不是写 G2M 大量代码，而是把当前机器上的：

```text
mcode --version

mcode --help

mcode exec --help

mcode acp --help
```

和真实：

```text
json
stream-json
session
permission
timeout
max-steps
```

行为验证清楚。

验证完这些以后：

> **直接进入 MVP 实现，不再继续改总体架构。**
