import type { OperationalOptions, OperationalSnapshot } from "./snapshot.js";
import { buildOperationalSnapshot } from "./snapshot.js";
import { isTerminal } from "../execution/state-machine.js";

export type DoctorCategory = "state_root" | "journal" | "projection" | "lease" | "reservation" | "storage" | "recovery" | "gc" | "runtime" | "repair" | "cross_source";
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
  const unsafeLeaseStatuses = ["INCOMPLETE", "MALFORMED", "HEARTBEAT_MISMATCH", "RECOVERY_CRITICAL", "FOREIGN_HOST", "UNKNOWN", "ACTIVE_EXECUTION_STALE_OWNER", "STALE_TERMINAL_RECLAIMABLE"];
  const unsafeLeases = snapshot.workspaces.filter((workspace) => unsafeLeaseStatuses.includes(workspace.lease.status));
  const staleActiveLeases = snapshot.workspaces.filter((workspace) => workspace.lease.status === "ACTIVE_EXECUTION_STALE_OWNER");
  checks.push(check(
    "lease.consistency",
    "lease",
    staleActiveLeases.length > 0 ? "FAIL" : unsafeLeases.length === 0 ? "PASS" : "WARN",
    staleActiveLeases.length > 0 ? `${staleActiveLeases.length} active execution lease owner(s) are stale` : unsafeLeases.length === 0 ? "workspace leases are consistent" : `${unsafeLeases.length} workspace leases need operator review`,
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
  const overcommittedVolume = snapshot.storage.volumes.some((volume) => volume.effectiveAvailableBytes !== null && volume.effectiveAvailableBytes < 0);
  const belowPolicyVolume = snapshot.storage.volumes.some((volume) => volume.policyAvailableBytes !== null && volume.policyAvailableBytes < 0);
  const managedLimitExceeded = (snapshot.storage.maxTotalBytes > 0 && snapshot.storage.managedTotalBytes > snapshot.storage.maxTotalBytes) ||
    (snapshot.storage.maxArtifactBytes > 0 && snapshot.storage.managedArtifactBytes > snapshot.storage.maxArtifactBytes) ||
    (snapshot.storage.maxWorktreeBytes > 0 && snapshot.storage.managedWorktreeBytes > snapshot.storage.maxWorktreeBytes);
  checks.push(check(
    "storage.accounting",
    "storage",
    overcommittedVolume || managedLimitExceeded ? "FAIL" : belowPolicyVolume ? "WARN" : "PASS",
    overcommittedVolume ? "active reservations exceed physical free space" : managedLimitExceeded ? "managed storage exceeds a configured maximum" : belowPolicyVolume ? "one or more volumes are below the configured free-space policy" : "filesystem and reservation storage accounting is within policy",
    ["storage:filesystem", "storage:reservations", "storage:policy"],
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
  const phase12Executions = snapshot.executions.filter((execution) => execution.phase12.legacyClassification === "NONE");
  const artifactState = (name: "runtimeIdentityArtifact" | "protectedPolicyArtifact" | "fingerprintArtifact"): DoctorCheckStatus => {
    const invalid = phase12Executions.filter((execution) => execution.phase12[name].state !== "VALID");
    if (invalid.length === 0) return "PASS";
    return invalid.some((execution) => execution.recoveryStatus === "REQUIRED" || execution.state === "RECOVERY_REQUIRED" || (execution.state !== null && !isTerminal(execution.state))) ? "FAIL" : "WARN";
  };
  for (const [id, field, label] of [
    ["runtime.identity-artifact", "runtimeIdentityArtifact", "runtime identity"],
    ["runtime.protected-policy-artifact", "protectedPolicyArtifact", "protected policy"],
    ["runtime.fingerprint-artifact", "fingerprintArtifact", "fingerprint"],
  ] as const) {
    const invalid = phase12Executions.filter((execution) => execution.phase12[field].state !== "VALID");
    checks.push(check(id, "runtime", artifactState(field), invalid.length === 0 ? `${label} artifacts are valid` : `${invalid.length} execution(s) have invalid ${label} artifacts`, invalid.map((execution) => `artifact:${execution.executionId}/${field}`)));
  }
  const bindingConflicts = phase12Executions.filter((execution) => execution.phase12.bindings === "CONFLICT");
  const bindingStatus = bindingConflicts.some((execution) => execution.recoveryStatus === "REQUIRED" || execution.state === "RECOVERY_REQUIRED" || (execution.state !== null && !isTerminal(execution.state))) ? "FAIL" : bindingConflicts.length === 0 ? "PASS" : "WARN";
  checks.push(check(
    "runtime.binding-consistency", "runtime", bindingStatus,
    bindingConflicts.length === 0 ? "Phase 12 artifact bindings are consistent or unavailable" : `${bindingConflicts.length} execution(s) have conflicting Phase 12 artifact bindings`,
    bindingConflicts.map((execution) => `artifact-binding:${execution.executionId}`),
  ));
  const unpinned = phase12Executions.filter((execution) => !execution.phase12.model.pinned);
  checks.push(check(
    "runtime.model-pinning", "runtime", unpinned.length === 0 ? "PASS" : "WARN",
    unpinned.length === 0 ? "all Phase 12 runtime models are pinned" : `${unpinned.length} Phase 12 execution(s) use an unpinned model`,
    unpinned.map((execution) => `model:${execution.executionId}`),
  ));
  const drifted = phase12Executions.filter((execution) => execution.phase12.configDrift.length > 0);
  checks.push(check(
    "runtime.current-config-drift", "runtime", drifted.length === 0 ? "PASS" : "WARN",
    drifted.length === 0 ? "current configuration matches available protected policy bindings" : `${drifted.length} execution(s) have current-config drift: ${[...new Set(drifted.flatMap((execution) => execution.phase12.configDrift))].sort().join(", ")}`,
    drifted.map((execution) => `config:${execution.executionId}`),
  ));
  const legacy = snapshot.executions.filter((execution) => execution.phase12.legacyClassification !== "NONE");
  const legacyCritical = legacy.filter((execution) => execution.phase12.legacyClassification === "ACTIVE" || execution.phase12.legacyClassification === "RECOVERY_CRITICAL");
  checks.push(check(
    "runtime.legacy", "runtime", legacyCritical.length === 0 ? "PASS" : "WARN",
    legacy.length === 0 ? "all executions have Phase 12 evidence" : legacyCritical.length === 0 ? `${legacy.length} terminal legacy execution(s) are informational; no Phase 12 evidence was fabricated` : `${legacyCritical.length} active/recovery-critical legacy execution(s): Phase 12 evidence unavailable`,
    legacy.map((execution) => `legacy:${execution.executionId}`),
  ));
  const guard = snapshot.reclaimGuard ?? { state: "MISSING" as const, path: "", guardId: null, operationId: null, pid: null, hostname: null, heartbeatAgeMs: null, stale: null };
  checks.push(check(
    "repair.reclaim-guard", "repair", guard.state === "MISSING" ? "PASS" : "WARN",
    guard.state === "MISSING" ? "repair reclaim guard is absent" : `repair reclaim guard observation is ${guard.state.toLowerCase()}; no mutation was attempted`,
    guard.state === "MISSING" ? [] : ["repair:reclaim-guard"],
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
