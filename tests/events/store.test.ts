/**
 * EventStore + hash chain — plan §52
 */

import { describe, it, expect } from "vitest";

import {
  computeEventHash,
  EventStore,
  verifyChain,
} from "../../src/events/store.js";
import type { TaskEvent } from "../../src/events/events.js";
import type { TaskFingerprint } from "../../src/execution/fingerprint.js";

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

describe("EventStore.append", () => {
  it("assigns seq = 1, 2, 3, ... monotonically", () => {
    const store = new EventStore();
    const a = store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    const b = store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} });
    const c = store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(c.seq).toBe(3);
  });

  it("first event has prevHash = null; later events have prevHash = previous event's hash", () => {
    const store = new EventStore();
    const a = store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    const b = store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} });
    expect(a.prevHash).toBeNull();
    expect(b.prevHash).toBe(a.hash);
  });

  it("hash is sha256 of canonical JSON over the event fields (excluding hash itself)", () => {
    const store = new EventStore();
    const fp = makeFP();
    const event = store.append({
      taskId: "t", attemptId: "a1", type: "agent.spawn.started",
      payload: { executionId: "exec-1" },
      fingerprint: fp,
    });
    expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
    // 手工重算并比较
    const recomputed = computeEventHash({
      eventId: event.eventId,
      seq: event.seq,
      timestampMs: event.timestampMs,
      taskId: event.taskId,
      attemptId: event.attemptId,
      type: event.type,
      prevHash: event.prevHash,
      ...(event.fingerprint !== undefined ? { fingerprint: event.fingerprint } : {}),
      payload: event.payload,
    });
    expect(event.hash).toBe(recomputed);
  });

  it("eventId is a unique UUID per event", () => {
    const store = new EventStore();
    const a = store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    const b = store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} });
    expect(a.eventId).not.toBe(b.eventId);
  });

  it("timestampMs defaults to Date.now() and can be overridden for testing", () => {
    const store = new EventStore();
    const fixed = 1_700_000_000_000;
    const event = store.append({
      taskId: "t", attemptId: "a1", type: "task.created", payload: {},
      timestampMs: fixed,
    });
    expect(event.timestampMs).toBe(fixed);
  });

  it("stores fingerprint when provided (used by agent.spawn.started for freeze)", () => {
    const store = new EventStore();
    const fp = makeFP({ mcodeVersion: "0.2.7" });
    const event = store.append({
      taskId: "t", attemptId: "a1", type: "agent.spawn.started",
      payload: {}, fingerprint: fp,
    });
    expect(event.fingerprint).toEqual(fp);
  });
});

describe("EventStore.list (plan §52: insertion order, no sort)", () => {
  it("returns events in the order they were appended (physical order)", () => {
    const store = new EventStore();
    const types = [
      "task.created",
      "workspace.lock.requested",
      "agent.spawn.started",
      "agent.completed",
      "review.decision.accept",
    ] as const;
    for (const t of types) {
      store.append({ taskId: "t", attemptId: "a1", type: t, payload: {} });
    }
    const listed = store.list();
    expect(listed.map((e) => e.type)).toEqual([...types]);
  });

  it("returns a snapshot — mutating it does not affect the store", () => {
    const store = new EventStore();
    store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    const snapshot = store.list();
    expect(snapshot).toHaveLength(1);
    // 试图通过 reverse 改原数组
    (snapshot as TaskEvent[]).reverse();
    expect(store.list()[0]?.type).toBe("task.created");
  });

  it("does NOT sort by timestampMs or seq (only append order)", () => {
    const store = new EventStore();
    // 故意把时间戳倒着 append: 这样 seq 升序但 timestampMs 降序
    const t1 = store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {}, timestampMs: 3000 });
    const t2 = store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {}, timestampMs: 2000 });
    const t3 = store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {}, timestampMs: 1000 });
    const listed = store.list();
    expect(listed.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(listed.map((e) => e.timestampMs)).toEqual([3000, 2000, 1000]);
    expect(t1.seq).toBe(1);
    expect(t2.seq).toBe(2);
    expect(t3.seq).toBe(3);
  });
});

describe("EventStore indexes", () => {
  it("getByTaskId returns events for a specific task only", () => {
    const store = new EventStore();
    store.append({ taskId: "t1", attemptId: "a1", type: "task.created", payload: {} });
    store.append({ taskId: "t2", attemptId: "a1", type: "task.created", payload: {} });
    store.append({ taskId: "t1", attemptId: "a1", type: "task.validation.started", payload: {} });
    const t1Events = store.getByTaskId("t1");
    const t2Events = store.getByTaskId("t2");
    expect(t1Events).toHaveLength(2);
    expect(t2Events).toHaveLength(1);
    expect(t1Events.every((e) => e.taskId === "t1")).toBe(true);
  });

  it("getByAttemptId returns events for a specific attempt only", () => {
    const store = new EventStore();
    store.append({ taskId: "t1", attemptId: "att-1", type: "task.created", payload: {} });
    store.append({ taskId: "t1", attemptId: "att-2", type: "task.created", payload: {} });
    expect(store.getByAttemptId("att-1")).toHaveLength(1);
    expect(store.getByAttemptId("att-2")).toHaveLength(1);
  });

  it("getByEventId returns the matching event or undefined", () => {
    const store = new EventStore();
    const a = store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    expect(store.getByEventId(a.eventId)).toBe(a);
    expect(store.getByEventId("nonexistent")).toBeUndefined();
  });

  it("size returns total event count", () => {
    const store = new EventStore();
    expect(store.size()).toBe(0);
    store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    expect(store.size()).toBe(1);
  });
});

describe("verifyChain (user requirement 1: chain integrity, no reordering)", () => {
  it("validates an intact chain", () => {
    const store = new EventStore();
    store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} });
    store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} });
    const result = verifyChain(store.list());
    expect(result.valid).toBe(true);
  });

  it("validates an empty chain", () => {
    expect(verifyChain([]).valid).toBe(true);
  });

  it("flags prevHash mismatch when an event's prevHash is tampered", () => {
    const store = new EventStore();
    store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} });
    const events = store.list();
    // 篡改第 2 个事件的 prevHash
    const tampered = events.map((e, i) =>
      i === 1 ? { ...e, prevHash: "00" } : e,
    ) as TaskEvent[];
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("PREV_HASH_MISMATCH");
    expect(result.brokenAtSeq).toBe(2);
  });

  it("flags hash mismatch when payload is tampered", () => {
    const store = new EventStore();
    store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: { original: true } });
    const events = store.list();
    // 篡改 payload,但不改 hash
    const tampered = events.map((e, i) =>
      i === 0 ? { ...e, payload: { original: false } } : e,
    ) as TaskEvent[];
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("HASH_MISMATCH");
    expect(result.brokenAtSeq).toBe(1);
  });

  it("flags prevHash mismatch when events are reordered (plan §52: 禁止排序)", () => {
    const store = new EventStore();
    store.append({ taskId: "t", attemptId: "a1", type: "task.created", payload: {} });
    store.append({ taskId: "t", attemptId: "a1", type: "task.validation.started", payload: {} });
    store.append({ taskId: "t", attemptId: "a1", type: "task.validation.passed", payload: {} });
    const events = store.list();
    // 重新排序 — 第二和第三个事件互换
    const reordered = [events[0], events[2], events[1]] as TaskEvent[];
    const result = verifyChain(reordered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("PREV_HASH_MISMATCH");
  });

  it("first event must have prevHash = null; flagging if it's something else", () => {
    const e: TaskEvent = {
      eventId: "x",
      seq: 1,
      timestampMs: 1,
      taskId: "t",
      attemptId: "a1",
      type: "task.created",
      prevHash: "should-be-null",
      hash: "0".repeat(64),
      payload: {},
    };
    const result = verifyChain([e]);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("PREV_HASH_MISMATCH");
  });
});
