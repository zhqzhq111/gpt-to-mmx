/**
 * task_fingerprint — plan §53
 */

import { describe, it, expect } from "vitest";

import {
  computeTaskFingerprint,
  buildFingerprintV2Artifact,
  fingerprintHash,
  FingerprintRegistry,
  FingerprintRegistryError,
  type TaskFingerprint,
  validateFingerprintV2Artifact,
} from "../../src/execution/fingerprint.js";

function makeFP(overrides: Partial<TaskFingerprint> = {}): TaskFingerprint {
  return {
    taskHash: "task-hash-1",
    workspaceId: "ws-A",
    baseRevision: "HEAD",
    mcodeVersion: "0.2.7",
    model: "minimax/MiniMax-M3",
    permissionProfile: "coding_standard",
    maxSteps: 30,
    timeoutMs: 600_000,
    adapterContractVersion: "g2m.worker.v1",
    runtimeCapabilitySnapshotHash: "rt-cap-1",
    ...overrides,
  };
}

describe("computeTaskFingerprint", () => {
  it("returns a fingerprint with all 10 plan §53 fields populated", () => {
    const fp = computeTaskFingerprint(
      {
        taskHash: "t1",
        workspaceId: "ws-A",
        baseRevision: "HEAD",
        maxSteps: 30,
        timeoutMs: 600_000,
        permissionProfile: "coding_standard",
      },
      {
        mcodeVersion: "0.2.7",
        model: "minimax/MiniMax-M3",
        adapterContractVersion: "g2m.worker.v1",
        runtimeCapabilitySnapshotHash: "rt-cap-1",
      },
    );
    expect(fp.taskHash).toBe("t1");
    expect(fp.workspaceId).toBe("ws-A");
    expect(fp.baseRevision).toBe("HEAD");
    expect(fp.maxSteps).toBe(30);
    expect(fp.timeoutMs).toBe(600_000);
    expect(fp.permissionProfile).toBe("coding_standard");
    expect(fp.mcodeVersion).toBe("0.2.7");
    expect(fp.model).toBe("minimax/MiniMax-M3");
    expect(fp.adapterContractVersion).toBe("g2m.worker.v1");
    expect(fp.runtimeCapabilitySnapshotHash).toBe("rt-cap-1");
  });

  it("same inputs produce equal fingerprints", () => {
    const a = makeFP();
    const b = makeFP();
    expect(a).toEqual(b);
  });
});

describe("fingerprintHash", () => {
  it("is stable for identical fingerprints (plan §45 / §53 anti-replay)", () => {
    const a = makeFP();
    const b = makeFP();
    expect(fingerprintHash(a)).toBe(fingerprintHash(b));
  });

  it("is a 64-char hex string (sha256)", () => {
    expect(fingerprintHash(makeFP())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field changes (plan §53 binding)", () => {
    const baseline = makeFP();
    const variations: Array<Partial<TaskFingerprint>> = [
      { taskHash: "other" },
      { workspaceId: "ws-B" },
      { baseRevision: "main" },
      { mcodeVersion: "0.2.8" },
      { model: "other-model" },
      { permissionProfile: "read_only" },
      { maxSteps: 50 },
      { timeoutMs: 900_000 },
      { adapterContractVersion: "g2m.worker.v2" },
      { runtimeCapabilitySnapshotHash: "rt-cap-2" },
    ];
    for (const v of variations) {
      expect(fingerprintHash(makeFP(v))).not.toBe(fingerprintHash(baseline));
    }
  });
});

describe("FingerprintRegistry", () => {
  it("stores a fingerprint on freeze and retrieves it on get", () => {
    const reg = new FingerprintRegistry();
    const fp = makeFP();
    reg.freeze("task-1", fp);
    expect(reg.has("task-1")).toBe(true);
    expect(reg.get("task-1")).toBe(fp);
  });

  it("returns undefined for tasks that have not been frozen", () => {
    const reg = new FingerprintRegistry();
    expect(reg.get("task-unknown")).toBeUndefined();
    expect(reg.has("task-unknown")).toBe(false);
  });

  it("rejects double-freeze with ALREADY_FROZEN (plan §53 freeze is one-shot)", () => {
    const reg = new FingerprintRegistry();
    reg.freeze("task-1", makeFP());
    let caught: unknown;
    try {
      reg.freeze("task-1", makeFP({ mcodeVersion: "0.2.8" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FingerprintRegistryError);
    expect((caught as FingerprintRegistryError).code).toBe("ALREADY_FROZEN");
    // 第一次冻结的 fingerprint 还在
    expect(reg.get("task-1")?.mcodeVersion).toBe("0.2.7");
  });

  it("reset clears a frozen fingerprint (recovery use case, Phase 9)", () => {
    const reg = new FingerprintRegistry();
    reg.freeze("task-1", makeFP());
    reg.reset("task-1");
    expect(reg.has("task-1")).toBe(false);
    // 重新 freeze 应该成功
    expect(() => reg.freeze("task-1", makeFP({ mcodeVersion: "0.2.8" }))).not.toThrow();
    expect(reg.get("task-1")?.mcodeVersion).toBe("0.2.8");
  });

  it("tracks multiple tasks independently", () => {
    const reg = new FingerprintRegistry();
    reg.freeze("task-1", makeFP({ mcodeVersion: "0.2.7" }));
    reg.freeze("task-2", makeFP({ mcodeVersion: "0.2.8" }));
    expect(reg.size()).toBe(2);
    expect(reg.get("task-1")?.mcodeVersion).toBe("0.2.7");
    expect(reg.get("task-2")?.mcodeVersion).toBe("0.2.8");
  });
});

describe("fingerprint v2 artifact", () => {
  it("binds runtime, policy, and worker schema evidence while preserving v1", () => {
    const fingerprint = computeTaskFingerprint(
      {
        taskHash: "task-hash",
        workspaceId: "ws-A",
        baseRevision: "HEAD",
        maxSteps: 20,
        timeoutMs: 60_000,
        permissionProfile: "coding_standard",
      },
      {
        mcodeVersion: "1.0.0",
        model: null,
        adapterContractVersion: "g2m-worker-v2",
        runtimeCapabilitySnapshotHash: "cap-hash",
        runtimeIdentityHash: "runtime-hash",
        protectedPolicyHash: "policy-hash",
        workerSummarySchemaHash: "schema-hash",
      },
    );
    const artifact = buildFingerprintV2Artifact({
      taskId: "task-1",
      executionId: "exec-1",
      fingerprint,
    });
    expect(artifact.fingerprint_version).toBe(2);
    expect(artifact.model).toBeNull();
    expect(validateFingerprintV2Artifact(artifact)).toBe(true);
    expect(() => buildFingerprintV2Artifact({
      taskId: "task-1",
      executionId: "exec-1",
      fingerprint: makeFP(),
    })).toThrow(/v2/i);
  });
});
