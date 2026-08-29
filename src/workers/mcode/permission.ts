/**
 * Permission Mapping 类型 + 默认映射表
 *
 * 参考 plan §18-19:
 * - §18:G2M 协议不直接暴露 mcode 命令层,使用语义层 read_only / coding_standard / coding_extended
 * - §19:实测后才能把 G2M 名字映射到 mcode 真实命名。
 *   当前 mcode 0.2.7 的 exec help 明确列出 smart / full / off；ask 只适用于 TUI/ACP。
 *
 * 0.2.7 本机实测表明 smart / full / off 在 headless exec 中均能写入
 * 隔离夹具；它们都不是 read-only sandbox。G2M 仍使用 smart/full 作为
 * MiniMax 侧纵深防御，并在 Engine 层通过真实 diff 强制执行无写权限任务。
 */

import type { PermissionPolicy } from "../policy.js";

/**
 * mcode exec 0.2.7 真实接受的 permission 字符串。
 * ask 不能用于 exec；它只适用于 TUI / ACP。
 */
export type MCodePermissionName = "smart" | "full" | "off";

/**
 * G2M 协议层的 PermissionPolicy 名字(plan §18 + `src/workers/policy.ts`)。
 * 跟 PermissionPolicy 类型保持一致(避免重复定义)。
 */
export type G2MPermissionPolicy = PermissionPolicy;

/**
 * 默认 G2M → mcode 映射(plan §18 语义层 → mcode exec 0.2.7):
 * - read_only       → smart(headless 中相对保守，但不等于不可写)
 * - coding_standard → smart(默认编码候选)
 * - coding_extended → full(扩展任务候选)
 *
 * off 实测仍可写，因此不进入任何默认映射。
 */
export const DEFAULT_G2M_TO_MCODE_PERMISSION: Readonly<
  Record<G2MPermissionPolicy, MCodePermissionName>
> = {
  read_only: "smart",
  coding_standard: "smart",
  coding_extended: "full",
};

/**
 * 默认本地 hard limits(plan §12:Local policy 永远 ≤ Planner 请求)。
 * 跟具体 workspace 配置无关,作为 G2M Core 的"最后防线"。
 * 真实部署应该从 G2M config 读,这一轮先 hardcode。
 */
export const DEFAULT_LOCAL_LIMITS = {
  maxSteps: 50,
  timeoutMs: 1_800_000, // 30 min
  network: false,
} as const;
