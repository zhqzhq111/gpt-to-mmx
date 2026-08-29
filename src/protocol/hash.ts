/**
 * Hash 工具 — task_hash / result_hash / review_bundle_hash
 *
 * 参考 plan 第 53 节 task_fingerprint + 第 45-46 节 Review 协议。
 *
 * 简化版 canonical JSON:递归对 object key 做稳定字典序排序,然后 JSON.stringify。
 * 不引入完整 RFC 8785(JCS)依赖 — 这一轮 task_hash 只在 G2M 内部用,
 * 同一进程同一输入产出的 hash 必须稳定即可。
 *
 * 如果以后要跟外部系统对账(比如跟 Codex review 跨进程对 hash),再升级到
 * 真 RFC 8785 实现。
 */

import { createHash } from "node:crypto";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * 稳定 canonical JSON 字符串(简化 RFC 8785 兼容 subset)。
 * - 排除 undefined
 * - 数组保留顺序(语义顺序)
 * - object key 字典序排序
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * SHA-256 hex hash of canonical JSON.
 * plan 第 53 节 task_fingerprint / 第 45 节 result_hash / 第 46 节 review_bundle_hash
 * 都用同样的 hash 函数,这样能级联。
 */
export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * task_hash — plan 第 53 节 task_fingerprint 的核心字段之一,
 * 绑定到 task 内容(不含 worker runtime / model / permission profile / max_steps /
 * timeout 等 runtime 字段,那些进 task_fingerprint 但不进 task_hash)。
 */
export function taskHash(taskContent: unknown): string {
  return sha256(taskContent);
}
