/**
 * Result Normalizer — plan §25 + §26
 *
 * 把 stream-json 事件序列归一化到 WorkerResult。
 * Worker 自述不等于证据(plan §28),但这是 Worker self-report 的标准化入口。
 * 真实证据(plan §26 Workspace Evidence)由 G2M Core 单独采集,这里只做 self-report 归一化。
 */

import {
  type StreamJsonEvent,
  type ResultEvent,
  type SystemEvent,
} from "./stream-json-parser.js";
import type { WorkerResult, TestAttempt } from "../coding-worker.js";

export interface NormalizeOutcome {
  /**
   * 最终 WorkerResult,只在 result 事件出现时填充。
   * 多个 result 事件时(理论不该发生),取最后一个。
   */
  readonly result?: WorkerResult;
  /** system init 事件里的 session_id(plan §22,§48) */
  readonly sessionId?: string;
  /** result.blocked_reason(plan §41 REVIEW_PENDING / BLOCKED) */
  readonly blockedReason?: string;
  /** Final mcode exec.result status, when the real envelope is present. */
  readonly workerStatus?: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseSummaryPayload(output: unknown): JsonObject | undefined {
  if (isObject(output)) return output;
  if (typeof output !== "string") return undefined;

  const text = output.trim();
  const candidates = [text];
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1] !== undefined) candidates.unshift(fenced[1].trim());

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isObject(parsed)) return parsed;
    } catch {
      // Worker output may be ordinary Markdown instead of JSON.
    }
  }
  return undefined;
}

function normalizeExecResult(
  rawResult: JsonObject,
  sessionId: string | undefined,
): NormalizeOutcome {
  const output = rawResult["output"];
  const payload = parseSummaryPayload(output);
  const summary = stringValue(payload?.["summary"])
    ?? (typeof output === "string" ? output.trim() : "");
  const reportedTests = isObject(payload) ? payload["tests"] : undefined;
  const testsAttempted: TestAttempt[] = Array.isArray(reportedTests)
    ? reportedTests.flatMap((test): TestAttempt[] => {
        if (!isObject(test)) return [];
        const name = stringValue(test["name"]);
        const status = test["status"];
        if (
          name === undefined ||
          (status !== "passed" && status !== "failed" && status !== "skipped")
        ) {
          return [];
        }
        const message = stringValue(test["message"]);
        return [{
          name,
          status,
          ...(message !== undefined ? { message } : {}),
        }];
      })
    : [];

  const blockedReason = stringValue(payload?.["blocked_reason"]);
  const workerStatus = stringValue(rawResult["status"]);

  const result: WorkerResult = {
    executionId: "",
    ...(sessionId !== undefined ? { sessionId } : {}),
    summary,
    filesChanged: stringArray(payload?.["files_changed"] ?? payload?.["filesChanged"]),
    testsAttempted,
    remainingRisks: stringArray(
      payload?.["remaining_risks"] ?? payload?.["remainingRisks"],
    ),
    ...(blockedReason !== undefined ? { blockedReason } : {}),
  };

  return {
    result,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(result.blockedReason !== undefined
      ? { blockedReason: result.blockedReason }
      : {}),
    ...(workerStatus !== undefined ? { workerStatus } : {}),
  };
}

export function normalizeWorkerEvents(
  events: readonly StreamJsonEvent[],
): NormalizeOutcome {
  let lastResult: ResultEvent | undefined;
  let lastExecResult: JsonObject | undefined;
  let sessionId: string | undefined;

  for (const ev of events) {
    const raw = ev as unknown as JsonObject;
    const topLevelSessionId = stringValue(raw["sessionId"]);
    if (topLevelSessionId !== undefined) sessionId = topLevelSessionId;

    if (ev.type === "system") {
      const sys = ev as SystemEvent;
      if (sys.event === "init" && sys.session_id !== undefined) {
        sessionId = sys.session_id;
      }
      continue;
    }
    if (ev.type === "result") {
      lastResult = ev as ResultEvent;
      continue;
    }
    if (ev.type === "exec.completed" && isObject(raw["result"])) {
      lastExecResult = raw["result"];
      const nestedSessionId = stringValue(lastExecResult["sessionId"]);
      if (nestedSessionId !== undefined) sessionId = nestedSessionId;
    }
  }

  if (lastExecResult !== undefined) {
    return normalizeExecResult(lastExecResult, sessionId);
  }

  if (!lastResult) {
    return sessionId !== undefined ? { sessionId } : {};
  }

  const tests: TestAttempt[] = lastResult.tests.map((t) => ({
    name: t.name,
    status: t.status,
    ...(t.message !== undefined ? { message: t.message } : {}),
  }));

  const result: WorkerResult = {
    executionId: "", // 由 Adapter 在 start 时填好,这里是占位
    ...(sessionId !== undefined ? { sessionId } : {}),
    summary: lastResult.summary,
    filesChanged: lastResult.files_changed,
    testsAttempted: tests,
    remainingRisks: lastResult.remaining_risks,
    ...(lastResult.blocked_reason !== undefined
      ? { blockedReason: lastResult.blocked_reason }
      : {}),
  };

  return {
    result,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(lastResult.blocked_reason !== undefined
      ? { blockedReason: lastResult.blocked_reason }
      : {}),
  };
}
