import { scanExecutionUsage, type StorageUsage } from "./usage.js";
import { nodeFreeSpaceProvider, type FreeSpaceProvider } from "./free-space.js";
import { DEFAULT_STORAGE_POLICY, type StoragePolicy } from "./policy.js";

export type StorageCheckStatus = "ok" | "emergency" | "limit_exceeded";

export interface StorageCheckResult {
  readonly status: StorageCheckStatus;
  readonly freeBytes: number;
  readonly usage: StorageUsage;
  readonly code?: "STORAGE_ADMISSION_DENIED" | "STORAGE_LIMIT_EXCEEDED";
  readonly reason?: string;
}

export interface StorageMonitorOptions {
  readonly policy?: StoragePolicy;
  readonly freeSpaceProvider?: FreeSpaceProvider;
  readonly usageScanner?: (options: { readonly artifactPath: string; readonly worktreePath: string }) => Promise<StorageUsage>;
  readonly managedUsageBytes?: () => number;
}

export interface StorageMonitorHandle {
  readonly stop: () => void;
}

export class StorageMonitor {
  private readonly policy: StoragePolicy;
  private readonly freeSpace: FreeSpaceProvider;
  private readonly usageScanner: NonNullable<StorageMonitorOptions["usageScanner"]>;
  private readonly managedUsageBytes: () => number;

  constructor(options: StorageMonitorOptions = {}) {
    this.policy = options.policy ?? DEFAULT_STORAGE_POLICY;
    this.freeSpace = options.freeSpaceProvider ?? nodeFreeSpaceProvider;
    this.usageScanner = options.usageScanner ?? (async (paths) => scanExecutionUsage({ executionId: "monitor", ...paths }));
    this.managedUsageBytes = options.managedUsageBytes ?? (() => 0);
  }

  async check(paths: { readonly worktreePath: string; readonly artifactPath: string }): Promise<StorageCheckResult> {
    const freeValues = await Promise.all([
      this.freeSpace.freeBytes(paths.worktreePath),
      this.freeSpace.freeBytes(paths.artifactPath),
    ]);
    const freeBytes = Math.min(...freeValues);
    const usage = await this.usageScanner(paths);
    if (freeBytes < this.policy.min_free_bytes + this.policy.safety_margin_bytes) {
      return { status: "emergency", freeBytes, usage, code: "STORAGE_ADMISSION_DENIED", reason: "free space crossed the storage safety floor" };
    }
    const worktreeExceeded = this.policy.max_worktree_bytes > 0 && usage.worktreeBytes > this.policy.max_worktree_bytes;
    const artifactExceeded = this.policy.max_artifact_bytes > 0 && usage.artifactBytes > this.policy.max_artifact_bytes;
    const totalExceeded = this.policy.max_total_bytes > 0 && this.managedUsageBytes() + usage.totalBytes > this.policy.max_total_bytes;
    if (worktreeExceeded || artifactExceeded || totalExceeded) {
      return { status: "limit_exceeded", freeBytes, usage, code: "STORAGE_LIMIT_EXCEEDED", reason: "storage usage exceeded the configured limit" };
    }
    return { status: "ok", freeBytes, usage };
  }

  start(
    paths: { readonly worktreePath: string; readonly artifactPath: string },
    onEmergency: (result: StorageCheckResult) => void | Promise<void>,
  ): StorageMonitorHandle {
    let stopped = false;
    let notified = false;
    const checkOnce = async (): Promise<void> => {
      if (stopped || notified) return;
      try {
        const result = await this.check(paths);
        if (result.status !== "ok" && !notified) {
          notified = true;
          await onEmergency(result);
        }
      } catch (error) {
        if (!notified) {
          notified = true;
          await onEmergency({
            status: "emergency",
            freeBytes: 0,
            usage: { artifactBytes: 0, worktreeBytes: 0, totalBytes: 0 },
            code: "STORAGE_ADMISSION_DENIED",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    void checkOnce();
    const timer = setInterval(() => { void checkOnce(); }, this.policy.monitor_interval_ms);
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      },
    };
  }
}
