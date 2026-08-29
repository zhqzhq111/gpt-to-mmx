/**
 * task_fingerprint — plan §53
 *
 * 任务 + runtime 的身份指纹,绑定 plan §53 列出的所有字段:
 * task_hash, workspace_id, base_revision, mcode version, model,
 * permission profile, max_steps, timeout, adapter contract version,
 * runtime capability snapshot hash。
 *
 * 语义(plan §53 + 用户要求 5/6):
 * - 在 ATTEMPT_STARTED (即 agent.spawn.started) 事件里冻结
 * - 冻结后任何事件如果 fingerprint 与冻结值不同 → RECOVERY_REQUIRED
 *
 * UNKNOWN 不在这个模块 — UNKNOWN 是 Recovery Verdict(plan §51),
 * 真正的 recovery 行为属于 Phase 9,本轮不实现。
 *
 * 持久化不在本轮(Phase 9 Event Log 一起做,plan §52)。
 */

import { sha256 } from "../protocol/hash.js";

export interface TaskFingerprint {
  readonly taskHash: string;
  readonly workspaceId: string;
  readonly baseRevision: string;
  readonly mcodeVersion: string;
  readonly model: string;
  readonly permissionProfile: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly adapterContractVersion: string;
  readonly runtimeCapabilitySnapshotHash: string;
}

/**
 * 计算 fingerprint 的稳定 hash(plan §53 binding 字段之一)。
 * 同一 fingerprint 多次调用结果稳定;不同 fingerprint 结果不同。
 */
export function fingerprintHash(fp: TaskFingerprint): string {
  return sha256(fp);
}

export interface ComputeFingerprintInput {
  readonly taskHash: string;
  readonly workspaceId: string;
  readonly baseRevision: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly permissionProfile: string;
}

export interface ComputeFingerprintRuntime {
  readonly mcodeVersion: string;
  readonly model: string;
  readonly adapterContractVersion: string;
  readonly runtimeCapabilitySnapshotHash: string;
}

export function computeTaskFingerprint(
  task: ComputeFingerprintInput,
  runtime: ComputeFingerprintRuntime,
): TaskFingerprint {
  return {
    taskHash: task.taskHash,
    workspaceId: task.workspaceId,
    baseRevision: task.baseRevision,
    mcodeVersion: runtime.mcodeVersion,
    model: runtime.model,
    permissionProfile: task.permissionProfile,
    maxSteps: task.maxSteps,
    timeoutMs: task.timeoutMs,
    adapterContractVersion: runtime.adapterContractVersion,
    runtimeCapabilitySnapshotHash: runtime.runtimeCapabilitySnapshotHash,
  };
}

export class FingerprintRegistryError extends Error {
  readonly code: "ALREADY_FROZEN" | "NOT_FOUND";
  constructor(
    code: FingerprintRegistryError["code"],
    message: string,
  ) {
    super(message);
    this.name = "FingerprintRegistryError";
    this.code = code;
  }
}

interface FrozenFingerprint {
  readonly fingerprint: TaskFingerprint;
  readonly frozenAt: number;
}

/**
 * 已冻结 fingerprint 的内存 registry。
 * 跟 WorkspaceRegistry / ProfileRegistry 一致,跟 fingerprint 一起放 execution/。
 * 跟 plan §60 略有差异(plan 只有 fingerprint.ts 没有 registry 文件),
 * 但跟现有 G2M 内部命名习惯一致(WorkspaceRegistry / ProfileRegistry 都是独立类)。
 */
export class FingerprintRegistry {
  private readonly frozen = new Map<string, FrozenFingerprint>();

  /**
   * 冻结一个 task 的 fingerprint。二次 freeze 抛 ALREADY_FROZEN,
   * 防止 reducer 在重复事件里意外覆盖。
   */
  freeze(taskId: string, fingerprint: TaskFingerprint): TaskFingerprint {
    if (this.frozen.has(taskId)) {
      throw new FingerprintRegistryError(
        "ALREADY_FROZEN",
        `fingerprint for task "${taskId}" already frozen`,
      );
    }
    this.frozen.set(taskId, {
      fingerprint,
      frozenAt: Date.now(),
    });
    return fingerprint;
  }

  get(taskId: string): TaskFingerprint | undefined {
    return this.frozen.get(taskId)?.fingerprint;
  }

  has(taskId: string): boolean {
    return this.frozen.has(taskId);
  }

  /**
   * 给 Phase 9 Recovery 用:手动清除冻结,允许重新冻结。
   * 本轮 reducer 不调用,只暴露给将来的 recovery 流程。
   */
  reset(taskId: string): void {
    this.frozen.delete(taskId);
  }

  size(): number {
    return this.frozen.size;
  }
}
