import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeImmutableArtifact, type ImmutableArtifactWriteResult } from "../persistence/artifact-writer.js";
import { renderJson } from "./format.js";

export type RepairAuditPhase = "plan" | "start" | "result";

export interface RepairAuditInput {
  readonly stateRoot: string;
  readonly operationId: string;
  readonly phase: RepairAuditPhase;
  readonly action: string;
  readonly createdAt: number;
  readonly payload: unknown;
}

export interface RepairAuditResult extends ImmutableArtifactWriteResult {
  readonly phase: RepairAuditPhase;
}

export async function writeRepairAudit(input: RepairAuditInput): Promise<RepairAuditResult> {
  const record = {
    schemaVersion: "g2m.repair-audit.v1",
    operationId: input.operationId,
    phase: input.phase,
    action: input.action,
    createdAt: input.createdAt,
    payload: input.payload,
  };
  const path = join(input.stateRoot, "repair", "audit", `${input.operationId}.${input.phase}.json`);
  const bytes = Buffer.from(renderJson(record), "utf8");
  let result: ImmutableArtifactWriteResult;
  try {
    result = await writeImmutableArtifact(path, bytes);
  } catch (error) {
    if (error instanceof Error && /already exists/.test(error.message)) {
      const existing = await readFile(path);
      const hash = createHash("sha256").update(existing).digest("hex");
      if (hash !== createHash("sha256").update(bytes).digest("hex")) throw error;
      result = { path, sha256: hash, bytes: existing.length };
    } else throw error;
  }
  const persisted = await readFile(path);
  const persistedHash = createHash("sha256").update(persisted).digest("hex");
  if (persistedHash !== result.sha256) throw new Error(`repair audit hash changed after write: ${path}`);
  return { ...result, phase: input.phase };
}
