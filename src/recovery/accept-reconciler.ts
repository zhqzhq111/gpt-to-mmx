/**
 * Phase 6 Accept Reconciler — plan §15-§26.
 *
 * Resumes or reconciles a partial ACCEPT execution whose previous process
 * has been proven gone. Forward dispositions:
 *
 *   1. RESUMED_AND_ACCEPTED    — Journal has `review.accept.prepared` but
 *                                no `patch.apply.started`; target is
 *                                CLEAN_BASE. Append the lifecycle events
 *                                and re-apply the Frozen Patch.
 *   2. RECONCILED_AND_ACCEPTED — two sub-cases (P0#1, P0#2):
 *      a) Journal has `patch.apply.started` but neither `patch.applied`
 *         nor `review.accept.completed`; target is
 *         EXACT_EXPECTED_CHANGE_SET. Apply already succeeded; just
 *         freeze the missing artifacts and complete the journal WITHOUT
 *         touching the target.
 *      b) Journal has `patch.applied`; target is
 *         EXACT_EXPECTED_CHANGE_SET; `apply-evidence.json` and
 *         `outcome.json` exist on disk with hashes matching the
 *         `patch.applied` payload. Verify (do NOT overwrite) and only
 *         append `review.accept.completed`.
 *   3. RECOVERY_REQUIRED       — any evidence gap (mismatch, divergence,
 *                                head movement, missing artifact) forces
 *                                a human decision. ZERO target mutation.
 *                                The verdict is also persisted to the
 *                                Journal as `recovery.required` (P1#1) so
 *                                the safe-hold is durable, not just
 *                                returned to the caller.
 *
 * Plus three early-exit verdicts:
 *
 *   - NOT_PARTIAL_ACCEPT      — execution is not in ACCEPT_PREPARED or
 *                                PATCH_APPLIED. Caller should fall back to
 *                                the generic recovery resolver.
 *   - ALREADY_ACCEPTED        — `review.accept.completed` is already in
 *                                the Journal; recovery is a no-op.
 *   - PROCESS_NOT_PROVEN_GONE — processStatus is `alive` or `unknown`.
 *                                Per plan §19 we MUST NOT mutate the
 *                                target, the Journal, or ReplayGuard.
 *
 * Invariants enforced (plan §4-§7):
 *
 *   - Frozen Patch bytes must SHA-256 match `patch_blob_hash`. Otherwise
 *     RECOVERY_REQUIRED.
 *   - Recovery does NOT re-generate the patch; it consumes the immutable
 *     artifact on disk.
 *   - Recovery does NOT git-reset, git-checkout, git-clean, or roll back
 *     user changes. The only writes are: artifacts, journal events.
 *   - When target == EXACT_EXPECTED_CHANGE_SET we verify the FULL working
 *     tree, not just the patch's declared files (so an unrelated user
 *     edit makes us abort, not silently overwrite).
 *   - When `patch.applied` is already in the Journal, the
 *     `apply-evidence.json` and `outcome.json` artifacts on disk are
 *     treated as IMMUTABLE EVIDENCE — verify their hashes, never
 *     overwrite (P0#2).
 *   - `review.accept.completed` in the Journal is the terminal commit
 *     point. Once it is durable, subsequent failures (ReplayGuard sync,
 *     worktree cleanup) are best-effort maintenance, not a way to undo
 *     ACCEPT.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TaskEvent } from "../events/events.js";
import { EventStore } from "../events/store.js";
import { reduce } from "../events/reducer.js";
import type { TaskState } from "../execution/state-machine.js";
import {
  FingerprintRegistry,
  validateFingerprintV2Artifact,
  type FingerprintV2Artifact,
} from "../execution/fingerprint.js";
import { writeImmutableArtifact } from "../persistence/artifact-writer.js";
import { computeFullWorkingTreeChangeSet } from "../workspace/change-set.js";
import type { ExecutionProjection } from "../projection/execution-projector.js";
import { ReplayGuard, type ReviewSignature } from "../review/replay-guard.js";
import { computeReviewBundleHash } from "../review/bundle.js";
import { validateProtectedPolicy, type ProtectedPolicy } from "../runtime/protected-policy.js";
import { validateRuntimeIdentity, type RuntimeIdentity } from "../runtime/identity.js";
import {
  applyPreflightedPatch,
  type AcceptedPatchPreflight,
  type ApplyAcceptedPatchResult,
} from "../workspace/worktree.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mirrors `ProcessStatus` from `recovery/resolver.ts` to keep this module
 * independent of the generic resolver. Plan §6: only
 * {exited_clean, exited_error, crashed} count as "previous process gone".
 */
export type AcceptProcessStatus =
  | "alive"
  | "unknown"
  | "exited_clean"
  | "exited_error"
  | "crashed";

/** Plan §15. */
export type AcceptTargetState =
  | "CLEAN_BASE"
  | "EXACT_EXPECTED_CHANGE_SET"
  | "DIVERGED"
  | "HEAD_MOVED";

/** Plan §17. */
export type AcceptRecoveryVerdict =
  | "NOT_PARTIAL_ACCEPT"
  | "ALREADY_ACCEPTED"
  | "PROCESS_NOT_PROVEN_GONE"
  | "RESUMED_AND_ACCEPTED"
  | "RECONCILED_AND_ACCEPTED"
  | "RECOVERY_REQUIRED";

/** Plan §16. */
export interface AcceptRecoveryInput {
  readonly executionId: string;
  readonly processStatus: AcceptProcessStatus;
  readonly events: readonly TaskEvent[];
  readonly repositoryPath: string;
  readonly artifactRoot: string;
  readonly temporaryRoot: string;
  readonly eventStore: EventStore;
  readonly projector: ExecutionProjection;
  readonly replayGuard: ReplayGuard;
  readonly fingerprintRegistry: FingerprintRegistry;
  /** Optional current root bindings supplied by callers with full config context. */
  readonly currentWorktreeRoot?: string;
  readonly currentStateRoot?: string;
}

export interface AcceptRecoveryResult {
  readonly verdict: AcceptRecoveryVerdict;
  readonly executionId: string;
  readonly originalState: TaskState;
  readonly finalState: TaskState;
  readonly targetState?: AcceptTargetState;
  readonly reason: string;
  readonly appendedEvents: readonly string[];
  readonly applyEvidenceHash?: string;
  readonly outcomeHash?: string;
}

// ---------------------------------------------------------------------------
// Internal error type — every failure mode is mapped to RECOVERY_REQUIRED
// with a precise reason.
// ---------------------------------------------------------------------------

class RecoverableError extends Error {
  readonly code:
    | "ARTIFACT_MISSING"
    | "ARTIFACT_HASH_MISMATCH"
    | "BINDING_MISMATCH"
    | "TARGET_GIT_FAILED"
    | "REVIEW_BUNDLE_HASH_MISMATCH"
    | "REVIEW_ARTIFACT_MISSING"
    | "REVIEW_ARTIFACT_HASH_MISMATCH"
    | "FROZEN_PATCH_MISSING"
    | "FROZEN_PATCH_HASH_MISMATCH";
  override readonly cause?: unknown;
  constructor(code: RecoverableError["code"], message: string, cause?: unknown) {
    super(message);
    this.name = "RecoverableError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readOptionalFile(path: string): Buffer | undefined {
  return existsSync(path) ? readFileSync(path) : undefined;
}

function readRequiredFile(path: string): Buffer {
  const bytes = readOptionalFile(path);
  if (bytes === undefined) {
    throw new RecoverableError("ARTIFACT_MISSING", `${path} is missing`);
  }
  return bytes;
}

async function gitRev(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", ref], {
    cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, shell: false,
  });
  return stdout.trim();
}

async function gitStatusPorcelain(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, shell: false,
  });
  return stdout;
}

function stringField(event: TaskEvent, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = event.payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function requireString(value: string | undefined, field: string, event: TaskEvent): string {
  if (value === undefined) {
    throw new RecoverableError(
      "BINDING_MISMATCH",
      `${field} missing on ${event.type} event ${event.eventId}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Binding extraction + artifact verification
// ---------------------------------------------------------------------------

interface PreparedBindings {
  readonly taskId: string;
  readonly reviewId: string;
  readonly reviewBundleId: string;
  readonly reviewHash: string;
  readonly reviewArtifactPath: string;
  readonly reviewArtifactHash: string;
  readonly patchBlobHash: string;
  readonly changeSetHash: string;
  readonly baseRevision: string;
}

function extractPreparedBindings(event: TaskEvent): PreparedBindings {
  return {
    taskId: event.taskId,
    reviewId: requireString(stringField(event, "reviewId"), "reviewId", event),
    reviewBundleId: requireString(stringField(event, "reviewBundleId"), "reviewBundleId", event),
    reviewHash: requireString(stringField(event, "reviewHash"), "reviewHash", event),
    reviewArtifactPath: requireString(
      stringField(event, "review_artifact_path", "reviewArtifactPath"),
      "review_artifact_path",
      event,
    ),
    reviewArtifactHash: requireString(
      stringField(event, "review_artifact_hash", "reviewArtifactHash"),
      "review_artifact_hash",
      event,
    ),
    patchBlobHash: requireString(stringField(event, "patch_blob_hash", "patchBlobHash"), "patch_blob_hash", event),
    changeSetHash: requireString(stringField(event, "change_set_hash", "changeSetHash"), "change_set_hash", event),
    baseRevision: requireString(stringField(event, "base_revision", "baseRevision"), "base_revision", event),
  };
}

function verifyArtifact(
  artifactRoot: string,
  executionId: string,
  artifactRelativePath: string,
  expectedHash: string,
): Buffer {
  const path = resolve(artifactRoot, executionId, artifactRelativePath);
  const bytes = readRequiredFile(path);
  const actual = sha256(bytes);
  if (actual !== expectedHash) {
    throw new RecoverableError(
      "ARTIFACT_HASH_MISMATCH",
      `${artifactRelativePath} hash mismatch: expected ${expectedHash} got ${actual}`,
    );
  }
  return bytes;
}

function verifyReviewBundle(
  artifactRoot: string,
  executionId: string,
  expectedBundleHash: string,
): void {
  const path = resolve(artifactRoot, executionId, "review-bundle.json");
  const bytes = readRequiredFile(path);
  const bundle = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const actual = bundle["reviewBundleHash"];
  if (actual !== expectedBundleHash) {
    throw new RecoverableError(
      "REVIEW_BUNDLE_HASH_MISMATCH",
      `review-bundle.json self-hash mismatch: expected ${expectedBundleHash} got ${String(actual)}`,
    );
  }
  const { reviewBundleHash: ignored, ...withoutHash } = bundle;
  void ignored;
  if (computeReviewBundleHash(withoutHash as never) !== actual) {
    throw new RecoverableError(
      "REVIEW_BUNDLE_HASH_MISMATCH",
      `review-bundle.json content does not match its self-hash`,
    );
  }
}

function readChangedFiles(artifactRoot: string, executionId: string): readonly string[] {
  const metadataPath = resolve(artifactRoot, executionId, "frozen-patch.json");
  const bytes = readOptionalFile(metadataPath);
  if (bytes === undefined) return [];
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const value = parsed["change_set"];
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>)["path"] : undefined))
      .filter((path): path is string => typeof path === "string");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Target classification (plan §15)
// ---------------------------------------------------------------------------

async function classifyTarget(
  repositoryPath: string,
  baseRevision: string,
  expectedChangeSetHash: string,
  temporaryRoot: string,
): Promise<{ readonly state: AcceptTargetState; readonly actualChangeSetHash: string }> {
  if (!isAbsolute(repositoryPath)) {
    throw new RecoverableError("TARGET_GIT_FAILED", `repositoryPath must be absolute: ${repositoryPath}`);
  }
  let currentHead: string;
  try {
    currentHead = await gitRev(repositoryPath, "HEAD");
  } catch (error) {
    throw new RecoverableError("TARGET_GIT_FAILED", `cannot read target HEAD: ${(error as Error).message}`, error);
  }
  if (currentHead !== baseRevision) {
    return { state: "HEAD_MOVED", actualChangeSetHash: "" };
  }
  const status = await gitStatusPorcelain(repositoryPath);
  if (status.trim().length === 0) {
    return { state: "CLEAN_BASE", actualChangeSetHash: "" };
  }
  // Use the FULL working-tree change set (git add -A against base) so an
  // unrelated user edit can never masquerade as the expected change set.
  const full = await computeFullWorkingTreeChangeSet(
    repositoryPath, baseRevision, temporaryRoot,
  );
  if (full.hash === expectedChangeSetHash) {
    return { state: "EXACT_EXPECTED_CHANGE_SET", actualChangeSetHash: full.hash };
  }
  return { state: "DIVERGED", actualChangeSetHash: full.hash };
}

// ---------------------------------------------------------------------------
// State replay
// ---------------------------------------------------------------------------

interface ReplayStateResult {
  readonly state: TaskState | null;
  readonly error?: unknown;
}

function replayState(
  events: readonly TaskEvent[],
  fingerprintRegistry: FingerprintRegistry,
): ReplayStateResult {
  let state: TaskState | null = null;
  for (const event of events) {
    try {
      state = reduce(state, event, { fingerprintRegistry });
    } catch (error) {
      return { state, error };
    }
  }
  return { state };
}

// ---------------------------------------------------------------------------
// Journal append + reduce + project (mirrors engine contract). CRITICAL
// events are durable on disk BEFORE the projector runs; if projection
// throws, we append `projection.stale` so the durable fact survives.
// ---------------------------------------------------------------------------

interface MutableState {
  state: TaskState;
}

function appendReduceProject(
  eventStore: EventStore,
  projector: ExecutionProjection,
  artifactRoot: string,
  fingerprintRegistry: FingerprintRegistry,
  mutable: MutableState,
  input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly type: Parameters<EventStore["append"]>[0]["type"];
    readonly payload: Record<string, unknown>;
  },
): TaskState {
  const event = eventStore.append({
    taskId: input.taskId,
    attemptId: input.executionId,
    type: input.type,
    payload: input.payload,
  });
  const next = reduce(mutable.state, event, { fingerprintRegistry });
  mutable.state = next;
  if (event.durability === "CRITICAL") {
    try {
      // P1#2: the projection `artifact_path` is the absolute directory the
      // engine / recovery wrote artifacts into — `<artifactRoot>/<executionId>`
      // — NOT a relative attemptId. Passing only `attemptId` made the
      // projection column point at a non-existent relative path.
      projector.project(event, next, {
        artifactPath: resolve(artifactRoot, input.executionId),
      });
    } catch (error) {
      eventStore.append({
        taskId: input.taskId,
        attemptId: input.executionId,
        type: "projection.stale",
        payload: {
          failed_event_id: event.eventId,
          failed_event_hash: event.hash,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Apply-artifact freeze + verify helpers.
// ---------------------------------------------------------------------------

/**
 * Freeze both `apply-evidence.json` and `outcome.json` as immutable
 * artifacts. Used by RESUMED and Case A' (mid-apply crash) where the
 * Journal never reached `patch.applied`. Idempotent: if a file with the
 * same name already exists with the same hash, we return the existing
 * hash instead of writing. If the existing file has different content,
 * we throw — recovery must NOT silently overwrite immutable evidence
 * with different bytes.
 */
async function freezeApplyArtifacts(
  artifactRoot: string,
  executionId: string,
  evidencePayload: Record<string, unknown>,
  outcomePayload: Record<string, unknown>,
): Promise<{ readonly evidenceArtifact: { readonly path: string; readonly sha256: string; readonly bytes: number }; readonly outcomeArtifact: { readonly path: string; readonly sha256: string; readonly bytes: number } }> {
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidencePayload, null, 2)}\n`, "utf8");
  const outcomeBytes = Buffer.from(`${JSON.stringify(outcomePayload, null, 2)}\n`, "utf8");
  const evidencePath = resolve(artifactRoot, executionId, "apply-evidence.json");
  const outcomePath = resolve(artifactRoot, executionId, "outcome.json");
  const evidenceArtifact = await freezeOrVerify(evidencePath, evidenceBytes, "apply-evidence.json");
  const outcomeArtifact = await freezeOrVerify(outcomePath, outcomeBytes, "outcome.json");
  return { evidenceArtifact, outcomeArtifact };
}

async function freezeOrVerify(
  path: string,
  bytes: Buffer,
  label: string,
): Promise<{ readonly path: string; readonly sha256: string; readonly bytes: number }> {
  const existing = readOptionalFile(path);
  if (existing !== undefined) {
    const existingHash = sha256(existing);
    const expectedHash = sha256(bytes);
    if (existingHash !== expectedHash) {
      throw new RecoverableError(
        "ARTIFACT_HASH_MISMATCH",
        `${label} exists but its hash ${existingHash} does not match the expected ${expectedHash}`,
      );
    }
    return { path, sha256: existingHash, bytes: existing.length };
  }
  return writeImmutableArtifact(path, bytes);
}

type VerifyApplyArtifactsResult =
  | { readonly kind: "ok"; readonly evidenceHash: string; readonly outcomeHash: string }
  | { readonly kind: "missing"; readonly detail: string }
  | { readonly kind: "mismatch"; readonly detail: string };

/**
 * Phase 6.2 — Orphan pre-commit artifact recovery.
 *
 * The normal ACCEPT path writes artifacts in this order:
 *
 *   git apply
 *   ↓
 *   apply-evidence.json
 *   ↓
 *   outcome.json
 *   ↓
 *   patch.applied
 *   ↓
 *   review.accept.completed
 *
 * A crash after `apply-evidence.json` but before `patch.applied` (or
 * after `outcome.json` but before `patch.applied`) leaves the Journal
 * in `ACCEPT_PREPARED + apply.started` while one or both pre-commit
 * artifacts are already on disk. We must NOT overwrite them with
 * Recovery's own `recovery_mode: true / applied_at: 0` bytes — that
 * would lose the original `applied_at` timestamp and corrupt the
 * `recovery_mode` audit field.
 *
 * The helper below classifies the on-disk state into one of five
 * outcomes:
 *
 *   - both_missing         → Recovery creates both (legacy Case A')
 *   - both_present         → Preserve BOTH bytes; reuse their hashes
 *                             in the journal event bindings
 *   - evidence_only        → Preserve the evidence; Recovery creates
 *                             outcome with recovery_mode=true (writes
 *                             only the missing one)
 *   - order_violation      → outcome.json exists without evidence
 *                             (impossible under the normal path) →
 *                             RECOVERY_REQUIRED
 *   - semantic_mismatch    → Existing artifact's binding does not
 *                             match the prepared event / current
 *                             target full change set → RECOVERY_REQUIRED
 *
 * `recovery_mode` and `applied_at` are intentionally NOT compared —
 * they are audit fields that legitimately differ between the normal
 * path and Recovery.
 */
type OrphanApplyArtifactsResult =
  | { readonly kind: "both_missing" }
  | {
      readonly kind: "both_present";
      readonly evidenceHash: string;
      readonly evidenceBytes: number;
      readonly outcomeHash: string;
      readonly outcomeBytes: number;
    }
  | {
      readonly kind: "evidence_only";
      readonly evidenceHash: string;
      readonly evidenceBytes: number;
    }
  | { readonly kind: "order_violation"; readonly detail: string }
  | { readonly kind: "semantic_mismatch"; readonly detail: string };

function readJsonArtifact(path: string): Record<string, unknown> | undefined {
  const bytes = readOptionalFile(path);
  if (bytes === undefined) return undefined;
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function comparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = comparablePath(left).replaceAll("\\", "/");
  const normalizedRight = comparablePath(right).replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function legacyFingerprintArtifact(value: Record<string, unknown>): boolean {
  const required = [
    ["task_hash", "taskHash"],
    ["workspace_id", "workspaceId"],
    ["base_revision", "baseRevision"],
    ["mcode_version", "mcodeVersion"],
    ["model"],
    ["permission_profile", "permissionProfile"],
    ["max_steps", "maxSteps"],
    ["timeout_ms", "timeoutMs"],
    ["adapter_contract_version", "adapterContractVersion"],
    ["runtime_capability_snapshot_hash", "runtimeCapabilitySnapshotHash"],
  ] as const;
  return required.every((aliases) => aliases.some((key) => {
    const field = value[key];
    return typeof field === "string" || typeof field === "number" || field === null;
  }));
}

/**
 * Validate only historical Phase 12 identity evidence that is present on
 * disk. Missing identity artifacts are the normal legacy shape and must not
 * be synthesized during patch-only recovery.
 */
function verifyHistoricalExecutionEvidence(input: AcceptRecoveryInput): void {
  const executionRoot = resolve(input.artifactRoot, input.executionId);
  const runtimePath = resolve(executionRoot, "runtime-identity.json");
  const policyPath = resolve(executionRoot, "protected-policy.json");
  const fingerprintPath = resolve(executionRoot, "fingerprint.json");
  const hasRuntime = existsSync(runtimePath);
  const hasPolicy = existsSync(policyPath);
  const hasFingerprint = existsSync(fingerprintPath);
  if (!hasRuntime && !hasPolicy && !hasFingerprint) return;

  if (hasRuntime !== hasPolicy) {
    throw new RecoverableError(
      "BINDING_MISMATCH",
      "Phase 12 identity evidence is incomplete: runtime-identity.json and protected-policy.json must appear together",
    );
  }

  const fingerprintValue = hasFingerprint ? readJsonArtifact(fingerprintPath) : undefined;
  if (hasFingerprint && fingerprintValue === undefined) {
    throw new RecoverableError("BINDING_MISMATCH", "fingerprint.json is not valid JSON");
  }

  if (!hasRuntime && !hasPolicy) {
    if (fingerprintValue !== undefined && fingerprintValue["fingerprint_version"] === 2) {
      throw new RecoverableError(
        "BINDING_MISMATCH",
        "fingerprint.json is Phase 12 v2 evidence but runtime and protected-policy artifacts are missing",
      );
    }
    if (fingerprintValue !== undefined && !legacyFingerprintArtifact(fingerprintValue)) {
      throw new RecoverableError("BINDING_MISMATCH", "fingerprint.json is not a readable legacy v1 fingerprint");
    }
    return;
  }

  if (fingerprintValue === undefined || fingerprintValue["fingerprint_version"] !== 2) {
    throw new RecoverableError(
      "BINDING_MISMATCH",
      "Phase 12 runtime and policy evidence requires a v2 fingerprint artifact",
    );
  }
  const runtimeValue = readJsonArtifact(runtimePath);
  const policyValue = readJsonArtifact(policyPath);
  if (runtimeValue === undefined || policyValue === undefined) {
    throw new RecoverableError("BINDING_MISMATCH", "Phase 12 identity evidence contains invalid JSON");
  }
  const runtime = runtimeValue as unknown as RuntimeIdentity;
  const policy = policyValue as unknown as ProtectedPolicy;
  const fingerprint = fingerprintValue as unknown as FingerprintV2Artifact;
  if (!validateRuntimeIdentity(runtime)) {
    throw new RecoverableError("BINDING_MISMATCH", "runtime-identity.json self-hash is invalid");
  }
  if (
    runtime.schema_version !== 1 ||
    runtime.runtime !== "mcode" ||
    typeof runtime.runtime_version !== "string" ||
    typeof runtime.identity_hash !== "string" ||
    typeof runtime.capability_snapshot_hash !== "string" ||
    typeof runtime.adapter_contract_version !== "string" ||
    typeof runtime.worker_summary_schema_hash !== "string" ||
    (runtime.model !== null && typeof runtime.model !== "string")
  ) {
    throw new RecoverableError("BINDING_MISMATCH", "runtime-identity.json has an invalid schema");
  }
  if (!validateProtectedPolicy(policy)) {
    throw new RecoverableError("BINDING_MISMATCH", "protected-policy.json self-hash is invalid");
  }
  if (
    policy.schema_version !== 1 ||
    typeof policy.task_id !== "string" ||
    typeof policy.execution_id !== "string" ||
    typeof policy.workspace_id !== "string" ||
    typeof policy.canonical_workspace_path !== "string" ||
    typeof policy.base_revision !== "string" ||
    typeof policy.artifact_root !== "string" ||
    typeof policy.worktree_root !== "string" ||
    typeof policy.state_root !== "string" ||
    typeof policy.runtime_identity_hash !== "string" ||
    policy.limits === null ||
    typeof policy.limits !== "object" ||
    Array.isArray(policy.limits) ||
    typeof policy.limits["max_steps"] !== "number" ||
    typeof policy.limits["timeout_ms"] !== "number"
  ) {
    throw new RecoverableError("BINDING_MISMATCH", "protected-policy.json has an invalid schema");
  }
  if (!validateFingerprintV2Artifact(fingerprint)) {
    throw new RecoverableError("BINDING_MISMATCH", "fingerprint.json self-hash is invalid");
  }
  if (
    fingerprint.schema_version !== "g2m.fingerprint.v2" ||
    fingerprint.fingerprint_version !== 2 ||
    typeof fingerprint.task_id !== "string" ||
    typeof fingerprint.execution_id !== "string" ||
    typeof fingerprint.task_hash !== "string" ||
    typeof fingerprint.workspace_id !== "string" ||
    typeof fingerprint.base_revision !== "string" ||
    typeof fingerprint.mcode_version !== "string" ||
    typeof fingerprint.permission_profile !== "string" ||
    typeof fingerprint.adapter_contract_version !== "string" ||
    typeof fingerprint.runtime_identity_hash !== "string" ||
    typeof fingerprint.protected_policy_hash !== "string" ||
    typeof fingerprint.worker_summary_schema_hash !== "string" ||
    typeof fingerprint.max_steps !== "number" ||
    typeof fingerprint.timeout_ms !== "number"
  ) {
    throw new RecoverableError("BINDING_MISMATCH", "fingerprint.json has an invalid schema");
  }
  if (policy.execution_id !== input.executionId || fingerprint.execution_id !== input.executionId) {
    throw new RecoverableError("BINDING_MISMATCH", "historical identity evidence is bound to another execution");
  }
  if (policy.runtime_identity_hash !== runtime.identity_hash || fingerprint.runtime_identity_hash !== runtime.identity_hash) {
    throw new RecoverableError("BINDING_MISMATCH", "runtime identity hashes do not agree across historical artifacts");
  }
  if (fingerprint.protected_policy_hash !== policy.policy_hash) {
    throw new RecoverableError("BINDING_MISMATCH", "fingerprint is not bound to protected-policy.json");
  }
  if (
    fingerprint.task_id !== policy.task_id ||
    fingerprint.workspace_id !== policy.workspace_id ||
    fingerprint.base_revision !== policy.base_revision ||
    fingerprint.mcode_version !== runtime.runtime_version ||
    fingerprint.model !== runtime.model ||
    fingerprint.adapter_contract_version !== runtime.adapter_contract_version ||
    fingerprint.runtime_capability_snapshot_hash !== runtime.capability_snapshot_hash ||
    fingerprint.worker_summary_schema_hash !== runtime.worker_summary_schema_hash ||
    fingerprint.permission_profile !== policy.permission_policy ||
    fingerprint.max_steps !== policy.limits["max_steps"] ||
    fingerprint.timeout_ms !== policy.limits["timeout_ms"]
  ) {
    throw new RecoverableError("BINDING_MISMATCH", "fingerprint fields contradict runtime or protected-policy evidence");
  }

  const taskEvent = input.events.find((event) => event.type === "task.created");
  const task = taskEvent?.payload["task"];
  const workspaceId = task && typeof task === "object"
    ? (task as { workspace_scope?: { workspace_id?: unknown } }).workspace_scope?.workspace_id
    : undefined;
  if (taskEvent !== undefined && policy.task_id !== taskEvent.taskId) {
    throw new RecoverableError("BINDING_MISMATCH", "protected policy task binding does not match the Journal");
  }
  if (typeof workspaceId === "string" && policy.workspace_id !== workspaceId) {
    throw new RecoverableError("BINDING_MISMATCH", "protected policy workspace binding does not match the Journal");
  }
  const prepared = input.events.find((event) => event.type === "review.accept.prepared");
  const historicalBase = prepared === undefined
    ? undefined
    : stringField(prepared, "base_revision", "baseRevision");
  if (historicalBase !== undefined && policy.base_revision !== historicalBase) {
    throw new RecoverableError("BINDING_MISMATCH", "protected policy base revision does not match the Journal");
  }
  if (!samePath(policy.canonical_workspace_path, input.repositoryPath)) {
    throw new RecoverableError("BINDING_MISMATCH", "current repository path differs from protected workspace binding");
  }
  if (!samePath(policy.artifact_root, input.artifactRoot)) {
    throw new RecoverableError("BINDING_MISMATCH", "current artifact root differs from protected artifact binding");
  }
  if (input.currentWorktreeRoot !== undefined && !samePath(policy.worktree_root, input.currentWorktreeRoot)) {
    throw new RecoverableError("BINDING_MISMATCH", "current worktree root differs from protected worktree binding");
  }
  if (input.currentStateRoot !== undefined && !samePath(policy.state_root, input.currentStateRoot)) {
    throw new RecoverableError("BINDING_MISMATCH", "current state root differs from protected state binding");
  }
}

function verifyApplyEvidenceSemantic(
  artifact: Record<string, unknown>,
  executionId: string,
  bindings: PreparedBindings,
  repositoryPath: string,
  targetFullChangeSetHash: string,
): { readonly ok: true; readonly bytes: number; readonly hash: string } | { readonly ok: false; readonly detail: string } {
  const path = resolve(repositoryPath, "<memory>"); // not used; path is implicit in bytes
  void path;
  if (artifact["schema_version"] !== 1) {
    return { ok: false, detail: "apply-evidence.json schema_version is not 1" };
  }
  if (artifact["execution_id"] !== executionId) {
    return { ok: false, detail: `apply-evidence.json execution_id ${String(artifact["execution_id"])} != ${executionId}` };
  }
  if (artifact["patch_blob_hash"] !== bindings.patchBlobHash) {
    return { ok: false, detail: `apply-evidence.json patch_blob_hash ${String(artifact["patch_blob_hash"])} != ${bindings.patchBlobHash}` };
  }
  if (artifact["expected_change_set_hash"] !== bindings.changeSetHash) {
    return { ok: false, detail: "apply-evidence.json expected_change_set_hash does not match review.accept.prepared" };
  }
  if (artifact["actual_change_set_hash"] !== bindings.changeSetHash) {
    return { ok: false, detail: "apply-evidence.json actual_change_set_hash does not match the prepared change set" };
  }
  if (artifact["actual_change_set_hash"] !== targetFullChangeSetHash) {
    return { ok: false, detail: "apply-evidence.json actual_change_set_hash does not match the current target full change set" };
  }
  if (artifact["base_revision"] !== bindings.baseRevision) {
    return { ok: false, detail: `apply-evidence.json base_revision ${String(artifact["base_revision"])} != ${bindings.baseRevision}` };
  }
  return { ok: true, bytes: 0, hash: "" };
}

function verifyOutcomeSemantic(
  artifact: Record<string, unknown>,
  executionId: string,
  bindings: PreparedBindings,
): { readonly ok: true; readonly bytes: number; readonly hash: string } | { readonly ok: false; readonly detail: string } {
  if (artifact["schema_version"] !== 1) {
    return { ok: false, detail: "outcome.json schema_version is not 1" };
  }
  if (artifact["task_id"] !== bindings.taskId) {
    return { ok: false, detail: `outcome.json task_id ${String(artifact["task_id"])} != ${bindings.taskId}` };
  }
  if (artifact["execution_id"] !== executionId) {
    return { ok: false, detail: `outcome.json execution_id ${String(artifact["execution_id"])} != ${executionId}` };
  }
  if (artifact["decision"] !== "ACCEPT") {
    return { ok: false, detail: `outcome.json decision ${String(artifact["decision"])} != ACCEPT` };
  }
  if (artifact["state"] !== "ACCEPTED") {
    return { ok: false, detail: `outcome.json state ${String(artifact["state"])} != ACCEPTED` };
  }
  if (artifact["patch_blob_hash"] !== bindings.patchBlobHash) {
    return { ok: false, detail: `outcome.json patch_blob_hash ${String(artifact["patch_blob_hash"])} != ${bindings.patchBlobHash}` };
  }
  if (artifact["change_set_hash"] !== bindings.changeSetHash) {
    return { ok: false, detail: "outcome.json change_set_hash does not match review.accept.prepared" };
  }
  if (artifact["review_id"] !== bindings.reviewId) {
    return { ok: false, detail: `outcome.json review_id ${String(artifact["review_id"])} != ${bindings.reviewId}` };
  }
  if (artifact["review_bundle_id"] !== bindings.reviewBundleId) {
    return { ok: false, detail: `outcome.json review_bundle_id ${String(artifact["review_bundle_id"])} != ${bindings.reviewBundleId}` };
  }
  return { ok: true, bytes: 0, hash: "" };
}

function classifyOrphanApplyArtifacts(
  artifactRoot: string,
  executionId: string,
  bindings: PreparedBindings,
  repositoryPath: string,
  targetFullChangeSetHash: string,
): OrphanApplyArtifactsResult {
  const evidencePath = resolve(artifactRoot, executionId, "apply-evidence.json");
  const outcomePath = resolve(artifactRoot, executionId, "outcome.json");
  const evidenceBytes = readOptionalFile(evidencePath);
  const outcomeBytes = readOptionalFile(outcomePath);
  if (evidenceBytes === undefined && outcomeBytes === undefined) {
    return { kind: "both_missing" };
  }
  if (evidenceBytes === undefined && outcomeBytes !== undefined) {
    return {
      kind: "order_violation",
      detail: "outcome.json exists without apply-evidence.json (impossible under the normal path)",
    };
  }
  if (evidenceBytes !== undefined && outcomeBytes === undefined) {
    const evidenceArtifact = readJsonArtifact(evidencePath);
    if (evidenceArtifact === undefined) {
      return { kind: "semantic_mismatch", detail: "apply-evidence.json is not valid JSON" };
    }
    const evidenceCheck = verifyApplyEvidenceSemantic(evidenceArtifact, executionId, bindings, repositoryPath, targetFullChangeSetHash);
    if (!evidenceCheck.ok) {
      return { kind: "semantic_mismatch", detail: evidenceCheck.detail };
    }
    return {
      kind: "evidence_only",
      evidenceHash: sha256(evidenceBytes),
      evidenceBytes: evidenceBytes.length,
    };
  }
  // both present
  const evidenceArtifact = readJsonArtifact(evidencePath);
  const outcomeArtifact = readJsonArtifact(outcomePath);
  if (evidenceArtifact === undefined) {
    return { kind: "semantic_mismatch", detail: "apply-evidence.json is not valid JSON" };
  }
  if (outcomeArtifact === undefined) {
    return { kind: "semantic_mismatch", detail: "outcome.json is not valid JSON" };
  }
  const evidenceCheck = verifyApplyEvidenceSemantic(evidenceArtifact, executionId, bindings, repositoryPath, targetFullChangeSetHash);
  if (!evidenceCheck.ok) {
    return { kind: "semantic_mismatch", detail: evidenceCheck.detail };
  }
  const outcomeCheck = verifyOutcomeSemantic(outcomeArtifact, executionId, bindings);
  if (!outcomeCheck.ok) {
    return { kind: "semantic_mismatch", detail: outcomeCheck.detail };
  }
  if (evidenceBytes === undefined || outcomeBytes === undefined) {
    // Defensive: the `readOptionalFile` calls above already proved these are defined.
    return { kind: "semantic_mismatch", detail: "internal: artifact bytes disappeared" };
  }
  return {
    kind: "both_present",
    evidenceHash: sha256(evidenceBytes),
    evidenceBytes: evidenceBytes.length,
    outcomeHash: sha256(outcomeBytes),
    outcomeBytes: outcomeBytes.length,
  };
}

/**
 * P0#2: the artifacts on disk are the immutable evidence. Read them,
 * hash them, and require their hashes to match the `patch.applied`
 * payload. We never overwrite.
 */
function verifyExistingApplyArtifacts(
  artifactRoot: string,
  executionId: string,
  patchAppliedEvent: TaskEvent,
): VerifyApplyArtifactsResult {
  const expectedEvidence = stringField(patchAppliedEvent, "apply_evidence_hash", "applyEvidenceHash");
  const expectedOutcome = stringField(patchAppliedEvent, "outcome_hash", "outcomeHash");
  if (expectedEvidence === undefined || expectedOutcome === undefined) {
    return { kind: "mismatch", detail: "patch.applied event has no apply_evidence_hash / outcome_hash" };
  }
  const evidencePath = resolve(artifactRoot, executionId, "apply-evidence.json");
  const evidenceBytes = readOptionalFile(evidencePath);
  if (evidenceBytes === undefined) {
    return { kind: "missing", detail: "apply-evidence.json is missing" };
  }
  const evidenceHash = sha256(evidenceBytes);
  if (evidenceHash !== expectedEvidence) {
    return { kind: "mismatch", detail: `apply-evidence.json hash ${evidenceHash} != expected ${expectedEvidence}` };
  }
  const outcomePath = resolve(artifactRoot, executionId, "outcome.json");
  const outcomeBytes = readOptionalFile(outcomePath);
  if (outcomeBytes === undefined) {
    return { kind: "missing", detail: "outcome.json is missing" };
  }
  const outcomeHash = sha256(outcomeBytes);
  if (outcomeHash !== expectedOutcome) {
    return { kind: "mismatch", detail: `outcome.json hash ${outcomeHash} != expected ${expectedOutcome}` };
  }
  return { kind: "ok", evidenceHash, outcomeHash };
}

/**
 * Phase 6.1: unified failure path for the Accept Reconciler. Every
 * proven-gone + unrecoverable branch (missing prepared event, missing
 * review_bundle_hash, frozen.patch / review.json / review-bundle hash
 * mismatch, classifyTarget failure, HEAD_MOVED, DIVERGED, artifact
 * mismatch, apply failure, …) routes through this helper. The
 * `recovery.required` event is durable on disk BEFORE the projector
 * runs; if projection throws, `projection.stale` is appended so the
 * durable fact survives (mirrors `appendReduceProject`).
 *
 * `processStatus ∈ {alive, unknown}` branches MUST NOT call this helper
 * — they return without mutating Journal, ReplayGuard, or the
 * projection. See the early-exit block at the top of `runAcceptRecovery`.
 */
async function failAcceptRecovery(
  input: AcceptRecoveryInput,
  base: AcceptRecoveryResult,
  mutable: MutableState,
  detail: { readonly targetState?: AcceptTargetState; readonly reason: string },
): Promise<AcceptRecoveryResult> {
  const taskIdEvent = input.events.find((event) => event.type === "task.created");
  const taskId = taskIdEvent?.taskId ?? "unknown";
  const recoveryEvent = input.eventStore.append({
    taskId,
    attemptId: input.executionId,
    type: "recovery.required",
    payload: {
      reason: detail.reason,
      partial_accept: true,
      ...(detail.targetState !== undefined ? { target_state: detail.targetState } : {}),
    },
  });
  const next = reduce(mutable.state, recoveryEvent, { fingerprintRegistry: input.fingerprintRegistry });
  mutable.state = next;
  try {
    input.projector.project(recoveryEvent, next, {
      artifactPath: resolve(input.artifactRoot, input.executionId),
    });
  } catch (error) {
    // Phase 6.1: same rule as `appendReduceProject` — a CRITICAL
    // barrier that survives projection failure MUST leave a
    // `projection.stale` marker, not silently swallow.
    input.eventStore.append({
      taskId,
      attemptId: input.executionId,
      type: "projection.stale",
      payload: {
        failed_event_id: recoveryEvent.eventId,
        failed_event_hash: recoveryEvent.hash,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
  return {
    ...base,
    verdict: "RECOVERY_REQUIRED",
    ...(detail.targetState !== undefined ? { targetState: detail.targetState } : {}),
    finalState: mutable.state ?? base.finalState,
    reason: detail.reason,
    appendedEvents: [recoveryEvent.type],
  };
}

function buildApplyEvidence(
  executionId: string,
  baseRevision: string,
  applied: ApplyAcceptedPatchResult,
  recoveryMode: boolean,
): Record<string, unknown> {
  return {
    schema_version: 1,
    execution_id: executionId,
    patch_blob_hash: applied.patchBlobHash,
    expected_change_set_hash: applied.expectedChangeSetHash,
    actual_change_set_hash: applied.actualChangeSetHash,
    base_revision: baseRevision,
    target_path: applied.targetPath,
    status: applied.status,
    recovery_mode: recoveryMode,
    applied_at: applied.appliedAt,
  };
}

function buildOutcome(
  executionId: string,
  bindings: PreparedBindings,
  applied: ApplyAcceptedPatchResult,
): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: bindings.taskId,
    execution_id: executionId,
    decision: "ACCEPT",
    state: "ACCEPTED",
    patch_status: applied.status,
    patch_blob_hash: applied.patchBlobHash,
    change_set_hash: bindings.changeSetHash,
    review_id: bindings.reviewId,
    review_bundle_id: bindings.reviewBundleId,
  };
}

function buildReconcilePreflight(
  bindings: PreparedBindings,
  repositoryPath: string,
  patchBytes: Buffer,
  patchPath: string,
  temporaryRoot: string,
  changedFiles: readonly string[],
): AcceptedPatchPreflight {
  return {
    repositoryPath,
    baseRevision: bindings.baseRevision,
    patchPath,
    patchBytes,
    expectedChangeSetHash: bindings.changeSetHash,
    changedFiles,
    patchBlobHash: sha256(patchBytes),
    targetPath: repositoryPath,
    temporaryRoot,
  };
}

function synthesizeAppliedFromTarget(
  bindings: PreparedBindings,
  repositoryPath: string,
  actualChangeSetHash: string,
): ApplyAcceptedPatchResult {
  return {
    status: "applied",
    targetPath: repositoryPath,
    patchHash: bindings.patchBlobHash,
    patchBlobHash: bindings.patchBlobHash,
    expectedChangeSetHash: bindings.changeSetHash,
    actualChangeSetHash,
    changedFiles: [],
    appliedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isPartialAccept(state: TaskState | null): boolean {
  return state === "ACCEPT_PREPARED" || state === "PATCH_APPLIED";
}

function isProcessGone(status: AcceptProcessStatus): boolean {
  return status === "exited_clean" || status === "exited_error" || status === "crashed";
}

/**
 * Run the Accept Reconciler for one partial-ACCEPT execution. Safe to call
 * multiple times for the same execution (idempotent — already-accepted
 * executions short-circuit to ALREADY_ACCEPTED).
 */
export async function runAcceptRecovery(
  input: AcceptRecoveryInput,
): Promise<AcceptRecoveryResult> {
  const replayResult = replayState(input.events, input.fingerprintRegistry);
  const replayed = replayResult.state;
  const originalState: TaskState = replayed ?? "RECOVERY_REQUIRED";
  const appended: string[] = [];
  const base: AcceptRecoveryResult = {
    verdict: "RECOVERY_REQUIRED",
    executionId: input.executionId,
    originalState,
    finalState: originalState,
    reason: "no disposition",
    appendedEvents: appended,
  };

  // --- Idempotency / process / state early-exits (ZERO MUTATION) ---
  // These three branches must NOT call `failAcceptRecovery` — they are
  // either no-ops (ALREADY_ACCEPTED) or refusal paths (the previous
  // process is not proven gone, or the execution is not in a partial
  // ACCEPT state). Mutating the Journal / projection / ReplayGuard in
  // any of these cases would violate plan §19.
  if (input.events.some((event) => event.type === "review.accept.completed")) {
    return {
      ...base,
      verdict: "ALREADY_ACCEPTED",
      finalState: "ACCEPTED",
      reason: "review.accept.completed already present in journal",
    };
  }
  if (!isProcessGone(input.processStatus)) {
    return {
      ...base,
      verdict: "PROCESS_NOT_PROVEN_GONE",
      reason: `processStatus=${input.processStatus}; recovery refused without proof previous process is gone`,
    };
  }
  if (replayResult.error !== undefined) {
    const replayReason = replayResult.error instanceof Error
      ? replayResult.error.message
      : String(replayResult.error);
    if (replayed === null || !isPartialAccept(replayed)) {
      return {
        ...base,
        verdict: "NOT_PARTIAL_ACCEPT",
        reason: `journal replay is contradictory: ${replayReason}`,
      };
    }
    return await failAcceptRecovery(input, base, { state: replayed }, {
      reason: `journal replay is contradictory: ${replayReason}`,
    });
  }
  if (!isPartialAccept(replayed)) {
    return {
      ...base,
      verdict: "NOT_PARTIAL_ACCEPT",
      reason: `execution state is ${replayed ?? "null"}; not a partial ACCEPT`,
    };
  }

  // From this point on, the previous process IS proven gone, so every
  // unrecoverable branch MUST persist `recovery.required` to the
  // Journal (P1#1). They all go through `failAcceptRecovery`.
  const mutable: MutableState = { state: originalState };

  try {
    verifyHistoricalExecutionEvidence(input);
  } catch (error) {
    if (error instanceof RecoverableError) {
      return await failAcceptRecovery(input, base, mutable, {
        reason: error.message,
      });
    }
    throw error;
  }

  const preparedEvent = input.events.find((event) => event.type === "review.accept.prepared");
  if (preparedEvent === undefined) {
    return await failAcceptRecovery(input, base, mutable, {
      reason: "no review.accept.prepared event in journal",
    });
  }
  let bindings: PreparedBindings;
  try {
    bindings = extractPreparedBindings(preparedEvent);
  } catch (error) {
    if (error instanceof RecoverableError) {
      return await failAcceptRecovery(input, base, mutable, {
        reason: `review.accept.prepared binding: ${error.message}`,
      });
    }
    throw error;
  }

  // The review-bundle self-hash is carried on the `review.requested` event
  // (not the prepared event), so the reconciler reads it directly from the
  // journal to verify `review-bundle.json`.
  const reviewRequestedEvent = input.events.find((event) => event.type === "review.requested");
  const reviewBundleHash = reviewRequestedEvent === undefined
    ? undefined
    : stringField(reviewRequestedEvent, "review_bundle_hash", "reviewBundleHash");
  if (reviewBundleHash === undefined) {
    return await failAcceptRecovery(input, base, mutable, {
      reason: "review.requested event has no review_bundle_hash",
    });
  }

  // --- Artifact verification (plan §26) ---
  let patchBytes: Buffer;
  let patchPath: string;
  let changedFiles: readonly string[];
  try {
    verifyReviewBundle(input.artifactRoot, input.executionId, reviewBundleHash);
    verifyArtifact(
      input.artifactRoot,
      input.executionId,
      bindings.reviewArtifactPath,
      bindings.reviewArtifactHash,
    );
    patchPath = resolve(input.artifactRoot, input.executionId, "frozen.patch");
    patchBytes = verifyArtifact(
      input.artifactRoot,
      input.executionId,
      "frozen.patch",
      bindings.patchBlobHash,
    );
    changedFiles = readChangedFiles(input.artifactRoot, input.executionId);
  } catch (error) {
    if (error instanceof RecoverableError) {
      return await failAcceptRecovery(input, base, mutable, {
        reason: error.message,
      });
    }
    throw error;
  }

  // --- Target classification (plan §15) ---
  let target: { readonly state: AcceptTargetState; readonly actualChangeSetHash: string };
  try {
    target = await classifyTarget(
      input.repositoryPath,
      bindings.baseRevision,
      bindings.changeSetHash,
      input.temporaryRoot,
    );
  } catch (error) {
    if (error instanceof RecoverableError) {
      return await failAcceptRecovery(input, base, mutable, {
        reason: `target classification: ${error.message}`,
      });
    }
    throw error;
  }

  if (target.state === "HEAD_MOVED") {
    return await failAcceptRecovery(input, base, { state: originalState }, {
      targetState: "HEAD_MOVED",
      reason: `target HEAD is not at frozen base ${bindings.baseRevision}`,
    });
  }

  const signature: ReviewSignature = {
    reviewId: bindings.reviewId,
    reviewBundleId: bindings.reviewBundleId,
    reviewHash: bindings.reviewHash,
    decision: "ACCEPT",
  };
  const applyStarted = input.events.some((event) => event.type === "patch.apply.started");
  const patchApplied = input.events.find((event) => event.type === "patch.applied");

  // --- Case A: ACCEPT_PREPARED + CLEAN_BASE → RESUMED_AND_ACCEPTED ---
  // Journal tail stopped before `patch.apply.started` and the target
  // workspace is still at the frozen base. The Frozen Patch was never
  // applied, so we re-apply and complete ACCEPT.
  //
  // Phase 6.2 safety: if `apply-evidence.json` is already on disk
  // while the target is CLEAN_BASE, the previous apply result has
  // been externally undone (someone ran `git reset --hard` /
  // `git checkout` / `git clean` after the apply). We must NOT
  // silently re-apply — the journal is no longer consistent with the
  // workspace. Refuse with RECOVERY_REQUIRED.
  if (originalState === "ACCEPT_PREPARED" && target.state === "CLEAN_BASE") {
    const existingEvidence = readOptionalFile(
      resolve(input.artifactRoot, input.executionId, "apply-evidence.json"),
    );
    if (existingEvidence !== undefined) {
      return await failAcceptRecovery(input, base, mutable, {
        targetState: "CLEAN_BASE",
        reason: "apply-evidence.json already exists while target is CLEAN_BASE; workspace was externally modified after the previous apply — operator decision required",
      });
    }
    if (!applyStarted) {
      appendReduceProject(input.eventStore, input.projector, input.artifactRoot, input.fingerprintRegistry, mutable, {
        taskId: bindings.taskId,
        executionId: input.executionId,
        type: "patch.apply.started",
        payload: {
          patch_blob_hash: bindings.patchBlobHash,
          change_set_hash: bindings.changeSetHash,
          base_revision: bindings.baseRevision,
          review_id: bindings.reviewId,
          review_bundle_id: bindings.reviewBundleId,
          review_hash: bindings.reviewHash,
        },
      });
      appended.push("patch.apply.started");
    }
    const preflight = buildReconcilePreflight(
      bindings, input.repositoryPath, patchBytes, patchPath, input.temporaryRoot, changedFiles,
    );
    let applied: ApplyAcceptedPatchResult;
    try {
      applied = await applyPreflightedPatch(preflight);
    } catch (error) {
      return await failAcceptRecovery(input, base, mutable, {
        targetState: "CLEAN_BASE",
        reason: `reconciled apply failed: ${(error as Error).message}`,
      });
    }
    const { evidenceArtifact, outcomeArtifact } = await freezeApplyArtifacts(
      input.artifactRoot,
      input.executionId,
      buildApplyEvidence(input.executionId, bindings.baseRevision, applied, true),
      buildOutcome(input.executionId, bindings, applied),
    );
    appendReduceProject(input.eventStore, input.projector, input.artifactRoot, input.fingerprintRegistry, mutable, {
      taskId: bindings.taskId,
      executionId: input.executionId,
      type: "patch.applied",
      payload: {
        patch_blob_hash: applied.patchBlobHash,
        expected_change_set_hash: applied.expectedChangeSetHash,
        actual_change_set_hash: applied.actualChangeSetHash,
        apply_evidence_hash: evidenceArtifact.sha256,
        outcome_hash: outcomeArtifact.sha256,
        status: applied.status,
        targetPath: applied.targetPath,
      },
    });
    appended.push("patch.applied");
    appendReduceProject(input.eventStore, input.projector, input.artifactRoot, input.fingerprintRegistry, mutable, {
      taskId: bindings.taskId,
      executionId: input.executionId,
      type: "review.accept.completed",
      payload: {
        reviewId: bindings.reviewId,
        reviewBundleId: bindings.reviewBundleId,
        reviewHash: bindings.reviewHash,
        patch_blob_hash: applied.patchBlobHash,
        change_set_hash: bindings.changeSetHash,
        apply_evidence_hash: evidenceArtifact.sha256,
        outcome_hash: outcomeArtifact.sha256,
      },
    });
    appended.push("review.accept.completed");
    input.replayGuard.record(signature);
    return {
      verdict: "RESUMED_AND_ACCEPTED",
      executionId: input.executionId,
      originalState: "ACCEPT_PREPARED",
      finalState: "ACCEPTED",
      targetState: "CLEAN_BASE",
      reason: "apply never reached the target; reconciled to ACCEPTED",
      appendedEvents: appended,
      applyEvidenceHash: evidenceArtifact.sha256,
      outcomeHash: outcomeArtifact.sha256,
    };
  }

  // --- Case A' (P0#1 + Phase 6.2): ACCEPT_PREPARED + apply.started + EXACT ---
  // The crash happened AFTER `git apply` succeeded but BEFORE
  // `patch.applied` / `review.accept.completed` were written. The
  // target is `EXACT_EXPECTED_CHANGE_SET` and the Journal proves G2M
  // started the apply.
  //
  // Phase 6.2: any of the four pre-commit artifact states is now
  // handled:
  //   - both_missing   → freeze both (recovery_mode=true)
  //   - evidence_only  → preserve the evidence bytes; create outcome
  //   - both_present   → preserve both bytes; reuse their hashes
  //   - order_violation / semantic_mismatch → RECOVERY_REQUIRED
  // We never overwrite pre-existing bytes.
  if (
    originalState === "ACCEPT_PREPARED" &&
    applyStarted &&
    target.state === "EXACT_EXPECTED_CHANGE_SET"
  ) {
    const orphan = classifyOrphanApplyArtifacts(
      input.artifactRoot,
      input.executionId,
      bindings,
      input.repositoryPath,
      target.actualChangeSetHash,
    );
    if (orphan.kind === "order_violation" || orphan.kind === "semantic_mismatch") {
      return await failAcceptRecovery(input, base, mutable, {
        targetState: "EXACT_EXPECTED_CHANGE_SET",
        reason: `orphan artifact check: ${orphan.detail}`,
      });
    }

    // Resolve the artifact hashes we will bind in patch.applied.
    let evidenceHash: string;
    let outcomeHash: string;
    if (orphan.kind === "both_missing") {
      const applied = synthesizeAppliedFromTarget(bindings, input.repositoryPath, target.actualChangeSetHash);
      const written = await freezeApplyArtifacts(
        input.artifactRoot,
        input.executionId,
        buildApplyEvidence(input.executionId, bindings.baseRevision, applied, true),
        buildOutcome(input.executionId, bindings, applied),
      );
      evidenceHash = written.evidenceArtifact.sha256;
      outcomeHash = written.outcomeArtifact.sha256;
    } else if (orphan.kind === "evidence_only") {
      // Preserve the on-disk evidence bytes; create only the missing
      // outcome. The outcome's audit fields (recovery_mode / applied_at)
      // legitimately differ from a normal-path write; the evidence is
      // untouched. We do NOT call `freezeApplyArtifacts` here because
      // that helper would also try to write the (already-present)
      // evidence and `freezeOrVerify` would reject the bytes (the
      // normal-path `recovery_mode: false` differs from Recovery's
      // `recovery_mode: true`).
      const applied = synthesizeAppliedFromTarget(bindings, input.repositoryPath, target.actualChangeSetHash);
      const outcomePath = resolve(input.artifactRoot, input.executionId, "outcome.json");
      const outcomePayload = buildOutcome(input.executionId, bindings, applied);
      const outcomeBytes = Buffer.from(`${JSON.stringify(outcomePayload, null, 2)}\n`, "utf8");
      const outcomeWrite = await writeImmutableArtifact(outcomePath, outcomeBytes);
      evidenceHash = orphan.evidenceHash;
      outcomeHash = outcomeWrite.sha256;
    } else {
      // both_present — reuse the exact existing hashes.
      evidenceHash = orphan.evidenceHash;
      outcomeHash = orphan.outcomeHash;
    }

    appendReduceProject(input.eventStore, input.projector, input.artifactRoot, input.fingerprintRegistry, mutable, {
      taskId: bindings.taskId,
      executionId: input.executionId,
      type: "patch.applied",
      payload: {
        patch_blob_hash: bindings.patchBlobHash,
        expected_change_set_hash: bindings.changeSetHash,
        actual_change_set_hash: target.actualChangeSetHash,
        apply_evidence_hash: evidenceHash,
        outcome_hash: outcomeHash,
        status: "applied",
        targetPath: input.repositoryPath,
      },
    });
    appended.push("patch.applied");
    appendReduceProject(input.eventStore, input.projector, input.artifactRoot, input.fingerprintRegistry, mutable, {
      taskId: bindings.taskId,
      executionId: input.executionId,
      type: "review.accept.completed",
      payload: {
        reviewId: bindings.reviewId,
        reviewBundleId: bindings.reviewBundleId,
        reviewHash: bindings.reviewHash,
        patch_blob_hash: bindings.patchBlobHash,
        change_set_hash: bindings.changeSetHash,
        apply_evidence_hash: evidenceHash,
        outcome_hash: outcomeHash,
      },
    });
    appended.push("review.accept.completed");
    input.replayGuard.record(signature);
    const reason = orphan.kind === "both_missing"
      ? "target already matches the frozen change set after apply.started; created missing artifacts and finished journal without re-apply"
      : orphan.kind === "evidence_only"
        ? "preserved pre-existing apply-evidence.json; created missing outcome.json and finished journal"
        : "preserved pre-existing apply-evidence.json and outcome.json; finished journal using their existing hashes";
    return {
      verdict: "RECONCILED_AND_ACCEPTED",
      executionId: input.executionId,
      originalState: "ACCEPT_PREPARED",
      finalState: "ACCEPTED",
      targetState: "EXACT_EXPECTED_CHANGE_SET",
      reason,
      appendedEvents: appended,
      applyEvidenceHash: evidenceHash,
      outcomeHash,
    };
  }

  // --- Case C (P0#2): PATCH_APPLIED + EXACT → RECONCILED_AND_ACCEPTED (verify-only) ---
  // The Journal has `patch.applied`; the target is
  // EXACT_EXPECTED_CHANGE_SET. The `apply-evidence.json` and
  // `outcome.json` artifacts on disk are IMMUTABLE EVIDENCE — we
  // MUST verify their hashes match the `patch.applied` payload
  // and only append `review.accept.completed`. We never overwrite
  // these artifacts.
  if (originalState === "PATCH_APPLIED" && target.state === "EXACT_EXPECTED_CHANGE_SET") {
    if (patchApplied === undefined) {
      return await failAcceptRecovery(input, base, mutable, {
        targetState: "EXACT_EXPECTED_CHANGE_SET",
        reason: "PATCH_APPLIED state but no patch.applied event in journal",
      });
    }
    const verifyResult = verifyExistingApplyArtifacts(
      input.artifactRoot,
      input.executionId,
      patchApplied,
    );
    if (verifyResult.kind === "missing" || verifyResult.kind === "mismatch") {
      return await failAcceptRecovery(input, base, mutable, {
        targetState: "EXACT_EXPECTED_CHANGE_SET",
        reason: `apply-evidence / outcome on disk ${verifyResult.kind} (${verifyResult.detail})`,
      });
    }
    appendReduceProject(input.eventStore, input.projector, input.artifactRoot, input.fingerprintRegistry, mutable, {
      taskId: bindings.taskId,
      executionId: input.executionId,
      type: "review.accept.completed",
      payload: {
        reviewId: bindings.reviewId,
        reviewBundleId: bindings.reviewBundleId,
        reviewHash: bindings.reviewHash,
        patch_blob_hash: bindings.patchBlobHash,
        change_set_hash: bindings.changeSetHash,
        apply_evidence_hash: verifyResult.evidenceHash,
        outcome_hash: verifyResult.outcomeHash,
      },
    });
    appended.push("review.accept.completed");
    input.replayGuard.record(signature);
    return {
      verdict: "RECONCILED_AND_ACCEPTED",
      executionId: input.executionId,
      originalState: "PATCH_APPLIED",
      finalState: "ACCEPTED",
      targetState: "EXACT_EXPECTED_CHANGE_SET",
      reason: "patch.applied present; verified apply-evidence and outcome hashes, finished journal without re-writing artifacts",
      appendedEvents: appended,
      applyEvidenceHash: verifyResult.evidenceHash,
      outcomeHash: verifyResult.outcomeHash,
    };
  }

  // --- Remaining cases are unrecoverable without human decision ---
  if (originalState === "ACCEPT_PREPARED" && target.state === "EXACT_EXPECTED_CHANGE_SET") {
    return await failAcceptRecovery(input, base, mutable, {
      targetState: "EXACT_EXPECTED_CHANGE_SET",
      reason: "ACCEPT_PREPARED without apply.started but target already shows the expected change set; cannot prove G2M applied the change",
    });
  }
  if (originalState === "PATCH_APPLIED" && target.state === "CLEAN_BASE") {
    return await failAcceptRecovery(input, base, mutable, {
      targetState: "CLEAN_BASE",
      reason: "PATCH_APPLIED but target is CLEAN_BASE; the applied result is unprovable",
    });
  }

  return await failAcceptRecovery(input, base, mutable, {
    targetState: target.state,
    reason: `no recovery path for state=${originalState} target=${target.state}`,
  });
}
