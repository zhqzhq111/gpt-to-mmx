import { sha256 } from "../protocol/hash.js";
import type { MCodeLaunchDescriptor } from "../workers/mcode/resolver.js";

export const RUNTIME_IDENTITY_SCHEMA_VERSION = 1 as const;
export const MCODE_ADAPTER_CONTRACT_VERSION = "g2m-worker-v2" as const;
export const MCODE_INVOCATION_CONTRACT_VERSION = "g2m-mcode-invocation-v2" as const;

export interface RuntimeIdentity {
  readonly schema_version: typeof RUNTIME_IDENTITY_SCHEMA_VERSION;
  readonly runtime: "mcode";
  readonly runtime_version: string;
  readonly node_version: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly launch_kind: MCodeLaunchDescriptor["kind"];
  readonly resolved_executable_path: string;
  readonly executable_sha256: string;
  readonly executable_bytes: number;
  readonly resolved_via: MCodeLaunchDescriptor["resolvedVia"];
  readonly help_sha256: string;
  readonly exec_help_sha256: string;
  readonly capability_snapshot_hash: string;
  readonly adapter_contract_version: typeof MCODE_ADAPTER_CONTRACT_VERSION;
  readonly invocation_contract_version: typeof MCODE_INVOCATION_CONTRACT_VERSION;
  readonly worker_summary_schema_hash: string;
  readonly model: string | null;
  readonly model_pinned: boolean;
  readonly identity_hash: string;
}

export interface RuntimeIdentityInput {
  readonly descriptor: MCodeLaunchDescriptor;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly capabilitySnapshotHash: string;
  readonly workerSummarySchemaHash: string;
  readonly model?: string;
}

type RuntimeIdentityContent = Omit<RuntimeIdentity, "identity_hash">;

export function buildRuntimeIdentity(input: RuntimeIdentityInput): RuntimeIdentity {
  const content: RuntimeIdentityContent = {
    schema_version: RUNTIME_IDENTITY_SCHEMA_VERSION,
    runtime: "mcode",
    runtime_version: input.descriptor.version,
    node_version: input.nodeVersion ?? process.version,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    launch_kind: input.descriptor.kind,
    resolved_executable_path: input.descriptor.executablePath,
    executable_sha256: input.descriptor.executableSha256,
    executable_bytes: input.descriptor.executableBytes,
    resolved_via: input.descriptor.resolvedVia,
    help_sha256: input.descriptor.helpSha256,
    exec_help_sha256: input.descriptor.execHelpSha256,
    capability_snapshot_hash: input.capabilitySnapshotHash,
    adapter_contract_version: MCODE_ADAPTER_CONTRACT_VERSION,
    invocation_contract_version: MCODE_INVOCATION_CONTRACT_VERSION,
    worker_summary_schema_hash: input.workerSummarySchemaHash,
    model: input.model ?? null,
    model_pinned: input.model !== undefined,
  };
  return Object.freeze({ ...content, identity_hash: sha256(content) });
}

export function runtimeIdentityHash(identity: RuntimeIdentity): string {
  const { identity_hash: _ignored, ...content } = identity;
  return sha256(content);
}

export function validateRuntimeIdentity(identity: RuntimeIdentity): boolean {
  return runtimeIdentityHash(identity) === identity.identity_hash;
}
