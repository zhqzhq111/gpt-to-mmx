/**
 * mcode stream-json Parser — plan §38
 *
 * mcode 真实 stream-json 输出格式(基于官方文档 + eogee.com 报道):
 * - NDJSON(Newline-Delimited JSON),每行一个 JSON object
 * - 事件类型跟 plan §42 状态机 + §25 Worker Summary 协议对齐
 *
 * G2M 不假设 mcode 内部事件 schema 100% 确定,这里定义一个 best-guess
 * 事件 union,Phase 0 真实 mcode 实测后,如果有出入只改本文件,不影响
 * MCodeAdapter / ResultNormalizer。
 */

export type StreamJsonEvent =
  | SystemEvent
  | AssistantEvent
  | ToolEvent
  | ResultEvent
  | RawEvent;

export interface SystemEvent {
  readonly type: "system";
  readonly event: "init" | "complete" | "error";
  readonly session_id?: string;
  readonly message?: string;
}

export interface AssistantEvent {
  readonly type: "assistant";
  readonly text: string;
}

export interface ToolEvent {
  readonly type: "tool";
  readonly name: string;
  readonly args?: unknown;
  readonly result?: unknown;
}

export interface ResultEvent {
  readonly type: "result";
  readonly status: "success" | "failure" | "blocked";
  readonly summary: string;
  readonly files_changed: readonly string[];
  readonly tests: readonly {
    readonly name: string;
    readonly status: "passed" | "failed" | "skipped";
    readonly message?: string;
  }[];
  readonly remaining_risks: readonly string[];
  readonly blocked_reason?: string;
}

/** 未知事件类型,保留 raw,供 debugging */
export interface RawEvent {
  readonly type: string;
  readonly [k: string]: unknown;
}

export class StreamJsonParseError extends Error {
  readonly code: "INVALID_JSON" | "EMPTY_LINE" | "INVALID_EVENT";
  override readonly cause?: unknown;
  constructor(code: StreamJsonParseError["code"], message: string, cause?: unknown) {
    super(message);
    this.name = "StreamJsonParseError";
    this.code = code;
    this.cause = cause;
  }
}

function invalidEvent(message: string): never {
  throw new StreamJsonParseError("INVALID_EVENT", message);
}

function requiredString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string") invalidEvent(`known event requires string \`${field}\``);
  return value;
}

function requiredStringArray(obj: Record<string, unknown>, field: string): string[] {
  const value = obj[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalidEvent(`known event requires string array \`${field}\``);
  }
  return value;
}

/**
 * 解析一行 NDJSON,失败抛 StreamJsonParseError(不静默吞)。
 * 解析成功返回类型化事件,未知 type 用 RawEvent 兜底。
 */
export function parseStreamJsonLine(line: string): StreamJsonEvent {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new StreamJsonParseError("EMPTY_LINE", "empty line");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (e) {
    throw new StreamJsonParseError(
      "INVALID_JSON",
      `failed to parse JSON: ${(e as Error).message}`,
      e,
    );
  }
  if (raw === null || typeof raw !== "object") {
    throw new StreamJsonParseError(
      "INVALID_JSON",
      "expected JSON object, got non-object",
    );
  }
  const obj = raw as Record<string, unknown>;
  const type = obj["type"];
  if (typeof type !== "string") {
    throw new StreamJsonParseError(
      "INVALID_JSON",
      "event missing string `type` field",
    );
  }
  switch (type) {
    case "system":
      if (obj["event"] !== "init" && obj["event"] !== "complete" && obj["event"] !== "error") {
        invalidEvent("system event has invalid `event` enum");
      }
      return {
        type: "system",
        event: obj["event"],
        ...(obj["session_id"] !== undefined ? { session_id: requiredString(obj, "session_id") } : {}),
        ...(obj["message"] !== undefined ? { message: requiredString(obj, "message") } : {}),
      };
    case "assistant":
      return {
        type: "assistant",
        text: requiredString(obj, "text"),
      };
    case "tool":
      return {
        type: "tool",
        name: requiredString(obj, "name"),
        args: obj["args"],
        result: obj["result"],
      };
    case "result":
      if (obj["status"] !== "success" && obj["status"] !== "failure" && obj["status"] !== "blocked") {
        invalidEvent("result event has invalid `status` enum");
      }
      if (obj["tests"] !== undefined && !Array.isArray(obj["tests"])) {
        invalidEvent("result event requires an array `tests` field");
      }
      if (obj["tests"] === undefined) invalidEvent("result event requires `tests`");
      for (const test of obj["tests"]) {
        if (test === null || typeof test !== "object" || Array.isArray(test)) invalidEvent("result test must be an object");
        const testObject = test as Record<string, unknown>;
        requiredString(testObject, "name");
        if (testObject["status"] !== "passed" && testObject["status"] !== "failed" && testObject["status"] !== "skipped") {
          invalidEvent("result test has invalid `status` enum");
        }
        if (testObject["message"] !== undefined) requiredString(testObject, "message");
      }
      return {
        type: "result",
        status: obj["status"],
        summary: requiredString(obj, "summary"),
        files_changed: requiredStringArray(obj, "files_changed"),
        tests: obj["tests"].map((test) => {
          const tt = test as Record<string, unknown>;
          return {
            name: tt["name"] as string,
            status: tt["status"] as "passed" | "failed" | "skipped",
            ...(tt["message"] !== undefined ? { message: tt["message"] as string } : {}),
          };
        }),
        remaining_risks: requiredStringArray(obj, "remaining_risks"),
        ...(obj["blocked_reason"] !== undefined ? { blocked_reason: requiredString(obj, "blocked_reason") } : {}),
      };
    default:
      return { type, ...obj };
  }
}

/**
 * 解析完整 stdout 文本为事件序列。
 * 任何一行解析失败抛 StreamJsonParseError(plan §25 严格要求 G2M 不静默吞错)。
 */
export function parseStreamJson(stdout: string): StreamJsonEvent[] {
  const events: StreamJsonEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    events.push(parseStreamJsonLine(line));
  }
  return events;
}
