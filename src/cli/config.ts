import { isAbsolute } from "node:path";
import { z } from "zod";

import { DEFAULT_STORAGE_POLICY } from "../storage/policy.js";

const absolutePath = z.string().min(1).refine(isAbsolute, "path must be absolute");

const WorkspaceConfigSchema = z
  .object({
    workspace_id: z.string().min(1),
    path: absolutePath,
  })
  .strict();

const VerificationProfileConfigSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1).optional(),
    description: z.string(),
    program: z.string().min(1),
    args: z.array(z.string()),
    timeout_ms: z.number().int().positive(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const WorkspaceLeaseConfigSchema = z
  .object({
    heartbeat_interval_ms: z.number().int().positive().optional(),
    stale_after_ms: z.number().int().positive().optional(),
    incomplete_lease_grace_ms: z.number().int().positive().optional(),
    reclaim_guard_stale_ms: z.number().int().positive().optional(),
  })
  .strict();

const MAX_RUNTIME_BYTES = 1_073_741_824;
const MAX_RUNTIME_EVENTS = 1_000_000;
const MAX_RUNTIME_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export const DEFAULT_RUNTIME_HARDENING = {
  max_worker_stdout_bytes: 33_554_432,
  max_worker_stderr_bytes: 8_388_608,
  max_stream_json_line_bytes: 4_194_304,
  max_worker_events: 100_000,
  max_verification_stdout_bytes: 16_777_216,
  max_verification_stderr_bytes: 16_777_216,
  max_probe_output_bytes: 2_097_152,
  repair_reclaim_guard_stale_ms: 30_000,
} as const;

const RuntimeHardeningConfigSchema = z
  .object({
    max_worker_stdout_bytes: z.number().int().positive().max(MAX_RUNTIME_BYTES).default(DEFAULT_RUNTIME_HARDENING.max_worker_stdout_bytes),
    max_worker_stderr_bytes: z.number().int().positive().max(MAX_RUNTIME_BYTES).default(DEFAULT_RUNTIME_HARDENING.max_worker_stderr_bytes),
    max_stream_json_line_bytes: z.number().int().positive().max(MAX_RUNTIME_BYTES).default(DEFAULT_RUNTIME_HARDENING.max_stream_json_line_bytes),
    max_worker_events: z.number().int().positive().max(MAX_RUNTIME_EVENTS).default(DEFAULT_RUNTIME_HARDENING.max_worker_events),
    max_verification_stdout_bytes: z.number().int().positive().max(MAX_RUNTIME_BYTES).default(DEFAULT_RUNTIME_HARDENING.max_verification_stdout_bytes),
    max_verification_stderr_bytes: z.number().int().positive().max(MAX_RUNTIME_BYTES).default(DEFAULT_RUNTIME_HARDENING.max_verification_stderr_bytes),
    max_probe_output_bytes: z.number().int().positive().max(MAX_RUNTIME_BYTES).default(DEFAULT_RUNTIME_HARDENING.max_probe_output_bytes),
    repair_reclaim_guard_stale_ms: z.number().int().positive().max(MAX_RUNTIME_DURATION_MS).default(DEFAULT_RUNTIME_HARDENING.repair_reclaim_guard_stale_ms),
  })
  .strict()
  .default(DEFAULT_RUNTIME_HARDENING);

const StoragePolicySchema = z.object({
  min_free_bytes: z.number().int().nonnegative().default(DEFAULT_STORAGE_POLICY.min_free_bytes),
  safety_margin_bytes: z.number().int().nonnegative().default(DEFAULT_STORAGE_POLICY.safety_margin_bytes),
  default_execution_reservation_bytes: z.number().int().nonnegative().default(DEFAULT_STORAGE_POLICY.default_execution_reservation_bytes),
  max_total_bytes: z.number().int().nonnegative().default(DEFAULT_STORAGE_POLICY.max_total_bytes),
  max_artifact_bytes: z.number().int().nonnegative().default(DEFAULT_STORAGE_POLICY.max_artifact_bytes),
  max_worktree_bytes: z.number().int().nonnegative().default(DEFAULT_STORAGE_POLICY.max_worktree_bytes),
  completed_retention_days: z.number().int().nonnegative().default(DEFAULT_STORAGE_POLICY.completed_retention_days),
  reservation_ttl_ms: z.number().int().positive().default(DEFAULT_STORAGE_POLICY.reservation_ttl_ms),
  monitor_interval_ms: z.number().int().positive().default(DEFAULT_STORAGE_POLICY.monitor_interval_ms),
}).strict();

const LocalConfigSchema = z
  .object({
    protocol_version: z.literal("g2m.local-config.v1"),
    workspaces: z.array(WorkspaceConfigSchema).min(1),
    verification_profiles: z.array(VerificationProfileConfigSchema),
    worktree_root: absolutePath,
    artifact_root: absolutePath,
    state_root: absolutePath.optional(),
    workspace_lease: WorkspaceLeaseConfigSchema.optional(),
    storage: StoragePolicySchema.default(DEFAULT_STORAGE_POLICY),
    runtime_hardening: RuntimeHardeningConfigSchema,
    mcode_model: z.string().min(1).optional(),
    mcode_path: absolutePath.optional(),
    review_timeout_ms: z.number().int().positive().default(1_800_000),
  })
  .strict();

export type G2MLocalConfig = z.infer<typeof LocalConfigSchema>;

export class LocalConfigError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "LocalConfigError";
  }
}

export function parseLocalConfig(raw: unknown): G2MLocalConfig {
  const parsed = LocalConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LocalConfigError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
        .join("; "),
      parsed.error,
    );
  }

  const workspaceIds = new Set<string>();
  for (const workspace of parsed.data.workspaces) {
    if (workspaceIds.has(workspace.workspace_id)) {
      throw new LocalConfigError(
        `duplicate workspace id "${workspace.workspace_id}"`,
      );
    }
    workspaceIds.add(workspace.workspace_id);
  }

  const profileKeys = new Set<string>();
  for (const profile of parsed.data.verification_profiles) {
    if (
      profile.workspace_id !== undefined &&
      !workspaceIds.has(profile.workspace_id)
    ) {
      throw new LocalConfigError(
        `verification profile "${profile.id}" references unknown workspace "${profile.workspace_id}"`,
      );
    }
    const key = `${profile.workspace_id ?? "*"}::${profile.id}`;
    if (profileKeys.has(key)) {
      throw new LocalConfigError(`duplicate verification profile "${key}"`);
    }
    profileKeys.add(key);
  }

  return parsed.data;
}
