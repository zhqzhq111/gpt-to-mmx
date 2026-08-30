const MAX_BUFFER_LIMIT = 1_073_741_824;

export class BoundedOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundedOutputError";
  }
}

export class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private seenBytes = 0;
  private didTruncate = false;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new BoundedOutputError("output limit must be a positive integer");
    if (limit > MAX_BUFFER_LIMIT) throw new BoundedOutputError(`output limit must be at most ${MAX_BUFFER_LIMIT} bytes`);
  }

  push(chunk: Uint8Array | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.seenBytes += bytes.byteLength;
    const remaining = this.limit - this.retainedBytes;
    if (remaining <= 0) {
      this.didTruncate = true;
      return;
    }
    if (bytes.byteLength > remaining) {
      this.chunks.push(Buffer.from(bytes.subarray(0, remaining)));
      this.retainedBytes += remaining;
      this.didTruncate = true;
      return;
    }
    this.chunks.push(bytes);
    this.retainedBytes += bytes.byteLength;
  }

  captured(): Buffer {
    return Buffer.concat(this.chunks, this.retainedBytes);
  }

  capturedText(): string {
    return this.captured().toString("utf8");
  }

  get capturedBytes(): number { return this.retainedBytes; }
  get totalBytes(): number { return this.seenBytes; }
  get truncated(): boolean { return this.didTruncate; }
}
