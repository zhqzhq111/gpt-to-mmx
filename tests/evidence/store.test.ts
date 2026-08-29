/**
 * Evidence Store — plan §26 + §45
 */

import { describe, it, expect } from "vitest";

import {
  EvidenceStore,
  EvidenceStoreError,
  recordWorkerEvidence,
  recordWorkspaceEvidence,
  recordVerificationEvidence,
} from "../../src/evidence/store.js";
import type { WorkerResult } from "../../src/workers/coding-worker.js";
import type { DiffResult } from "../../src/evidence/diff.js";
import type { WorkspaceBaseline } from "../../src/workspace/baseline.js";
import type { VerificationResult } from "../../src/evidence/verification.js";

function fakeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    executionId: "exec-1",
    sessionId: "sess-1",
    summary: "test summary",
    filesChanged: ["a.ts"],
    testsAttempted: [{ name: "t1", status: "passed" }],
    remainingRisks: [],
    ...overrides,
  };
}

function fakeDiff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    workspacePath: "/ws",
    baseRevision: "abc123",
    fullDiff: "diff --git a/a.ts b/a.ts\n+new line",
    diffStat: " a.ts | 1 +",
    changedFiles: [{ path: "a.ts", status: "M" }],
    untrackedFiles: [],
    deletedFiles: [],
    protectedFilesTouched: [],
    diffHash: "deadbeef".repeat(8),
    capturedAt: 1_000,
    ...overrides,
  };
}

function fakeBaseline(
  overrides: Partial<WorkspaceBaseline> = {},
): WorkspaceBaseline {
  return {
    canonicalPath: "/ws",
    baseRevision: "abc123",
    statusPorcelain: "",
    dirty: false,
    capturedAt: 1_000,
    ...overrides,
  };
}

function fakeVerification(
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    profileId: "tests",
    workspaceId: "ws-1",
    workspacePath: "/ws",
    program: "npm",
    args: ["test"],
    status: "passed",
    exitCode: 0,
    signal: null,
    stdout: "all passed",
    stderr: "",
    durationMs: 1_000,
    startedAt: 0,
    finishedAt: 1_000,
    resultHash: "0".repeat(64),
    ...overrides,
  };
}

describe("EvidenceStore basic put / get", () => {
  it("stores and retrieves evidence by id", () => {
    const store = new EvidenceStore();
    const ev = recordWorkerEvidence(store, "task-1", "exec-1", fakeWorkerResult());
    expect(store.get(ev.evidenceId)).toBe(ev);
  });

  it("returns undefined for missing evidenceId", () => {
    const store = new EvidenceStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("throws DUPLICATE_EVIDENCE_ID on re-put with the same id", () => {
    const store = new EvidenceStore();
    const ev = recordWorkerEvidence(store, "task-1", "exec-1", fakeWorkerResult());
    expect(() => store.put(ev)).toThrow(EvidenceStoreError);
    try {
      store.put(ev);
    } catch (e) {
      expect((e as EvidenceStoreError).code).toBe("DUPLICATE_EVIDENCE_ID");
    }
  });

  it("generates unique evidenceIds (different UUIDs for each record)", () => {
    const store = new EvidenceStore();
    const a = recordWorkerEvidence(store, "t", "e", fakeWorkerResult());
    const b = recordWorkerEvidence(store, "t", "e", fakeWorkerResult());
    expect(a.evidenceId).not.toBe(b.evidenceId);
  });

  it("evidenceId format is `${type}-${uuid}`", () => {
    const store = new EvidenceStore();
    const w = recordWorkerEvidence(store, "t", "e", fakeWorkerResult());
    const d = recordWorkspaceEvidence(store, "t", "e", fakeDiff(), fakeBaseline());
    const v = recordVerificationEvidence(store, "t", "e", fakeVerification());
    expect(w.evidenceId).toMatch(/^worker-/);
    expect(d.evidenceId).toMatch(/^workspace-/);
    expect(v.evidenceId).toMatch(/^verification-/);
  });
});

describe("EvidenceStore indexes", () => {
  it("indexes by executionId", () => {
    const store = new EvidenceStore();
    recordWorkerEvidence(store, "task-1", "exec-1", fakeWorkerResult());
    recordWorkspaceEvidence(store, "task-1", "exec-1", fakeDiff(), fakeBaseline());
    recordVerificationEvidence(store, "task-1", "exec-1", fakeVerification());
    recordWorkerEvidence(store, "task-1", "exec-2", fakeWorkerResult());
    expect(store.getByExecution("exec-1")).toHaveLength(3);
    expect(store.getByExecution("exec-2")).toHaveLength(1);
    expect(store.getByExecution("nope")).toEqual([]);
  });

  it("indexes by taskId", () => {
    const store = new EvidenceStore();
    recordWorkerEvidence(store, "task-1", "exec-1", fakeWorkerResult());
    recordWorkerEvidence(store, "task-1", "exec-2", fakeWorkerResult());
    recordWorkerEvidence(store, "task-2", "exec-3", fakeWorkerResult());
    expect(store.getByTask("task-1")).toHaveLength(2);
    expect(store.getByTask("task-2")).toHaveLength(1);
    expect(store.getByTask("nope")).toEqual([]);
  });

  it("filters by type via listByType", () => {
    const store = new EvidenceStore();
    recordWorkerEvidence(store, "t", "e1", fakeWorkerResult());
    recordWorkspaceEvidence(store, "t", "e1", fakeDiff(), fakeBaseline());
    recordVerificationEvidence(store, "t", "e1", fakeVerification());
    expect(store.listByType("worker")).toHaveLength(1);
    expect(store.listByType("workspace")).toHaveLength(1);
    expect(store.listByType("verification")).toHaveLength(1);
  });

  it("index snapshots are defensive copies (concurrent get returns same length)", () => {
    const store = new EvidenceStore();
    recordWorkerEvidence(store, "t", "e", fakeWorkerResult());
    const first = store.getByExecution("e");
    const second = store.getByExecution("e");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first).not.toBe(second);
  });
});

describe("Evidence content_hash (plan §45 anti-replay binding)", () => {
  it("WorkerEvidence contentHash is stable for the same payload", () => {
    const store = new EvidenceStore();
    const r1 = fakeWorkerResult();
    const r2: WorkerResult = { ...r1, testsAttempted: [...r1.testsAttempted] };
    const a = recordWorkerEvidence(store, "t", "e", r1);
    const b = recordWorkerEvidence(store, "t", "e", r2);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("WorkerEvidence contentHash differs when rawEventLogRef is set", () => {
    const store = new EvidenceStore();
    const r = fakeWorkerResult();
    const a = recordWorkerEvidence(store, "t", "e", r);
    const b = recordWorkerEvidence(store, "t", "e", r, {
      rawEventLogRef: "/tmp/events.jsonl",
    });
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(b.rawEventLogRef).toBe("/tmp/events.jsonl");
  });

  it("WorkspaceEvidence contentHash is stable for the same diff + baseline", () => {
    const store = new EvidenceStore();
    const a = recordWorkspaceEvidence(
      store,
      "t",
      "e",
      fakeDiff(),
      fakeBaseline(),
    );
    const b = recordWorkspaceEvidence(
      store,
      "t",
      "e",
      fakeDiff(),
      fakeBaseline(),
    );
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("WorkspaceEvidence contentHash differs when diff content differs", () => {
    const store = new EvidenceStore();
    const a = recordWorkspaceEvidence(
      store,
      "t",
      "e",
      fakeDiff({ fullDiff: "diff A" }),
      fakeBaseline(),
    );
    const b = recordWorkspaceEvidence(
      store,
      "t",
      "e",
      fakeDiff({ fullDiff: "diff B" }),
      fakeBaseline(),
    );
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("VerificationEvidence contentHash includes the verification status", () => {
    const store = new EvidenceStore();
    const a = recordVerificationEvidence(
      store,
      "t",
      "e",
      fakeVerification({ status: "passed" }),
    );
    const b = recordVerificationEvidence(
      store,
      "t",
      "e",
      fakeVerification({ status: "failed" }),
    );
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("EvidenceStore.size() reflects total evidence", () => {
    const store = new EvidenceStore();
    expect(store.size()).toBe(0);
    recordWorkerEvidence(store, "t", "e", fakeWorkerResult());
    expect(store.size()).toBe(1);
    recordWorkspaceEvidence(store, "t", "e", fakeDiff(), fakeBaseline());
    recordVerificationEvidence(store, "t", "e", fakeVerification());
    expect(store.size()).toBe(3);
  });
});
