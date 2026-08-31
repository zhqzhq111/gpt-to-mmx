import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";

import {
  FROZEN_SCHEMA_SQL,
  PROJECTION_SCHEMA_VERSION,
} from "./schema.js";

export class ProjectionDatabaseError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ProjectionDatabaseError";
    this.cause = cause;
  }
}

export interface StateDatabaseOptions {
  readonly readOnly?: boolean;
}

const SQLITE_BUSY_TIMEOUT_MS = 30_000;

export class StateDatabase {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly path: string, options: StateDatabaseOptions = {}) {
    let opened: DatabaseSync | undefined;
    try {
      if (path !== ":memory:" && !options.readOnly) mkdirSync(dirname(path), { recursive: true });
      const openPath = options.readOnly && path !== ":memory:" ? `file:${path}?immutable=1` : path;
      opened = new DatabaseSync(openPath, { timeout: SQLITE_BUSY_TIMEOUT_MS, readOnly: options.readOnly ?? false });
      if (!options.readOnly) {
        // Install the busy handler before WAL/schema setup. The first
        // concurrent opener can hold SQLite's schema lock while the other
        // process runs these pragmas; setting it afterwards is too late for
        // that initialization race.
        opened.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
        opened.exec("PRAGMA journal_mode = WAL");
        opened.exec("PRAGMA synchronous = NORMAL");
        opened.exec(FROZEN_SCHEMA_SQL);
        this.ensureStorageReservationColumns(opened);
      }
      this.database = opened;
      if (!options.readOnly) this.setMeta("schema_version", String(PROJECTION_SCHEMA_VERSION));
    } catch (error) {
      // Close the SQLite handle on any failure so the underlying file
      // lock is released (otherwise a follow-up `rm` / `rename` against
      // the same path would fail with EBUSY on Windows).
      if (opened !== undefined) {
        try { opened.close(); } catch { /* swallow close error during cleanup */ }
      }
      throw new ProjectionDatabaseError(`cannot open projection database: ${path}`, error);
    }
  }

  private ensureStorageReservationColumns(database: DatabaseSync): void {
    const existing = new Set(
      (database.prepare("PRAGMA table_info(storage_reservations)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const columns: ReadonlyArray<[string, string]> = [
      ["reservation_set_id", "TEXT"],
      ["pid", "INTEGER"],
      ["hostname", "TEXT"],
      ["roles_json", "TEXT"],
      ["record_path", "TEXT"],
      ["record_hash", "TEXT"],
    ];
    for (const [name, type] of columns) {
      if (!existing.has(name)) {
        try {
          database.exec(`ALTER TABLE storage_reservations ADD COLUMN ${name} ${type}`);
        } catch (error) {
          if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
        }
      }
    }
  }

  prepare(sql: string): StatementSync {
    return this.database.prepare(sql);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  run(sql: string, ...parameters: SQLInputValue[]): void {
    this.database.prepare(sql).run(...parameters);
  }

  pragma(name: "journal_mode" | "synchronous" | "busy_timeout"): string | number | bigint | null {
    const row = this.database.prepare(`PRAGMA ${name}`).get() as
      | Record<string, string | number | bigint | null>
      | undefined;
    const resultKey = name === "busy_timeout" ? "timeout" : name;
    return row?.[resultKey] ?? null;
  }

  tableNames(): readonly string[] {
    const rows = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  getMeta(key: string): string | undefined {
    const row = this.database.prepare(
      "SELECT value FROM projection_meta WHERE key = ?",
    ).get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO projection_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
