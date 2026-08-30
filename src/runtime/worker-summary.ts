import { sha256 } from "../protocol/hash.js";

export const WORKER_SUMMARY_SCHEMA_VERSION = "g2m.worker-summary.v1" as const;

/** The schema is data so its hash can be bound into runtime identity. */
export const WORKER_SUMMARY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["summary", "files_changed", "tests", "remaining_risks"],
  properties: {
    summary: { type: "string" },
    files_changed: { type: "array", items: { type: "string" } },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string" },
          status: { enum: ["passed", "failed", "skipped"] },
          message: { type: "string" },
        },
      },
    },
    remaining_risks: { type: "array", items: { type: "string" } },
    blocked_reason: { type: "string" },
  },
});

export const WORKER_SUMMARY_SCHEMA_HASH = sha256(WORKER_SUMMARY_SCHEMA);
