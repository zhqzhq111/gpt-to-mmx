import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { main } from "../../dist/cli/index.js";
import { acquireRepairLock } from "../../dist/operations/repair-lock.js";

const mode = process.argv[2];
const configPath = resolve(process.argv[3]);

if (mode === "status" || mode === "doctor" || mode === "repair") {
  const args = [mode, "--config", configPath, ...(mode === "repair" ? ["--action", "projection-rebuild", "--apply", "--format", "json"] : ["--format", "json"] )];
  await main(args);
  process.exit(0);
}

if (mode === "hold-lock") {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const stateRoot = config.state_root ?? resolve(config.artifact_root, "state");
  const lock = await acquireRepairLock(stateRoot, { operationId: process.argv[4] ?? "held", heartbeatIntervalMs: 25, staleAfterMs: 75 });
  process.stdout.write(JSON.stringify({ path: lock.path, pid: process.pid }) + "\n");
  process.stdin.resume();
  await new Promise((resolvePromise) => process.stdin.once("end", resolvePromise));
  await lock.release();
  process.exit(0);
}

if (mode === "write-guard") {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const stateRoot = config.state_root ?? resolve(config.artifact_root, "state");
  const path = join(stateRoot, "repair", "repair.lock.reclaim");
  const now = Date.now();
  await mkdir(join(stateRoot, "repair"), { recursive: true });
  await writeFile(path, JSON.stringify({
    schema_version: "g2m.repair-lock-reclaim.v1", guard_id: `guard-${process.pid}`,
    operation_id: "guard-owner", pid: process.pid, hostname: hostname(), created_at: now, heartbeat_at: now,
  }) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ path, pid: process.pid }) + "\n");
  process.exit(0);
}

throw new Error(`unknown operations child mode: ${mode}`);
