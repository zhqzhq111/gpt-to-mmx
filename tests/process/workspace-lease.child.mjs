import { createInterface } from "node:readline";
import { WorkspaceLock } from "../../dist/workspace/lock.js";

const [mode, stateRoot, workspacePath, workspaceId = "demo", executionId = "exec"] = process.argv.slice(2);
const lock = new WorkspaceLock({
  stateRoot,
  heartbeatIntervalMs: 10,
  staleAfterMs: 30,
});

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = [];
input.on("line", (line) => lines.push(line.trim()));
process.stdout.write("READY\n");

while (lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
const command = lines.shift();

if (mode === "acquire") {
  try {
    const handle = await lock.acquire({ workspaceId, canonicalPath: workspacePath, executionId });
    process.stdout.write(`${JSON.stringify({ kind: "acquired", leaseId: handle.leaseId })}\n`);
    while (!lines.includes("RELEASE")) await new Promise((resolve) => setTimeout(resolve, 1));
    lock.release(handle);
    process.stdout.write(`${JSON.stringify({ kind: "released", leaseId: handle.leaseId })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ kind: "error", code: error?.code ?? "UNKNOWN", message: error?.message ?? String(error) })}\n`);
  }
  input.close();
  process.exit(0);
}

if (mode === "reclaim") {
  try {
    const owner = await lock.reclaimStaleLease({ workspaceKey: workspacePath, journalState: "TERMINAL" });
    process.stdout.write(`${JSON.stringify({ kind: "reclaimed", leaseId: owner.lease_id })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ kind: "error", code: error?.code ?? "UNKNOWN", message: error?.message ?? String(error) })}\n`);
  }
  input.close();
  process.exit(0);
}

process.stdout.write(`${JSON.stringify({ kind: "error", code: "INVALID_MODE" })}\n`);
input.close();
process.exit(1);
