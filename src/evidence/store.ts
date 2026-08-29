/**
 * Evidence Store — plan §26 + §45 + Phase 5
 *
 * 三种 evidence 类型的内存仓库(plan §26 Evidence Model):
 * - Worker Evidence:Final Summary, Reported Files, Reported Tests,
 *   stream-json Events, Session ID
 * - Workspace Evidence:Base Revision, git status, Changed Files,
 *   Full Git Diff, Diff Stat, Untracked Files, Deleted Files, Diff Hash
 * - Verification Evidence:Verification Profile, Exit Code, Duration,
 *   stdout/stderr logs, Pass / Fail
 *
 * 每个 evidence 都带:
 * - evidenceId (UUID,${type}-${uuid})
 * - taskId, executionId(索引维度)
 * - type
 * - contentHash(sha256 of canonical JSON payload,plan §45 anti-replay binding)
 * - createdAt
 *
 * 持久化不在本轮(Phase 9 Event Log 一起做,plan §52)。
 * 写入辅助是纯函数(不修改 MCodeAdapter / Parser),State Machine / Engine 在 Phase 8
 * 把 Adapter 输出转成 evidence 写入。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../protocol/hash.js";
import { appendJsonLine, readJsonLines } from "../persistence/durable-state.js";
import type { WorkerResult } from "../workers/coding-worker.js";
import type { DiffResult } from "./diff.js";
import type { WorkspaceBaseline } from "../workspace/baseline.js";
import type { VerificationResult } from "./verification.js";

export type EvidenceType = "worker" | "workspace" | "verification";

interface EvidenceMetadata {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly type: EvidenceType;
  readonly createdAt: number;
  readonly contentHash: string;
}

export interface WorkerEvidence extends EvidenceMetadata {
  readonly type: "worker";
  readonly workerResult: WorkerResult;
  readonly rawEventLogRef?: string;
}

export interface WorkspaceEvidence extends EvidenceMetadata {
  readonly type: "workspace";
  readonly diff: DiffResult;
  readonly baseline: WorkspaceBaseline;
}

export interface VerificationEvidence extends EvidenceMetadata {
  readonly type: "verification";
  readonly verification: VerificationResult;
}

export type Evidence =
  | WorkerEvidence
  | WorkspaceEvidence
  | VerificationEvidence;

function evidenceContentHash(evidence: Evidence): string {
  switch (evidence.type) {
    case "worker":
      return sha256({
        workerResult: evidence.workerResult,
        ...(evidence.rawEventLogRef !== undefined
          ? { rawEventLogRef: evidence.rawEventLogRef }
          : {}),
      });
    case "workspace":
      return sha256({ diff: evidence.diff, baseline: evidence.baseline });
    case "verification":
      return sha256({ verification: evidence.verification });
  }
}

export class EvidenceStoreError extends Error {
  readonly code: "DUPLICATE_EVIDENCE_ID" | "EVIDENCE_NOT_FOUND" | "PERSISTENCE_FAILED";
  constructor(
    code: EvidenceStoreError["code"],
    message: string,
  ) {
    super(message);
    this.name = "EvidenceStoreError";
    this.code = code;
  }
}

function appendToIndex<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, [value]);
  } else {
    existing.push(value);
  }
}

function newEvidenceId(type: EvidenceType): string {
  return `${type}-${randomUUID()}`;
}

export interface EvidenceStoreOptions {
  readonly directory?: string;
}

export class EvidenceStore {
  private readonly byId = new Map<string, Evidence>();
  // 次级索引。浅引用,值更新跟 byId 同步。
  private readonly byExecution = new Map<string, Evidence[]>();
  private readonly byTask = new Map<string, Evidence[]>();
  private readonly directory: string | undefined;

  constructor(options: EvidenceStoreOptions = {}) {
    this.directory = options.directory;
    if (this.directory === undefined) return;

    mkdirSync(this.directory, { recursive: true });
    const files = readdirSync(this.directory)
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
    for (const file of files) {
      for (const evidence of readJsonLines<Evidence>(join(this.directory, file))) {
        this.putInternal(evidence, false);
      }
    }
  }

  /**
   * 放入一个 evidence。evidenceId 重复抛 DUPLICATE_EVIDENCE_ID。
   * 返回入参本身,方便链式调用。
   */
  put<E extends Evidence>(evidence: E): E {
    this.putInternal(evidence, true);
    return evidence;
  }

  private putInternal<E extends Evidence>(evidence: E, persist: boolean): void {
    if (this.byId.has(evidence.evidenceId)) {
      throw new EvidenceStoreError(
        "DUPLICATE_EVIDENCE_ID",
        `evidenceId "${evidence.evidenceId}" already in store`,
      );
    }
    if (evidenceContentHash(evidence) !== evidence.contentHash) {
      throw new EvidenceStoreError(
        "PERSISTENCE_FAILED",
        `evidence "${evidence.evidenceId}" failed content hash validation`,
      );
    }
    if (persist && this.directory !== undefined) {
      const path = join(this.directory, `${encodeURIComponent(evidence.executionId)}.jsonl`);
      appendJsonLine(path, evidence);
    }
    this.byId.set(evidence.evidenceId, evidence);
    appendToIndex(this.byExecution, evidence.executionId, evidence);
    appendToIndex(this.byTask, evidence.taskId, evidence);
  }

  get(evidenceId: string): Evidence | undefined {
    return this.byId.get(evidenceId);
  }

  getByExecution(executionId: string): readonly Evidence[] {
    return (this.byExecution.get(executionId) ?? []).slice();
  }

  getByTask(taskId: string): readonly Evidence[] {
    return (this.byTask.get(taskId) ?? []).slice();
  }

  listByType(type: EvidenceType): readonly Evidence[] {
    const out: Evidence[] = [];
    for (const e of this.byId.values()) {
      if (e.type === type) out.push(e);
    }
    return out;
  }

  size(): number {
    return this.byId.size;
  }
}

/**
 * 写入 Worker Evidence。contentHash 绑 workerResult + 可选 rawEventLogRef,
 * 同一份 (workerResult, rawEventLogRef) 多次写入会得到相同 hash,
 * 符合 plan §45 anti-replay 语义。
 */
export function recordWorkerEvidence(
  store: EvidenceStore,
  taskId: string,
  executionId: string,
  workerResult: WorkerResult,
  options: { rawEventLogRef?: string } = {},
): WorkerEvidence {
  const payload: Record<string, unknown> = { workerResult };
  if (options.rawEventLogRef !== undefined) {
    payload["rawEventLogRef"] = options.rawEventLogRef;
  }
  const evidence: WorkerEvidence = {
    type: "worker",
    evidenceId: newEvidenceId("worker"),
    taskId,
    executionId,
    createdAt: Date.now(),
    contentHash: sha256(payload),
    workerResult,
    ...(options.rawEventLogRef !== undefined
      ? { rawEventLogRef: options.rawEventLogRef }
      : {}),
  };
  store.put(evidence);
  return evidence;
}

/**
 * 写入 Workspace Evidence。contentHash 绑 diff + baseline(plan §26 Workspace Evidence)。
 */
export function recordWorkspaceEvidence(
  store: EvidenceStore,
  taskId: string,
  executionId: string,
  diff: DiffResult,
  baseline: WorkspaceBaseline,
): WorkspaceEvidence {
  const evidence: WorkspaceEvidence = {
    type: "workspace",
    evidenceId: newEvidenceId("workspace"),
    taskId,
    executionId,
    createdAt: Date.now(),
    contentHash: sha256({ diff, baseline }),
    diff,
    baseline,
  };
  store.put(evidence);
  return evidence;
}

/**
 * 写入 Verification Evidence。contentHash 绑 verification result(plan §26 Verification Evidence)。
 */
export function recordVerificationEvidence(
  store: EvidenceStore,
  taskId: string,
  executionId: string,
  verification: VerificationResult,
): VerificationEvidence {
  const evidence: VerificationEvidence = {
    type: "verification",
    evidenceId: newEvidenceId("verification"),
    taskId,
    executionId,
    createdAt: Date.now(),
    contentHash: sha256({ verification }),
    verification,
  };
  store.put(evidence);
  return evidence;
}
