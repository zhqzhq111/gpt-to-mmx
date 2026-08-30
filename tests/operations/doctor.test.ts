import { describe, expect, it } from "vitest";

import { buildDoctorReport, type DoctorSnapshotInput } from "../../src/operations/doctor.js";

const snapshot = (overrides: Partial<DoctorSnapshotInput> = {}): DoctorSnapshotInput => ({
  schemaVersion: "g2m.status.v1",
  generatedAt: 100,
  stateRoot: {
    stateRootExists: true,
    executionsDirectoryExists: true,
    locksDirectoryExists: true,
    reservationsDirectoryExists: true,
    tombstonesDirectoryExists: true,
    projectionDatabaseExists: true,
  },
  executions: [],
  workspaces: [],
  projection: {
    status: "OK", databaseExists: true, databaseReadable: true, schemaVersion: 1,
    rebuildStatus: "complete", rebuildAt: 100, staleExecutionCount: 0, projectionStaleEventCount: 0,
  },
  storage: {
    managedArtifactBytes: 0, managedWorktreeBytes: 0, managedTotalBytes: 0, activeReservedBytes: 0,
    maxTotalBytes: 0, maxArtifactBytes: 0, maxWorktreeBytes: 0, volumes: [],
  },
  recovery: { openRecoveryCases: 0, executionsRequiringRecovery: [], issuesByKind: {}, safeHoldCount: 0, reportOnlyCount: 0 },
  gc: { eligibleCount: 0, estimatedReclaimBytes: 0, interruptedCount: 0, cleanupPendingCount: 0, tombstoneCount: 0, invalidTombstoneCount: 0 },
  reclaimGuard: { state: "MISSING", path: "state/repair/repair.lock.reclaim", guardId: null, operationId: null, pid: null, hostname: null, heartbeatAgeMs: null, stale: null },
  ...overrides,
});

describe("operational doctor", () => {
  it("returns deterministic PASS checks for a consistent snapshot", () => {
    const report = buildDoctorReport(snapshot());
    expect(report.schemaVersion).toBe("g2m.doctor.v1");
    expect(report.status).toBe("PASS");
    expect(report.checks.map((check) => check.id)).toEqual([...report.checks].map((check) => check.id).sort());
    expect(report.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("fails on safe holds and warns on degraded projection", () => {
    const report = buildDoctorReport(snapshot({
      projection: {
        ...snapshot().projection, status: "MISSING", databaseExists: false, databaseReadable: false,
      },
      recovery: { ...snapshot().recovery, safeHoldCount: 1, executionsRequiringRecovery: ["exec-1"] },
    }));
    expect(report.status).toBe("FAIL");
    expect(report.checks.find((check) => check.id === "recovery.safe-holds")?.status).toBe("FAIL");
    expect(report.checks.find((check) => check.id === "projection.readable")?.status).toBe("WARN");
  });

  it("surfaces stale lease owners with severity based on their disposition", () => {
    const report = buildDoctorReport(snapshot({
      workspaces: [
        { workspaceId: "ws-active-stale", canonicalPath: "C:/a", canonicalPathExists: true, lease: { status: "ACTIVE_EXECUTION_STALE_OWNER", executionId: "e1", leaseId: "l1", hostname: "host", pid: 1, heartbeatAgeMs: 100 } },
        { workspaceId: "ws-terminal-stale", canonicalPath: "C:/b", canonicalPathExists: true, lease: { status: "STALE_TERMINAL_RECLAIMABLE", executionId: "e2", leaseId: "l2", hostname: "host", pid: 2, heartbeatAgeMs: 100 } },
      ],
    }));
    expect(report.checks.find((check) => check.id === "lease.consistency")?.status).toBe("FAIL");
  });

  it("fails when raw storage facts violate the configured floor or total limit", () => {
    const report = buildDoctorReport(snapshot({
      storage: {
        ...snapshot().storage,
        managedTotalBytes: 200,
        maxTotalBytes: 100,
        volumes: [{ volumeId: "v1", physicalFreeBytes: 50, activeReservedBytes: 40, effectiveAvailableBytes: 10, policyAvailableBytes: -10, minFreeBytes: 10, safetyMarginBytes: 10 }],
      },
    }));
    expect(report.checks.find((check) => check.id === "storage.accounting")?.status).toBe("FAIL");
  });

  it("warns for an unpinned model without failing the execution", () => {
    const report = buildDoctorReport(snapshot({
      executions: [{
        executionId: "e1", taskId: "t1", workspaceId: null, state: "COMPLETED", createdAt: 1, updatedAt: 2,
        journalStatus: "OK", lastEventType: "agent.completed", lastEventSeq: 2, retentionClass: null, gcEligibleAt: null,
        artifactBytes: 0, worktreeBytes: 0, leaseStatus: "NONE", reservationStatus: "NONE", recoveryStatus: "NONE", gcStatus: "NONE",
        phase12: {
          fingerprintVersion: 2, runtimeIdentityArtifact: { state: "VALID" }, protectedPolicyArtifact: { state: "VALID" }, fingerprintArtifact: { state: "VALID" },
          model: { value: null, pinned: false }, effectiveOutputLimits: {}, outputLimitsSource: "protected-policy", configDrift: [], bindings: "CONSISTENT", legacyClassification: "NONE",
        },
      } as never],
    }));
    expect(report.status).toBe("WARN");
    expect(report.checks.find((check) => check.id === "runtime.model-pinning")?.status).toBe("WARN");
  });

  it("fails on conflicting immutable Phase 12 evidence for an active execution", () => {
    const report = buildDoctorReport(snapshot({
      executions: [{
        executionId: "e1", taskId: "t1", workspaceId: null, state: "RUNNING", createdAt: 1, updatedAt: 2,
        journalStatus: "OK", lastEventType: "agent.spawn.started", lastEventSeq: 1, retentionClass: null, gcEligibleAt: null,
        artifactBytes: 0, worktreeBytes: 0, leaseStatus: "NONE", reservationStatus: "NONE", recoveryStatus: "REQUIRED", gcStatus: "NONE",
        phase12: {
          fingerprintVersion: 2, runtimeIdentityArtifact: { state: "HASH_MISMATCH" }, protectedPolicyArtifact: { state: "VALID" }, fingerprintArtifact: { state: "VALID" },
          model: { value: "MiniMax-M3", pinned: true }, effectiveOutputLimits: {}, outputLimitsSource: "protected-policy", configDrift: [], bindings: "CONFLICT", legacyClassification: "NONE",
        },
      } as never],
    }));
    expect(report.status).toBe("FAIL");
    expect(report.checks.find((check) => check.id === "runtime.binding-consistency")?.status).toBe("FAIL");
  });

  it("reports terminal legacy evidence as informational and active legacy evidence as a warning", () => {
    const terminal = buildDoctorReport(snapshot({
      executions: [{ state: "COMPLETED", recoveryStatus: "NONE", phase12: { fingerprintVersion: 1, legacyClassification: "TERMINAL", model: { value: null, pinned: false }, runtimeIdentityArtifact: { state: "MISSING" }, protectedPolicyArtifact: { state: "MISSING" }, fingerprintArtifact: { state: "MISSING" }, effectiveOutputLimits: {}, outputLimitsSource: "unavailable", configDrift: [], bindings: "UNAVAILABLE" } } as never],
    }));
    expect(terminal.checks.find((check) => check.id === "runtime.legacy")?.status).toBe("PASS");
    expect(terminal.checks.find((check) => check.id === "runtime.legacy")?.severity).toBe("INFO");

    const active = buildDoctorReport(snapshot({
      executions: [{ state: "RECOVERY_REQUIRED", recoveryStatus: "REQUIRED", phase12: { fingerprintVersion: 1, legacyClassification: "RECOVERY_CRITICAL", model: { value: null, pinned: false }, runtimeIdentityArtifact: { state: "MISSING" }, protectedPolicyArtifact: { state: "MISSING" }, fingerprintArtifact: { state: "MISSING" }, effectiveOutputLimits: {}, outputLimitsSource: "unavailable", configDrift: [], bindings: "UNAVAILABLE" } } as never],
    }));
    expect(active.checks.find((check) => check.id === "runtime.legacy")?.status).toBe("WARN");
    expect(active.checks.find((check) => check.id === "runtime.legacy")?.message).toMatch(/evidence unavailable/i);
  });

  it("observes reclaim guard states without turning a dead or foreign guard into a mutation", () => {
    for (const state of ["LIVE", "DEAD", "FOREIGN", "MALFORMED"] as const) {
      const report = buildDoctorReport(snapshot({ reclaimGuard: { state, path: "state/repair/repair.lock.reclaim", pid: null, hostname: null, operationId: null, guardId: null, heartbeatAgeMs: null } } as never));
      expect(report.checks.find((check) => check.id === "repair.reclaim-guard")?.evidence).toContain("repair:reclaim-guard");
    }
  });
});
