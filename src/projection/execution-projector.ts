import type { TaskEvent } from "../events/events.js";
import { fingerprintHash } from "../execution/fingerprint.js";
import type { TaskState } from "../execution/state-machine.js";
import { StateDatabase } from "./database.js";

export interface WorkspaceSeed {
  readonly workspaceId: string;
  readonly canonicalPath: string;
}

export interface ProjectionMetadata {
  readonly artifactPath?: string;
  readonly worktreePath?: string;
  readonly runtime?: string;
  readonly runtimeVersion?: string;
  readonly model?: string;
}

export interface ProjectionReplayStep {
  readonly event: TaskEvent;
  readonly state: TaskState;
  readonly metadata?: ProjectionMetadata;
}

export interface ReplaceExecutionOptions {
  readonly staleReason?: string;
}

export interface ExecutionProjection {
  project(event: TaskEvent, state: TaskState, metadata?: ProjectionMetadata): void;
}

export interface ExecutionProjectionRow {
  readonly execution_id: string;
  readonly task_id: string;
  readonly workspace_id: string | null;
  readonly state: TaskState;
  readonly created_at: number;
  readonly updated_at: number;
  readonly base_revision: string | null;
  readonly runtime: string | null;
  readonly runtime_version: string | null;
  readonly model: string | null;
  readonly fingerprint_hash: string | null;
  readonly artifact_path: string | null;
  readonly worktree_path: string | null;
  readonly review_bundle_id: string | null;
  readonly retention_class: string | null;
  readonly gc_eligible_at: number | null;
}

export interface RecoveryCaseRow {
  readonly execution_id: string;
  readonly status: string;
  readonly reason: string;
  readonly created_at: number;
  readonly resolved_at: number | null;
}

function textPayload(event: TaskEvent, snake: string, camel: string): string | undefined {
  const value = event.payload[snake] ?? event.payload[camel];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function taskBinding(event: TaskEvent): { workspaceId?: string; baseRevision?: string } {
  const task = event.payload["task"];
  if (task === null || typeof task !== "object") return {};
  const scope = (task as { workspace_scope?: unknown }).workspace_scope;
  if (scope === null || typeof scope !== "object") return {};
  const workspaceId = (scope as { workspace_id?: unknown }).workspace_id;
  const baseRevision = (scope as { base_revision?: unknown }).base_revision;
  return {
    ...(typeof workspaceId === "string" ? { workspaceId } : {}),
    ...(typeof baseRevision === "string" ? { baseRevision } : {}),
  };
}

function retentionClass(state: TaskState): string | null {
  if (state === "REVIEW_PENDING" || state === "REVISION_REQUESTED") return "RETAINED";
  if (state === "RECOVERY_REQUIRED") return "RECOVERY_CRITICAL";
  if (["ACCEPTED", "BLOCKED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(state)) {
    return "NORMAL";
  }
  return null;
}

export class ExecutionProjector implements ExecutionProjection {
  constructor(private readonly database: StateDatabase) {}

  project(event: TaskEvent, state: TaskState, metadata: ProjectionMetadata = {}): void {
    this.database.transaction(() => this.projectWithinTransaction(event, state, metadata));
  }

  replaceExecution(
    executionId: string,
    steps: readonly ProjectionReplayStep[],
    options: ReplaceExecutionOptions = {},
  ): void {
    if (steps.length === 0) {
      throw new Error("replaceExecution requires at least one replay step");
    }
    for (const step of steps) {
      if (step.event.attemptId !== executionId) {
        throw new Error(
          `replaceExecution replay step attemptId ${step.event.attemptId} does not match ${executionId}`,
        );
      }
    }

    this.database.transaction(() => {
      this.resetExecution(executionId);
      for (const step of steps) {
        this.projectWithinTransaction(step.event, step.state, step.metadata ?? {});
      }
      if (options.staleReason !== undefined) {
        this.database.setMeta(`execution:${executionId}:stale`, options.staleReason);
      }
    });
  }

  invalidateExecution(executionId: string, reason: string): void {
    this.database.transaction(() => {
      this.resetExecution(executionId);
      this.database.setMeta(`execution:${executionId}:stale`, reason);
    });
  }

  execution(executionId: string): ExecutionProjectionRow | undefined {
    return this.database.prepare(
      "SELECT * FROM executions WHERE execution_id = ?",
    ).get(executionId) as ExecutionProjectionRow | undefined;
  }

  recoveryCase(executionId: string): RecoveryCaseRow | undefined {
    return this.database.prepare(
      "SELECT * FROM recovery_cases WHERE execution_id = ?",
    ).get(executionId) as RecoveryCaseRow | undefined;
  }

  /**
   * Seed the `workspaces` table from trusted CLI configuration. The Journal
   * does not capture workspace identity because workspace bindings come from
   * the local config file, not from the execution. The projector is the
   * canonical writer for the projection, so this method lives here and is
   * reused by `rebuildProjection`.
   *
   * UPSERT semantics: re-seeding refreshes `canonical_path` and `updated_at`
   * but does not delete rows the caller did not include.
   */
  seedWorkspaces(workspaces: readonly WorkspaceSeed[], nowMs: number): void {
    if (workspaces.length === 0) return;
    const statement = this.database.prepare(`
      INSERT INTO workspaces(workspace_id, canonical_path, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        canonical_path = excluded.canonical_path,
        updated_at = excluded.updated_at
    `);
    for (const workspace of workspaces) {
      statement.run(workspace.workspaceId, workspace.canonicalPath, nowMs);
    }
  }

  private projectWithinTransaction(
    event: TaskEvent,
    state: TaskState,
    metadata: ProjectionMetadata,
  ): void {
    if (event.domain === "projection") {
      this.updateCursor(event);
      return;
    }

    if (event.type === "task.created") {
      this.createExecution(event, state, metadata);
    } else {
      const existing = this.execution(event.attemptId);
      if (existing === undefined) {
        throw new Error(
          `cannot project ${event.type} for ${event.attemptId}: task.created projection is absent`,
        );
      }
      this.updateExecution(event, state, metadata);
    }

    this.projectArtifact(event);
    this.projectReview(event);
    this.projectRecovery(event);
    this.updateCursor(event);
  }

  private updateCursor(event: TaskEvent): void {
    this.database.setMeta(`execution:${event.attemptId}:last_event_hash`, event.hash);
    this.database.setMeta(`execution:${event.attemptId}:last_event_seq`, String(event.seq));
  }

  private resetExecution(executionId: string): void {
    for (const table of [
      "artifacts",
      "reviews",
      "recovery_cases",
      "storage_usage",
      "storage_reservations",
      "executions",
    ]) {
      this.database.prepare(`DELETE FROM ${table} WHERE execution_id = ?`).run(executionId);
    }

    const prefix = `execution:${executionId}:`;
    this.database.prepare(
      "DELETE FROM projection_meta WHERE substr(key, 1, length(?)) = ?",
    ).run(prefix, prefix);
  }

  private createExecution(
    event: TaskEvent,
    state: TaskState,
    metadata: ProjectionMetadata,
  ): void {
    const binding = taskBinding(event);
    this.database.prepare(`
      INSERT INTO executions(
        execution_id, task_id, workspace_id, state, created_at, updated_at,
        base_revision, runtime, runtime_version, model, fingerprint_hash,
        artifact_path, worktree_path, retention_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        task_id = excluded.task_id,
        workspace_id = COALESCE(executions.workspace_id, excluded.workspace_id),
        state = excluded.state,
        updated_at = excluded.updated_at,
        base_revision = COALESCE(executions.base_revision, excluded.base_revision),
        artifact_path = COALESCE(executions.artifact_path, excluded.artifact_path)
    `).run(
      event.attemptId,
      event.taskId,
      binding.workspaceId ?? null,
      state,
      event.timestampMs,
      event.timestampMs,
      binding.baseRevision ?? null,
      metadata.runtime ?? null,
      metadata.runtimeVersion ?? null,
      metadata.model ?? null,
      event.fingerprint !== undefined ? fingerprintHash(event.fingerprint) : null,
      metadata.artifactPath ?? null,
      metadata.worktreePath ?? null,
      retentionClass(state),
    );
  }

  private updateExecution(
    event: TaskEvent,
    state: TaskState,
    metadata: ProjectionMetadata,
  ): void {
    const reviewBundleId = textPayload(event, "review_bundle_id", "reviewBundleId");
    this.database.prepare(`
      UPDATE executions SET
        state = ?,
        updated_at = ?,
        runtime = COALESCE(?, runtime),
        runtime_version = COALESCE(?, runtime_version),
        model = COALESCE(?, model),
        fingerprint_hash = COALESCE(?, fingerprint_hash),
        artifact_path = COALESCE(?, artifact_path),
        worktree_path = COALESCE(?, worktree_path),
        review_bundle_id = COALESCE(?, review_bundle_id),
        retention_class = COALESCE(?, retention_class)
      WHERE execution_id = ?
    `).run(
      state,
      event.timestampMs,
      metadata.runtime ?? null,
      metadata.runtimeVersion ?? null,
      metadata.model ?? null,
      event.fingerprint !== undefined ? fingerprintHash(event.fingerprint) : null,
      metadata.artifactPath ?? null,
      metadata.worktreePath ?? null,
      reviewBundleId ?? null,
      retentionClass(state),
      event.attemptId,
    );
  }

  private projectArtifact(event: TaskEvent): void {
    if (event.type !== "patch.frozen") return;
    const artifactId = textPayload(event, "artifact_id", "artifactId");
    const path = textPayload(event, "artifact_path", "artifactPath");
    const hash = textPayload(event, "patch_blob_hash", "patchBlobHash");
    const bytes = event.payload["patch_bytes"] ?? event.payload["patchBytes"];
    if (artifactId === undefined || path === undefined || hash === undefined || typeof bytes !== "number") {
      throw new Error("patch.frozen has incomplete artifact bindings");
    }
    this.database.prepare(`
      INSERT INTO artifacts(artifact_id, execution_id, kind, path, sha256, bytes, immutable)
      VALUES (?, ?, 'frozen.patch', ?, ?, ?, 1)
      ON CONFLICT(artifact_id) DO UPDATE SET
        execution_id = excluded.execution_id,
        path = excluded.path,
        sha256 = excluded.sha256,
        bytes = excluded.bytes
    `).run(artifactId, event.attemptId, path, hash, bytes);
  }

  private projectReview(event: TaskEvent): void {
    const bundleId = textPayload(event, "review_bundle_id", "reviewBundleId");
    if (bundleId === undefined) return;
    const reviewId = textPayload(event, "review_id", "reviewId");
    const reviewHash = textPayload(event, "review_hash", "reviewHash");
    const decision = event.type.startsWith("review.decision.")
      ? event.type.slice("review.decision.".length).toUpperCase()
      : undefined;
    this.database.prepare(`
      INSERT INTO reviews(review_bundle_id, execution_id, review_id, decision, review_hash, applied_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_bundle_id) DO UPDATE SET
        review_id = COALESCE(excluded.review_id, reviews.review_id),
        decision = COALESCE(excluded.decision, reviews.decision),
        review_hash = COALESCE(excluded.review_hash, reviews.review_hash),
        applied_at = COALESCE(excluded.applied_at, reviews.applied_at)
    `).run(
      bundleId,
      event.attemptId,
      reviewId ?? null,
      decision ?? null,
      reviewHash ?? null,
      decision !== undefined ? event.timestampMs : null,
    );
  }

  private projectRecovery(event: TaskEvent): void {
    if (event.type === "recovery.required") {
      const reason = textPayload(event, "reason", "reason") ?? "unspecified recovery requirement";
      this.database.prepare(`
        INSERT INTO recovery_cases(execution_id, status, reason, created_at, resolved_at)
        VALUES (?, 'OPEN', ?, ?, NULL)
        ON CONFLICT(execution_id) DO UPDATE SET
          status = 'OPEN', reason = excluded.reason, resolved_at = NULL
      `).run(event.attemptId, reason, event.timestampMs);
    } else if (event.type === "recovery.reconciled") {
      this.database.prepare(`
        UPDATE recovery_cases SET status = 'RESOLVED', resolved_at = ?
        WHERE execution_id = ?
      `).run(event.timestampMs, event.attemptId);
    }
  }
}
