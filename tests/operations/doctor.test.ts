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
});
