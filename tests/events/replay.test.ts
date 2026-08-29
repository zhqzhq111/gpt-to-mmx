/**
 * Event Replay — plan §52
 */

import { describe, it, expect } from "vitest";

import { FingerprintRegistry, type TaskFingerprint } from "../../src/execution/fingerprint.js";
import { EventStore } from "../../src/events/store.js";
import { replay, replayFromStore, ReplayError } from "../../src/events/replay.js";

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

function makeHappyPathEvents(taskId: string, fp: TaskFingerprint) {
  const store = new EventStore();
  return {
    store,
    events: [
      store.append({ taskId, attemptId: "a1", type: "task.created", payload: {} }),
      store.append({ taskId, attemptId: "a1", type: "task.validation.started", payload: {} }),
      store.append({ taskId, attemptId: "a1", type: "task.validation.passed", payload: {} }),
      store.append({ taskId, attemptId: "a1", type: "workspace.lock.requested", payload: {} }),
      store.append({ taskId, attemptId: "a1", type: "workspace.lock.acquired", payload: {} }),
      store.append({ taskId, attemptId: "a1", type: "agent.spawn.started", payload: {}, fingerprint: fp }),
      store.append({ taskId, attemptId: "a1", type: "agent.completed", payload: {} }),
      store.append({ taskId, attemptId: "a1", type: "evidence.diff.collected", payload: {} }),
      store.append({ taskId, attemptId: "a1", type: "verification.completed", payload: {} }),
      store.append({ taskId, attemptId: "a1", type: "review.requested", payload: {} }),
      store.append({ taskId, attemptId: "a1", type: "review.decision.accept", payload: {} }),
    ],
  };
}

describe("replay — happy path", () => {
  it("reproduces ACCEPTED from a valid event log", () => {
    const fp = makeFP();
    const { events } = makeHappyPathEvents("t", fp);
    const reg = new FingerprintRegistry();
    const result = replay(events, { fingerprintRegistry: reg });
    expect(result.state).toBe("ACCEPTED");
    expect(result.applied).toBe(11);
    expect(result.chainValid).toBe(true);
  });

  it("freezes the fingerprint during replay (same as live reduce)", () => {
    const fp = makeFP();
    const { events } = makeHappyPathEvents("t", fp);
    const reg = new FingerprintRegistry();
    replay(events, { fingerprintRegistry: reg });
    expect(reg.has("t")).toBe(true);
    expect(reg.get("t")).toEqual(fp);
  });

  it("replay is deterministic — same events + fresh registry → same state", () => {
    const fp = makeFP();
    const { events } = makeHappyPathEvents("t", fp);
    const reg1 = new FingerprintRegistry();
    const reg2 = new FingerprintRegistry();
    const r1 = replay(events, { fingerprintRegistry: reg1 });
    const r2 = replay(events, { fingerprintRegistry: reg2 });
    expect(r1.state).toBe(r2.state);
    expect(r1.applied).toBe(r2.applied);
  });
});

describe("replay — chain verification (user requirement 1)", () => {
  it("throws ReplayError when chain is broken", () => {
    const fp = makeFP();
    const { events } = makeHappyPathEvents("t", fp);
    // 篡改最后一个事件的 prevHash
    const tampered = events.map((e, i) =>
      i === events.length - 1 ? { ...e, prevHash: "00" } : e,
    );
    const reg = new FingerprintRegistry();
    let caught: unknown;
    try {
      replay(tampered, { fingerprintRegistry: reg });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReplayError);
    expect((caught as ReplayError).code).toBe("CHAIN_BROKEN");
  });

  it("throws ReplayError when payload is tampered (hash mismatch)", () => {
    const fp = makeFP();
    const { events } = makeHappyPathEvents("t", fp);
    const tampered = events.map((e, i) =>
      i === 0 ? { ...e, payload: { tampered: true } } : e,
    );
    const reg = new FingerprintRegistry();
    expect(() => replay(tampered, { fingerprintRegistry: reg })).toThrow(ReplayError);
  });

  it("throws when events are reordered (plan §52: 禁止排序)", () => {
    const fp = makeFP();
    const { events } = makeHappyPathEvents("t", fp);
    // 把第 2 和第 3 个事件互换
    const reordered = [events[0]!, events[2]!, events[1]!, ...events.slice(3)];
    const reg = new FingerprintRegistry();
    expect(() => replay(reordered, { fingerprintRegistry: reg })).toThrow(ReplayError);
  });
});

describe("replay — empty log", () => {
  it("returns state = null for an empty log (no events yet)", () => {
    const reg = new FingerprintRegistry();
    const result = replay([], { fingerprintRegistry: reg });
    expect(result.state).toBeNull();
    expect(result.applied).toBe(0);
    expect(result.chainValid).toBe(true);
  });
});

describe("replayFromStore (convenience)", () => {
  it("replays directly from an EventStore instance", () => {
    const fp = makeFP();
    const { store, events } = makeHappyPathEvents("t", fp);
    expect(store.list()).toEqual(events);
    const reg = new FingerprintRegistry();
    const result = replayFromStore(store, { fingerprintRegistry: reg });
    expect(result.state).toBe("ACCEPTED");
    expect(result.applied).toBe(events.length);
  });
});

describe("replay — fingerprint change detection during replay", () => {
  it("transitions to RECOVERY_REQUIRED when a later event has different fingerprint", () => {
    const fp1 = makeFP({ mcodeVersion: "0.2.7" });
    const fp2 = makeFP({ mcodeVersion: "0.2.8" });
    const store = new EventStore();
    const events = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.requested", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.acquired", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.spawn.started", payload: {}, fingerprint: fp1 }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.completed", payload: {}, fingerprint: fp2 }),
    ];
    const reg = new FingerprintRegistry();
    const result = replay(events, { fingerprintRegistry: reg });
    expect(result.state).toBe("RECOVERY_REQUIRED");
  });
});
