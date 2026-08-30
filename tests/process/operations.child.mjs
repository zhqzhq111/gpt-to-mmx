import { readFile } from "node:fs/promises";
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

throw new Error(`unknown operations child mode: ${mode}`);
