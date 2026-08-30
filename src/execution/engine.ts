/**
 * G2M execution engine — connects the previously independent MVP modules.
 *
 * The engine validates a structured task, runs the Worker only in a temporary
 * Git worktree, collects independent evidence, builds a Review Bundle, then
 * applies or discards the frozen patch according to a bound Review decision.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { EventStore } from "../events/store.js";
import type { TaskEvent } from "../events/events.js";
import { reduce } from "../events/reducer.js";
import { collectDiff } from "../evidence/diff.js";
import {
  EvidenceStore,
  recordVerificationEvidence,
  recordWorkerEvidence,
  recordWorkspaceEvidence,
} from "../evidence/store.js";
import { runVerification } from "../evidence/verification.js";
import type { ProcessSupervisor } from "../process/supervisor.js";
import { writeImmutableArtifact } from "../persistence/artifact-writer.js";
import type { ExecutionProjection } from "../projection/execution-projector.js";
import { ProfileRegistry, resolveProfile } from "../policy/verification.js";
import { sha256, taskHash } from "../protocol/hash.js";
import {
  type CodeTaskV1,
  type SessionPolicy,
} from "../protocol/code-task.v1.schema.js";
import { validateCodeTask } from "../protocol/schema-validator.js";
import { buildReviewBundle, type ReviewBundle, type WorkerRuntimeInfo } from "../review/bundle.js";
import {
  applyReview as applyBoundReview,
  reviewSignature,
  validateReview,
  type Review,
} from "../review/ingress.js";
import { ReplayGuard } from "../review/replay-guard.js";
import {
  AdapterError,
  type CodingWorkerAdapter,
  type WorkerInvocation,
} from "../workers/coding-worker.js";
import { captureBaseline } from "../workspace/baseline.js";
import { WorkspaceLock, type LockHandle } from "../workspace/lock.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import {
  applyPreflightedPatch,
  collectWorktreePatch,
  freezePreparedWorktreePatch,
  createTemporaryWorktree,
  prepareWorktreePatch,
  preflightAcceptedPatch,
  removeTemporaryWorktree,
  type ApplyAcceptedPatchResult,
  type TemporaryWorktreeHandle,
  type WorktreePatch,
} from "../workspace/worktree.js";
import {
  computeTaskFingerprint,
  fingerprintHash,
  FingerprintRegistry,
  buildFingerprintV2Artifact,
  type TaskFingerprint,
} from "./fingerprint.js";
import type { TaskState } from "./state-machine.js";
import { StorageAdmissionError, type StorageManager, type StorageReservationHandle } from "../storage/reservation.js";
import type { StorageMonitor, StorageMonitorHandle } from "../storage/monitor.js";
import { buildProtectedPolicy } from "../runtime/protected-policy.js";
import { resolveProgramIdentity } from "../runtime/program-identity.js";

export interface G2MExecutionEngineOptions {
  readonly workspaceRegistry: WorkspaceRegistry;
  readonly workspaceLock: WorkspaceLock;
  readonly profileRegistry: ProfileRegistry;
  readonly evidenceStore: EvidenceStore;
  readonly eventStore: EventStore;
  readonly projection?: ExecutionProjection;
  readonly fingerprintRegistry: FingerprintRegistry;
  readonly replayGuard: ReplayGuard;
  readonly worker: CodingWorkerAdapter;
  readonly processSupervisor?: ProcessSupervisor;
  readonly workerRuntime: WorkerRuntimeInfo;
  readonly adapterContractVersion: string;
  readonly worktreeRoot: string;
  readonly artifactRoot: string;
  readonly storageManager?: StorageManager;
  readonly storageMonitor?: StorageMonitor;
  readonly stateRoot?: string;
  readonly runtimeHardening?: Readonly<Record<string, number>>;
  readonly storagePolicyHash?: string;
  readonly leasePolicyHash?: string;
}

export interface PendingReviewExecution {
  readonly task: CodeTaskV1;
  readonly taskHash: string;
  readonly executionId: string;
  readonly state: "REVIEW_PENDING";
  readonly bundle: ReviewBundle;
  readonly worktree: TemporaryWorktreeHandle;
  readonly patch: WorktreePatch;
  readonly fingerprint: TaskFingerprint;
  readonly lease: LockHandle;
  readonly reservation?: StorageReservationHandle;
}

export interface CompletedReviewExecution {
  readonly taskId: string;
  readonly executionId: string;
  readonly decision: Review["decision"];
  readonly state: "ACCEPTED" | "REVISION_REQUESTED" | "BLOCKED";
  readonly patchStatus:
    | ApplyAcceptedPatchResult["status"]
    | "discarded"
    | "retained_for_revision";
  readonly newTaskId?: string;
}

export class G2MExecutionEngineError extends Error {
  readonly code:
    | "VALIDATION_FAILED"
    | "WORKSPACE_FAILED"
    | "DIRTY_WORKSPACE"
    | "WORKSPACE_BUSY"
    | "WORKER_FAILED"
    | "RUNTIME_DRIFT"
    | "WORKER_TIMED_OUT"
    | "WORKER_CANCELLED"
    | "RECOVERY_REQUIRED"
    | "CAPABILITY_VIOLATION"
    | "VERIFICATION_FAILED"
    | "STORAGE_ADMISSION_DENIED"
    | "STORAGE_LIMIT_EXCEEDED"
    | "STORAGE_SCAN_FAILED"
    | "STORAGE_RESERVATION_FAILED"
    | "STORAGE_STATE_INCONSISTENT"
    | "WORKTREE_CHANGED_AFTER_REVIEW"
    | "UNKNOWN_PENDING_EXECUTION";
  override readonly cause?: unknown;
  readonly recovery?: {
    readonly state: "RECOVERY_REQUIRED" | "TIMED_OUT";
    readonly worktree: TemporaryWorktreeHandle;
  };

  constructor(
    code: G2MExecutionEngineError["code"],
    message: string,
    cause?: unknown,
    recovery?: G2MExecutionEngineError["recovery"],
  ) {
    super(message);
    this.name = "G2MExecutionEngineError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    if (recovery !== undefined) this.recovery = recovery;
  }
}

interface MutableExecutionState {
  state: TaskState | null;
}

function workerSessionPolicy(policy: SessionPolicy): WorkerInvocation["sessionPolicy"] {
  if (policy.mode === "new") return { mode: "new" };
  return { mode: "attach", verifiedSessionId: policy.verified_session_id };
}

/**
 * Phase 6: freeze the bound Review JSON as an immutable execution artifact.
 * Acceptance reads `review.json` to verify Review binding and recover after
 * a crash between `review.accept.prepared` and the actual apply.
 */
async function freezeAcceptReviewArtifact(
  artifactRoot: string,
  executionId: string,
  review: Review,
): Promise<{ readonly path: string; readonly sha256: string; readonly bytes: number }> {
  const path = resolve(artifactRoot, executionId, "review.json");
  const bytes = Buffer.from(`${JSON.stringify(review, null, 2)}\n`, "utf8");
  return writeImmutableArtifact(path, bytes);
}

/**
 * Phase 6 ACCEPT outcome artifact (plan §29). Frozen BEFORE `patch.applied`
 * so the Journal and the artifact agree on the same result even if the
 * process dies immediately after writing the Journal line.
 */
interface AcceptOutcomeArtifact {
  readonly schema_version: 1;
  readonly task_id: string;
  readonly execution_id: string;
  readonly decision: "ACCEPT";
  readonly state: "ACCEPTED";
  readonly patch_status: "applied" | "no_changes";
  readonly patch_blob_hash: string;
  readonly change_set_hash: string;
  readonly review_id: string;
  readonly review_bundle_id: string;
}

function buildAcceptOutcome(
  taskId: string,
  executionId: string,
  review: Review,
  applied: ApplyAcceptedPatchResult,
): AcceptOutcomeArtifact {
  return {
    schema_version: 1,
    task_id: taskId,
    execution_id: executionId,
    decision: "ACCEPT",
    state: "ACCEPTED",
    patch_status: applied.status,
    patch_blob_hash: applied.patchBlobHash,
    change_set_hash: applied.expectedChangeSetHash,
    review_id: review.reviewId,
    review_bundle_id: review.reviewBundleId,
  };
}

/**
 * Phase 6: freeze the ACCEPT apply-evidence artifact (plan §27). Schema is
 * deterministic so Normal Path and Recovery Path generate the same bytes
 * for the same inputs.
 */
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

function buildWorkerPrompt(task: CodeTaskV1): string {
  return [
    "GOAL",
    task.goal,
    "",
    "CONSTRAINTS",
    ...task.constraints.map((value) => `- ${value}`),
    "",
    "ACCEPTANCE CRITERIA",
    ...task.acceptance_criteria.map((value) => `- ${value}`),
    "",
    "DELIVERABLE",
    "Return a final JSON object with summary, files_changed, tests, remaining_risks, and optional blocked_reason.",
    "Do not commit or push changes.",
  ].join("\n");
}

export class G2MExecutionEngine {
  private readonly pending = new Map<string, PendingReviewExecution>();

  constructor(private readonly options: G2MExecutionEngineOptions) {}

  private async snapshotStorage(
    executionId: string,
    worktreePath: string,
    retentionClass: string | null = null,
    gcEligibleAt: number | null = null,
  ): Promise<void> {
    if (this.options.storageManager === undefined) return;
    try {
      await this.options.storageManager.snapshotExecution({
        executionId,
        artifactPath: resolve(this.options.artifactRoot, executionId),
        worktreePath,
        retentionClass,
        gcEligibleAt,
      });
    } catch (error) {
      if (error instanceof StorageAdmissionError) {
        throw new G2MExecutionEngineError(error.code, error.message, error);
      }
      throw new G2MExecutionEngineError("STORAGE_SCAN_FAILED", "storage usage scan failed", error);
    }
  }

  private projectDurable(event: TaskEvent, state: TaskState): void {
    if (this.options.projection === undefined || event.durability !== "CRITICAL") return;
    try {
      this.options.projection.project(event, state, {
        artifactPath: resolve(this.options.artifactRoot, event.attemptId),
        runtime: this.options.workerRuntime.runtime,
        runtimeVersion: this.options.workerRuntime.version,
        ...(this.options.workerRuntime.model !== null
          ? { model: this.options.workerRuntime.model }
          : {}),
      });
    } catch (error) {
      this.options.eventStore.append({
        taskId: event.taskId,
        attemptId: event.attemptId,
        type: "projection.stale",
        payload: {
          failed_event_id: event.eventId,
          failed_event_hash: event.hash,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private appendAndReduce(
    mutable: MutableExecutionState,
    input: {
      readonly taskId: string;
      readonly executionId: string;
      readonly type: Parameters<EventStore["append"]>[0]["type"];
      readonly payload?: Record<string, unknown>;
      readonly fingerprint?: TaskFingerprint;
    },
  ): TaskState {
    const event = this.options.eventStore.append({
      taskId: input.taskId,
      attemptId: input.executionId,
      type: input.type,
      payload: input.payload ?? {},
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
    });
    mutable.state = reduce(mutable.state, event, {
      fingerprintRegistry: this.options.fingerprintRegistry,
    });
    // A CRITICAL append flushes itself and all prior NORMAL records. Projecting
    // only at that barrier guarantees SQLite can never lead the Journal.
    this.projectDurable(event, mutable.state);
    return mutable.state;
  }

  async execute(rawTask: unknown): Promise<PendingReviewExecution> {
    const validated = validateCodeTask(rawTask);
    if (!validated.ok) {
      throw new G2MExecutionEngineError(
        "VALIDATION_FAILED",
        validated.errors.map((error) => `${error.path}: ${error.message}`).join("; "),
      );
    }
    const task = validated.value;
    const executionId = randomUUID();
    const mutable: MutableExecutionState = { state: null };
    let lockHandle: LockHandle | undefined;
    let worktree: TemporaryWorktreeHandle | undefined;
    let preserveWorktree = false;
    let reservation: StorageReservationHandle | undefined;
    let workerMonitor: StorageMonitorHandle | undefined;

    this.appendAndReduce(mutable, {
      taskId: task.task_id,
      executionId,
      type: "task.created",
      payload: { protocolVersion: task.protocol_version, task },
    });
    this.appendAndReduce(mutable, {
      taskId: task.task_id,
      executionId,
      type: "task.validation.started",
    });

    try {
      const workspace = this.options.workspaceRegistry.get(
        task.workspace_scope.workspace_id,
      );
      const mainBaseline = await captureBaseline(workspace.canonicalPath);
      if (task.workspace_scope.require_clean_worktree && mainBaseline.dirty) {
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "task.validation.failed",
          payload: { reason: "dirty workspace" },
        });
        throw new G2MExecutionEngineError(
          "DIRTY_WORKSPACE",
          `workspace ${task.workspace_scope.workspace_id} is dirty`,
        );
      }
      const profile = resolveProfile(
        this.options.profileRegistry,
        task.workspace_scope.workspace_id,
        task.verification_profile,
      );
      const runtimeSnapshot = await this.options.worker.probe();

      if (this.options.storageManager !== undefined) {
        try {
          reservation = await this.options.storageManager.reserveExecution({
            executionId,
            taskId: task.task_id,
            roots: [
              { rootPath: this.options.worktreeRoot, roles: ["worktree"] },
              { rootPath: this.options.artifactRoot, roles: ["artifact"] },
            ],
          });
        } catch (error) {
          const code = error instanceof StorageAdmissionError ? error.code : "STORAGE_RESERVATION_FAILED";
          this.appendAndReduce(mutable, {
            taskId: task.task_id,
            executionId,
            type: "task.validation.failed",
            payload: { reason: error instanceof Error ? error.message : String(error), storageErrorCode: code },
          });
          throw new G2MExecutionEngineError(code, "storage admission failed", error);
        }
      }

      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "task.validation.passed",
      });
      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "workspace.lock.requested",
      });
      try {
        lockHandle = await this.options.workspaceLock.acquire({
          workspaceId: task.workspace_scope.workspace_id,
          canonicalPath: workspace.canonicalPath,
          executionId,
        });
      } catch (error) {
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "workspace.lock.busy",
        });
        throw new G2MExecutionEngineError(
          "WORKSPACE_BUSY",
          `workspace ${task.workspace_scope.workspace_id} is busy`,
          error,
        );
      }
      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "workspace.lock.acquired",
      });

      worktree = await createTemporaryWorktree({
        workspaceId: task.workspace_scope.workspace_id,
        repositoryPath: workspace.canonicalPath,
        baseRevision: task.workspace_scope.base_revision,
        worktreeRoot: this.options.worktreeRoot,
      });
      await this.snapshotStorage(executionId, worktree.worktreePath);
      const baseline = await captureBaseline(worktree.worktreePath);
      const stableTaskHash = taskHash(task);
      const runtimeCapabilitySnapshotHash = sha256(runtimeSnapshot);
      const runtimeIdentity = this.options.worker.getRuntimeIdentity === undefined
        ? undefined
        : await this.options.worker.getRuntimeIdentity(runtimeCapabilitySnapshotHash);
      const resolvedVerificationProgram = profile === undefined
        ? undefined
        : await resolveProgramIdentity(profile.program);
      const verificationIdentity = profile === undefined
        ? {
            id: "none",
            resolved_program: "",
            program_identity_hash: sha256(""),
            program_bytes: 0,
            args: [],
            timeout_ms: 0,
          }
        : {
            id: profile.id,
            resolved_program: resolvedVerificationProgram!.resolved_program,
            program_identity_hash: resolvedVerificationProgram!.program_identity_hash,
            program_bytes: resolvedVerificationProgram!.program_bytes,
            args: profile.args,
            timeout_ms: profile.timeoutMs,
            ...(profile.env !== undefined ? { env: profile.env } : {}),
          };
      const protectedPolicy = runtimeIdentity === undefined
        ? undefined
        : buildProtectedPolicy({
            task_id: task.task_id,
            execution_id: executionId,
            workspace_id: task.workspace_scope.workspace_id,
            canonical_workspace_path: workspace.canonicalPath,
            base_revision: worktree.baseRevision,
            artifact_root: this.options.artifactRoot,
            worktree_root: this.options.worktreeRoot,
            state_root: this.options.stateRoot ?? resolve(this.options.artifactRoot, "state"),
            permission_policy: task.permission_policy,
            requested_capabilities: task.requested_capabilities,
            limits: {
              max_steps: task.limits.max_steps,
              timeout_ms: task.limits.timeout_ms,
            },
            verification_profile: verificationIdentity,
            runtime_identity_hash: runtimeIdentity.identity_hash,
            output_limits: this.options.runtimeHardening ?? {},
            storage_policy_hash: this.options.storagePolicyHash ?? sha256(this.options.storageManager?.storagePolicy ?? {}),
            lease_policy_hash: this.options.leasePolicyHash ?? sha256({}),
          });
      const fingerprint = computeTaskFingerprint(
        {
          taskHash: stableTaskHash,
          workspaceId: task.workspace_scope.workspace_id,
          baseRevision: worktree.baseRevision,
          maxSteps: task.limits.max_steps,
          timeoutMs: task.limits.timeout_ms,
          permissionProfile: task.permission_policy,
        },
        {
          mcodeVersion: runtimeSnapshot.version ?? this.options.workerRuntime.version,
          model: runtimeIdentity?.model ?? (this.options.workerRuntime.model || null),
          adapterContractVersion: runtimeIdentity?.adapter_contract_version ?? this.options.adapterContractVersion,
          runtimeCapabilitySnapshotHash,
          ...(runtimeIdentity !== undefined ? { runtimeIdentityHash: runtimeIdentity.identity_hash } : {}),
          ...(protectedPolicy !== undefined ? { protectedPolicyHash: protectedPolicy.policy_hash } : {}),
          ...(runtimeIdentity !== undefined ? { workerSummarySchemaHash: runtimeIdentity.worker_summary_schema_hash } : {}),
        },
      );
      let fingerprintArtifactHash: string | undefined;
      if (runtimeIdentity !== undefined && protectedPolicy !== undefined) {
        const executionArtifactRoot = resolve(this.options.artifactRoot, executionId);
        await writeImmutableArtifact(
          resolve(executionArtifactRoot, "runtime-identity.json"),
          Buffer.from(`${JSON.stringify(runtimeIdentity, null, 2)}\n`, "utf8"),
        );
        await writeImmutableArtifact(
          resolve(executionArtifactRoot, "protected-policy.json"),
          Buffer.from(`${JSON.stringify(protectedPolicy, null, 2)}\n`, "utf8"),
        );
        const fingerprintArtifact = await writeImmutableArtifact(
          resolve(executionArtifactRoot, "fingerprint.json"),
          Buffer.from(`${JSON.stringify(buildFingerprintV2Artifact({ taskId: task.task_id, executionId, fingerprint }), null, 2)}\n`, "utf8"),
        );
        fingerprintArtifactHash = fingerprintArtifact.sha256;
      }
      const invocation: WorkerInvocation = {
        executionId,
        prompt: buildWorkerPrompt(task),
        workspacePath: worktree.worktreePath,
        permissionPolicy: task.permission_policy,
        requestedCapabilities: task.requested_capabilities,
        limits: {
          maxSteps: task.limits.max_steps,
          timeoutMs: task.limits.timeout_ms,
        },
        sessionPolicy: workerSessionPolicy(task.session_policy),
        ...(runtimeIdentity !== undefined
          ? { expectedRuntimeIdentityHash: runtimeIdentity.identity_hash }
          : {}),
      };

      try {
        await this.options.worker.start(invocation);
      } catch (error) {
        const workerErrorCode = error instanceof AdapterError ? error.code : undefined;
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "agent.spawn.failed",
          payload: {
            message: (error as Error).message,
            ...(workerErrorCode !== undefined ? { workerErrorCode } : {}),
          },
        });
        if (workerErrorCode === "RUNTIME_DRIFT") {
          throw new G2MExecutionEngineError(
            "RUNTIME_DRIFT",
            "worker runtime identity changed before spawn",
            error,
          );
        }
        throw new G2MExecutionEngineError("WORKER_FAILED", "worker start failed", error);
      }
      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "agent.spawn.started",
        payload: {
          ...(runtimeIdentity !== undefined ? { runtime_identity_hash: runtimeIdentity.identity_hash } : {}),
          ...(protectedPolicy !== undefined ? { protected_policy_hash: protectedPolicy.policy_hash } : {}),
          ...(fingerprintArtifactHash !== undefined ? { fingerprint_artifact_hash: fingerprintArtifactHash } : {}),
          fingerprint_hash: fingerprintHash(fingerprint),
        },
        fingerprint,
      });

      let workerStorageAbort: import("../storage/monitor.js").StorageCheckResult | undefined;
      workerMonitor = this.options.storageMonitor?.start(
        { worktreePath: worktree.worktreePath, artifactPath: resolve(this.options.artifactRoot, executionId) },
        async (result) => {
          workerStorageAbort = result;
          await this.options.worker.cancel(executionId);
        },
      );

      let workerResult;
      try {
        workerResult = await this.options.worker.collectResult(executionId);
      } catch (error) {
        if (
          workerStorageAbort !== undefined &&
          error instanceof AdapterError &&
          error.code !== "UNKNOWN"
        ) {
          const code = workerStorageAbort.status === "limit_exceeded"
            ? "STORAGE_LIMIT_EXCEEDED"
            : "STORAGE_ADMISSION_DENIED";
          this.appendAndReduce(mutable, {
            taskId: task.task_id,
            executionId,
            type: "agent.cancelled",
            payload: { reason: workerStorageAbort.reason ?? "worker stopped by storage guard", code },
            fingerprint,
          });
          throw new G2MExecutionEngineError(code, "worker stopped by storage guard", error);
        }
        if (error instanceof AdapterError && error.code === "UNKNOWN") {
          this.appendAndReduce(mutable, {
            taskId: task.task_id,
            executionId,
            type: "recovery.required",
            payload: { reason: error.message, workerErrorCode: error.code },
            fingerprint,
          });
          preserveWorktree = true;
          throw new G2MExecutionEngineError(
            "RECOVERY_REQUIRED",
            "worker outcome is unknown; isolated evidence was preserved",
            error,
            { state: "RECOVERY_REQUIRED", worktree },
          );
        }
        if (error instanceof AdapterError && error.code === "TIMED_OUT") {
          this.appendAndReduce(mutable, {
            taskId: task.task_id,
            executionId,
            type: "agent.timed_out",
            payload: { reason: error.message },
            fingerprint,
          });
          preserveWorktree = true;
          throw new G2MExecutionEngineError(
            "WORKER_TIMED_OUT",
            "worker exceeded its execution timeout; isolated workspace was preserved",
            error,
            { state: "TIMED_OUT", worktree },
          );
        }
        if (error instanceof AdapterError && error.code === "CANCELLED") {
          this.appendAndReduce(mutable, {
            taskId: task.task_id,
            executionId,
            type: "agent.cancelled",
            payload: { reason: error.message },
            fingerprint,
          });
          throw new G2MExecutionEngineError(
            "WORKER_CANCELLED",
            "worker execution was cancelled",
            error,
          );
        }
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "agent.failed",
          payload: { message: (error as Error).message },
          fingerprint,
        });
        throw new G2MExecutionEngineError("WORKER_FAILED", "worker execution failed", error);
      } finally {
        workerMonitor?.stop();
      }
      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "agent.completed",
        fingerprint,
      });
      await this.snapshotStorage(executionId, worktree.worktreePath);

      const workerDiff = await collectDiff(worktree.worktreePath, worktree.baseRevision);
      recordWorkerEvidence(
        this.options.evidenceStore,
        task.task_id,
        executionId,
        workerResult,
      );

      if (!task.requested_capabilities.write && workerDiff.changedFiles.length > 0) {
        recordWorkspaceEvidence(
          this.options.evidenceStore,
          task.task_id,
          executionId,
          workerDiff,
          baseline,
        );
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "evidence.diff.collected",
          payload: { diffHash: workerDiff.diffHash },
          fingerprint,
        });
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "verification.failed",
          payload: {
            reason: "write capability was not authorized",
            changedFiles: workerDiff.changedFiles.map((entry) => entry.path),
          },
          fingerprint,
        });
        throw new G2MExecutionEngineError(
          "CAPABILITY_VIOLATION",
          `worker modified ${workerDiff.changedFiles.length} file(s) without write capability`,
        );
      }

      const verification = await runVerification(
        profile,
        task.workspace_scope.workspace_id,
        worktree.worktreePath,
        {
          ...(this.options.processSupervisor !== undefined
            ? { processSupervisor: this.options.processSupervisor }
            : {}),
          ...(this.options.storageMonitor !== undefined
            ? {
                storageMonitor: this.options.storageMonitor,
                storageArtifactPath: resolve(this.options.artifactRoot, executionId),
              }
            : {}),
          ...(this.options.runtimeHardening?.max_verification_stdout_bytes !== undefined
            ? { maxStdoutBytes: this.options.runtimeHardening.max_verification_stdout_bytes }
            : {}),
          ...(this.options.runtimeHardening?.max_verification_stderr_bytes !== undefined
            ? { maxStderrBytes: this.options.runtimeHardening.max_verification_stderr_bytes }
            : {}),
          ...(resolvedVerificationProgram !== undefined
            ? { expectedProgramIdentity: resolvedVerificationProgram }
            : {}),
        },
      );
      recordVerificationEvidence(
        this.options.evidenceStore,
        task.task_id,
        executionId,
        verification,
      );

      if (verification.status === "storage_limit_exceeded") {
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "verification.failed",
          payload: { reason: verification.errorMessage ?? "storage limit exceeded", verificationStatus: verification.status, resultHash: verification.resultHash },
          fingerprint,
        });
        throw new G2MExecutionEngineError("STORAGE_LIMIT_EXCEEDED", "verification stopped after storage limit was exceeded");
      }
      if (verification.status === "termination_unconfirmed") {
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "recovery.required",
          payload: {
            reason: verification.errorMessage ?? "verification termination could not be confirmed",
            verificationStatus: verification.status,
            resultHash: verification.resultHash,
          },
          fingerprint,
        });
        preserveWorktree = true;
        throw new G2MExecutionEngineError(
          "RECOVERY_REQUIRED",
          "verification process termination is unknown; isolated evidence was preserved",
          undefined,
          { state: "RECOVERY_REQUIRED", worktree },
        );
      }

      await this.snapshotStorage(executionId, worktree.worktreePath);
      const executionArtifactRoot = resolve(this.options.artifactRoot, executionId);
      const preparedPatch = await prepareWorktreePatch(worktree, executionArtifactRoot);
      if (this.options.storageManager !== undefined) {
        try {
          await this.options.storageManager.assertExecutionLimits({
            executionId,
            artifactPath: executionArtifactRoot,
            worktreePath: worktree.worktreePath,
            additionalArtifactBytes: preparedPatch.patchBytes.byteLength + preparedPatch.metadataBytes,
          });
        } catch (error) {
          if (error instanceof StorageAdmissionError) {
            throw new G2MExecutionEngineError(error.code, error.message, error);
          }
          throw error;
        }
      }
      const patch = await freezePreparedWorktreePatch(preparedPatch);
      await this.snapshotStorage(executionId, worktree.worktreePath);
      const diff = await collectDiff(worktree.worktreePath, worktree.baseRevision);
      recordWorkspaceEvidence(
        this.options.evidenceStore,
        task.task_id,
        executionId,
        diff,
        baseline,
      );
      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "evidence.diff.collected",
        payload: { diffHash: diff.diffHash },
        fingerprint,
      });
      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "patch.frozen",
        payload: {
          artifact_id: patch.artifactId,
          artifact_path: "frozen.patch",
          patch_blob_hash: patch.patchBlobHash,
          change_set_hash: patch.changeSetHash,
          base_revision: patch.baseRevision,
          patch_bytes: patch.patchBytes,
        },
        fingerprint,
      });

      if (verification.status === "passed") {
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "verification.completed",
          payload: { resultHash: verification.resultHash },
          fingerprint,
        });
      } else if (verification.status === "skipped") {
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "verification.skipped",
          payload: { resultHash: verification.resultHash },
          fingerprint,
        });
      } else {
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "verification.failed",
          payload: { status: verification.status, resultHash: verification.resultHash },
          fingerprint,
        });
        throw new G2MExecutionEngineError(
          "VERIFICATION_FAILED",
          `independent verification ended with ${verification.status}`,
        );
      }

      const bundle = buildReviewBundle({
        task,
        taskHash: stableTaskHash,
        executionId,
        workerSummary: workerResult,
        workspaceEvidence: {
          diff,
          baseline,
          patch: {
            artifactId: patch.artifactId,
            artifactPath: "frozen.patch",
            baseRevision: patch.baseRevision,
            patchBlobHash: patch.patchBlobHash,
            changeSetHash: patch.changeSetHash,
            patchBytes: patch.patchBytes,
            changeSet: patch.changeSet,
            patchHash: patch.patchHash,
            patchText: patch.patchText,
            changedFiles: patch.changedFiles,
            empty: patch.empty,
          },
        },
        verificationEvidence: { verification },
        workerRuntime: this.options.workerRuntime,
      });
      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "review.requested",
        payload: {
          review_bundle_id: bundle.bundleId,
          review_bundle_hash: bundle.reviewBundleHash,
          task_hash: bundle.taskHash,
          result_hash: bundle.resultHash,
        },
        fingerprint,
      });
      if (mutable.state !== "REVIEW_PENDING") {
        throw new G2MExecutionEngineError(
          "WORKER_FAILED",
          `unexpected state ${mutable.state ?? "null"} after review.requested`,
        );
      }
      await this.snapshotStorage(executionId, worktree.worktreePath, "RETAINED", null);

      const pending: PendingReviewExecution = Object.freeze({
        task,
        taskHash: stableTaskHash,
        executionId,
        state: "REVIEW_PENDING",
        bundle,
        worktree,
        patch,
        fingerprint,
        lease: lockHandle,
        ...(reservation !== undefined ? { reservation } : {}),
      });
      this.pending.set(bundle.bundleId, pending);
      return pending;
    } catch (error) {
      if (reservation !== undefined && mutable.state !== "REVIEW_PENDING" && mutable.state !== "RECOVERY_REQUIRED") {
        await this.options.storageManager?.releaseReservation(
          reservation,
          error instanceof Error ? error.message : "execution ended before review",
        ).catch(() => undefined);
      }
      if (
        worktree !== undefined &&
        mutable.state !== "REVIEW_PENDING" &&
        !preserveWorktree
      ) {
        await removeTemporaryWorktree(worktree).catch(() => undefined);
      }
      if (
        worktree !== undefined &&
        this.options.storageManager !== undefined &&
        ["FAILED", "TIMED_OUT", "CANCELLED"].includes(mutable.state ?? "")
      ) {
        await this.snapshotStorage(
          executionId,
          worktree.worktreePath,
          "NORMAL",
          Date.now() + (this.options.storageManager.storagePolicy?.completed_retention_days ?? 30) * 24 * 60 * 60 * 1000,
        ).catch(() => undefined);
      }
      if (error instanceof G2MExecutionEngineError) throw error;
      throw new G2MExecutionEngineError(
        "WORKSPACE_FAILED",
        (error as Error).message,
        error,
      );
    } finally {
      if (
        lockHandle !== undefined &&
        mutable.state !== "REVIEW_PENDING" &&
        mutable.state !== "RECOVERY_REQUIRED"
      ) {
        try { this.options.workspaceLock.release(lockHandle); } catch { /* terminal outcome remains durable */ }
      }
    }
  }

  async applyReview(
    pending: PendingReviewExecution,
    review: Review,
  ): Promise<CompletedReviewExecution> {
    if (this.pending.get(pending.bundle.bundleId) !== pending) {
      throw new G2MExecutionEngineError(
        "UNKNOWN_PENDING_EXECUTION",
        `bundle ${pending.bundle.bundleId} is not pending in this engine`,
      );
    }

    const lockHandle = pending.lease;
    let releaseLease = false;
    try {
      await this.options.workspaceLock.assertOwned(lockHandle);
      const currentDiff = await collectDiff(
        pending.worktree.worktreePath,
        pending.worktree.baseRevision,
      );
      if (currentDiff.diffHash !== pending.bundle.workspaceEvidence.diff.diffHash) {
        throw new G2MExecutionEngineError(
          "WORKTREE_CHANGED_AFTER_REVIEW",
          "isolated worktree changed after the review bundle was created",
        );
      }

      const reviewContext = {
        currentState: pending.state,
        eventStore: this.options.eventStore,
        replayGuard: this.options.replayGuard,
      } as const;
      const validation = validateReview(review, pending.bundle, reviewContext);
      let patchStatus: CompletedReviewExecution["patchStatus"];
      let newState: CompletedReviewExecution["state"];
      if (review.decision === "ACCEPT") {
        const transaction: MutableExecutionState = { state: pending.state };
        // Phase 6 §8: freeze `review.json` BEFORE any other accept evidence so
        // the recovery scanner always has the bound Review bytes available.
        const reviewArtifact = await freezeAcceptReviewArtifact(
          this.options.artifactRoot,
          pending.executionId,
          review,
        );
        // Phase 6 §9: enriched review.accept.prepared binding (Review +
        // Review Artifact + Patch + Base Revision). CRITICAL flush happens
        // inside `appendAndReduce`.
        this.appendAndReduce(transaction, {
          taskId: review.taskId,
          executionId: review.executionId,
          type: "review.accept.prepared",
          payload: {
            reviewId: review.reviewId,
            reviewBundleId: review.reviewBundleId,
            reviewHash: review.reviewHash,
            review_artifact_path: "review.json",
            review_artifact_hash: reviewArtifact.sha256,
            patch_blob_hash: pending.patch.patchBlobHash,
            change_set_hash: pending.patch.changeSetHash,
            base_revision: pending.worktree.baseRevision,
          },
          fingerprint: pending.fingerprint,
        });
        // Phase 6 §11: preflight does NOT mutate the Git workspace. After
        // this call we may safely append `patch.apply.started` to the
        // Journal before doing the real apply.
        const preflight = await preflightAcceptedPatch(
          pending.worktree,
          pending.patch,
          pending.worktree.repositoryPath,
        );
        await this.options.workspaceLock.assertOwned(lockHandle);
        // Phase 6 §6 / §7: `patch.apply.started` is a CRITICAL lifecycle
        // event. Its payload binds the Frozen Patch, expected change set,
        // base revision, and Review triple so the recovery scanner can
        // confirm "what was about to be applied" after any crash.
        this.appendAndReduce(transaction, {
          taskId: review.taskId,
          executionId: review.executionId,
          type: "patch.apply.started",
          payload: {
            patch_blob_hash: preflight.patchBlobHash,
            change_set_hash: preflight.expectedChangeSetHash,
            base_revision: preflight.baseRevision,
            review_id: review.reviewId,
            review_bundle_id: review.reviewBundleId,
            review_hash: review.reviewHash,
          },
          fingerprint: pending.fingerprint,
        });
        // Phase 6 §12: real apply. `preflight.patchBytes` is already
        // validated so this is the only place we touch the target.
        const appliedPatch = await applyPreflightedPatch(preflight);
        patchStatus = appliedPatch.status;
        // Phase 6 §27: apply-evidence.json is immutable evidence of the
        // post-apply state. `recovery_mode=false` because we are on the
        // normal path; the Recovery Path writes the same schema with
        // `recovery_mode=true` (see Phase 6 Task 3).
        const applyEvidenceArtifact = await writeImmutableArtifact(
          resolve(this.options.artifactRoot, pending.executionId, "apply-evidence.json"),
          Buffer.from(
            `${JSON.stringify(
              buildApplyEvidence(
                pending.executionId,
                preflight.baseRevision,
                appliedPatch,
                false,
              ),
              null,
              2,
            )}\n`,
            "utf8",
          ),
        );
        // Phase 6 §28-§29: outcome.json is the deterministic result
        // descriptor. Frozen BEFORE `patch.applied` so a crash immediately
        // after the Journal line still leaves the artifact on disk.
        const outcomeArtifact = await writeImmutableArtifact(
          resolve(this.options.artifactRoot, pending.executionId, "outcome.json"),
          Buffer.from(
            `${JSON.stringify(
              buildAcceptOutcome(
                pending.task.task_id,
                pending.executionId,
                review,
                appliedPatch,
              ),
              null,
              2,
            )}\n`,
            "utf8",
          ),
        );
        // Phase 6 §30: `patch.applied` payload now binds both the
        // apply-evidence hash and the outcome hash so recovery can verify
        // the post-apply invariant without re-running anything.
        this.appendAndReduce(transaction, {
          taskId: review.taskId,
          executionId: review.executionId,
          type: "patch.applied",
          payload: {
            patch_blob_hash: appliedPatch.patchBlobHash,
            expected_change_set_hash: appliedPatch.expectedChangeSetHash,
            actual_change_set_hash: appliedPatch.actualChangeSetHash,
            apply_evidence_hash: applyEvidenceArtifact.sha256,
            outcome_hash: outcomeArtifact.sha256,
            status: appliedPatch.status,
            targetPath: appliedPatch.targetPath,
          },
          fingerprint: pending.fingerprint,
        });
        // Phase 6 §31: review.accept.completed is the terminal commit
        // point. Its payload binds the full result so the Journal is
        // self-sufficient for recovery.
        this.appendAndReduce(transaction, {
          taskId: review.taskId,
          executionId: review.executionId,
          type: "review.accept.completed",
          payload: {
            reviewId: review.reviewId,
            reviewBundleId: review.reviewBundleId,
            reviewHash: review.reviewHash,
            patch_blob_hash: appliedPatch.patchBlobHash,
            change_set_hash: appliedPatch.expectedChangeSetHash,
            apply_evidence_hash: applyEvidenceArtifact.sha256,
            outcome_hash: outcomeArtifact.sha256,
          },
          fingerprint: pending.fingerprint,
        });
        releaseLease = true;
        // Phase 6 §32: ReplayGuard is a derived anti-replay cache. It
        // MUST never lead the Journal — record only after
        // review.accept.completed is durable. P1#3: any failure here is
        // a maintenance issue, not a reason to undo ACCEPT — the
        // Journal has already committed ACCEPT.
        try {
          this.options.replayGuard.record(reviewSignature(review));
        } catch (error) {
          // ReplayGuard sync failure cannot reverse ACCEPT. Log and
          // continue; the next recover / scan will rebuild the cache.
          void error;
        }
        newState = "ACCEPTED";
      } else if (review.decision === "BLOCK") {
        await removeTemporaryWorktree(pending.worktree);
        patchStatus = "discarded";
        newState = "BLOCKED";
      } else {
        patchStatus = "retained_for_revision";
        newState = "REVISION_REQUESTED";
      }
      if (review.decision !== "ACCEPT") {
        // Phase 6 §28: outcome.json is the immutable terminal descriptor,
        // frozen BEFORE the decision event so the Journal and the artifact
        // agree on the same result. For REVISE / BLOCK the binding does not
        // carry the Frozen Patch triple — only the decision summary.
        const terminalOutcome = {
          schema_version: 1,
          task_id: pending.task.task_id,
          execution_id: pending.executionId,
          decision: review.decision,
          state: newState,
          patch_status: patchStatus,
        };
        await writeImmutableArtifact(
          resolve(this.options.artifactRoot, pending.executionId, "outcome.json"),
          Buffer.from(`${JSON.stringify(terminalOutcome, null, 2)}\n`, "utf8"),
        );
        const applied = applyBoundReview(review, pending.bundle, reviewContext);
        if (applied.kind === "applied") {
          this.projectDurable(applied.event, applied.newState);
          releaseLease = true;
        }
      }
      if (pending.reservation !== undefined && newState !== undefined) {
        await this.options.storageManager?.releaseReservation(
          pending.reservation,
          `review decision ${review.decision}`,
        ).catch(() => undefined);
      }
      if (review.decision === "ACCEPT") {
        // P1#3: cleanup is best-effort maintenance. ACCEPT is already
        // durable in the Journal (review.accept.completed). A failure
        // here must not surface to the caller as a "failed ACCEPT".
        // The scanner's RETAINED_WORKTREE_CANDIDATE will surface the
        // leftover for the next operator.
        await removeTemporaryWorktree(pending.worktree).catch(() => undefined);
      }
      if (this.options.storageManager !== undefined) {
        const retentionClass = newState === "REVISION_REQUESTED" ? "RETAINED" : "NORMAL";
        const retentionDays = this.options.storageManager.storagePolicy?.completed_retention_days ?? 30;
        const gcEligibleAt = retentionClass === "NORMAL"
          ? Date.now() + retentionDays * 24 * 60 * 60 * 1000
          : null;
        await this.snapshotStorage(pending.executionId, pending.worktree.worktreePath, retentionClass, gcEligibleAt);
      }
      this.pending.delete(pending.bundle.bundleId);

      return Object.freeze({
        taskId: pending.task.task_id,
        executionId: pending.executionId,
        decision: review.decision,
        state: newState as CompletedReviewExecution["state"],
        patchStatus,
        ...(review.newTaskId !== undefined ? { newTaskId: review.newTaskId } : {}),
      });
    } finally {
      if (releaseLease) {
        try { this.options.workspaceLock.release(lockHandle); } catch { /* terminal outcome remains durable */ }
      }
    }
  }
}
