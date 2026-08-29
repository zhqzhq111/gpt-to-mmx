import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  buildReview,
  type Review,
  type ReviewDecision,
} from "../review/ingress.js";

export interface ReviewBundleBinding {
  readonly taskId: string;
  readonly executionId: string;
  readonly bundleId: string;
  readonly taskHash: string;
  readonly resultHash: string;
  readonly reviewBundleHash: string;
}

export interface CreateReviewOptions {
  readonly decision: ReviewDecision;
  readonly findings?: string;
  readonly newTaskId?: string;
  readonly reviewerId?: string;
  readonly reviewId?: string;
  readonly timestampMs?: number;
}

export function createReviewForBundle(
  bundle: ReviewBundleBinding,
  options: CreateReviewOptions,
): Review {
  return buildReview({
    taskId: bundle.taskId,
    executionId: bundle.executionId,
    reviewBundleId: bundle.bundleId,
    taskHash: bundle.taskHash,
    resultHash: bundle.resultHash,
    reviewBundleHash: bundle.reviewBundleHash,
    decision: options.decision,
    ...(options.findings !== undefined ? { findings: options.findings } : {}),
    ...(options.newTaskId !== undefined ? { newTaskId: options.newTaskId } : {}),
    ...(options.reviewerId !== undefined ? { reviewerId: options.reviewerId } : {}),
    ...(options.reviewId !== undefined ? { reviewId: options.reviewId } : {}),
    ...(options.timestampMs !== undefined ? { timestampMs: options.timestampMs } : {}),
  });
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}
