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
  readonly code: "INVALID_JSON" | "EMPTY_LINE";
  override readonly cause?: unknown;
  constructor(code: StreamJsonParseError["code"], message: string, cause?: unknown) {
    super(message);
    this.name = "StreamJsonParseError";
    this.code = code;
    this.cause = cause;
  }
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
      return {
        type: "system",
        event: typeof obj["event"] === "string" ? (obj["event"] as SystemEvent["event"]) : "init",
        session_id: typeof obj["session_id"] === "string" ? obj["session_id"] : undefined,
        message: typeof obj["message"] === "string" ? obj["message"] : undefined,
      };
    case "assistant":
      return {
        type: "assistant",
        text: typeof obj["text"] === "string" ? obj["text"] : "",
      };
    case "tool":
      return {
        type: "tool",
        name: typeof obj["name"] === "string" ? obj["name"] : "unknown",
        args: obj["args"],
        result: obj["result"],
      };
    case "result":
      return {
        type: "result",
        status: typeof obj["status"] === "string" ? (obj["status"] as ResultEvent["status"]) : "success",
        summary: typeof obj["summary"] === "string" ? obj["summary"] : "",
        files_changed: Array.isArray(obj["files_changed"]) ? obj["files_changed"].filter((s): s is string => typeof s === "string") : [],
        tests: Array.isArray(obj["tests"]) ? obj["tests"].map((t) => {
          const tt = t as Record<string, unknown>;
          return {
            name: typeof tt["name"] === "string" ? tt["name"] : "",
            status: typeof tt["status"] === "string" ? (tt["status"] as "passed" | "failed" | "skipped") : "passed",
            ...(typeof tt["message"] === "string" ? { message: tt["message"] } : {}),
          };
        }) : [],
        remaining_risks: Array.isArray(obj["remaining_risks"]) ? obj["remaining_risks"].filter((s): s is string => typeof s === "string") : [],
        ...(typeof obj["blocked_reason"] === "string" ? { blocked_reason: obj["blocked_reason"] } : {}),
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
