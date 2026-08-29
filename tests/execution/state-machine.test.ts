/**
 * State Machine — plan §41 + §51
 */

import { describe, it, expect } from "vitest";

import {
  ACTIVE_STATES,
  InvalidTransitionError,
  isActive,
  isTerminal,
  legalNextStates,
  nextState,
  TERMINAL_STATES,
  type TaskState,
} from "../../src/execution/state-machine.js";

describe("TaskState sets", () => {
  it("ACTIVE_STATES contains 10 active states", () => {
    expect(ACTIVE_STATES.size).toBe(10);
    expect(ACTIVE_STATES.has("PLANNED")).toBe(true);
    expect(ACTIVE_STATES.has("RUNNING")).toBe(true);
    expect(ACTIVE_STATES.has("REVIEW_PENDING")).toBe(true);
  });

  it("TERMINAL_STATES contains 7 terminal states, including RECOVERY_REQUIRED", () => {
    expect(TERMINAL_STATES.size).toBe(7);
    expect(TERMINAL_STATES.has("ACCEPTED")).toBe(true);
    expect(TERMINAL_STATES.has("BLOCKED")).toBe(true);
    expect(TERMINAL_STATES.has("FAILED")).toBe(true);
    expect(TERMINAL_STATES.has("TIMED_OUT")).toBe(true);
    expect(TERMINAL_STATES.has("CANCELLED")).toBe(true);
    expect(TERMINAL_STATES.has("REVISION_REQUESTED")).toBe(true);
    expect(TERMINAL_STATES.has("RECOVERY_REQUIRED")).toBe(true);
  });

  it("UNKNOWN is NOT a TaskState (plan §51: UNKNOWN is a Recovery Verdict, not a state)", () => {
    const allStates: TaskState[] = [
      "PLANNED", "VALIDATING", "READY", "WAITING_WORKSPACE_LOCK",
      "SPAWNING_AGENT", "RUNNING", "COLLECTING_EVIDENCE", "VERIFYING",
      "EXECUTION_SUCCEEDED", "REVIEW_PENDING",
      "REVISION_REQUESTED", "ACCEPTED", "BLOCKED",
      "FAILED", "TIMED_OUT", "CANCELLED", "RECOVERY_REQUIRED",
    ];
    expect(allStates.includes("UNKNOWN" as TaskState)).toBe(false);
  });

  it("isActive / isTerminal are complements for the 17 states", () => {
    const allStates: TaskState[] = [
      "PLANNED", "VALIDATING", "READY", "WAITING_WORKSPACE_LOCK",
      "SPAWNING_AGENT", "RUNNING", "COLLECTING_EVIDENCE", "VERIFYING",
      "EXECUTION_SUCCEEDED", "REVIEW_PENDING",
      "REVISION_REQUESTED", "ACCEPTED", "BLOCKED",
      "FAILED", "TIMED_OUT", "CANCELLED", "RECOVERY_REQUIRED",
    ];
    for (const s of allStates) {
      expect(isActive(s) !== isTerminal(s)).toBe(true);
    }
  });
});

describe("nextState (plan §41 transitions)", () => {
  it("happy path: PLANNED → VALIDATING → READY → ... → ACCEPTED", () => {
    const path: Array<[TaskState, Parameters<typeof nextState>[1], TaskState]> = [
      ["PLANNED", "task.validation.started", "VALIDATING"],
      ["VALIDATING", "task.validation.passed", "READY"],
      ["READY", "workspace.lock.requested", "WAITING_WORKSPACE_LOCK"],
      ["WAITING_WORKSPACE_LOCK", "workspace.lock.acquired", "SPAWNING_AGENT"],
      ["SPAWNING_AGENT", "agent.spawn.started", "RUNNING"],
      ["RUNNING", "agent.completed", "COLLECTING_EVIDENCE"],
      ["COLLECTING_EVIDENCE", "evidence.diff.collected", "VERIFYING"],
      ["VERIFYING", "verification.completed", "EXECUTION_SUCCEEDED"],
      ["EXECUTION_SUCCEEDED", "review.requested", "REVIEW_PENDING"],
      ["REVIEW_PENDING", "review.decision.accept", "ACCEPTED"],
    ];
    for (const [from, ev, to] of path) {
      expect(nextState(from, ev)).toBe(to);
    }
  });

  it("VERIFYING can go to EXECUTION_SUCCEEDED via either verification.completed or verification.skipped", () => {
    expect(nextState("VERIFYING", "verification.completed")).toBe("EXECUTION_SUCCEEDED");
    expect(nextState("VERIFYING", "verification.skipped")).toBe("EXECUTION_SUCCEEDED");
  });

  it("RUNNING branches into FAILED / TIMED_OUT / CANCELLED on bad agent events", () => {
    expect(nextState("RUNNING", "agent.failed")).toBe("FAILED");
    expect(nextState("RUNNING", "agent.timed_out")).toBe("TIMED_OUT");
    expect(nextState("RUNNING", "agent.cancelled")).toBe("CANCELLED");
  });

  it("WAITING_WORKSPACE_LOCK can fail with FAILED on lock.busy", () => {
    expect(nextState("WAITING_WORKSPACE_LOCK", "workspace.lock.busy")).toBe("FAILED");
  });

  it("REVIEW_PENDING branches to ACCEPTED / REVISION_REQUESTED / BLOCKED", () => {
    expect(nextState("REVIEW_PENDING", "review.decision.accept")).toBe("ACCEPTED");
    expect(nextState("REVIEW_PENDING", "review.decision.revise")).toBe("REVISION_REQUESTED");
    expect(nextState("REVIEW_PENDING", "review.decision.block")).toBe("BLOCKED");
  });
});

describe("nextState rejects illegal transitions (user requirement 2)", () => {
  it("throws InvalidTransitionError when no edge is defined", () => {
    let caught: unknown;
    try {
      nextState("PLANNED", "agent.completed");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    const err = caught as InvalidTransitionError;
    expect(err.fromState).toBe("PLANNED");
    expect(err.eventType).toBe("agent.completed");
  });

  it("terminal states have no outgoing edges (all events rejected)", () => {
    const terminals: TaskState[] = [
      "ACCEPTED", "BLOCKED", "FAILED", "TIMED_OUT", "CANCELLED",
      "REVISION_REQUESTED", "RECOVERY_REQUIRED",
    ];
    for (const s of terminals) {
      expect(legalNextStates(s)).toHaveLength(0);
      expect(() => nextState(s, "task.created")).toThrow(InvalidTransitionError);
    }
  });

  it("does not silently no-op — every illegal event throws", () => {
    // PLANNED + 任何非 task.validation.started 的事件 → throw
    const illegalEvents = [
      "task.created", "task.validation.passed", "task.validation.failed",
      "workspace.lock.requested", "agent.completed", "agent.spawn.started",
      "review.decision.accept", "verification.completed",
    ];
    for (const ev of illegalEvents) {
      expect(() => nextState("PLANNED", ev as never)).toThrow(InvalidTransitionError);
    }
  });

  it("does not allow skipping lifecycle stages (READY → RUNNING is illegal)", () => {
    expect(() => nextState("READY", "agent.spawn.started")).toThrow(InvalidTransitionError);
    expect(() => nextState("WAITING_WORKSPACE_LOCK", "agent.spawn.started")).toThrow(InvalidTransitionError);
  });
});

describe("legalNextStates", () => {
  it("PLANNED has VALIDATING and RECOVERY_REQUIRED as next (plan §51)", () => {
    const next = legalNextStates("PLANNED");
    expect(next).toHaveLength(2);
    expect(next).toContain("VALIDATING");
    expect(next).toContain("RECOVERY_REQUIRED");
  });

  it("RUNNING has 5 next states (collected + 3 failure modes + recovery, plan §51)", () => {
    const next = legalNextStates("RUNNING");
    expect(next).toHaveLength(5);
    expect(next).toContain("COLLECTING_EVIDENCE");
    expect(next).toContain("FAILED");
    expect(next).toContain("TIMED_OUT");
    expect(next).toContain("CANCELLED");
    expect(next).toContain("RECOVERY_REQUIRED");
  });
});

describe("recovery.required event (plan §51)", () => {
  it("transitions from every active state to RECOVERY_REQUIRED", () => {
    const activeStates: TaskState[] = [
      "PLANNED", "VALIDATING", "READY", "WAITING_WORKSPACE_LOCK",
      "SPAWNING_AGENT", "RUNNING", "COLLECTING_EVIDENCE", "VERIFYING",
      "EXECUTION_SUCCEEDED", "REVIEW_PENDING",
    ];
    for (const s of activeStates) {
      expect(nextState(s, "recovery.required")).toBe("RECOVERY_REQUIRED");
    }
  });

  it("terminal states reject recovery.required", () => {
    const terminals: TaskState[] = [
      "REVISION_REQUESTED", "ACCEPTED", "BLOCKED",
      "FAILED", "TIMED_OUT", "CANCELLED", "RECOVERY_REQUIRED",
    ];
    for (const s of terminals) {
      expect(() => nextState(s, "recovery.required")).toThrow(InvalidTransitionError);
    }
  });
});
