import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeImmutableArtifact } from "../../src/persistence/artifact-writer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("writeImmutableArtifact", () => {
  it("atomically persists and verifies the exact bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2m-artifact-"));
    roots.push(root);
    const path = join(root, "execution", "frozen.patch");
    const bytes = Buffer.from([0, 13, 10, 255, 1, 2, 3, 128]);

    const result = await writeImmutableArtifact(path, bytes);

    expect(await readFile(path)).toEqual(bytes);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.bytes).toBe(bytes.length);
    expect((await readdir(join(root, "execution"))).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
