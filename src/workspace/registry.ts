/**
 * Workspace Registry — workspace_id → canonical path 映射
 *
 * 参考 plan 第 13 节「Workspace Registry」+ 第 60 节目录。
 *
 * 关键约束:
 * - Codex 不直接知道绝对路径(plan 第 13 节),只传 workspace_id
 * - canonical path 由本地 G2M 解析,Pluggable 加载
 * - 这一轮 MVP 用纯内存 Registry;持久化(写到 JSON config 文件)
 *   留到 Phase 2 末再补(plan 第 79 节 09-10 完成后)
 *
 * 不做的事:
 * - 不验证路径真的存在(那是 baseline.ts 的职责,plan 第 16 节 Clean Worktree)
 * - 不解析符号链接(plan 第 14 节承认 --cwd 不是完整安全边界,符号链接逃逸
 *   是 Phase 11 Temporary Worktree 才解决)
 */

import { resolve as resolvePath } from "node:path";

export interface WorkspaceEntry {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly registeredAt: number;
}

export class WorkspaceRegistryError extends Error {
  readonly code: "DUPLICATE_ID" | "INVALID_PATH" | "NOT_FOUND" | "EMPTY_ID";
  constructor(code: WorkspaceRegistryError["code"], message: string) {
    super(message);
    this.name = "WorkspaceRegistryError";
    this.code = code;
  }
}

export class WorkspaceRegistry {
  private readonly map = new Map<string, WorkspaceEntry>();

  /**
   * 注册一个 workspace。path 必须是绝对路径,会被 canonicalize
   * (即转成绝对 + 规范化分隔符,Node 的 path.resolve 自动做)。
   * 重复 id 抛错,不覆盖。
   */
  register(workspaceId: string, rawPath: string): WorkspaceEntry {
    if (workspaceId.trim().length === 0) {
      throw new WorkspaceRegistryError("EMPTY_ID", "workspace_id cannot be empty");
    }
    if (this.map.has(workspaceId)) {
      throw new WorkspaceRegistryError(
        "DUPLICATE_ID",
        `workspace_id "${workspaceId}" already registered`,
      );
    }
    if (rawPath.trim().length === 0) {
      throw new WorkspaceRegistryError("INVALID_PATH", "path cannot be empty");
    }
    if (!this.isAbsolutePath(rawPath)) {
      throw new WorkspaceRegistryError(
        "INVALID_PATH",
        `path must be absolute, got: ${rawPath}`,
      );
    }
    const entry: WorkspaceEntry = {
      workspaceId,
      canonicalPath: resolvePath(rawPath),
      registeredAt: Date.now(),
    };
    this.map.set(workspaceId, entry);
    return entry;
  }

  /**
   * 取消注册。已 unregister 的 id 抛 NOT_FOUND。
   */
  unregister(workspaceId: string): void {
    if (!this.map.delete(workspaceId)) {
      throw new WorkspaceRegistryError(
        "NOT_FOUND",
        `workspace_id "${workspaceId}" not registered`,
      );
    }
  }

  /**
   * 拿一个 entry。找不到抛 NOT_FOUND。
   */
  get(workspaceId: string): WorkspaceEntry {
    const entry = this.map.get(workspaceId);
    if (!entry) {
      throw new WorkspaceRegistryError(
        "NOT_FOUND",
        `workspace_id "${workspaceId}" not registered`,
      );
    }
    return entry;
  }

  /**
   * 列出所有 entry(浅拷贝,外部改不影响内部 map)。
   */
  list(): readonly WorkspaceEntry[] {
    return Array.from(this.map.values());
  }

  /**
   * 简单绝对路径判断,Windows 跟 POSIX 都覆盖。
   * 不做符号链接解析(plan 第 14 节说明这不是完整安全边界)。
   */
  private isAbsolutePath(p: string): boolean {
    if (p.length === 0) return false;
    if (p[0] === "/" || p[0] === "\\") return true; // POSIX 或 UNC
    if (/^[A-Za-z]:[\\/]/.test(p)) return true; // Windows drive letter
    return false;
  }
}
