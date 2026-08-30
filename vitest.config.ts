import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Windows Git worktree setup can exceed Vitest's 5 s default when the
    // complete suite runs in parallel. Individual watchdog behavior still has
    // its own tighter assertions and test-level timeouts.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // The Phase 9 suite adds filesystem scanners and SQLite/process tests.
    // Capping workers prevents Windows timer starvation and transient
    // ENOTEMPTY/EBUSY cleanup races without serializing the suite.
    maxWorkers: 8,
  },
});
