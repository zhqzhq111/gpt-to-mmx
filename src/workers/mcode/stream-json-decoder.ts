import { StringDecoder } from "node:string_decoder";

import {
  parseStreamJsonLine,
  type StreamJsonEvent,
} from "./stream-json-parser.js";

const MAX_DECODER_LIMIT = 1_073_741_824;

export type StreamJsonProtocolErrorCode =
  | "MALFORMED_JSON"
  | "INVALID_EVENT"
  | "LINE_TOO_LARGE"
  | "STDOUT_LIMIT_EXCEEDED"
  | "EVENT_LIMIT_EXCEEDED"
  | "DECODER_FINISHED";

export class StreamJsonProtocolError extends Error {
  override readonly cause?: unknown;

  constructor(
    readonly code: StreamJsonProtocolErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "StreamJsonProtocolError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface StreamJsonDecoderOptions {
  readonly maxLineBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEvents: number;
}

function assertLimit(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  if (value > maximum) {
    throw new RangeError(`${name} must be at most ${maximum}`);
  }
}

export class StreamJsonDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private readonly partial: string[] = [];
  private total = 0;
  private events = 0;
  private finished = false;

  constructor(private readonly options: StreamJsonDecoderOptions) {
    assertLimit("maxLineBytes", options.maxLineBytes, MAX_DECODER_LIMIT);
    assertLimit("maxTotalBytes", options.maxTotalBytes, MAX_DECODER_LIMIT);
    assertLimit("maxEvents", options.maxEvents, 1_000_000);
  }

  push(chunk: Uint8Array | string): StreamJsonEvent[] {
    if (this.finished) {
      throw new StreamJsonProtocolError("DECODER_FINISHED", "cannot push after decoder.finish()");
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.total += bytes.byteLength;
    if (this.total > this.options.maxTotalBytes) {
      throw new StreamJsonProtocolError(
        "STDOUT_LIMIT_EXCEEDED",
        `worker stdout exceeded ${this.options.maxTotalBytes} bytes`,
      );
    }
    return this.consumeText(this.decoder.write(bytes));
  }

  finish(): StreamJsonEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const events = this.consumeText(this.decoder.end());
    if (this.partial.length === 0) return events;
    const line = this.partial.join("");
    this.partial.length = 0;
    if (line.trim().length === 0) return events;
    events.push(this.parseLine(line));
    return events;
  }

  get totalBytes(): number { return this.total; }
  get eventCount(): number { return this.events; }

  private consumeText(text: string): StreamJsonEvent[] {
    const events: StreamJsonEvent[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "\n") continue;
      const line = `${this.partial.join("")}${text.slice(start, index).replace(/\r$/, "")}`;
      this.partial.length = 0;
      start = index + 1;
      if (line.trim().length === 0) continue;
      events.push(this.parseLine(line));
    }
    const remainder = text.slice(start);
    if (remainder.length > 0) this.partial.push(remainder);
    this.assertPartialLineLimit();
    return events;
  }

  private assertPartialLineLimit(): void {
    const bytes = Buffer.byteLength(this.partial.join(""), "utf8");
    if (bytes > this.options.maxLineBytes) {
      throw new StreamJsonProtocolError(
        "LINE_TOO_LARGE",
        `worker stream-json line exceeded ${this.options.maxLineBytes} bytes`,
      );
    }
  }

  private parseLine(line: string): StreamJsonEvent {
    if (Buffer.byteLength(line, "utf8") > this.options.maxLineBytes) {
      throw new StreamJsonProtocolError(
        "LINE_TOO_LARGE",
        `worker stream-json line exceeded ${this.options.maxLineBytes} bytes`,
      );
    }
    if (this.events >= this.options.maxEvents) {
      throw new StreamJsonProtocolError(
        "EVENT_LIMIT_EXCEEDED",
        `worker stream-json event count exceeded ${this.options.maxEvents}`,
      );
    }
    try {
      const event = parseStreamJsonLine(line);
      this.events += 1;
      return event;
    } catch (error) {
      const code = error instanceof Error && "code" in error && error.code === "INVALID_EVENT"
        ? "INVALID_EVENT"
        : "MALFORMED_JSON";
      throw new StreamJsonProtocolError(
        code,
        `invalid worker stream-json event: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }
}
