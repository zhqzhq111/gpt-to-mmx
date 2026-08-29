/**
 * Reducer — plan §41 + §51 + §53
 */

import { describe, it, expect } from "vitest";

import {
  FingerprintRegistry,
  fingerprintHash,
  type TaskFingerprint,
} from "../../src/execution/fingerprint.js";
import { EventStore } from "../../src/events/store.js";
import { reduce, reduceAll } from "../../src/events/reducer.js";
import { InvalidTransitionError, type TaskState } from "../../src/execution/state-machine.js";

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

describe("reduce — initial state (user requirement: illegal transitions rejected)", () => {
  it("first event must be task.created → PLANNED", () => {
    const store = new EventStore();
    const ev = store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    const reg = new FingerprintRegistry();
    expect(reduce(null, ev, { fingerprintRegistry: reg })).toBe("PLANNED");
  });

  it("any non-task.created as first event throws InvalidTransitionError", () => {
    const store = new EventStore();
    const ev = store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} });
    const reg = new FingerprintRegistry();
    let caught: unknown;
    try {
      reduce(null, ev, { fingerprintRegistry: reg });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    expect((caught as InvalidTransitionError).fromState).toBeNull();
  });
});

describe("reduce — happy path through full lifecycle", () => {
  it("walks PLANNED → ... → ACCEPTED with valid events", () => {
    const store = new EventStore();
    const fp = makeFP();
    const events = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.requested", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.acquired", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.spawn.started", payload: {}, fingerprint: fp }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.completed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "evidence.diff.collected", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "verification.completed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "review.requested", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "review.decision.accept", payload: {} }),
    ];
    const reg = new FingerprintRegistry();
    let state: TaskState | null = null;
    for (const e of events) {
      state = reduce(state, e, { fingerprintRegistry: reg });
    }
    expect(state).toBe("ACCEPTED");
  });

  it("walks to FAILED on workspace.lock.busy", () => {
    const store = new EventStore();
    const events = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.requested", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.busy", payload: {} }),
    ];
    const reg = new FingerprintRegistry();
    const result = reduceAll(events, { fingerprintRegistry: reg });
    expect(result.state).toBe("FAILED");
  });

  it("walks to TIMED_OUT on agent.timed_out from RUNNING", () => {
    const store = new EventStore();
    const fp = makeFP();
    const events = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.requested", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.acquired", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.spawn.started", payload: {}, fingerprint: fp }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.timed_out", payload: {} }),
    ];
    const reg = new FingerprintRegistry();
    expect(reduceAll(events, { fingerprintRegistry: reg }).state).toBe("TIMED_OUT");
  });
});

describe("reduce — terminal states reject all events (user requirement 2)", () => {
  it("ACCEPTED + new event throws", () => {
    const store = new EventStore();
    const fp = makeFP();
    const fullPath = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.requested", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.acquired", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.spawn.started", payload: {}, fingerprint: fp }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.completed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "evidence.diff.collected", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "verification.completed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "review.requested", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "review.decision.accept", payload: {} }),
    ];
    const reg = new FingerprintRegistry();
    const result = reduceAll(fullPath, { fingerprintRegistry: reg });
    expect(result.state).toBe("ACCEPTED");
    // Now try a new event on the terminal state
    const newEvent = store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    expect(() => reduce(result.state, newEvent, { fingerprintRegistry: reg })).toThrow(InvalidTransitionError);
  });

  it("RECOVERY_REQUIRED rejects all subsequent events (user requirement 4: no auto retry)", () => {
    // 走到 RECOVERY_REQUIRED,然后再发新事件必须抛
    const store = new EventStore();
    const fp1 = makeFP({ mcodeVersion: "0.2.7" });
    const fp2 = makeFP({ mcodeVersion: "0.2.8" });
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
    const result = reduceAll(events, { fingerprintRegistry: reg });
    expect(result.state).toBe("RECOVERY_REQUIRED");
    // 再发一个事件必须抛
    const newEvent = store.append({ taskId: "t", attemptId: "a1", type: "agent.completed", payload: {} });
    expect(() => reduce(result.state, newEvent, { fingerprintRegistry: reg })).toThrow(InvalidTransitionError);
  });
});

describe("reduce — fingerprint freeze (user requirement 5)", () => {
  it("freezes the fingerprint at agent.spawn.started", () => {
    const store = new EventStore();
    const fp = makeFP();
    const events = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.requested", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.acquired", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.spawn.started", payload: {}, fingerprint: fp }),
    ];
    const reg = new FingerprintRegistry();
    expect(reg.has("t")).toBe(false);
    reduceAll(events, { fingerprintRegistry: reg });
    expect(reg.has("t")).toBe(true);
    expect(reg.get("t")).toEqual(fp);
  });

  it("does NOT freeze fingerprint before agent.spawn.started", () => {
    const store = new EventStore();
    const fp = makeFP();
    const events = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {}, fingerprint: fp }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {}, fingerprint: fp }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {}, fingerprint: fp }),
    ];
    const reg = new FingerprintRegistry();
    reduceAll(events, { fingerprintRegistry: reg });
    expect(reg.has("t")).toBe(false);
  });

  it("events without fingerprint do not affect the registry", () => {
    const store = new EventStore();
    const events = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} }),
    ];
    const reg = new FingerprintRegistry();
    reduceAll(events, { fingerprintRegistry: reg });
    expect(reg.has("t")).toBe(false);
  });
});

describe("reduce — fingerprint change → RECOVERY_REQUIRED (user requirement 6)", () => {
  it("detects fingerprint change after agent.spawn.started freeze", () => {
    const store = new EventStore();
    const fp1 = makeFP({ mcodeVersion: "0.2.7" });
    const fp2 = makeFP({ mcodeVersion: "0.2.8" });
    const events = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.requested", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.acquired", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.spawn.started", payload: {}, fingerprint: fp1 }),
      // 后续事件带不同 fingerprint
      store.append({ taskId: "t", attemptId: "a1", type: "agent.completed", payload: {}, fingerprint: fp2 }),
    ];
    const reg = new FingerprintRegistry();
    const result = reduceAll(events, { fingerprintRegistry: reg });
    expect(result.state).toBe("RECOVERY_REQUIRED");
  });

  it("same fingerprint on subsequent events keeps normal transition", () => {
    const store = new EventStore();
    const fp = makeFP();
    const events = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.requested", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "workspace.lock.acquired", payload: {} }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.spawn.started", payload: {}, fingerprint: fp }),
      store.append({ taskId: "t", attemptId: "a1", type: "agent.completed", payload: {}, fingerprint: fp }),
    ];
    const reg = new FingerprintRegistry();
    const result = reduceAll(events, { fingerprintRegistry: reg });
    expect(result.state).toBe("COLLECTING_EVIDENCE");
  });

  it("verifies hash equality, not object identity", () => {
    const store = new EventStore();
    const fp1: TaskFingerprint = { ...makeFP() };
    const fp2: TaskFingerprint = { ...makeFP() };
    expect(fingerprintHash(fp1)).toBe(fingerprintHash(fp2));
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
    expect(reduceAll(events, { fingerprintRegistry: reg }).state).toBe("COLLECTING_EVIDENCE");
  });

  it("fingerprint change in early state (before freeze) does not trigger recovery", () => {
    const store = new EventStore();
    const fp1 = makeFP({ mcodeVersion: "0.2.7" });
    const fp2 = makeFP({ mcodeVersion: "0.2.8" });
    const events = [
      store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {}, fingerprint: fp1 }),
      store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {}, fingerprint: fp2 }),
    ];
    const reg = new FingerprintRegistry();
    // 还没冻结,所以 fp2 不会触发 recovery
    expect(reduceAll(events, { fingerprintRegistry: reg }).state).toBe("VALIDATING");
  });
});

describe("reduce — event domains", () => {
  it("does not let storage events drive lifecycle state", () => {
    const store = new EventStore();
    const created = store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    const gcMarked = store.append({ taskId: "t", attemptId: "a1", type: "gc.marked", payload: {} });
    const reg = new FingerprintRegistry();
    const planned = reduce(null, created, { fingerprintRegistry: reg });

    expect(gcMarked.domain).toBe("storage");
    expect(reduce(planned, gcMarked, { fingerprintRegistry: reg })).toBe("PLANNED");
  });

  it("does not let projection events disturb a terminal lifecycle state", () => {
    const store = new EventStore();
    const repaired = store.append({
      taskId: "t",
      attemptId: "a1",
      type: "projection.repaired",
      payload: {},
    });

    expect(repaired.domain).toBe("projection");
    expect(reduce("ACCEPTED", repaired, {
      fingerprintRegistry: new FingerprintRegistry(),
    })).toBe("ACCEPTED");
  });
});

describe("reduce — illegal transitions (user requirement 2)", () => {
  it("throws InvalidTransitionError for skipping stages", () => {
    const store = new EventStore();
    const ev = store.append({ taskId: "t", attemptId: "a1", type: "agent.spawn.started", payload: {} });
    const reg = new FingerprintRegistry();
    expect(() => reduce("PLANNED", ev, { fingerprintRegistry: reg })).toThrow(InvalidTransitionError);
  });

  it("throws when receiving terminal state for already-terminal task", () => {
    const store = new EventStore();
    const ev = store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    const reg = new FingerprintRegistry();
    expect(() => reduce("ACCEPTED", ev, { fingerprintRegistry: reg })).toThrow(InvalidTransitionError);
  });
});
