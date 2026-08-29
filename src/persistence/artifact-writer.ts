import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface ImmutableArtifactWriteResult {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export class ImmutableArtifactError extends Error {
  readonly code: "ARTIFACT_EXISTS" | "WRITE_FAILED" | "HASH_MISMATCH";
  override readonly cause?: unknown;

  constructor(
    code: ImmutableArtifactError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ImmutableArtifactError";
    this.code = code;
    this.cause = cause;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function writeImmutableArtifact(
  path: string,
  bytes: Uint8Array,
): Promise<ImmutableArtifactWriteResult> {
  if (await stat(path).then(() => true).catch(() => false)) {
    throw new ImmutableArtifactError("ARTIFACT_EXISTS", `immutable artifact already exists: ${path}`);
  }

  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    const persisted = await readFile(path);
    const expected = sha256(bytes);
    const actual = sha256(persisted);
    if (actual !== expected) {
      throw new ImmutableArtifactError(
        "HASH_MISMATCH",
        `artifact hash mismatch after rename: expected ${expected}, got ${actual}`,
      );
    }
    return Object.freeze({ path, sha256: actual, bytes: persisted.length });
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof ImmutableArtifactError) throw error;
    throw new ImmutableArtifactError("WRITE_FAILED", `cannot write immutable artifact: ${path}`, error);
  }
}
