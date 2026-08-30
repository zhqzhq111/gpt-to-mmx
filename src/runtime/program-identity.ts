import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";

export interface ProgramIdentity {
  readonly resolved_program: string;
  readonly program_identity_hash: string;
  readonly program_bytes: number;
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function candidates(program: string): readonly string[] {
  if (isAbsolute(program) || extname(program) !== "") return [program];
  if (process.platform !== "win32") return [program];
  return [program, `${program}.com`, `${program}.exe`, `${program}.bat`, `${program}.cmd`];
}

async function locate(program: string): Promise<string> {
  if (isAbsolute(program)) return realpath(program);
  const separator = process.platform === "win32" ? ";" : ":";
  for (const directory of (process.env.PATH ?? "").split(separator)) {
    if (!isAbsolute(directory)) continue;
    for (const candidate of candidates(program)) {
      const path = join(directory, candidate);
      try {
        if ((await stat(path)).isFile()) return realpath(path);
      } catch {
        // Continue through PATH in its declared order.
      }
    }
  }
  throw new Error(`program "${program}" was not found on PATH`);
}

export async function resolveProgramIdentity(program: string): Promise<ProgramIdentity> {
  const resolved = await locate(program);
  const hash = await hashFile(resolved);
  return {
    resolved_program: resolved,
    program_identity_hash: hash.sha256,
    program_bytes: hash.bytes,
  };
}
