import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import type { StateDatabase } from "../projection/database.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export interface StorageUsage {
  readonly artifactBytes: number;
  readonly worktreeBytes: number;
  readonly totalBytes: number;
}

export interface ScanExecutionUsageOptions {
  readonly executionId: string;
  readonly artifactPath: string;
  readonly worktreePath: string;
}

export interface StorageManifestInput {
  readonly executionId: string;
  readonly artifactBytes: number;
  readonly worktreeBytes: number;
  readonly artifactPath: string;
  readonly worktreePath: string;
  readonly retentionClass: string | null;
  readonly gcEligibleAt: number | null;
  readonly updatedAt: number;
}

export interface StorageManifest extends StorageManifestInput {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly totalBytes: number;
}

async function logicalBytes(path: string): Promise<number> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (entry.isFile() || entry.isSymbolicLink()) return entry.size;
  if (!entry.isDirectory()) return 0;

  let total = 0;
  const children = await readdir(path);
  for (const child of children) total += await logicalBytes(join(path, child));
  return total;
}

export async function scanExecutionUsage(options: ScanExecutionUsageOptions): Promise<StorageUsage> {
  const [artifactBytes, worktreeBytes] = await Promise.all([
    logicalBytes(options.artifactPath),
    logicalBytes(options.worktreePath),
  ]);
  return { artifactBytes, worktreeBytes, totalBytes: artifactBytes + worktreeBytes };
}

function toDiskManifest(manifest: StorageManifest): Record<string, unknown> {
  return {
    schema_version: manifest.schemaVersion,
    execution_id: manifest.executionId,
    generation: manifest.generation,
    updated_at: manifest.updatedAt,
    artifact_bytes: manifest.artifactBytes,
    worktree_bytes: manifest.worktreeBytes,
    total_bytes: manifest.totalBytes,
    artifact_path: manifest.artifactPath,
    worktree_path: manifest.worktreePath,
    retention_class: manifest.retentionClass,
    gc_eligible_at: manifest.gcEligibleAt,
  };
}

function parseManifest(raw: unknown): StorageManifest {
  if (raw === null || typeof raw !== "object") throw new Error("storage manifest must be an object");
  const value = raw as Record<string, unknown>;
  const requiredStrings = ["execution_id", "artifact_path", "worktree_path"];
  for (const key of requiredStrings) if (typeof value[key] !== "string") throw new Error(`manifest.${key} must be a string`);
  const requiredNumbers = ["generation", "updated_at", "artifact_bytes", "worktree_bytes", "total_bytes"];
  for (const key of requiredNumbers) if (typeof value[key] !== "number" || !Number.isInteger(value[key]) || value[key] < 0) throw new Error(`manifest.${key} must be a non-negative integer`);
  if (value["schema_version"] !== 1) throw new Error("unsupported storage manifest schema version");
  if (value["total_bytes"] !== (value["artifact_bytes"] as number) + (value["worktree_bytes"] as number)) throw new Error("manifest total_bytes mismatch");
  const retentionClass = value["retention_class"];
  const gcEligibleAt = value["gc_eligible_at"];
  if (retentionClass !== null && typeof retentionClass !== "string") throw new Error("manifest.retention_class must be string or null");
  if (gcEligibleAt !== null && (typeof gcEligibleAt !== "number" || !Number.isInteger(gcEligibleAt))) throw new Error("manifest.gc_eligible_at must be integer or null");
  return {
    schemaVersion: 1,
    executionId: value["execution_id"] as string,
    generation: value["generation"] as number,
    updatedAt: value["updated_at"] as number,
    artifactBytes: value["artifact_bytes"] as number,
    worktreeBytes: value["worktree_bytes"] as number,
    totalBytes: value["total_bytes"] as number,
    artifactPath: value["artifact_path"] as string,
    worktreePath: value["worktree_path"] as string,
    retentionClass: retentionClass as string | null,
    gcEligibleAt: gcEligibleAt as number | null,
  };
}

export async function readStorageManifest(path: string): Promise<StorageManifest | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseManifest(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function readStorageManifestSync(path: string): StorageManifest | undefined {
  try {
    return parseManifest(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function upsertStorageUsage(
  database: StateDatabase,
  executionId: string,
  usage: Pick<StorageUsage, "artifactBytes" | "worktreeBytes">,
  updatedAt: number,
): void {
  database.run(`
    INSERT INTO storage_usage(execution_id, artifact_bytes, worktree_bytes, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(execution_id) DO UPDATE SET
      artifact_bytes = excluded.artifact_bytes,
      worktree_bytes = excluded.worktree_bytes,
      updated_at = excluded.updated_at
  `, executionId, usage.artifactBytes, usage.worktreeBytes, updatedAt);
}

export function rebuildStorageUsageFromManifests(options: {
  readonly stateRoot: string;
  readonly database: StateDatabase;
  readonly nowMs: number;
}): { readonly rebuilt: number; readonly skipped: number } {
  const executionsRoot = join(options.stateRoot, "executions");
  let rebuilt = 0;
  let skipped = 0;
  let entries: string[];
  try {
    entries = readdirSync(executionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rebuilt: 0, skipped: 0 };
    throw error;
  }
  for (const executionId of entries) {
    try {
      const manifest = readStorageManifestSync(join(executionsRoot, executionId, "storage-manifest.json"));
      if (manifest === undefined || manifest.executionId !== executionId) { skipped += 1; continue; }
      upsertStorageUsage(options.database, executionId, manifest, manifest.updatedAt ?? options.nowMs);
      rebuilt += 1;
    } catch {
      skipped += 1;
    }
  }
  return { rebuilt, skipped };
}

export async function writeStorageManifestAtomic(path: string, input: StorageManifestInput): Promise<StorageManifest> {
  const previous = await readStorageManifest(path);
  const manifest: StorageManifest = {
    ...input,
    schemaVersion: 1,
    generation: (previous?.generation ?? 0) + 1,
    totalBytes: input.artifactBytes + input.worktreeBytes,
  };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(toDiskManifest(manifest), null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return manifest;
}
