/**
 * Workspace Resolver — plan 第 13 节
 *
 * 给 Codex(Planner)一个 workspace_id,G2M 解析成 canonical trusted path,
 * 然后才作为 mcode --cwd 传入。
 *
 * 现阶段就是 Registry 的薄包装,Plan E2E 阶段可能会加 "workspace_id alias
 * 解析 + 多源 merge + 缓存" 等更复杂逻辑,先不预判。
 */

import { WorkspaceRegistry, WorkspaceRegistryError } from "./registry.js";

export class WorkspaceResolverError extends Error {
  readonly code: "NOT_FOUND" | "INVALID_ID";
  constructor(code: WorkspaceResolverError["code"], message: string) {
    super(message);
    this.name = "WorkspaceResolverError";
    this.code = code;
  }
}

/**
 * Resolve workspace_id → canonical path.
 * 失败抛 WorkspaceResolverError;调用方应该 catch 后映射到 G2M 错误模型。
 */
export function resolveWorkspace(
  registry: WorkspaceRegistry,
  workspaceId: string,
): string {
  if (workspaceId.trim().length === 0) {
    throw new WorkspaceResolverError("INVALID_ID", "workspace_id cannot be empty");
  }
  try {
    return registry.get(workspaceId).canonicalPath;
  } catch (e) {
    if (e instanceof WorkspaceRegistryError && e.code === "NOT_FOUND") {
      throw new WorkspaceResolverError(
        "NOT_FOUND",
        `cannot resolve workspace_id "${workspaceId}"`,
      );
    }
    throw e;
  }
}
