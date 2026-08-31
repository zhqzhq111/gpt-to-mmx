import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { StateDatabase } from "../../src/projection/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "g2m-projection-"));
  roots.push(root);
  return join(root, "g2m-state.sqlite");
}

describe("StateDatabase", () => {
  it("opens the shared database with the frozen cross-process pragmas", async () => {
    const database = new StateDatabase(await databasePath());

    expect(database.pragma("journal_mode")).toBe("wal");
    expect(database.pragma("synchronous")).toBe(1);
    expect(database.pragma("busy_timeout")).toBe(30_000);
    database.close();
  });

  it("creates every Phase 0 projection table and schema metadata", async () => {
    const database = new StateDatabase(await databasePath());

    expect(database.tableNames()).toEqual(expect.arrayContaining([
      "executions",
      "workspaces",
      "workspace_locks",
      "reviews",
      "artifacts",
      "storage_usage",
      "storage_reservations",
      "recovery_cases",
      "projection_meta",
    ]));
    expect(database.getMeta("schema_version")).toBe("1");
    database.close();
  });

  it("rolls back a failed transaction", async () => {
    const database = new StateDatabase(await databasePath());

    expect(() => database.transaction(() => {
      database.setMeta("transaction-test", "should-rollback");
      throw new Error("injected failure");
    })).toThrow(/injected failure/);

    expect(database.getMeta("transaction-test")).toBeUndefined();
    database.close();
  });
});
