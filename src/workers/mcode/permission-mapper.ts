/**
 * Permission Mapper + Local Policy(plan §12, §18-19)
 *
 * 两条职责:
 * 1. mapG2MPermissionToMCode:把 G2M 语义层映射到 mcode CLI 真实 flag
 * 2. LocalPermissionPolicy:Planner requests, G2M authorizes
 *    (本地 policy 永远 ≤ Planner 请求,plan §12 原话:
 *    "Codex 可以要求更少权限,Codex 不能强制扩大权限")
 *
 * 这一轮实现核心 decide() 逻辑。Phase 4 真实 Adapter 集成时,直接调
 * decide() 拿 effective policy + limits 喂给 buildMCodeInvocation。
 */

import {
  DEFAULT_G2M_TO_MCODE_PERMISSION,
  DEFAULT_LOCAL_LIMITS,
  type G2MPermissionPolicy,
  type MCodePermissionName,
} from "./permission.js";
import type { RequestedCapabilities } from "../../protocol/code-task.v1.schema.js";
import type { ExecutionLimits } from "../policy.js";

export interface EffectivePolicy {
  /** mcode 真实 CLI flag 值,直接喂 --permission */
  readonly mcodePermission: MCodePermissionName;
  /** 解析后的 effective capabilities(本地 ∧ requested) */
  readonly capabilities: {
    readonly read: boolean;
    readonly write: boolean;
    readonly test: boolean;
    readonly network: boolean;
  };
  /** min(Planner max_steps, Local max_steps),plan §40 */
  readonly effectiveMaxSteps: number;
  /** min(Planner timeout_ms, Local timeout_ms),plan §39 */
  readonly effectiveTimeoutMs: number;
}

export class LocalPermissionPolicy {
  private readonly mcodeMapping: Readonly<Record<G2MPermissionPolicy, MCodePermissionName>>;
  private readonly localMaxSteps: number;
  private readonly localTimeoutMs: number;
  private readonly localNetwork: boolean;

  constructor(
    options: {
      mcodeMapping?: Readonly<Record<G2MPermissionPolicy, MCodePermissionName>>;
      localMaxSteps?: number;
      localTimeoutMs?: number;
      localNetwork?: boolean;
    } = {},
  ) {
    this.mcodeMapping = options.mcodeMapping ?? DEFAULT_G2M_TO_MCODE_PERMISSION;
    this.localMaxSteps = options.localMaxSteps ?? DEFAULT_LOCAL_LIMITS.maxSteps;
    this.localTimeoutMs = options.localTimeoutMs ?? DEFAULT_LOCAL_LIMITS.timeoutMs;
    this.localNetwork = options.localNetwork ?? DEFAULT_LOCAL_LIMITS.network;
  }

  /**
   * G2M 语义层 → mcode 真实 flag 翻译。
   * plan §18 写 "G2M 协议不直接暴露 mcode 字符串",通过这一层转换。
   */
  mapToMCode(g2m: G2MPermissionPolicy): MCodePermissionName {
    return this.mcodeMapping[g2m];
  }

  /**
   * plan §12 核心:Planner requests, G2M authorizes。
   * 返回 effective policy,所有维度都是 local ∧ requested(本地永远更严)。
   */
  decide(
    g2mRequested: G2MPermissionPolicy,
    requestedCapabilities: RequestedCapabilities,
    requestedLimits: ExecutionLimits,
  ): EffectivePolicy {
    return {
      mcodePermission: this.mapToMCode(g2mRequested),
      capabilities: {
        read: requestedCapabilities.read, // read 默认允许
        write: requestedCapabilities.write,
        test: requestedCapabilities.test,
        // network 永远 = local ∧ requested(plan §12 例)
        network: requestedCapabilities.network && this.localNetwork,
      },
      effectiveMaxSteps: Math.min(requestedLimits.maxSteps, this.localMaxSteps),
      effectiveTimeoutMs: Math.min(requestedLimits.timeoutMs, this.localTimeoutMs),
    };
  }
}
