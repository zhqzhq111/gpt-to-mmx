import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import type { G2MLocalConfig } from "../cli/config.js";
import { EventStore } from "../events/store.js";
import { rebuildProjection } from "../projection/rebuild.js";
import { StateDatabase } from "../projection/database.js";
import { reconcileStorageReservations } from "../storage/reservation.js";
import { resumeInterrupted } from "../storage/gc.js";
import { WorkspaceLock } from "../workspace/lock.js";
import { sha256 } from "../protocol/hash.js";
import { buildOperationalSnapshot, type OperationalOptions, type OperationalSnapshot } from "./snapshot.js";
import { acquireRepairLock } from "./repair-lock.js";
import { writeRepairAudit } from "./repair-audit.js";

export type RepairAction = "projection-rebuild" | "gc-resume" | "storage-reconcile";

export class RepairActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairActionError";
  }
}

export interface RepairOptions extends OperationalOptions {
  readonly action: string;
  readonly apply: boolean;
  readonly operationId?: string;
}

export interface RepairDependencies {
  readonly buildSnapshot?: (options: OperationalOptions) => Promise<OperationalSnapshot>;
  readonly dispatch?: (plan: RepairPlan, config: G2MLocalConfig) => Promise<unknown>;
}

export interface RepairPlan {
  readonly schemaVersion: "g2m.repair-plan.v1";
  readonly operationId: string;
  readonly generatedAt: number;
  readonly action: string;
  readonly executionId: string | null;
  readonly applyRequired: true;
  readonly permitted: boolean;
  readonly preconditionHash: string;
  readonly reasons: readonly string[];
  readonly target: string;
}

export interface RepairResult {
  readonly schemaVersion: "g2m.repair-result.v1";
  readonly operationId: string;
  readonly generatedAt: number;
  readonly action: string;
  readonly executionId: string | null;
  readonly status: "APPLIED" | "REFUSED" | "FAILED";
  readonly result: unknown;
  readonly reasons: readonly string[];
}

const allowlist = new Set<string>(["projection-rebuild", "gc-resume", "storage-reconcile"]);
const forbidden = new Set<string>(["all", "force", "delete-anyway", "ignore-journal", "ignore-recovery", "ignore-lease", "trust-sqlite", "rewrite-journal"]);

function stateRoot(config: G2MLocalConfig): string {
  return config.state_root ?? resolve(config.artifact_root, "state");
}

function preconditionHash(snapshot: OperationalSnapshot): string {
  // Acquiring the repair lock creates the control-plane directory itself. It
  // must not make an otherwise identical data snapshot stale, especially when
  // this is the first repair against a previously absent state root.
  const stableWorkspaces = snapshot.workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    canonicalPath: workspace.canonicalPath,
    canonicalPathExists: workspace.canonicalPathExists,
    lease: {
      status: workspace.lease.status,
      executionId: workspace.lease.executionId,
      leaseId: workspace.lease.leaseId,
      hostname: workspace.lease.hostname,
      pid: workspace.lease.pid,
    },
  }));
  // Physical free-space readings and heartbeat ages are intentionally
  // volatile. The action-specific persistent records below remain in the
  // execution/recovery/GC portions of the snapshot and are revalidated after
  // the lock is held.
  const { storage: _volatileStorage, workspaces: _volatileWorkspaces, ...stable } = snapshot;
  void _volatileStorage;
  void _volatileWorkspaces;
  return sha256({ ...stable, generatedAt: 0, stateRoot: { ...snapshot.stateRoot, stateRootExists: true }, workspaces: stableWorkspaces });
}

export async function planRepair(options: RepairOptions, dependencies: RepairDependencies = {}): Promise<RepairPlan> {
  if (forbidden.has(options.action) || !allowlist.has(options.action)) {
    throw new RepairActionError(`repair action is not allowlisted: ${options.action}`);
  }
  const snapshot = await (dependencies.buildSnapshot ?? buildOperationalSnapshot)(options);
  const reasons: string[] = [];
  if (options.action === "gc-resume") {
    const target = options.executionId === undefined
      ? snapshot.gc.interruptedCount
      : snapshot.executions.some((execution) => execution.executionId === options.executionId && execution.gcStatus === "INTERRUPTED") ? 1 : 0;
    if (target === 0) reasons.push("no interrupted GC operation is eligible for resume");
  }
  if (options.action !== "projection-rebuild" && !snapshot.projection.databaseExists) reasons.push("projection database is required by this repair action");
  if (options.executionId !== undefined && options.action === "projection-rebuild") reasons.push("projection rebuild operates on the complete state root");
  return {
    schemaVersion: "g2m.repair-plan.v1",
    operationId: options.operationId ?? randomUUID(),
    generatedAt: snapshot.generatedAt,
    action: options.action,
    executionId: options.executionId ?? null,
    applyRequired: true,
    permitted: reasons.length === 0,
    preconditionHash: preconditionHash(snapshot),
    reasons: Object.freeze(reasons),
    target: options.executionId === undefined ? "state-root" : `execution:${options.executionId}`,
  };
}

function gcOptions(config: G2MLocalConfig, nowMs: number, executionId: string | undefined) {
  const root = stateRoot(config);
  const eventStore = new EventStore({ executionDirectory: join(root, "executions"), tolerateLoadErrors: true });
  const database = new StateDatabase(join(root, "g2m-state.sqlite"));
  const workspaceLock = new WorkspaceLock({ stateRoot: root });
  return {
    options: {
      stateRoot: root, artifactRoot: config.artifact_root, worktreeRoot: config.worktree_root, eventStore, database, nowMs,
      ...(executionId !== undefined ? { executionId } : {}), completedRetentionDays: config.storage.completed_retention_days,
      workspaces: config.workspaces.map((workspace) => ({ workspaceId: workspace.workspace_id, canonicalPath: workspace.path })), workspaceLock,
    } as const,
    close: () => { eventStore.close(); database.close(); },
  };
}

async function dispatch(plan: RepairPlan, config: G2MLocalConfig): Promise<unknown> {
  const nowMs = plan.generatedAt;
  if (plan.action === "projection-rebuild") {
    return rebuildProjection({
      stateRoot: stateRoot(config), nowMs,
      workspaces: config.workspaces.map((workspace) => ({ workspaceId: workspace.workspace_id, canonicalPath: workspace.path })),
      completedRetentionDays: config.storage.completed_retention_days,
    });
  }
  const resources = gcOptions(config, nowMs, plan.executionId ?? undefined);
  try {
    if (plan.action === "gc-resume") return resumeInterrupted(resources.options);
    return reconcileStorageReservations({ stateRoot: stateRoot(config), database: resources.options.database, eventStore: resources.options.eventStore, nowMs });
  } finally { resources.close(); }
}

export async function executeRepair(options: RepairOptions & { readonly apply: true }, dependencies: RepairDependencies = {}): Promise<RepairResult> {
  const plan = await planRepair(options, dependencies);
  const resultBase = {
    schemaVersion: "g2m.repair-result.v1" as const,
    operationId: plan.operationId,
    generatedAt: plan.generatedAt,
    action: plan.action,
    executionId: plan.executionId,
  };
  if (!plan.permitted) {
    return { ...resultBase, status: "REFUSED", result: null, reasons: plan.reasons };
  }
  const lock = await acquireRepairLock(stateRoot(options.config), { operationId: plan.operationId, nowMs: plan.generatedAt });
  try {
    const freshPlan = await planRepair({ ...options, operationId: plan.operationId }, dependencies);
    const stale = plan.action !== freshPlan.action || plan.executionId !== freshPlan.executionId || plan.permitted !== freshPlan.permitted || plan.target !== freshPlan.target || plan.preconditionHash !== freshPlan.preconditionHash || JSON.stringify(plan.reasons) !== JSON.stringify(freshPlan.reasons);
    if (stale) {
      const result: RepairResult = {
        ...resultBase,
        status: "REFUSED",
        result: { originalPreconditionHash: plan.preconditionHash, freshPreconditionHash: freshPlan.preconditionHash },
        reasons: ["REPAIR_PLAN_STALE"],
      };
      await writeRepairAudit({ stateRoot: stateRoot(options.config), operationId: plan.operationId, phase: "result", action: plan.action, createdAt: Date.now(), payload: result });
      return result;
    }
    await writeRepairAudit({ stateRoot: stateRoot(options.config), operationId: plan.operationId, phase: "plan", action: plan.action, createdAt: plan.generatedAt, payload: plan });
    await writeRepairAudit({ stateRoot: stateRoot(options.config), operationId: plan.operationId, phase: "start", action: plan.action, createdAt: Date.now(), payload: { target: plan.target } });
    try {
      const value = await (dependencies.dispatch ?? dispatch)(freshPlan, options.config);
      const result: RepairResult = { ...resultBase, status: "APPLIED", result: value, reasons: [] };
      await writeRepairAudit({ stateRoot: stateRoot(options.config), operationId: plan.operationId, phase: "result", action: plan.action, createdAt: Date.now(), payload: result });
      return result;
    } catch (error) {
      const result: RepairResult = { ...resultBase, status: "FAILED", result: null, reasons: [error instanceof Error ? error.message : String(error)] };
      await writeRepairAudit({ stateRoot: stateRoot(options.config), operationId: plan.operationId, phase: "result", action: plan.action, createdAt: Date.now(), payload: result });
      return result;
    }
  } finally { await lock.release(); }
}
