import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Windows Git worktree setup can exceed Vitest's 5 s default when the
    // complete suite runs in parallel. Individual watchdog behavior still has
    // its own tighter assertions and test-level timeouts.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
