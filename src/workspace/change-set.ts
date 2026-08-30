import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "../protocol/hash.js";

const execFileAsync = promisify(execFile);

export type ChangeSetKind = "file" | "symlink" | "gitlink" | "deleted";

export interface ChangeSetEntry {
  readonly path: string;
  readonly kind: ChangeSetKind;
  readonly mode: string | null;
  readonly content_sha256: string | null;
}

export interface ChangeSetResult {
  readonly entries: readonly ChangeSetEntry[];
  readonly hash: string;
}

export interface ChangeSetOptions {
  readonly indexFile?: string;
}

async function gitBytes(
  cwd: string,
  args: readonly string[],
  options: ChangeSetOptions,
): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    windowsHide: true,
    encoding: "buffer",
    maxBuffer: 50 * 1024 * 1024,
    ...(options.indexFile !== undefined
      ? { env: { ...process.env, GIT_INDEX_FILE: options.indexFile } }
      : {}),
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function normalizeRepositoryPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`invalid repository-relative path: ${path}`);
  }
  return normalized;
}

function kindForMode(mode: string): Exclude<ChangeSetKind, "deleted"> {
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "gitlink";
  return "file";
}

function sortEntries(entries: ChangeSetEntry[]): ChangeSetEntry[] {
  return entries.sort((left, right) => {
    const pathOrder = Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
    return pathOrder !== 0 ? pathOrder : left.kind.localeCompare(right.kind);
  });
}

export async function computeIndexedChangeSet(
  repositoryPath: string,
  baseRevision: string,
  options: ChangeSetOptions = {},
): Promise<ChangeSetResult> {
  const changedRaw = await gitBytes(
    repositoryPath,
    ["diff", "--cached", "--name-only", "-z", "--no-renames", baseRevision],
    options,
  );
  const paths = changedRaw
    .toString("binary")
    .split("\0")
    .filter((value) => value.length > 0)
    .map((value) => normalizeRepositoryPath(decodeUtf8(Buffer.from(value, "binary"))));

  const entries: ChangeSetEntry[] = [];
  for (const path of paths) {
    const indexRaw = await gitBytes(repositoryPath, ["ls-files", "-s", "-z", "--", path], options);
    if (indexRaw.length === 0) {
      entries.push({ path, kind: "deleted", mode: null, content_sha256: null });
      continue;
    }
    const record = decodeUtf8(indexRaw.subarray(0, indexRaw.indexOf(0)));
    const tab = record.indexOf("\t");
    const metadata = (tab >= 0 ? record.slice(0, tab) : record).split(" ");
    const mode = metadata[0];
    const objectId = metadata[1];
    if (mode === undefined || objectId === undefined) {
      throw new Error(`cannot parse Git index entry for ${path}`);
    }
    const kind = kindForMode(mode);
    const content_sha256 =
      kind === "gitlink"
        ? objectId
        : createHash("sha256")
            .update(await gitBytes(repositoryPath, ["cat-file", "blob", objectId], options))
            .digest("hex");
    entries.push({ path, kind, mode, content_sha256 });
  }

  const sorted = sortEntries(entries);
  return Object.freeze({ entries: Object.freeze(sorted), hash: sha256(sorted) });
}

export async function computeWorkingTreeChangeSet(
  repositoryPath: string,
  baseRevision: string,
  changedFiles: readonly string[],
  temporaryRoot: string,
): Promise<ChangeSetResult> {
  const indexFile = join(temporaryRoot, `change-set-${randomUUID()}.index`);
  const options = { indexFile } as const;
  try {
    await gitBytes(repositoryPath, ["read-tree", baseRevision], options);
    if (changedFiles.length > 0) {
      await gitBytes(repositoryPath, ["add", "-A", "--", ...changedFiles], options);
    }
    return await computeIndexedChangeSet(repositoryPath, baseRevision, options);
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/**
 * Phase 6 full working-tree change set — unlike `computeWorkingTreeChangeSet`
 * (which only adds the Frozen Patch's declared `changedFiles`), this stages
 * the entire working tree against the base revision so the recovery scanner
 * can detect unrelated user edits, partial patch writes, or extra files.
 *
 * Used by the Accept Reconciler to verify that "target == reviewed result"
 * before completing ACCEPT, and to classify `EXACT_EXPECTED_CHANGE_SET` vs
 * `DIVERGED`. The temporary index file is removed in `finally` and never
 * touches the real repository index.
 */
export async function computeFullWorkingTreeChangeSet(
  repositoryPath: string,
  baseRevision: string,
  temporaryRoot: string,
): Promise<ChangeSetResult> {
  const indexFile = join(temporaryRoot, `full-change-set-${randomUUID()}.index`);
  const options = { indexFile } as const;
  try {
    await gitBytes(repositoryPath, ["read-tree", baseRevision], options);
    // `git add -A` without a pathspec stages every modification in the
    // working tree, including untracked files, so the resulting index
    // represents the full diff against `baseRevision` — not just the
    // Frozen Patch's declared files.
    await gitBytes(repositoryPath, ["add", "-A"], options);
    return await computeIndexedChangeSet(repositoryPath, baseRevision, options);
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}
