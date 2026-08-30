export interface StoragePolicy {
  readonly min_free_bytes: number;
  readonly safety_margin_bytes: number;
  readonly default_execution_reservation_bytes: number;
  readonly max_total_bytes: number;
  readonly max_artifact_bytes: number;
  readonly max_worktree_bytes: number;
  readonly completed_retention_days: number;
  readonly reservation_ttl_ms: number;
  readonly monitor_interval_ms: number;
}

const GiB = 1024 ** 3;

export const DEFAULT_STORAGE_POLICY: StoragePolicy = Object.freeze({
  min_free_bytes: GiB,
  safety_margin_bytes: 512 * 1024 ** 2,
  default_execution_reservation_bytes: GiB,
  max_total_bytes: 0,
  max_artifact_bytes: 0,
  max_worktree_bytes: 0,
  completed_retention_days: 30,
  reservation_ttl_ms: 24 * 60 * 60 * 1000,
  monitor_interval_ms: 5_000,
});

export type StoragePolicyInput = Partial<StoragePolicy>;

export function resolveStoragePolicy(input: StoragePolicyInput = {}): StoragePolicy {
  const merged = { ...DEFAULT_STORAGE_POLICY, ...input };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`storage.${key} must be a non-negative integer`);
    }
  }
  return Object.freeze(merged);
}
