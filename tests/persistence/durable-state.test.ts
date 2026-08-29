import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DurableStateError } from "../../src/persistence/durable-state.js";
import { EventStore } from "../../src/events/store.js";
import { FingerprintRegistry, type TaskFingerprint } from "../../src/execution/fingerprint.js";
import { EvidenceStore, recordWorkerEvidence } from "../../src/evidence/store.js";
import { ReplayGuard } from "../../src/review/replay-guard.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "g2m-durable-state-"));
  roots.push(root);
  return root;
}

const fingerprint: TaskFingerprint = {
  taskHash: "a".repeat(64),
  workspaceId: "workspace-1",
  baseRevision: "b".repeat(40),
  mcodeVersion: "0.2.7",
  model: "configured",
  permissionProfile: "coding_standard",
  maxSteps: 10,
  timeoutMs: 60_000,
  adapterContractVersion: "g2m-worker-v1",
  runtimeCapabilitySnapshotHash: "c".repeat(64),
};

describe("durable state stores", () => {
  it("reloads an event chain and continues its sequence", async () => {
    const root = await makeRoot();
    const first = new EventStore({ logDirectory: join(root, "events") });
    first.append({
      taskId: "task-1",
      attemptId: "attempt-1",
      type: "task.created",
      payload: {},
    });

    const reloaded = new EventStore({ logDirectory: join(root, "events") });
    const event = reloaded.append({
      taskId: "task-1",
      attemptId: "attempt-1",
      type: "task.validation.started",
      payload: {},
    });

    expect(event.seq).toBe(2);
    expect(reloaded.getByAttemptId("attempt-1")).toHaveLength(2);
  });

  it("reloads evidence and validates its content hash", async () => {
    const root = await makeRoot();
    const first = new EvidenceStore({ directory: join(root, "evidence") });
    const evidence = recordWorkerEvidence(first, "task-1", "attempt-1", {
      executionId: "attempt-1",
      summary: "ok",
      filesChanged: [],
      testsAttempted: [],
      remainingRisks: [],
    });

    const reloaded = new EvidenceStore({ directory: join(root, "evidence") });
    expect(reloaded.get(evidence.evidenceId)).toEqual(evidence);
  });

  it("reloads replay decisions and fingerprints", async () => {
    const root = await makeRoot();
    const signature = {
      reviewId: "review-1",
      reviewBundleId: "bundle-1",
      reviewHash: "d".repeat(64),
      decision: "ACCEPT" as const,
    };
    const guard = new ReplayGuard({ statePath: join(root, "replay.json") });
    guard.record(signature, 123);
    const registry = new FingerprintRegistry({ statePath: join(root, "fingerprints.json") });
    registry.freeze("task-1", fingerprint);

    const reloadedGuard = new ReplayGuard({ statePath: join(root, "replay.json") });
    const reloadedRegistry = new FingerprintRegistry({ statePath: join(root, "fingerprints.json") });
    expect(reloadedGuard.check(signature).kind).toBe("idempotent");
    expect(reloadedRegistry.get("task-1")).toEqual(fingerprint);
  });

  it("rejects malformed persisted JSONL", async () => {
    const root = await makeRoot();
    const events = join(root, "events");
    await mkdir(events, { recursive: true });
    await writeFile(join(events, "attempt-1.jsonl"), "{not-json}\n", "utf8");

    expect(() => new EventStore({ logDirectory: events })).toThrow(DurableStateError);
  });
});
