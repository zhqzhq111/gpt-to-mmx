import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  JournalWriter,
  readJournal,
} from "../../src/events/journal.js";
import { DurableStateError } from "../../src/persistence/durable-state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeJournalPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "g2m-journal-"));
  roots.push(root);
  const directory = join(root, "execution-1");
  await mkdir(directory, { recursive: true });
  return join(directory, "state-events.ndjson");
}

describe("JournalWriter", () => {
  it("a CRITICAL append flushes preceding NORMAL records in physical order", async () => {
    const path = await makeJournalPath();
    const writer = new JournalWriter(path);

    writer.append({ type: "normal" }, "NORMAL");
    writer.append({ type: "critical" }, "CRITICAL");

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { type: "normal" },
      { type: "critical" },
    ]);
    writer.close();
  });

  it("flush persists queued NORMAL records", async () => {
    const path = await makeJournalPath();
    const writer = new JournalWriter(path);
    writer.append({ type: "normal" }, "NORMAL");
    writer.flush();

    expect((await readFile(path, "utf8")).trim()).toBe('{"type":"normal"}');
    writer.close();
  });
});

describe("readJournal", () => {
  it("returns the valid prefix and marks an incomplete final line as TRUNCATED_TAIL", async () => {
    const path = await makeJournalPath();
    await writeFile(path, '{"seq":1}\n{"seq":', "utf8");

    const result = readJournal<{ seq: number }>(path);

    expect(result.records).toEqual([{ seq: 1 }]);
    expect(result.tailStatus).toBe("TRUNCATED_TAIL");
  });

  it("rejects malformed JSON in the middle of a journal", async () => {
    const path = await makeJournalPath();
    await writeFile(path, '{"seq":1}\n{broken}\n{"seq":3}\n', "utf8");

    expect(() => readJournal(path)).toThrow(DurableStateError);
  });

  it("rejects a malformed final line that was physically completed", async () => {
    const path = await makeJournalPath();
    await writeFile(path, '{"seq":1}\n{broken}\n', "utf8");

    expect(() => readJournal(path)).toThrow(DurableStateError);
  });
});
