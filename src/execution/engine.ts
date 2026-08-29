/**
 * G2M execution engine — connects the previously independent MVP modules.
 *
 * The engine validates a structured task, runs the Worker only in a temporary
 * Git worktree, collects independent evidence, builds a Review Bundle, then
 * applies or discards the frozen patch according to a bound Review decision.
 */

import { randomUUID } from "node:crypto";

import { EventStore } from "../events/store.js";
import { reduce } from "../events/reducer.js";
import { collectDiff } from "../evidence/diff.js";
import {
  EvidenceStore,
  recordVerificationEvidence,
  recordWorkerEvidence,
  recordWorkspaceEvidence,
} from "../evidence/store.js";
import { runVerification } from "../evidence/verification.js";
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
  applyAcceptedPatch,
  collectWorktreePatch,
  createTemporaryWorktree,
  removeTemporaryWorktree,
  type ApplyAcceptedPatchResult,
  type TemporaryWorktreeHandle,
  type WorktreePatch,
} from "../workspace/worktree.js";
import {
  computeTaskFingerprint,
  FingerprintRegistry,
  type TaskFingerprint,
} from "./fingerprint.js";
import type { TaskState } from "./state-machine.js";

export interface G2MExecutionEngineOptions {
  readonly workspaceRegistry: WorkspaceRegistry;
  readonly workspaceLock: WorkspaceLock;
  readonly profileRegistry: ProfileRegistry;
  readonly evidenceStore: EvidenceStore;
  readonly eventStore: EventStore;
  readonly fingerprintRegistry: FingerprintRegistry;
  readonly replayGuard: ReplayGuard;
  readonly worker: CodingWorkerAdapter;
  readonly workerRuntime: WorkerRuntimeInfo;
  readonly adapterContractVersion: string;
  readonly worktreeRoot: string;
  readonly artifactRoot: string;
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
    | "WORKER_TIMED_OUT"
    | "WORKER_CANCELLED"
    | "RECOVERY_REQUIRED"
    | "CAPABILITY_VIOLATION"
    | "VERIFICATION_FAILED"
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

    this.appendAndReduce(mutable, {
      taskId: task.task_id,
      executionId,
      type: "task.created",
      payload: { protocolVersion: task.protocol_version },
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
        lockHandle = this.options.workspaceLock.acquire(
          task.workspace_scope.workspace_id,
          executionId,
        );
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
      const baseline = await captureBaseline(worktree.worktreePath);
      const stableTaskHash = taskHash(task);
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
          model: this.options.workerRuntime.model,
          adapterContractVersion: this.options.adapterContractVersion,
          runtimeCapabilitySnapshotHash: sha256(runtimeSnapshot),
        },
      );
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
      };

      try {
        await this.options.worker.start(invocation);
      } catch (error) {
        this.appendAndReduce(mutable, {
          taskId: task.task_id,
          executionId,
          type: "agent.spawn.failed",
          payload: { message: (error as Error).message },
        });
        throw new G2MExecutionEngineError("WORKER_FAILED", "worker start failed", error);
      }
      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "agent.spawn.started",
        fingerprint,
      });

      let workerResult;
      try {
        workerResult = await this.options.worker.collectResult(executionId);
      } catch (error) {
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
      }
      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "agent.completed",
        fingerprint,
      });

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
      );
      recordVerificationEvidence(
        this.options.evidenceStore,
        task.task_id,
        executionId,
        verification,
      );

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

      const patch = await collectWorktreePatch(worktree, this.options.artifactRoot);
      const bundle = buildReviewBundle({
        task,
        taskHash: stableTaskHash,
        executionId,
        workerSummary: workerResult,
        workspaceEvidence: { diff, baseline },
        verificationEvidence: { verification },
        workerRuntime: this.options.workerRuntime,
      });
      this.appendAndReduce(mutable, {
        taskId: task.task_id,
        executionId,
        type: "review.requested",
        payload: { bundleId: bundle.bundleId },
        fingerprint,
      });
      if (mutable.state !== "REVIEW_PENDING") {
        throw new G2MExecutionEngineError(
          "WORKER_FAILED",
          `unexpected state ${mutable.state ?? "null"} after review.requested`,
        );
      }

      const pending: PendingReviewExecution = Object.freeze({
        task,
        taskHash: stableTaskHash,
        executionId,
        state: "REVIEW_PENDING",
        bundle,
        worktree,
        patch,
        fingerprint,
      });
      this.pending.set(bundle.bundleId, pending);
      return pending;
    } catch (error) {
      if (
        worktree !== undefined &&
        mutable.state !== "REVIEW_PENDING" &&
        !preserveWorktree
      ) {
        await removeTemporaryWorktree(worktree).catch(() => undefined);
      }
      if (error instanceof G2MExecutionEngineError) throw error;
      throw new G2MExecutionEngineError(
        "WORKSPACE_FAILED",
        (error as Error).message,
        error,
      );
    } finally {
      if (lockHandle !== undefined && this.options.workspaceLock.isHeld(lockHandle.workspaceId)) {
        this.options.workspaceLock.release(lockHandle);
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

    let lockHandle: LockHandle | undefined;
    try {
      lockHandle = this.options.workspaceLock.acquire(
        pending.task.workspace_scope.workspace_id,
        `review-${pending.executionId}`,
      );
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
      if (review.decision === "ACCEPT") {
        const appliedPatch = await applyAcceptedPatch(
          pending.worktree,
          pending.patch,
          pending.worktree.repositoryPath,
        );
        patchStatus = appliedPatch.status;
      } else if (review.decision === "BLOCK") {
        await removeTemporaryWorktree(pending.worktree);
        patchStatus = "discarded";
      } else {
        patchStatus = "retained_for_revision";
      }
      const appliedReview = applyBoundReview(review, pending.bundle, reviewContext);
      const newState = appliedReview.newState;
      if (review.decision === "ACCEPT") {
        await removeTemporaryWorktree(pending.worktree);
      }
      if (validation.kind === "idempotent" && appliedReview.kind !== "idempotent") {
        throw new G2MExecutionEngineError(
          "UNKNOWN_PENDING_EXECUTION",
          "review validation changed before the decision was recorded",
        );
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
      if (lockHandle !== undefined && this.options.workspaceLock.isHeld(lockHandle.workspaceId)) {
        this.options.workspaceLock.release(lockHandle);
      }
    }
  }
}
