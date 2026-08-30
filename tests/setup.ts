import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testTemporaryRoot = resolve(repositoryRoot, ".tmp", "test-runs");

mkdirSync(testTemporaryRoot, { recursive: true });
process.env.TEMP = testTemporaryRoot;
process.env.TMP = testTemporaryRoot;
process.env.TMPDIR = testTemporaryRoot;
