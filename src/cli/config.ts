import { isAbsolute } from "node:path";
import { z } from "zod";

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

const LocalConfigSchema = z
  .object({
    protocol_version: z.literal("g2m.local-config.v1"),
    workspaces: z.array(WorkspaceConfigSchema).min(1),
    verification_profiles: z.array(VerificationProfileConfigSchema),
    worktree_root: absolutePath,
    artifact_root: absolutePath,
    state_root: absolutePath.optional(),
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
