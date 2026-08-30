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
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TaskEvent } from "../events/events.js";
import { EventStore } from "../events/store.js";
import { reduce } from "../events/reducer.js";
import type { TaskState } from "../execution/state-machine.js";
import { FingerprintRegistry } from "../execution/fingerprint.js";
import { writeImmutableArtifact } from "../persistence/artifact-writer.js";
import { computeFullWorkingTreeChangeSet } from "../workspace/change-set.js";
import type { ExecutionProjection } from "../projection/execution-projector.js";
import { ReplayGuard, type ReviewSignature } from "../review/replay-guard.js";
import { computeReviewBundleHash } from "../review/bundle.js";
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

function replayState(
  events: readonly TaskEvent[],
  fingerprintRegistry: FingerprintRegistry,
): TaskState | null {
  let state: TaskState | null = null;
  for (const event of events) {
    try {
      state = reduce(state, event, { fingerprintRegistry });
    } catch {
      return state;
    }
  }
  return state;
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
  const replayed = replayState(input.events, input.fingerprintRegistry);
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
  if (originalState === "ACCEPT_PREPARED" && target.state === "CLEAN_BASE") {
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

  // --- Case A' (P0#1): ACCEPT_PREPARED + apply.started EXISTS + EXACT → RECONCILED_AND_ACCEPTED ---
  // The crash happened AFTER `git apply` succeeded but BEFORE
  // `patch.applied` / `review.accept.completed` were written. The Frozen
  // Patch bytes are already on disk, the target matches, and the
  // Journal proves G2M started the apply. We freeze the missing
  // artifacts (defensively — they may already exist with the same
  // bytes) and finish the journal WITHOUT re-running `git apply`.
  if (
    originalState === "ACCEPT_PREPARED" &&
    applyStarted &&
    target.state === "EXACT_EXPECTED_CHANGE_SET"
  ) {
    const applied = synthesizeAppliedFromTarget(bindings, input.repositoryPath, target.actualChangeSetHash);
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
      verdict: "RECONCILED_AND_ACCEPTED",
      executionId: input.executionId,
      originalState: "ACCEPT_PREPARED",
      finalState: "ACCEPTED",
      targetState: "EXACT_EXPECTED_CHANGE_SET",
      reason: "target already matches the frozen change set after apply.started; finished journal without re-apply",
      appendedEvents: appended,
      applyEvidenceHash: evidenceArtifact.sha256,
      outcomeHash: outcomeArtifact.sha256,
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
