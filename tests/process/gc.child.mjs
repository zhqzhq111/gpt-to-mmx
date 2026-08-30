import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { main } from "../../dist/cli/index.js";
import { EventStore } from "../../dist/events/store.js";
import { StateDatabase } from "../../dist/projection/database.js";
import { executeGc } from "../../dist/storage/gc.js";

const mode = process.argv[2] ?? "cli";
const configPath = resolve(process.argv[3]);
const config = JSON.parse(await readFile(configPath, "utf8"));

if (mode === "cli") {
  await main(["gc", "--config", configPath, "--apply"]);
  process.exit(0);
}

const stateRoot = config.state_root ?? resolve(config.artifact_root, "state");
const eventStore = new EventStore({ executionDirectory: join(stateRoot, "executions") });
const database = new StateDatabase(join(stateRoot, "g2m-state.sqlite"));
try {
  const point = process.argv[4];
  const result = await executeGc({
    stateRoot,
    artifactRoot: config.artifact_root,
    worktreeRoot: config.worktree_root,
    eventStore,
    database,
    nowMs: Date.now(),
    completedRetentionDays: config.storage?.completed_retention_days ?? 30,
    workspaces: config.workspaces.map((entry) => ({ workspaceId: entry.workspace_id, canonicalPath: entry.path })),
    ...(point ? { fault: async (actual) => { if (actual === point) process.exit(91); } } : {}),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  eventStore.close();
  database.close();
}
