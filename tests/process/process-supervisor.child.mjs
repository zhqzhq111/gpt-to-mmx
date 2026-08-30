import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [, , role, heartbeatPath] = process.argv;
if (typeof role !== "string" || typeof heartbeatPath !== "string") {
  process.exit(2);
}

if (role === "grandchild") {
  writeFileSync(`${heartbeatPath}.grandchild.pid`, String(process.pid));
  setInterval(() => {
    appendFileSync(heartbeatPath, `${Date.now()}\n`);
  }, 25);
} else if (role === "parent") {
  writeFileSync(`${heartbeatPath}.parent.pid`, String(process.pid));
  spawn(process.execPath, [fileURLToPath(import.meta.url), "grandchild", heartbeatPath], {
    stdio: "ignore",
  });
  setInterval(() => undefined, 1_000);
} else {
  process.exit(2);
}
