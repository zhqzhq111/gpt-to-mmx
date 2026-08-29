/**
 * Workspace Lock — plan 第 15 节
 *
 * 强制一个 workspace 同时只能有 1 个 Active Coding Execution。
 * 避免两个 Agent 同时跑导致:
 * - Git diff 混合
 * - 文件覆盖
 * - 测试结果混合
 * - 恢复状态混乱
 *
 * MVP 限制:
 * - 只在单进程内有效(用 Map 存 active locks)
 * - 跨进程 lock 用文件系统(flock / lockfile)留到 Phase 11 Temporary Worktree 一起做
 * - 不持久化,G2M 进程 crash 后所有 lock 自动释放
 *
 * 这跟 plan 第 51 节 Recovery 设计一致:进程 crash → UNKNOWN →
 * Recovery Resolver → 人工干预(而不是锁文件残留阻塞)。
 */

export class WorkspaceLockError extends Error {
  readonly code: "WORKSPACE_BUSY" | "INVALID_HANDLE" | "NOT_HELD";
  constructor(code: WorkspaceLockError["code"], message: string) {
    super(message);
    this.name = "WorkspaceLockError";
    this.code = code;
  }
}

export interface LockHandle {
  readonly workspaceId: string;
  readonly acquiredAt: number;
  readonly executionId: string;
}

/**
 * Generation token — 每次 release 递增,防止"已 release 的 handle 又被
 * release 一次"或"并发竞争条件下 stale handle 被错误重用"。
 */
interface InternalLock {
  readonly handle: LockHandle;
  generation: number;
}

export class WorkspaceLock {
  private readonly active = new Map<string, InternalLock>();

  /**
   * 尝试获取 workspace 的 lock。已被占用抛 WORKSPACE_BUSY。
   * 成功返回 LockHandle,release 时用。
   */
  acquire(workspaceId: string, executionId: string): LockHandle {
    if (workspaceId.trim().length === 0) {
      throw new WorkspaceLockError(
        "INVALID_HANDLE",
        "workspaceId cannot be empty",
      );
    }
    if (executionId.trim().length === 0) {
      throw new WorkspaceLockError(
        "INVALID_HANDLE",
        "executionId cannot be empty",
      );
    }
    if (this.active.has(workspaceId)) {
      const held = this.active.get(workspaceId)!;
      throw new WorkspaceLockError(
        "WORKSPACE_BUSY",
        `workspace "${workspaceId}" is busy (held by execution ${held.handle.executionId})`,
      );
    }
    const handle: LockHandle = {
      workspaceId,
      executionId,
      acquiredAt: Date.now(),
    };
    this.active.set(workspaceId, { handle, generation: 0 });
    return handle;
  }

  /**
   * 释放 lock。handle 必须由本 WorkspaceLock 的 acquire 产生。
   * 二次 release / 错误 handle 抛错,防止误释放别人的 lock。
   */
  release(handle: LockHandle): void {
    const held = this.active.get(handle.workspaceId);
    if (!held || held.handle !== handle) {
      throw new WorkspaceLockError(
        "NOT_HELD",
        `lock for workspace "${handle.workspaceId}" is not held by this handle`,
      );
    }
    this.active.delete(handle.workspaceId);
  }

  /**
   * 诊断用:列出所有 active lock workspace_id。
   */
  heldWorkspaceIds(): readonly string[] {
    return Array.from(this.active.keys());
  }

  /**
   * 诊断用:看一个 workspace 是否被锁。
   */
  isHeld(workspaceId: string): boolean {
    return this.active.has(workspaceId);
  }
}
