import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createReviewForBundle, writeJsonAtomic } from "../../src/cli/review-file.js";
import { computeReviewHash } from "../../src/review/ingress.js";

describe("CLI review file", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  const bundle = {
    taskId: "task-1",
    executionId: "exec-1",
    bundleId: "bundle-1",
    taskHash: "a".repeat(64),
    resultHash: "b".repeat(64),
    reviewBundleHash: "c".repeat(64),
  };

  it("creates a six-field-bound review with a valid self hash", () => {
    const review = createReviewForBundle(bundle, {
      decision: "ACCEPT",
      findings: "Evidence is sufficient",
      reviewerId: "codex",
      reviewId: "review-1",
      timestampMs: 123,
    });

    const { reviewHash: _reviewHash, ...withoutHash } = review;
    expect(review.reviewHash).toBe(computeReviewHash(withoutHash));
    expect(review.reviewBundleId).toBe("bundle-1");
  });

  it("requires a new task id for REVISE", () => {
    expect(() => createReviewForBundle(bundle, { decision: "REVISE" })).toThrow(
      /newTaskId/,
    );
  });

  it("writes complete JSON atomically", async () => {
    root = await mkdtemp(join(tmpdir(), "g2m-review-file-"));
    const target = join(root, "nested", "review.json");
    const review = createReviewForBundle(bundle, { decision: "BLOCK" });

    await writeJsonAtomic(target, review);

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(review);
  });
});
