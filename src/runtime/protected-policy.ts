import { sha256 } from "../protocol/hash.js";

export const PROTECTED_POLICY_SCHEMA_VERSION = 1 as const;

export interface ProtectedVerificationProfile {
  readonly id: string;
  readonly resolved_program: string;
  readonly program_identity_hash: string;
  readonly program_bytes: number;
  readonly args_hash: string;
  readonly timeout_ms: number;
  readonly env_names: readonly string[];
  readonly env_hash: string;
}

export interface ProtectedPolicy {
  readonly schema_version: typeof PROTECTED_POLICY_SCHEMA_VERSION;
  readonly task_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly canonical_workspace_path: string;
  readonly base_revision: string;
  readonly artifact_root: string;
  readonly worktree_root: string;
  readonly state_root: string;
  readonly permission_policy: string;
  readonly requested_capabilities: Readonly<Record<string, boolean>>;
  readonly limits: Readonly<Record<string, number>>;
  readonly verification_profile: ProtectedVerificationProfile;
  readonly runtime_identity_hash: string;
  readonly output_limits: Readonly<Record<string, number>>;
  readonly storage_policy_hash: string;
  readonly lease_policy_hash: string;
  readonly policy_hash: string;
}

export interface ProtectedPolicyInput {
  readonly task_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly canonical_workspace_path: string;
  readonly base_revision: string;
  readonly artifact_root: string;
  readonly worktree_root: string;
  readonly state_root: string;
  readonly permission_policy: string;
  readonly requested_capabilities: Readonly<Record<string, boolean>>;
  readonly limits: Readonly<Record<string, number>>;
  readonly verification_profile: {
    readonly id: string;
    readonly resolved_program: string;
    readonly program_identity_hash: string;
    readonly program_bytes: number;
    readonly args: readonly string[];
    readonly timeout_ms: number;
    readonly env?: Readonly<Record<string, string>>;
  };
  readonly runtime_identity_hash: string;
  readonly output_limits: Readonly<Record<string, number>>;
  readonly storage_policy_hash: string;
  readonly lease_policy_hash: string;
}

type ProtectedPolicyContent = Omit<ProtectedPolicy, "policy_hash">;

function envHash(env: Readonly<Record<string, string>> | undefined): string {
  return sha256(env ?? {});
}

export function buildProtectedPolicy(input: ProtectedPolicyInput): ProtectedPolicy {
  const envNames = Object.keys(input.verification_profile.env ?? {}).sort();
  const content: ProtectedPolicyContent = {
    schema_version: PROTECTED_POLICY_SCHEMA_VERSION,
    task_id: input.task_id,
    execution_id: input.execution_id,
    workspace_id: input.workspace_id,
    canonical_workspace_path: input.canonical_workspace_path,
    base_revision: input.base_revision,
    artifact_root: input.artifact_root,
    worktree_root: input.worktree_root,
    state_root: input.state_root,
    permission_policy: input.permission_policy,
    requested_capabilities: { ...input.requested_capabilities },
    limits: { ...input.limits },
    verification_profile: {
      id: input.verification_profile.id,
      resolved_program: input.verification_profile.resolved_program,
      program_identity_hash: input.verification_profile.program_identity_hash,
      program_bytes: input.verification_profile.program_bytes,
      args_hash: sha256(input.verification_profile.args),
      timeout_ms: input.verification_profile.timeout_ms,
      env_names: envNames,
      env_hash: envHash(input.verification_profile.env),
    },
    runtime_identity_hash: input.runtime_identity_hash,
    output_limits: { ...input.output_limits },
    storage_policy_hash: input.storage_policy_hash,
    lease_policy_hash: input.lease_policy_hash,
  };
  return Object.freeze({ ...content, policy_hash: sha256(content) });
}

export function protectedPolicyHash(policy: ProtectedPolicy): string {
  const { policy_hash: _ignored, ...content } = policy;
  return sha256(content);
}

export function validateProtectedPolicy(policy: ProtectedPolicy): boolean {
  return protectedPolicyHash(policy) === policy.policy_hash;
}
