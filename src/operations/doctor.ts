import type { OperationalOptions, OperationalSnapshot } from "./snapshot.js";
import { buildOperationalSnapshot } from "./snapshot.js";

export type DoctorCategory = "state_root" | "journal" | "projection" | "lease" | "reservation" | "storage" | "recovery" | "gc" | "cross_source";
export type DoctorCheckStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  readonly id: string;
  readonly category: DoctorCategory;
  readonly status: DoctorCheckStatus;
  readonly severity: "INFO" | "WARNING" | "ERROR";
  readonly message: string;
  readonly evidence: readonly string[];
}

export interface DoctorSnapshotInput extends OperationalSnapshot {}

export interface DoctorReport {
  readonly schemaVersion: "g2m.doctor.v1";
  readonly generatedAt: number;
  readonly status: DoctorCheckStatus;
  readonly checks: readonly DoctorCheck[];
}

function check(
  id: string,
  category: DoctorCategory,
  status: DoctorCheckStatus,
  message: string,
  evidence: readonly string[] = [],
): DoctorCheck {
  return { id, category, status, severity: status === "FAIL" ? "ERROR" : status === "WARN" ? "WARNING" : "INFO", message, evidence };
}

function worstStatus(checks: readonly DoctorCheck[]): DoctorCheckStatus {
  if (checks.some((item) => item.status === "FAIL")) return "FAIL";
  if (checks.some((item) => item.status === "WARN")) return "WARN";
  return "PASS";
}

export function buildDoctorReport(snapshot: DoctorSnapshotInput): DoctorReport {
  const checks: DoctorCheck[] = [];
  const rootValues = Object.values(snapshot.stateRoot);
  checks.push(check(
    "state-root.present",
    "state_root",
    rootValues.every(Boolean) ? "PASS" : "WARN",
    rootValues.every(Boolean) ? "state root layout is present" : "one or more state-root paths are absent",
    ["state-root"],
  ));
  const badJournals = snapshot.executions.filter((execution) => ["TRUNCATED_TAIL", "LOAD_ERROR", "MISSING"].includes(execution.journalStatus));
  checks.push(check(
    "journal.integrity",
    "journal",
    badJournals.length === 0 ? "PASS" : "FAIL",
    badJournals.length === 0 ? "all execution Journals are readable and chained" : `${badJournals.length} execution Journals require attention`,
    badJournals.map((execution) => `journal:${execution.executionId}`),
  ));
  checks.push(check(
    "projection.readable",
    "projection",
    snapshot.projection.status === "OK" ? "PASS" : "WARN",
    snapshot.projection.status === "OK" ? "projection is readable" : `projection is ${snapshot.projection.status.toLowerCase()}`,
    ["projection:g2m-state.sqlite"],
  ));
  const stale = snapshot.projection.staleExecutionCount + snapshot.projection.projectionStaleEventCount;
  checks.push(check(
    "projection.stale",
    "projection",
    stale === 0 ? "PASS" : "FAIL",
    stale === 0 ? "projection has no stale executions or events" : `${stale} stale projection records/events detected`,
    stale === 0 ? [] : ["projection:stale"],
  ));
  const unsafeLeases = snapshot.workspaces.filter((workspace) => ["INCOMPLETE", "MALFORMED", "HEARTBEAT_MISMATCH", "RECOVERY_CRITICAL", "FOREIGN_HOST", "UNKNOWN"].includes(workspace.lease.status));
  checks.push(check(
    "lease.consistency",
    "lease",
    unsafeLeases.length === 0 ? "PASS" : "WARN",
    unsafeLeases.length === 0 ? "workspace leases are consistent" : `${unsafeLeases.length} workspace leases need operator review`,
    unsafeLeases.map((workspace) => `lease:${workspace.workspaceId}`),
  ));
  const invalidReservations = snapshot.executions.filter((execution) => execution.reservationStatus === "INVALID");
  checks.push(check(
    "reservation.integrity",
    "reservation",
    invalidReservations.length === 0 ? "PASS" : "WARN",
    invalidReservations.length === 0 ? "storage reservation records are readable" : `${invalidReservations.length} reservation records are invalid`,
    invalidReservations.map((execution) => `reservation:${execution.executionId}`),
  ));
  checks.push(check(
    "storage.accounting",
    "storage",
    snapshot.storage.volumes.some((volume) => volume.effectiveAvailableBytes !== null && volume.effectiveAvailableBytes < 0) ? "FAIL" : "PASS",
    "filesystem and reservation storage accounting is available",
    ["storage:filesystem", "storage:reservations"],
  ));
  checks.push(check(
    "recovery.safe-holds",
    "recovery",
    snapshot.recovery.safeHoldCount === 0 ? "PASS" : "FAIL",
    snapshot.recovery.safeHoldCount === 0 ? "no recovery safe holds are active" : `${snapshot.recovery.safeHoldCount} recovery safe hold(s) block execution`,
    snapshot.recovery.executionsRequiringRecovery.map((executionId) => `recovery:${executionId}`),
  ));
  checks.push(check(
    "recovery.report-only",
    "recovery",
    snapshot.recovery.reportOnlyCount === 0 ? "PASS" : "WARN",
    snapshot.recovery.reportOnlyCount === 0 ? "no report-only recovery issues are present" : `${snapshot.recovery.reportOnlyCount} report-only recovery issue(s) are present`,
    ["recovery:report-only"],
  ));
  checks.push(check(
    "gc.consistency",
    "gc",
    snapshot.gc.invalidTombstoneCount > 0 ? "FAIL" : snapshot.gc.interruptedCount + snapshot.gc.cleanupPendingCount > 0 ? "WARN" : "PASS",
    snapshot.gc.invalidTombstoneCount > 0 ? `${snapshot.gc.invalidTombstoneCount} invalid tombstone(s) detected` : snapshot.gc.interruptedCount + snapshot.gc.cleanupPendingCount > 0 ? "GC has interrupted or pending cleanup work" : "GC state is consistent",
    ["gc:tombstones"],
  ));
  for (const execution of snapshot.executions.filter((item) => item.recoveryStatus === "REQUIRED")) {
    checks.push(check(`execution.${execution.executionId}.recovery-required`, "cross_source", "FAIL", `execution ${execution.executionId} is RECOVERY_REQUIRED`, [`execution:${execution.executionId}`]));
  }
  checks.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: "g2m.doctor.v1", generatedAt: snapshot.generatedAt, status: worstStatus(checks), checks };
}

export async function runDoctor(options: OperationalOptions): Promise<DoctorReport> {
  return buildDoctorReport(await buildOperationalSnapshot(options));
}
