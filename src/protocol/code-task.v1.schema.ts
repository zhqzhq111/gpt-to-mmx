/**
 * g2m.code-task.v1 — Zod schema 定义
 *
 * 参考 plan 第 10 节「核心任务协议」JSON 模板 + 第 11 节「禁止字段」+ 第 62 节 Phase 1。
 *
 * 这一文件只做 schema 定义,不负责禁止字段检查(那是 schema-validator 的职责)。
 * 不通过 schema 的未知字段会被 zod 拒绝(zod 默认 strip 行为改成 strict)。
 */

import { z } from "zod";

/**
 * Plan 第 10 节 WorkspaceScope。
 * 不接受 absolute_workspace_path(plan 第 11 节禁止字段 + 第 13 节约束)。
 */
export const WorkspaceScopeSchema = z
  .object({
    workspace_id: z.string().min(1),
    base_revision: z.string().min(1).default("HEAD"),
    require_clean_worktree: z.boolean().default(true),
  })
  .strict();

/**
 * Plan 第 10 节 RequestedCapabilities。
 * read / write / test / network 四元组。
 */
export const RequestedCapabilitiesSchema = z
  .object({
    read: z.boolean().default(true),
    write: z.boolean().default(true),
    test: z.boolean().default(true),
    network: z.boolean().default(false),
  })
  .strict();

/**
 * Plan 第 18 节 PermissionPolicy 语义层(非 mcode 原生命令层)。
 * 实测后再映射到 mcode Ask / Auto / Full(plan 第 19 节)。
 */
export const PermissionPolicyNameSchema = z.enum([
  "read_only",
  "coding_standard",
  "coding_extended",
]);

/**
 * Plan 第 10 节 Limits。
 */
export const ExecutionLimitsSchema = z
  .object({
    max_steps: z.number().int().positive().max(10_000),
    timeout_ms: z.number().int().positive().max(86_400_000), // 24h
  })
  .strict();

/**
 * Plan 第 10 节 SessionPolicy。
 * 严格遵守 plan 第 23 节 MVP 不允许 --continue:
 * verifiedSessionId 必须在 Runtime Probe 证明 Session ID 可靠获得后才能用。
 */
export const SessionPolicySchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("new") }).strict(),
    z
      .object({
        mode: z.literal("attach"),
        verified_session_id: z.string().min(1),
      })
      .strict(),
  ]);

/**
 * Plan 第 10 节 + 第 11 节 + 第 12 节 — g2m.code-task.v1 主 schema。
 * 未知字段(除了禁止字段由 schema-validator 提前检查外)走 .strict() 直接拒绝,
 * 不静默 strip。
 */
export const CodeTaskV1Schema = z
  .object({
    protocol_version: z.literal("g2m.code-task.v1"),
    task_id: z.string().min(1).max(200),
    workspace_scope: WorkspaceScopeSchema,
    goal: z.string().min(1).max(20_000),
    constraints: z.array(z.string().min(1)).max(100).default([]),
    requested_capabilities: RequestedCapabilitiesSchema,
    permission_policy: PermissionPolicyNameSchema,
    limits: ExecutionLimitsSchema,
    verification_profile: z.string().min(1).default("targeted_tests"),
    acceptance_criteria: z.array(z.string().min(1)).max(50).default([]),
    session_policy: SessionPolicySchema,
  })
  .strict();

export type CodeTaskV1 = z.infer<typeof CodeTaskV1Schema>;
export type WorkspaceScope = z.infer<typeof WorkspaceScopeSchema>;
export type RequestedCapabilities = z.infer<typeof RequestedCapabilitiesSchema>;
export type ExecutionLimitsSchemaT = z.infer<typeof ExecutionLimitsSchema>;
export type SessionPolicy = z.infer<typeof SessionPolicySchema>;
