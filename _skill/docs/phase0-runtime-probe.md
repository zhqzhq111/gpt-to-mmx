# Phase 0 — MiniMax Code Runtime Probe

**更新日期**: 2026-08-29
**环境**: Windows / PowerShell 7 / Node.js 22
**运行时**: MiniMax Code CLI 0.2.7
**状态**: v1 所需 Contract、权限写入行为、真实 Adapter 与外层 timeout 策略已验证；原生 timeout、output-schema 与 ACP 仅保留为可选后续实验

## 0.1 运行入口

当前终端已经解析到：

~~~text
CommandType : Application
Path        : C:/Users/zhq/AppData/Roaming/npm/mcode.cmd
where.exe   : C:/Users/zhq/AppData/Roaming/npm/mcode.cmd
~~~

一次运行过程中观察到的真实 Node 入口为：

~~~text
D:/Program Files/node.exe
C:/Users/zhq/.minimax-code/releases/0.2.7/node_modules/@minimax-ai/code/cli.js
~~~

release 路径只是本次进程观测结果，G2M 不得硬编码，仍必须通过 mcode Resolver 调用。

## 0.2 版本和帮助

~~~text
mcode --version
0.2.7
~~~

已确认顶层命令：

~~~text
init  exec  acp  login  logout  update  provider  plugin
~~~

mcode exec 是单次无 TUI 执行；mcode acp 是通过 stdio 提供的 ACP Server。

## 0.3 exec 参数 Contract

当前 mcode exec 支持：

~~~text
--input <source>                  目前仅支持 -
--input-format <format>           text / json
--cwd <path>
--file <path>                     可重复
--model <provider/model>
--session <id>
--continue
--config <path>
--permission <policy>             smart / full / off
--timeout <duration>
--max-steps <count>
--output-format <format>          text / json / stream-json
--output-schema <schema>
--output-last-message <path>
~~~

重要修正：

~~~text
mcode exec 不接受 --permission ask
ask 只适用于 TUI / ACP
默认 permission = smart
~~~

G2M 语义层不能直接暴露 ask。本机写入夹具实测表明：`smart`、`full`、`off` 三者在 headless exec 中均能创建文件。`off` 不是“关闭文件工具”，更接近关闭审批检查；三者都不得作为 G2M 的只读安全边界。

## 0.4 JSON 输出实测

mcode exec --output-format json 的外层结果已验证为 JSON object，结构摘要如下：

~~~json
{
  "schemaVersion": 1,
  "type": "exec.result",
  "runId": "exec_turn_...",
  "sessionId": "mvs_...",
  "turnId": "turn_...",
  "status": "succeeded",
  "output": "Worker final message",
  "model": { "providerId": "minimax", "modelId": "MiniMax-M3", "variant": "thinking" },
  "usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
  "durationMs": 13044
}
~~~

已确认：

- output 当前是字符串，不是已经解析好的 Worker Summary。
- Worker 要求返回 JSON 时，JSON 可能被包在 Markdown code fence 中。
- sessionId 位于外层 camelCase 字段中。
- Result Parser 必须解析 output 字符串，不能只寻找旧设计中的 type=result 事件。

## 0.5 stream-json 实测

固定只读夹具的成功 Probe 得到逐行 NDJSON，事件序号为 1 到 18，连续且无重复。

~~~text
exec.started       1
session.started    1
turn.started       1
item.started       4
item.updated       5
item.completed     4
turn.completed     1
exec.completed     1
~~~

典型事件包含：

~~~json
{
  "schemaVersion": 1,
  "sequence": 1,
  "timestampMs": 1788007447954,
  "runId": "exec_turn_...",
  "sessionId": "mvs_...",
  "turnId": "turn_...",
  "type": "exec.started"
}
~~~

最终结果位于 exec.completed.result；其中 result.status、result.output、result.model、result.usage 和 result.durationMs 可直接作为 Worker Envelope 解析。

第一次 Probe 把 stdout 捕获文件放在 --cwd 内，导致 Worker 反复读取不断增长的事件文件并触发 max-steps。修正版把捕获文件放在 --cwd 外后成功。

> G2M 的 stdout、stderr、事件日志和临时捕获文件不得放入 MiniMax Worker 工作区。

## 0.6 当前验证状态

~~~text
mcode 安装入口             VERIFIED
mcode version              0.2.7
mcode exec                 AVAILABLE
json output                VERIFIED
stream-json output         VERIFIED
sessionId                  VERIFIED
permission write behavior  VERIFIED (smart/full/off 均可写)
G2M outer timeout          VERIFIED
mcode native timeout       UNVERIFIED_OPTIONAL
output-schema              UNVERIFIED
ACP behavior               DOCUMENTED_ONLY
~~~

Session ID 已在 JSON 和 stream-json 中观察到，但在跨任务验证完成前，Revision 默认使用新 Session，不自动使用 --continue。

## 0.7 Windows .cmd 外层进程问题

真实进程链为：

~~~text
mcode.cmd → cmd.exe → node.exe → MiniMax Code CLI
~~~

两次 Probe 都出现 Node 内部已经产生最终结果，但外层 cmd.exe 没有在预期时间退出的现象。

因此 G2M 必须区分：

~~~text
Worker Result 已经产生
不等于
Wrapper Process 已经正常退出
~~~

Adapter 已实现 exec.completed 识别、外层 watchdog 和进程树清理：先收集最终 Result，再处理仍存活的 cmd.exe wrapper。UNKNOWN 由 Engine 转入 RECOVERY_REQUIRED 并保留隔离现场，不能仅凭父进程 exit code 重复启动任务。

## 0.8 Phase 0 结论

已完成：

1. 真实事件 Parser 和 `exec.completed.result` Result Normalizer。
2. camelCase `sessionId` 提取。
3. Prompt 通过 `--input -` stdin 传输。
4. `.cmd` wrapper 完成后提前收集 Result，并清理对应进程树。
5. Fake Worker 对真实事件格式的覆盖。

仍待实现：

1. mcode 原生 timeout 的单独黑盒实验（v1 已有 G2M 外层 watchdog）。
2. `--output-schema` 与跨任务 Session 续接实验。
3. 只有出现实时 steering 等硬需求时才实现 ACP Client。

## 0.9 Permission 与外层 Watchdog 补充实测

2026-08-29 使用三个独立临时目录执行同一写文件任务：

~~~text
smart  → 创建 permission-probe.txt 成功
full   → 创建 permission-probe.txt 成功
off    → 创建 permission-probe.txt 成功
~~~

因此 v1 的强制边界是：

~~~text
Temporary Worktree + requested_capabilities diff audit + independent verification + Codex review
~~~

MCodeAdapter 同时增加外层 watchdog 与 Windows process-tree kill。Mock 进程实测在超时后返回 `TIMED_OUT`，显式取消返回 `CANCELLED`；UNKNOWN 则由 Engine 转入 `RECOVERY_REQUIRED` 并保留隔离 worktree。

暂不允许：

1. 把旧的 system / assistant / result 结构当作真实 Contract。
2. 把 ask 当作 headless permission。
3. 把父进程 exit code 单独作为任务成功或失败依据。
4. 在 Session ID 跨任务验证前自动使用 --continue。
