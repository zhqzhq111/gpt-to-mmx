import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { G2MLocalConfig } from "../../src/cli/config.js";
import { buildFingerprintV2Artifact } from "../../src/execution/fingerprint.js";
import { buildOperationalSnapshot } from "../../src/operations/snapshot.js";
import { buildProtectedPolicy } from "../../src/runtime/protected-policy.js";
import { buildRuntimeIdentity } from "../../src/runtime/identity.js";
import { sha256 } from "../../src/protocol/hash.js";
import type { MCodeLaunchDescriptor } from "../../src/workers/mcode/resolver.js";
import { StateDatabase } from "../../src/projection/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(root: string): G2MLocalConfig {
  return {
    protocol_version: "g2m.local-config.v1",
    workspaces: [{ workspace_id: "ws-1", path: join(root, "workspace") }],
    verification_profiles: [],
    worktree_root: join(root, "worktrees"),
    artifact_root: join(root, "artifacts"),
    state_root: join(root, "state"),
    storage: {
      min_free_bytes: 0,
      safety_margin_bytes: 0,
      default_execution_reservation_bytes: 100,
      max_total_bytes: 0,
      max_artifact_bytes: 0,
      max_worktree_bytes: 0,
      completed_retention_days: 30,
      reservation_ttl_ms: 60_000,
      monitor_interval_ms: 1_000,
    },
    runtime_hardening: { max_worker_stdout_bytes: 33_554_432, max_worker_stderr_bytes: 8_388_608, max_stream_json_line_bytes: 4_194_304, max_worker_events: 100_000, max_verification_stdout_bytes: 16_777_216, max_verification_stderr_bytes: 16_777_216, max_probe_output_bytes: 2_097_152, repair_reclaim_guard_stale_ms: 30_000 },
    mcode_model: "MiniMax-M3",
    review_timeout_ms: 60_000,
  };
}

function phase12Artifacts(root: string, executionId = "exec-v2"): void {
  const runtime = buildRuntimeIdentity({
    descriptor: {
      kind: "cmd", executablePath: "C:/mcode.cmd", executableSha256: "a".repeat(64), executableBytes: 1,
      version: "0.2.7", helpText: "help", helpSha256: "b".repeat(64), execHelpText: "exec help",
      execHelpSha256: "c".repeat(64), outputSchemaSupported: true, resolvedAt: 1, resolvedVia: "explicit",
    } satisfies MCodeLaunchDescriptor,
    capabilitySnapshotHash: "d".repeat(64),
    workerSummarySchemaHash: "e".repeat(64),
    model: "MiniMax-M3",
  });
  const policy = buildProtectedPolicy({
    task_id: "task-v2", execution_id: executionId, workspace_id: "ws-1", canonical_workspace_path: join(root, "workspace"),
    base_revision: "base", artifact_root: join(root, "artifacts"), worktree_root: join(root, "worktrees"), state_root: join(root, "state"),
    permission_policy: "smart", requested_capabilities: { network: false }, limits: { max_steps: 5, timeout_ms: 10_000 },
    verification_profile: { id: "none", resolved_program: "", program_identity_hash: sha256(""), program_bytes: 0, args: [], timeout_ms: 0 },
    runtime_identity_hash: runtime.identity_hash, output_limits: config(root).runtime_hardening,
    storage_policy_hash: sha256(config(root).storage), lease_policy_hash: sha256({}),
  });
  const fingerprint = buildFingerprintV2Artifact({
    taskId: "task-v2", executionId,
    fingerprint: {
      fingerprintVersion: 2, taskHash: "f".repeat(64), workspaceId: "ws-1", baseRevision: "base", mcodeVersion: runtime.runtime_version,
      model: runtime.model, permissionProfile: "smart", maxSteps: 5, timeoutMs: 10_000, adapterContractVersion: runtime.adapter_contract_version,
      runtimeCapabilitySnapshotHash: runtime.capability_snapshot_hash, runtimeIdentityHash: runtime.identity_hash,
      protectedPolicyHash: policy.policy_hash, workerSummarySchemaHash: runtime.worker_summary_schema_hash,
    },
  });
  const directory = join(root, "artifacts", executionId);
  const stateExecution = join(root, "state", "executions", executionId);
  mkdirSync(directory, { recursive: true });
  mkdirSync(stateExecution, { recursive: true });
  writeFileSync(join(directory, "runtime-identity.json"), `${JSON.stringify(runtime, null, 2)}\n`);
  writeFileSync(join(directory, "protected-policy.json"), `${JSON.stringify(policy, null, 2)}\n`);
  writeFileSync(join(directory, "fingerprint.json"), `${JSON.stringify(fingerprint, null, 2)}\n`);
}

describe("read-only operational snapshot", () => {
  it("reports missing state roots without creating directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-snapshot-"));
    roots.push(root);

    const snapshot = await buildOperationalSnapshot({ config: config(root), nowMs: 100 });

    expect(snapshot.schemaVersion).toBe("g2m.status.v1");
    expect(snapshot.generatedAt).toBe(100);
    expect(snapshot.stateRoot.stateRootExists).toBe(false);
    expect(snapshot.stateRoot.executionsDirectoryExists).toBe(false);
    await expect(stat(join(root, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues filesystem reporting when the projection database is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-snapshot-"));
    roots.push(root);
    await mkdir(join(root, "state", "executions"), { recursive: true });
    await mkdir(join(root, "artifacts"), { recursive: true });
    await writeFile(join(root, "state", "executions", "orphan"), "not a directory");

    const before = await stat(join(root, "state", "executions", "orphan"));
    const snapshot = await buildOperationalSnapshot({ config: config(root) });
    const after = await stat(join(root, "state", "executions", "orphan"));

    expect(snapshot.projection.status).toBe("MISSING");
    expect(snapshot.stateRoot.executionsDirectoryExists).toBe(true);
    expect(before.size).toBe(after.size);
    expect(before.mtimeMs).toBe(after.mtimeMs);
  });

  it("continues filesystem reporting when an opened SQLite projection is unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-snapshot-"));
    roots.push(root);
    const database = new StateDatabase(join(root, "state", "g2m-state.sqlite"));
    database.exec("DROP TABLE projection_meta");
    database.close();

    const snapshot = await buildOperationalSnapshot({ config: config(root), nowMs: 100 });

    expect(snapshot.projection.status).toBe("UNREADABLE");
    expect(snapshot.stateRoot.projectionDatabaseExists).toBe(true);
  });

  it("reports immutable Phase 12 evidence, model pinning, limits, and no reclaim guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-snapshot-"));
    roots.push(root);
    phase12Artifacts(root);
    const evidencePaths = ["runtime-identity.json", "protected-policy.json", "fingerprint.json"].map((name) => join(root, "artifacts", "exec-v2", name));
    const before = evidencePaths.map((path) => { const value = statSync(path); return [value.size, value.mtimeMs]; });

    const snapshot = await buildOperationalSnapshot({ config: config(root), nowMs: 100 });
    const execution = snapshot.executions.find((item) => item.executionId === "exec-v2");

    expect(execution?.phase12.fingerprintVersion).toBe(2);
    expect(execution?.phase12.runtimeIdentityArtifact.state).toBe("VALID");
    expect(execution?.phase12.protectedPolicyArtifact.state).toBe("VALID");
    expect(execution?.phase12.fingerprintArtifact.state).toBe("VALID");
    expect(execution?.phase12.model).toEqual({ value: "MiniMax-M3", pinned: true });
    expect(execution?.phase12.effectiveOutputLimits.max_worker_events).toBe(100_000);
    expect(execution?.phase12.configDrift).toEqual([]);
    expect(snapshot.reclaimGuard!.state).toBe("MISSING");
    const after = evidencePaths.map((path) => { const value = statSync(path); return [value.size, value.mtimeMs]; });
    expect(after).toEqual(before);
  });

  it("reports malformed immutable evidence and current-config drift without rewriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-snapshot-"));
    roots.push(root);
    phase12Artifacts(root);
    const protectedPath = join(root, "artifacts", "exec-v2", "protected-policy.json");
    writeFileSync(protectedPath, "not-json");
    const before = statSync(protectedPath);
    const snapshot = await buildOperationalSnapshot({ config: { ...config(root), mcode_model: "Other-Model" }, nowMs: 100 });
    expect(snapshot.executions[0]?.phase12.protectedPolicyArtifact.state).toBe("MALFORMED");
    expect(snapshot.executions[0]?.phase12.configDrift).toEqual([]);
    const after = statSync(protectedPath);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });

  it("reports conflicting artifact bindings without invoking runtime probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-snapshot-"));
    roots.push(root);
    phase12Artifacts(root);
    const policyPath = join(root, "artifacts", "exec-v2", "protected-policy.json");
    const policy = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, unknown>;
    policy.runtime_identity_hash = "0".repeat(64);
    const { policy_hash: ignored, ...changedContent } = policy;
    policy.policy_hash = sha256(changedContent);
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    const snapshot = await buildOperationalSnapshot({ config: { ...config(root), mcode_model: "Other-Model" }, nowMs: 100 });
    expect(ignored).toBeDefined();
    expect(snapshot.executions[0]?.phase12.bindings).toBe("CONFLICT");
    expect(snapshot.executions[0]?.phase12.configDrift).toContain("mcode_model");
  });

  it("observes live, dead, foreign, and malformed reclaim guards without changing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-snapshot-"));
    roots.push(root);
    await mkdir(join(root, "state", "repair"), { recursive: true });
    const path = join(root, "state", "repair", "repair.lock.reclaim");
    const base = { schema_version: "g2m.repair-lock-reclaim.v1", guard_id: "g1", operation_id: "op1", pid: process.pid, hostname: "local", created_at: 1, heartbeat_at: 1 };
    writeFileSync(path, JSON.stringify({ ...base, hostname: hostname() }));
    expect((await buildOperationalSnapshot({ config: config(root), nowMs: 100 })).reclaimGuard!.state).toBe("LIVE");
    writeFileSync(path, JSON.stringify({ ...base, pid: 2147483647, hostname: hostname() }));
    expect((await buildOperationalSnapshot({ config: config(root), nowMs: 100 })).reclaimGuard!.state).toBe("DEAD");
    writeFileSync(path, JSON.stringify({ ...base, hostname: "foreign-host" }));
    expect((await buildOperationalSnapshot({ config: config(root), nowMs: 100 })).reclaimGuard!.state).toBe("FOREIGN");
    writeFileSync(path, "not-json");
    expect((await buildOperationalSnapshot({ config: config(root), nowMs: 100 })).reclaimGuard!.state).toBe("MALFORMED");
  });
});
