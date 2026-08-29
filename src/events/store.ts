/**
 * Event Store — plan §52
 *
 * Append-only 事件仓库(内存版,持久化留到 Phase 9)。
 * 关键约束(plan §52 + 用户要求 1):
 * - 物理顺序就是事件顺序,append-only,禁止 Replay 排序
 * - 每个事件带 seq(单调)和 hash(由 prevHash 链上来的 sha256)
 * - chain verification 用来检测日志被篡改
 *
 * Hash Chain 设计(plan §46 anti-stale / anti-replay + 用户要求 5/6):
 * - 第 1 个事件 prevHash = null
 * - 第 N 个事件 prevHash = 第 N-1 个事件的 hash
 * - 每个事件的 hash = sha256(canonicalJson({seq, timestampMs, taskId,
 *   attemptId, type, prevHash, fingerprint, payload}))
 *
 * 验证策略:
 * - verifyChain 检查 prevHash 链接 + hash 本身
 * - 任何不一致 → EventStoreError,phase 9 的 recovery 会把它转 RECOVERY_REQUIRED
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../protocol/hash.js";
import type { TaskFingerprint } from "../execution/fingerprint.js";
import type { TaskEvent, TaskEventPayload, TaskEventType } from "./events.js";
import { appendJsonLine, readJsonLines } from "../persistence/durable-state.js";

/**
 * EventStore.append 的输入。seq / prevHash / hash 由 store 自动填。
 */
export interface TaskEventInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly type: TaskEventType;
  readonly payload: TaskEventPayload;
  readonly fingerprint?: TaskFingerprint;
  /**
   * 可选时间戳覆盖,默认 Date.now()。测试用。
   */
  readonly timestampMs?: number;
}

export class EventStoreError extends Error {
  readonly code: "PREV_HASH_MISMATCH" | "HASH_MISMATCH" | "PERSISTENCE_FAILED";
  constructor(
    code: EventStoreError["code"],
    message: string,
  ) {
    super(message);
    this.name = "EventStoreError";
    this.code = code;
  }
}

/**
 * 计算事件的 hash(plan §46 anti-stale 绑定)。
 * fingerprint 字段不参与 hash 时如果 undefined 会被 canonicalJson 跳过,
 * 所以"没 fingerprint"和"fingerprint: undefined"是同一回事。
 */
export function computeEventHash(
  event: Omit<TaskEvent, "hash">,
): string {
  return sha256({
    seq: event.seq,
    timestampMs: event.timestampMs,
    taskId: event.taskId,
    attemptId: event.attemptId,
    type: event.type,
    prevHash: event.prevHash,
    fingerprint: event.fingerprint,
    payload: event.payload,
  });
}

export interface ChainVerificationResult {
  readonly valid: boolean;
  readonly brokenAtSeq?: number;
  readonly brokenAtEventId?: string;
  readonly reason?: "PREV_HASH_MISMATCH" | "HASH_MISMATCH";
}

export interface EventStoreOptions {
  readonly logDirectory?: string;
}

export class EventStore {
  private readonly events: TaskEvent[] = [];
  private readonly logDirectory: string | undefined;

  constructor(options: EventStoreOptions = {}) {
    this.logDirectory = options.logDirectory;
    if (this.logDirectory === undefined) return;

    mkdirSync(this.logDirectory, { recursive: true });
    const files = readdirSync(this.logDirectory)
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
    for (const file of files) {
      const path = join(this.logDirectory, file);
      const loaded = readJsonLines<TaskEvent>(path);
      const verification = verifyChain(loaded);
      if (!verification.valid) {
        throw new EventStoreError(
          "PERSISTENCE_FAILED",
          `event log chain is invalid in ${path} at sequence ${verification.brokenAtSeq ?? "unknown"}`,
        );
      }
      this.events.push(...loaded);
    }
  }

  /**
   * Append 一个事件。seq / prevHash / hash 自动填。
   * 返回填好 metadata 的完整事件。
   */
  append(input: TaskEventInput): TaskEvent {
    const attemptEvents = this.logDirectory === undefined
      ? this.events
      : this.events.filter((event) => event.attemptId === input.attemptId);
    const prev = attemptEvents[attemptEvents.length - 1];
    const seq = prev ? prev.seq + 1 : 1;
    const prevHash: string | null = prev ? prev.hash : null;
    const partial: Omit<TaskEvent, "hash"> = {
      eventId: randomUUID(),
      seq,
      prevHash,
      timestampMs: input.timestampMs ?? Date.now(),
      taskId: input.taskId,
      attemptId: input.attemptId,
      type: input.type,
      payload: input.payload,
      ...(input.fingerprint !== undefined
        ? { fingerprint: input.fingerprint }
        : {}),
    };
    const hash = computeEventHash(partial);
    const event: TaskEvent = { ...partial, hash };
    if (this.logDirectory !== undefined) {
      const path = join(this.logDirectory, `${encodeURIComponent(input.attemptId)}.jsonl`);
      appendJsonLine(path, event);
    }
    this.events.push(event);
    return event;
  }

  /**
   * 列出全部事件,插入顺序(plan §52 物理顺序 = 事件顺序)。
   * 返回浅拷贝,防止外部修改内部数组。
   */
  list(): readonly TaskEvent[] {
    return this.events.slice();
  }

  getByEventId(eventId: string): TaskEvent | undefined {
    return this.events.find((e) => e.eventId === eventId);
  }

  getByTaskId(taskId: string): readonly TaskEvent[] {
    return this.events.filter((e) => e.taskId === taskId);
  }

  getByAttemptId(attemptId: string): readonly TaskEvent[] {
    return this.events.filter((e) => e.attemptId === attemptId);
  }

  size(): number {
    return this.events.length;
  }
}

/**
 * 验证一串事件的 hash chain。
 * - 第 1 个事件 prevHash 必须是 null
 * - 第 N 个事件 prevHash 必须等于第 N-1 个事件的 hash
 * - 每个事件的 hash 必须等于 computeEventHash(它本身,不算 hash 字段)
 */
export function verifyChain(
  events: readonly TaskEvent[],
): ChainVerificationResult {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined) continue; // noUncheckedIndexedAccess 兼容
    const expectedPrev = i === 0 ? null : events[i - 1]?.hash ?? null;
    if (e.prevHash !== expectedPrev) {
      return {
        valid: false,
        brokenAtSeq: e.seq,
        brokenAtEventId: e.eventId,
        reason: "PREV_HASH_MISMATCH",
      };
    }
    const expectedHash = computeEventHash(e);
    if (expectedHash !== e.hash) {
      return {
        valid: false,
        brokenAtSeq: e.seq,
        brokenAtEventId: e.eventId,
        reason: "HASH_MISMATCH",
      };
    }
  }
  return { valid: true };
}
