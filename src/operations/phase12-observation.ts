import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import type { G2MLocalConfig } from "../cli/config.js";
import { fingerprintHash, validateFingerprintV2Artifact, type FingerprintV2Artifact } from "../execution/fingerprint.js";
import { isTerminal, type TaskState } from "../execution/state-machine.js";
import type { TaskEvent } from "../events/events.js";
import { validateProtectedPolicy, type ProtectedPolicy } from "../runtime/protected-policy.js";
import { validateRuntimeIdentity, type RuntimeIdentity } from "../runtime/identity.js";
import { sha256 } from "../protocol/hash.js";

export type Phase12ArtifactState = "MISSING" | "VALID" | "MALFORMED" | "HASH_MISMATCH";
export type Phase12BindingState = "CONSISTENT" | "CONFLICT" | "UNAVAILABLE";
export type LegacyExecutionClassification = "NONE" | "TERMINAL" | "ACTIVE" | "RECOVERY_CRITICAL" | "UNKNOWN";

export interface Phase12ArtifactObservation {
  readonly state: Phase12ArtifactState;
  readonly fileSha256: string | null;
  readonly declaredHash: string | null;
}

export interface Phase12ModelObservation {
  readonly value: string | null;
  readonly pinned: boolean;
}

export interface Phase12ExecutionObservation {
  readonly fingerprintVersion: 1 | 2 | null;
  readonly runtimeIdentityArtifact: Phase12ArtifactObservation;
  readonly protectedPolicyArtifact: Phase12ArtifactObservation;
  readonly fingerprintArtifact: Phase12ArtifactObservation;
  readonly model: Phase12ModelObservation;
  readonly effectiveOutputLimits: Readonly<Record<string, number>>;
  readonly outputLimitsSource: "protected-policy" | "current-config" | "unavailable";
  readonly configDrift: readonly string[];
  readonly bindings: Phase12BindingState;
  readonly legacyClassification: LegacyExecutionClassification;
}

export type ReclaimGuardState = "MISSING" | "LIVE" | "DEAD" | "FOREIGN" | "MALFORMED";

export interface ReclaimGuardObservation {
  readonly state: ReclaimGuardState;
  readonly path: string;
  readonly guardId: string | null;
  readonly operationId: string | null;
  readonly pid: number | null;
  readonly hostname: string | null;
  readonly heartbeatAgeMs: number | null;
  readonly stale: boolean | null;
}

interface ParsedArtifact<T> {
  readonly observation: Phase12ArtifactObservation;
  readonly value?: T;
}

const RUNTIME_KEYS = [
  "adapter_contract_version", "arch", "capability_snapshot_hash", "exec_help_sha256", "executable_bytes", "executable_sha256",
  "help_sha256", "identity_hash", "invocation_contract_version", "launch_kind", "model", "model_pinned", "node_version",
  "platform", "resolved_executable_path", "resolved_via", "runtime", "runtime_version", "schema_version", "worker_summary_schema_hash",
];
const POLICY_KEYS = [
  "artifact_root", "base_revision", "canonical_workspace_path", "execution_id", "lease_policy_hash", "limits", "output_limits",
  "permission_policy", "policy_hash", "requested_capabilities", "runtime_identity_hash", "schema_version", "state_root", "storage_policy_hash",
  "task_id", "verification_profile", "worktree_root", "workspace_id",
];
const VERIFICATION_KEYS = ["args_hash", "env_hash", "env_names", "id", "program_bytes", "program_identity_hash", "resolved_program", "timeout_ms"];
const FINGERPRINT_KEYS = [
  "adapter_contract_version", "base_revision", "execution_id", "fingerprint_hash", "fingerprint_version", "mcode_version", "max_steps",
  "model", "model_pinned", "permission_profile", "protected_policy_hash", "runtime_capability_snapshot_hash", "runtime_identity_hash",
  "schema_version", "task_hash", "task_id", "timeout_ms", "worker_summary_schema_hash", "workspace_id",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasBooleanValues(value: Record<string, unknown>): boolean {
  return Object.values(value).every((item) => typeof item === "boolean");
}

function hasFiniteNumberValues(value: Record<string, unknown>): boolean {
  return Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item));
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseRuntime(value: unknown): RuntimeIdentity {
  if (!isRecord(value) || !hasExactKeys(value, RUNTIME_KEYS) || value.schema_version !== 1 || value.runtime !== "mcode" ||
    typeof value.runtime_version !== "string" || typeof value.node_version !== "string" || typeof value.platform !== "string" ||
    typeof value.arch !== "string" || typeof value.resolved_executable_path !== "string" || typeof value.executable_sha256 !== "string" ||
    typeof value.executable_bytes !== "number" || !Number.isSafeInteger(value.executable_bytes) || typeof value.help_sha256 !== "string" ||
    typeof value.exec_help_sha256 !== "string" || typeof value.capability_snapshot_hash !== "string" || typeof value.adapter_contract_version !== "string" ||
    typeof value.invocation_contract_version !== "string" || typeof value.worker_summary_schema_hash !== "string" ||
    (value.model !== null && typeof value.model !== "string") || typeof value.model_pinned !== "boolean" || typeof value.identity_hash !== "string") {
    throw new Error("MALFORMED");
  }
  const runtime = value as unknown as RuntimeIdentity;
  if (!validateRuntimeIdentity(runtime)) throw new Error("HASH_MISMATCH");
  return runtime;
}

function parsePolicy(value: unknown): ProtectedPolicy {
  if (!isRecord(value) || !hasExactKeys(value, POLICY_KEYS) || value.schema_version !== 1 ||
    typeof value.task_id !== "string" || typeof value.execution_id !== "string" || typeof value.workspace_id !== "string" ||
    typeof value.canonical_workspace_path !== "string" || typeof value.base_revision !== "string" || typeof value.artifact_root !== "string" ||
    typeof value.worktree_root !== "string" || typeof value.state_root !== "string" || typeof value.permission_policy !== "string" ||
    !isRecord(value.requested_capabilities) || !hasBooleanValues(value.requested_capabilities) || !isRecord(value.limits) || !hasFiniteNumberValues(value.limits) || !isRecord(value.output_limits) || !hasFiniteNumberValues(value.output_limits) ||
    typeof value.runtime_identity_hash !== "string" || typeof value.storage_policy_hash !== "string" || typeof value.lease_policy_hash !== "string" ||
    typeof value.policy_hash !== "string" || !isRecord(value.verification_profile) || !hasExactKeys(value.verification_profile, VERIFICATION_KEYS) ||
    typeof value.verification_profile.id !== "string" || typeof value.verification_profile.resolved_program !== "string" || typeof value.verification_profile.program_identity_hash !== "string" ||
    typeof value.verification_profile.program_bytes !== "number" || !Number.isSafeInteger(value.verification_profile.program_bytes) || typeof value.verification_profile.args_hash !== "string" ||
    typeof value.verification_profile.timeout_ms !== "number" || !Number.isSafeInteger(value.verification_profile.timeout_ms) || !Array.isArray(value.verification_profile.env_names) ||
    !value.verification_profile.env_names.every((item) => typeof item === "string") || typeof value.verification_profile.env_hash !== "string") {
    throw new Error("MALFORMED");
  }
  const policy = value as unknown as ProtectedPolicy;
  if (!validateProtectedPolicy(policy)) throw new Error("HASH_MISMATCH");
  return policy;
}

function parseFingerprint(value: unknown): FingerprintV2Artifact {
  if (!isRecord(value) || !hasExactKeys(value, FINGERPRINT_KEYS) || value.schema_version !== "g2m.fingerprint.v2" || value.fingerprint_version !== 2 ||
    typeof value.task_id !== "string" || typeof value.execution_id !== "string" || typeof value.task_hash !== "string" || typeof value.workspace_id !== "string" ||
    typeof value.base_revision !== "string" || typeof value.mcode_version !== "string" || (value.model !== null && typeof value.model !== "string") ||
    typeof value.model_pinned !== "boolean" || typeof value.permission_profile !== "string" || typeof value.max_steps !== "number" ||
    typeof value.timeout_ms !== "number" || !Number.isSafeInteger(value.timeout_ms) || !Number.isSafeInteger(value.max_steps) || typeof value.adapter_contract_version !== "string" || typeof value.runtime_capability_snapshot_hash !== "string" ||
    typeof value.runtime_identity_hash !== "string" || typeof value.protected_policy_hash !== "string" || typeof value.worker_summary_schema_hash !== "string" ||
    typeof value.fingerprint_hash !== "string") {
    throw new Error("MALFORMED");
  }
  const fingerprint = value as unknown as FingerprintV2Artifact;
  if (!validateFingerprintV2Artifact(fingerprint)) throw new Error("HASH_MISMATCH");
  return fingerprint;
}

function readArtifact<T>(path: string, parser: (value: unknown) => T): ParsedArtifact<T> {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { observation: { state: "MISSING", fileSha256: null, declaredHash: null } };
    return { observation: { state: "MALFORMED", fileSha256: null, declaredHash: null } };
  }
  const fileSha256 = sha256Bytes(bytes);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { return { observation: { state: "MALFORMED", fileSha256, declaredHash: null } }; }
  let parsed: T;
  try { parsed = parser(value); }
  catch (error) {
    const code = error instanceof Error ? error.message : "MALFORMED";
    return { observation: { state: code === "HASH_MISMATCH" ? "HASH_MISMATCH" : "MALFORMED", fileSha256, declaredHash: isRecord(value) && typeof value.identity_hash === "string" ? value.identity_hash : isRecord(value) && typeof value.policy_hash === "string" ? value.policy_hash : isRecord(value) && typeof value.fingerprint_hash === "string" ? value.fingerprint_hash : null } };
  }
  const declaredHash = isRecord(value) && typeof value.identity_hash === "string" ? value.identity_hash : isRecord(value) && typeof value.policy_hash === "string" ? value.policy_hash : isRecord(value) && typeof value.fingerprint_hash === "string" ? value.fingerprint_hash : null;
  return { observation: { state: "VALID", fileSha256, declaredHash }, value: parsed };
}

function numberRecord(value: Readonly<Record<string, number>> | undefined): Readonly<Record<string, number>> {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "number" && Number.isFinite(item)));
}

function payloadString(event: TaskEvent | undefined, key: string): string | undefined {
  const value = event?.payload[key];
  return typeof value === "string" ? value : undefined;
}

function latestFingerprint(events: readonly TaskEvent[]): TaskEvent["fingerprint"] | undefined {
  return [...events].reverse().find((event) => event.fingerprint !== undefined)?.fingerprint;
}

function configDrift(config: G2MLocalConfig, runtime: RuntimeIdentity, policy: ProtectedPolicy): string[] {
  const drift: string[] = [];
  const stateRoot = config.state_root ?? resolve(config.artifact_root, "state");
  if (policy.artifact_root !== config.artifact_root) drift.push("artifact_root");
  if (policy.worktree_root !== config.worktree_root) drift.push("worktree_root");
  if (policy.state_root !== stateRoot) drift.push("state_root");
  const workspace = config.workspaces.find((item) => item.workspace_id === policy.workspace_id);
  if (workspace === undefined) drift.push("workspace");
  else if (resolve(workspace.path) !== resolve(policy.canonical_workspace_path)) drift.push("workspace.path");
  if ((config.mcode_model ?? null) !== runtime.model) drift.push("mcode_model");
  if (config.mcode_path !== undefined && resolve(config.mcode_path) !== resolve(runtime.resolved_executable_path)) drift.push("mcode_path");
  if (sha256(config.runtime_hardening) !== sha256(policy.output_limits)) drift.push("runtime_hardening");
  if (sha256(config.storage) !== policy.storage_policy_hash) drift.push("storage_policy");
  if (sha256(config.workspace_lease ?? {}) !== policy.lease_policy_hash) drift.push("lease_policy");
  const profile = config.verification_profiles.find((item) => item.id === policy.verification_profile.id && (item.workspace_id === undefined || item.workspace_id === policy.workspace_id));
  if (profile !== undefined) {
    if (sha256(profile.args) !== policy.verification_profile.args_hash) drift.push("verification_profile.args");
    if (profile.timeout_ms !== policy.verification_profile.timeout_ms) drift.push("verification_profile.timeout");
    if (sha256(profile.env ?? {}) !== policy.verification_profile.env_hash) drift.push("verification_profile.env");
  }
  return drift.sort();
}

export function buildPhase12Observation(options: {
  readonly artifactRoot: string;
  readonly executionId: string;
  readonly config: G2MLocalConfig;
  readonly events: readonly TaskEvent[];
  readonly state: TaskState | null;
  readonly recoveryRequired: boolean;
}): Phase12ExecutionObservation {
  const root = resolve(options.artifactRoot, options.executionId);
  const runtime = readArtifact(join(root, "runtime-identity.json"), parseRuntime);
  const policy = readArtifact(join(root, "protected-policy.json"), parsePolicy);
  const fingerprint = readArtifact(join(root, "fingerprint.json"), parseFingerprint);
  const event = [...options.events].reverse().find((item) => item.type === "agent.spawn.started");
  const eventFingerprint = latestFingerprint(options.events);
  const fingerprintVersion = fingerprint.value !== undefined ? 2 : eventFingerprint?.fingerprintVersion ?? null;
  let bindingEvidence = event !== undefined || (runtime.value !== undefined && policy.value !== undefined && fingerprint.value !== undefined);
  let bindingConflict = false;
  if (runtime.value !== undefined && policy.value !== undefined && runtime.value.identity_hash !== policy.value.runtime_identity_hash) bindingConflict = true;
  if (runtime.value !== undefined && fingerprint.value !== undefined && runtime.value.identity_hash !== fingerprint.value.runtime_identity_hash) bindingConflict = true;
  if (policy.value !== undefined && fingerprint.value !== undefined && policy.value.policy_hash !== fingerprint.value.protected_policy_hash) bindingConflict = true;
  if (fingerprint.value !== undefined && fingerprint.value.execution_id !== options.executionId) bindingConflict = true;
  if (event !== undefined) {
    if (runtime.value === undefined || policy.value === undefined || fingerprint.value === undefined) bindingConflict = true;
    if (payloadString(event, "runtime_identity_hash") !== undefined && payloadString(event, "runtime_identity_hash") !== runtime.value?.identity_hash) bindingConflict = true;
    if (payloadString(event, "protected_policy_hash") !== undefined && payloadString(event, "protected_policy_hash") !== policy.value?.policy_hash) bindingConflict = true;
    if (payloadString(event, "fingerprint_artifact_hash") !== undefined && payloadString(event, "fingerprint_artifact_hash") !== fingerprint.observation.fileSha256) bindingConflict = true;
    if (event.fingerprint !== undefined && payloadString(event, "fingerprint_hash") !== fingerprintHash(event.fingerprint)) bindingConflict = true;
  }
  const model: Phase12ModelObservation = runtime.value !== undefined
    ? { value: runtime.value.model, pinned: runtime.value.model_pinned }
    : fingerprint.value !== undefined
      ? { value: fingerprint.value.model, pinned: fingerprint.value.model_pinned }
      : eventFingerprint !== undefined
        ? { value: eventFingerprint.model, pinned: eventFingerprint.model !== null }
        : { value: null, pinned: false };
  const outputLimits = policy.value === undefined ? numberRecord(options.config.runtime_hardening) : numberRecord(policy.value.output_limits);
  const outputLimitsSource = policy.value === undefined ? (runtime.observation.state === "MISSING" && fingerprint.observation.state === "MISSING" ? "unavailable" : "current-config") : "protected-policy";
  const legacyClassification: LegacyExecutionClassification = fingerprintVersion === 2 ? "NONE" : options.state === "RECOVERY_REQUIRED" ? "RECOVERY_CRITICAL" : options.state !== null && isTerminal(options.state) ? "TERMINAL" : options.state !== null ? "ACTIVE" : options.recoveryRequired ? "RECOVERY_CRITICAL" : "UNKNOWN";
  return {
    fingerprintVersion,
    runtimeIdentityArtifact: runtime.observation,
    protectedPolicyArtifact: policy.observation,
    fingerprintArtifact: fingerprint.observation,
    model,
    effectiveOutputLimits: outputLimits,
    outputLimitsSource,
    configDrift: runtime.value !== undefined && policy.value !== undefined ? configDrift(options.config, runtime.value, policy.value) : [],
    bindings: bindingEvidence ? (bindingConflict ? "CONFLICT" : "CONSISTENT") : "UNAVAILABLE",
    legacyClassification,
  };
}

function pidState(pid: number): "LIVE" | "DEAD" {
  try { process.kill(pid, 0); return "LIVE"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return "DEAD"; return "LIVE"; }
}

export function observeReclaimGuard(stateRoot: string, nowMs: number, staleAfterMs: number): ReclaimGuardObservation {
  const path = join(stateRoot, "repair", "repair.lock.reclaim");
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "MISSING", path, guardId: null, operationId: null, pid: null, hostname: null, heartbeatAgeMs: null, stale: null };
    return { state: "MALFORMED", path, guardId: null, operationId: null, pid: null, hostname: null, heartbeatAgeMs: null, stale: null };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !hasExactKeys(value, ["created_at", "guard_id", "heartbeat_at", "hostname", "operation_id", "pid", "schema_version"]) ||
      value.schema_version !== "g2m.repair-lock-reclaim.v1" || typeof value.guard_id !== "string" || typeof value.operation_id !== "string" ||
      typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.hostname !== "string" ||
      typeof value.created_at !== "number" || !Number.isSafeInteger(value.created_at) || typeof value.heartbeat_at !== "number" || !Number.isSafeInteger(value.heartbeat_at)) throw new Error("malformed");
    const heartbeatAgeMs = Math.max(0, nowMs - value.heartbeat_at);
    const state = value.hostname !== hostname() ? "FOREIGN" : pidState(value.pid);
    return { state, path, guardId: value.guard_id, operationId: value.operation_id, pid: value.pid, hostname: value.hostname, heartbeatAgeMs, stale: heartbeatAgeMs > staleAfterMs };
  } catch {
    return { state: "MALFORMED", path, guardId: null, operationId: null, pid: null, hostname: null, heartbeatAgeMs: null, stale: null };
  }
}
