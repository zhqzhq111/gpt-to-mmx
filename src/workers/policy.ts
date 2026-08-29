/**
 * Permission Policy / Execution Limits — G2M Core 跟 Adapter 之间的协议层。
 *
 * 参考 plan 第 12 节「Planner 与 G2M 权限关系」(Planner requests, G2M authorizes)、
 * 第 18 节「Permission Policy」(G2M 协议不直接暴露 mcode 的 ask/smart/full/off,
 * 用 read_only / coding_standard / coding_extended 这套语义层)。
 *
 * 实测后再映射到 mcode 真实 permission 命名(plan 第 19 节,
 * 官方实际是 Ask / Auto / Full access,跟 plan 写的 ask/smart/full/off 有差异)。
 */

export type PermissionPolicy = "read_only" | "coding_standard" | "coding_extended";

export interface ExecutionLimits {
  readonly maxSteps: number;
  readonly timeoutMs: number;
}
