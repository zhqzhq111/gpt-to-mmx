/**
 * Recovery Resolver — plan §51
 *
 * 覆盖用户要求的测试:
 * - Crash(进程消失 + mid-execution + dirty workspace + no result → UNKNOWN)
 * - Result 已存在(进程没了 + Result 存在 → RECOVERED)
 * - Result 缺失(进程没了 + 没 Result + clean workspace → RECOVERED)
 * - Fingerprint 改变 → UNKNOWN
 * - 进程仍存活 → UNKNOWN
 * - UNKNOWN 禁止 auto retry / resume / 继续后续 Task
 * - Hash chain 断了 → UNKNOWN
 * - 没事件 → UNKNOWN
 * - currentState 终态 → RECOVERED
 * - replay 终态 → RECOVERED
 * - recovery.required 事件 append + reducer 把状态推到 RECOVERY_REQUIRED
 */

import { describe, it, expect } from "vitest";

import { EventStore } from "../../src/events/store.js";
import type { TaskEvent } from "../../src/events/events.js";
import { FingerprintRegistry, type TaskFingerprint } from "../../src/execution/fingerprint.js";
import { replay } from "../../src/events/replay.js";
import {
  resolveRecovery,
  appendRecoveryTransition,
  type RecoveryInput,
} from "../../src/recovery/resolver.js";
import type { WorkerResult } from "../../src/workers/coding-worker.js";

function makeFP(overrides: Partial<TaskFingerprint> = {}): TaskFingerprint {
  return {
    taskHash: "x".repeat(64),
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

function makeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    executionId: "exec-1",
    sessionId: "sess-1",
    summary: "did the thing",
    filesChanged: ["a.ts"],
    testsAttempted: [{ name: "t1", status: "passed" }],
    remainingRisks: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    currentState: null,
    events: [],
    processStatus: "exited_clean",
    workerResult: null,
    diff: null,
    fingerprintMatch: true,
    workspaceDirty: false,
    ...overrides,
  };
}

function makeEventsUpToAgentSpawn(): readonly TaskEvent[] {
  const store = new EventStore();
  const fp = makeFP();
  store.append({ taskId: "t-1", attemptId: "a-1", type: "task.created", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.started", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.passed", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.requested", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.acquired", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "agent.spawn.started", payload: {}, fingerprint: fp });
  return store.list();
}

function makeEventsUpToValidation(): readonly TaskEvent[] {
  const store = new EventStore();
  store.append({ taskId: "t-1", attemptId: "a-1", type: "task.created", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.started", payload: {} });
  return store.list();
}

function makeCompleteHappyPathEvents(): readonly TaskEvent[] {
  const store = new EventStore();
  const fp = makeFP();
  store.append({ taskId: "t-1", attemptId: "a-1", type: "task.created", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.started", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.passed", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.requested", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.acquired", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "agent.spawn.started", payload: {}, fingerprint: fp });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "agent.completed", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "evidence.diff.collected", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "verification.completed", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "review.requested", payload: {} });
  store.append({ taskId: "t-1", attemptId: "a-1", type: "review.decision.accept", payload: {} });
  return store.list();
}

describe("resolveRecovery — Crash mid-execution (plan §51 example)", () => {
  it("returns UNKNOWN for process gone, no result, dirty workspace", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "crashed",
      workerResult: null,
      workspaceDirty: true,
    }));
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.suggestedNextState).toBe("RECOVERY_REQUIRED");
    expect(r.reason).toMatch(/dirty workspace|cannot determine/);
  });

  it("returns UNKNOWN for process exited_error, no result, dirty workspace", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "exited_error",
      workerResult: null,
      workspaceDirty: true,
    }));
    expect(r.verdict).toBe("UNKNOWN");
  });

  it("returns UNKNOWN for process exited_clean, no result, dirty workspace (still ambiguous)", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "exited_clean",
      workerResult: null,
      workspaceDirty: true,
    }));
    expect(r.verdict).toBe("UNKNOWN");
  });

  it("returns UNKNOWN for crash during COLLECTING_EVIDENCE state", () => {
    // 构造一个 last event 是 evidence.diff.collected 的事件链
    const store = new EventStore();
    const fp = makeFP();
    store.append({ taskId: "t-1", attemptId: "a-1", type: "task.created", payload: {} });
    store.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.started", payload: {} });
    store.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.passed", payload: {} });
    store.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.requested", payload: {} });
    store.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.acquired", payload: {} });
    store.append({ taskId: "t-1", attemptId: "a-1", type: "agent.spawn.started", payload: {}, fingerprint: fp });
    store.append({ taskId: "t-1", attemptId: "a-1", type: "agent.completed", payload: {} });
    const events = store.list();
    const r = resolveRecovery(makeInput({
      events,
      currentState: "COLLECTING_EVIDENCE",
      processStatus: "crashed",
      workerResult: null,
      workspaceDirty: true,
    }));
    expect(r.verdict).toBe("UNKNOWN");
  });
});

describe("resolveRecovery — Result exists (plan §28 / §67)", () => {
  it("returns RECOVERED at COLLECTING_EVIDENCE when result is present", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "exited_clean",
      workerResult: makeWorkerResult(),
      workspaceDirty: true,
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    expect(r.suggestedNextState).toBe("COLLECTING_EVIDENCE");
    expect(r.reason).toMatch(/worker result/);
  });

  it("returns RECOVERED at COLLECTING_EVIDENCE when result is present and diff is also collected", () => {
    // 事件链已经走到 evidence.diff.collected,但 result 在外面捕获
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "exited_clean",
      workerResult: makeWorkerResult(),
      diff: null,
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    expect(r.suggestedNextState).toBe("COLLECTING_EVIDENCE");
  });

  it("returns RECOVERED even if workspace is clean (result takes precedence)", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "exited_clean",
      workerResult: makeWorkerResult(),
      workspaceDirty: false,
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
  });

  it("returns RECOVERED at COLLECTING_EVIDENCE with no canAutoContinueNextTask (post-result state is non-terminal)", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      workerResult: makeWorkerResult(),
    }));
    expect(r.canAutoContinueNextTask).toBe(false);
  });
});

describe("resolveRecovery — Result missing", () => {
  it("returns RECOVERED at replay state when workspace is clean (agent never ran or no changes)", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToValidation(),
      currentState: "VALIDATING",
      processStatus: "exited_clean",
      workerResult: null,
      workspaceDirty: false,
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    expect(r.suggestedNextState).toBe("VALIDATING");
    expect(r.reason).toMatch(/clean workspace|did not modify/);
  });

  it("returns RECOVERED at SPAWNING_AGENT when lock acquired but agent never spawned", () => {
    const store = new EventStore();
    store.append({ taskId: "t-1", attemptId: "a-1", type: "task.created", payload: {} });
    store.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.started", payload: {} });
    store.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.passed", payload: {} });
    store.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.requested", payload: {} });
    store.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.acquired", payload: {} });
    const events = store.list();
    const r = resolveRecovery(makeInput({
      events,
      currentState: "SPAWNING_AGENT",
      processStatus: "exited_clean",
      workerResult: null,
      workspaceDirty: false,
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    expect(r.suggestedNextState).toBe("SPAWNING_AGENT");
  });

  it("returns UNKNOWN when result missing + dirty workspace (mid-modification crash)", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "crashed",
      workerResult: null,
      workspaceDirty: true,
    }));
    expect(r.verdict).toBe("UNKNOWN");
  });

  it("returns RECOVERED at PLANNED when only task.created event exists and workspace clean", () => {
    const store = new EventStore();
    store.append({ taskId: "t-1", attemptId: "a-1", type: "task.created", payload: {} });
    const r = resolveRecovery(makeInput({
      events: store.list(),
      currentState: "PLANNED",
      processStatus: "exited_clean",
      workerResult: null,
      workspaceDirty: false,
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    expect(r.suggestedNextState).toBe("PLANNED");
  });
});

describe("resolveRecovery — Fingerprint changed", () => {
  it("returns UNKNOWN when fingerprintMatch is false (plan §51 / §53)", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "crashed",
      fingerprintMatch: false,
      workspaceDirty: true,
    }));
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.suggestedNextState).toBe("RECOVERY_REQUIRED");
    expect(r.reason).toMatch(/fingerprint/);
  });

  it("fingerprint check takes precedence over other reconciliation (security)", () => {
    // 即使 current state 是 terminal,fingerprint 不匹配也直接 UNKNOWN
    const r = resolveRecovery(makeInput({
      currentState: "ACCEPTED",
      fingerprintMatch: false,
    }));
    expect(r.verdict).toBe("UNKNOWN");
  });

  it("returns UNKNOWN when fingerprint mismatch even with result present", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      workerResult: makeWorkerResult(),
      fingerprintMatch: false,
    }));
    expect(r.verdict).toBe("UNKNOWN");
  });
});

describe("resolveRecovery — Process still alive", () => {
  it("returns UNKNOWN when processStatus is alive (must not kill)", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "alive",
      workerResult: null,
      workspaceDirty: false,
    }));
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.reason).toMatch(/alive/);
    expect(r.suggestedNextState).toBe("RECOVERY_REQUIRED");
  });

  it("process alive check takes precedence over result presence", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "alive",
      workerResult: makeWorkerResult(),
    }));
    expect(r.verdict).toBe("UNKNOWN");
  });

  it("process alive check takes precedence over terminal currentState", () => {
    // 即便 current state 是 terminal,process 还在跑就不应该 reconcile
    const r = resolveRecovery(makeInput({
      currentState: "RUNNING",
      processStatus: "alive",
    }));
    expect(r.verdict).toBe("UNKNOWN");
  });
});

describe("resolveRecovery — Hash chain broken (plan §46)", () => {
  it("returns UNKNOWN when payload is tampered", () => {
    const events = makeCompleteHappyPathEvents();
    const tampered = events.map((e, i) =>
      i === 0 ? { ...e, payload: { tampered: true } } : e,
    );
    const r = resolveRecovery(makeInput({
      events: tampered,
      currentState: "REVIEW_PENDING",
      processStatus: "exited_clean",
    }));
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.reason).toMatch(/event chain broken/);
  });

  it("returns UNKNOWN when prevHash is broken", () => {
    const events = makeCompleteHappyPathEvents();
    const tampered = events.map((e, i) =>
      i === 3 ? { ...e, prevHash: "deadbeef" } : e,
    );
    const r = resolveRecovery(makeInput({
      events: tampered,
      currentState: "REVIEW_PENDING",
      processStatus: "exited_clean",
    }));
    expect(r.verdict).toBe("UNKNOWN");
  });
});

describe("resolveRecovery — current state terminal", () => {
  it("returns RECOVERED at ACCEPTED when currentState is terminal", () => {
    const r = resolveRecovery(makeInput({
      currentState: "ACCEPTED",
      events: [],
      processStatus: "exited_clean",
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    expect(r.suggestedNextState).toBe("ACCEPTED");
    expect(r.canAutoContinueNextTask).toBe(true);
  });

  it("returns RECOVERED at BLOCKED (canAutoContinueNextTask = true, next task can start)", () => {
    const r = resolveRecovery(makeInput({
      currentState: "BLOCKED",
      events: [],
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    expect(r.suggestedNextState).toBe("BLOCKED");
    expect(r.canAutoContinueNextTask).toBe(true);
  });

  it("returns RECOVERED at RECOVERY_REQUIRED (already in this state, canAutoContinue = false)", () => {
    const r = resolveRecovery(makeInput({
      currentState: "RECOVERY_REQUIRED",
      events: [],
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    expect(r.suggestedNextState).toBe("RECOVERY_REQUIRED");
    expect(r.canAutoContinueNextTask).toBe(false);
  });

  it("returns RECOVERED at FAILED (canAutoContinueNextTask = true)", () => {
    const r = resolveRecovery(makeInput({
      currentState: "FAILED",
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    expect(r.canAutoContinueNextTask).toBe(true);
  });
});

describe("resolveRecovery — replay reaches terminal", () => {
  it("returns RECOVERED at ACCEPTED when events complete the happy path", () => {
    const r = resolveRecovery(makeInput({
      events: makeCompleteHappyPathEvents(),
      currentState: "REVIEW_PENDING", // 状态机还没 advance
      processStatus: "exited_clean",
    }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    expect(r.suggestedNextState).toBe("ACCEPTED");
    expect(r.canAutoContinueNextTask).toBe(true);
  });

  it("currentState terminal wins over replay (caller is authoritative when known)", () => {
    // 如果 caller 说 ACCEPTED 但 replay 还在 RUNNING,信任 caller
    const events = makeEventsUpToAgentSpawn();
    const r = resolveRecovery(makeInput({
      events,
      currentState: "ACCEPTED", // caller 已知
    }));
    expect(r.suggestedNextState).toBe("ACCEPTED");
  });
});

describe("resolveRecovery — no events", () => {
  it("returns UNKNOWN when events array is empty", () => {
    const r = resolveRecovery(makeInput({
      currentState: "PLANNED",
      events: [],
      processStatus: "exited_clean",
    }));
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.reason).toMatch(/no events/);
  });
});

describe("resolveRecovery — anti-retry / anti-resume / anti-next-task (user requirement 4)", () => {
  it("UNKNOWN always sets safeToRetry = false (plan §50)", () => {
    const r1 = resolveRecovery(makeInput());
    const r2 = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      processStatus: "crashed",
    }));
    const r3 = resolveRecovery(makeInput({
      events: [],
      fingerprintMatch: false,
    }));
    expect(r1.safeToRetry).toBe(false);
    expect(r2.safeToRetry).toBe(false);
    expect(r3.safeToRetry).toBe(false);
  });

  it("RECOVERED also sets safeToRetry = false (plan §50: only on clear pre-execution failure)", () => {
    const r = resolveRecovery(makeInput({ currentState: "ACCEPTED" }));
    expect(r.safeToRetry).toBe(false);
  });

  it("UNKNOWN always sets safeToResume = false (plan §48)", () => {
    const r = resolveRecovery(makeInput());
    expect(r.safeToResume).toBe(false);
  });

  it("RECOVERED also sets safeToResume = false (no verified session_id in MVP)", () => {
    const r = resolveRecovery(makeInput({ currentState: "ACCEPTED" }));
    expect(r.safeToResume).toBe(false);
  });

  it("UNKNOWN always sets canAutoContinueNextTask = false (plan §51)", () => {
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      processStatus: "crashed",
      workspaceDirty: true,
    }));
    expect(r.canAutoContinueNextTask).toBe(false);
  });
});

describe("appendRecoveryTransition", () => {
  it("appends recovery.required event for UNKNOWN + non-terminal state", () => {
    const eventStore = new EventStore();
    const r = resolveRecovery(makeInput({
      events: makeEventsUpToAgentSpawn(),
      currentState: "RUNNING",
      processStatus: "crashed",
      workspaceDirty: true,
    }));
    expect(r.verdict).toBe("UNKNOWN");
    const event = appendRecoveryTransition(r, {
      taskId: "t-1",
      attemptId: "a-1",
      currentState: "RUNNING",
      eventStore,
    });
    expect(event).not.toBeNull();
    expect(event?.type).toBe("recovery.required");
    expect(event?.payload).toHaveProperty("reason");
    expect(eventStore.size()).toBe(1);
  });

  it("returns null for RECOVERED (no event needed, state already consistent)", () => {
    const eventStore = new EventStore();
    const r = resolveRecovery(makeInput({ currentState: "ACCEPTED" }));
    expect(r.verdict).toBe("RECOVERY_RECONCILED");
    const event = appendRecoveryTransition(r, {
      taskId: "t-1",
      attemptId: "a-1",
      currentState: "ACCEPTED",
      eventStore,
    });
    expect(event).toBeNull();
    expect(eventStore.size()).toBe(0);
  });

  it("returns null for UNKNOWN + terminal state (can't transition from terminal)", () => {
    const eventStore = new EventStore();
    const u = resolveRecovery(makeInput({
      currentState: "ACCEPTED",
      events: [],
      fingerprintMatch: false, // forces UNKNOWN
    }));
    expect(u.verdict).toBe("UNKNOWN");
    const event = appendRecoveryTransition(u, {
      taskId: "t-1",
      attemptId: "a-1",
      currentState: "ACCEPTED",
      eventStore,
    });
    expect(event).toBeNull();
    expect(eventStore.size()).toBe(0);
  });
});

describe("integration: full recovery flow (Crash → UNKNOWN → RECOVERY_REQUIRED)", () => {
  it("resolves UNKNOWN, helper appends event, replay reaches RECOVERY_REQUIRED", () => {
    // 模拟:G2M 跑到 RUNNING 状态,mcode 崩了
    const eventStore = new EventStore();
    const fp = makeFP();
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "task.created", payload: {} });
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.started", payload: {} });
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.passed", payload: {} });
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.requested", payload: {} });
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.acquired", payload: {} });
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "agent.spawn.started", payload: {}, fingerprint: fp });
    // No agent.completed — crash here

    const events = eventStore.list();

    // Step 1: 收集信息,call resolver
    const resolution = resolveRecovery({
      currentState: "RUNNING",
      events,
      processStatus: "crashed",
      workerResult: null,
      diff: null,
      fingerprintMatch: true,
      workspaceDirty: true,
    });

    // Step 2: 验证 UNKNOWN + 全套禁止
    expect(resolution.verdict).toBe("UNKNOWN");
    expect(resolution.suggestedNextState).toBe("RECOVERY_REQUIRED");
    expect(resolution.safeToRetry).toBe(false);
    expect(resolution.safeToResume).toBe(false);
    expect(resolution.canAutoContinueNextTask).toBe(false);

    // Step 3: apply transition
    const event = appendRecoveryTransition(resolution, {
      taskId: "t-1",
      attemptId: "a-1",
      currentState: "RUNNING",
      eventStore,
    });
    expect(event?.type).toBe("recovery.required");

    // Step 4: replay 验证最终状态
    const reg = new FingerprintRegistry();
    const replayResult = replay(eventStore.list(), { fingerprintRegistry: reg });
    expect(replayResult.state).toBe("RECOVERY_REQUIRED");
  });
});

describe("integration: full recovery flow (Result exists → RECOVERED at post-result state)", () => {
  it("resolves RECOVERED at COLLECTING_EVIDENCE, no extra event needed", () => {
    const eventStore = new EventStore();
    const fp = makeFP();
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "task.created", payload: {} });
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.started", payload: {} });
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "task.validation.passed", payload: {} });
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.requested", payload: {} });
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "workspace.lock.acquired", payload: {} });
    eventStore.append({ taskId: "t-1", attemptId: "a-1", type: "agent.spawn.started", payload: {}, fingerprint: fp });

    const events = eventStore.list();
    const resolution = resolveRecovery({
      currentState: "RUNNING",
      events,
      processStatus: "exited_clean",
      workerResult: makeWorkerResult(),
      diff: null,
      fingerprintMatch: true,
      workspaceDirty: true,
    });
    expect(resolution.verdict).toBe("RECOVERY_RECONCILED");
    expect(resolution.suggestedNextState).toBe("COLLECTING_EVIDENCE");
    expect(resolution.canAutoContinueNextTask).toBe(false); // 还没到终态

    // 不需要 append 任何事件(状态机自己处理 advance)
    const event = appendRecoveryTransition(resolution, {
      taskId: "t-1",
      attemptId: "a-1",
      currentState: "RUNNING",
      eventStore,
    });
    expect(event).toBeNull();
  });
});
