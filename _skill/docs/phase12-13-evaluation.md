# Phase 12–13 复评：ACP 与 Agent Team

**日期：** 2026-08-29  
**结论：** G2M v1 不实现 ACP Client，不依赖 Agent Team。

## ACP

本机 `mcode` 0.2.7 提供 `mcode acp`，但当前 `mcode exec` 已满足 v1 必需能力：

- headless 单任务执行；
- `stream-json` 最终结果与 session ID；
- cwd、permission、timeout、max-steps；
- G2M 外层 cancellation、watchdog、diff 与 verification。

ACP 能增加实时 permission prompt、steering、tool status 和更强 session 控制，但这些不是当前“Planner/Reviewer + Coding Worker”闭环的阻塞项。按 ADR-005，不为未来可能需求提前增加长期 stdio client 与交互状态机。

重新开启条件：真实任务明确需要中途 steering、实时审批、流式 tool status 或强 session 生命周期，而且 `mcode exec` 无法可靠完成。

## Agent Team

MiniMax 官方已公开 Agent Team 产品和 Leader/Worker/Verifier 思路，但截至本次复评，没有在当前 `mcode` 0.2.7 CLI 帮助或公开 API 总览中找到可供 G2M 稳定调用的 Agent Team 专用 CLI/API/SDK contract。

G2M 已通过 `CodingWorkerAdapter` 保留未来替换 Worker 的边界。按 ADR-006，v1 不依赖 Agent Team，也不解析产品内部实现。

重新开启条件：官方出现带版本、鉴权、任务状态、取消、结果与错误语义的 External Interface。

官方参考：

- MiniMax Agent Team 技术文章：https://agent.minimax.io/docs/techblog
- MiniMax API Overview：https://platform.minimax.io/docs/api-reference/api-overview
