/**
 * Independent Verification Runner — plan §28 + §67
 *
 * 用 process.execPath(当前 node)直接跑,避开 PATH / npm 启动开销,
 * 也避免依赖项目里 npx 之类的工具。测试覆盖:
 * - passed / failed / spawn_error / timed_out / skipped
 * - stdout / stderr 分离
 * - resultHash 稳定
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { runVerification } from "../../src/evidence/verification.js";
import { ProcessSupervisor } from "../../src/process/supervisor.js";
import {
  createPlatformProcessController,
  type PlatformProcessController,
} from "../../src/process/platform.js";
import { sha256 } from "../../src/protocol/hash.js";
import type { VerificationProfile } from "../../src/policy/verification.js";
import type { StorageMonitor } from "../../src/storage/monitor.js";
import { resolveProgramIdentity } from "../../src/runtime/program-identity.js";

const execFileAsync = promisify(execFile);

describe("runVerification", () => {
  let tempDir: string;
  const nodeBin = process.execPath;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "g2m-verify-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeProfile(
    overrides: Partial<VerificationProfile> = {},
  ): VerificationProfile {
    return {
      id: "test",
      description: "verification runner test",
      program: nodeBin,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 10_000,
      registeredAt: 0,
      ...overrides,
    };
  }

  it("returns 'skipped' when profile is undefined (verification_profile = 'none')", async () => {
    const r = await runVerification(undefined, "ws-1", tempDir);
    expect(r.status).toBe("skipped");
    expect(r.profileId).toBe("none");
    expect(r.program).toBe("");
    expect(r.args).toEqual([]);
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBeNull();
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.durationMs).toBe(0);
    expect(r.resultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 'passed' when program exits 0 (plan §67 independent verification)", async () => {
    const r = await runVerification(
      makeProfile({ id: "pass", args: ["-e", "process.exit(0)"] }),
      "ws-pass",
      tempDir,
    );
    expect(r.status).toBe("passed");
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.errorMessage).toBeUndefined();
  });

  it("returns 'failed' when program exits non-zero", async () => {
    const r = await runVerification(
      makeProfile({ id: "fail", args: ["-e", "process.exit(2)"] }),
      "ws-fail",
      tempDir,
    );
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(2);
  });

  it("captures stdout and stderr separately (plan §37)", async () => {
    const r = await runVerification(
      makeProfile({
        id: "io",
        args: ["-e", "console.log('out-hello'); console.error('err-world');"],
      }),
      "ws-io",
      tempDir,
    );
    expect(r.status).toBe("passed");
    expect(r.stdout).toContain("out-hello");
    expect(r.stderr).toContain("err-world");
    expect(r.stdout).not.toContain("err-world");
    expect(r.stderr).not.toContain("out-hello");
  });

  it("returns 'timed_out' when program exceeds timeoutMs", async () => {
    const r = await runVerification(
      makeProfile({
        id: "slow",
        args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
        timeoutMs: 500,
      }),
      "ws-slow",
      tempDir,
    );
    expect(r.status).toBe("timed_out");
    expect(r.exitCode).toBeNull();
    expect(r.errorMessage).toMatch(/500ms/);
    expect(r.termination).toMatchObject({ confirmedGone: true });
  });

  it("preserves a confirmed storage-triggered termination as storage_limit_exceeded", async () => {
    const storageMonitor = {
      start: (_paths: unknown, callback: (result: unknown) => void | Promise<void>) => {
        void callback({
          status: "limit_exceeded",
          code: "STORAGE_LIMIT_EXCEEDED",
          freeBytes: 1,
          usage: { artifactBytes: 10, worktreeBytes: 10, totalBytes: 20 },
        });
        return { stop: () => undefined };
      },
    } as StorageMonitor;
    const r = await runVerification(
      makeProfile({ id: "storage-limit", args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 10_000 }),
      "ws-storage-limit",
      tempDir,
      { storageMonitor },
    );
    expect(r.status).toBe("storage_limit_exceeded");
    expect(r.status).not.toBe("timed_out");
  });

  it("maps an unconfirmed storage-triggered termination to termination_unconfirmed", async () => {
    const storageMonitor = {
      start: (_paths: unknown, callback: (result: unknown) => void | Promise<void>) => {
        void callback({
          status: "limit_exceeded",
          code: "STORAGE_LIMIT_EXCEEDED",
          freeBytes: 1,
          usage: { artifactBytes: 10, worktreeBytes: 10, totalBytes: 20 },
        });
        return { stop: () => undefined };
      },
    } as StorageMonitor;
    const controller: PlatformProcessController = {
      strategy: "windows_taskkill",
      isAlive: () => "alive",
      terminate: async (pid) => {
        try { process.kill(pid); } catch { /* process may already be gone */ }
        return { confirmedGone: false, gracefulAttempted: true, forcedAttempted: true, strategy: "windows_taskkill", error: "not confirmed" };
      },
    };
    const r = await runVerification(
      makeProfile({ id: "storage-unknown", args: ["-e", "setInterval(() => {}, 10000)"], timeoutMs: 10_000 }),
      "ws-storage-unknown",
      tempDir,
      { storageMonitor, processSupervisor: new ProcessSupervisor({ platformController: controller }) },
    );
    expect(r.status).toBe("termination_unconfirmed");
  });

  it("returns 'termination_unconfirmed' when the process tree cannot be proven gone", async () => {
    const controller: PlatformProcessController = {
      strategy: "windows_taskkill",
      isAlive: () => "alive",
      terminate: async (pid) => {
        try {
          await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        } catch { /* cleanup is best effort */ }
        return {
          confirmedGone: false,
          gracefulAttempted: true,
          forcedAttempted: true,
          strategy: "windows_taskkill",
          error: "test probe refused confirmation",
        };
      },
    };
    const r = await runVerification(
      makeProfile({
        id: "unknown-termination",
        args: ["-e", "setInterval(() => {}, 10000)"],
        timeoutMs: 50,
      }),
      "ws-unknown-termination",
      tempDir,
      { processSupervisor: new ProcessSupervisor({ platformController: controller }) },
    );

    expect(r.status).toBe("termination_unconfirmed");
    expect(r.termination).toMatchObject({ confirmedGone: false });
  }, 10_000);

  it("maps a failed Windows taskkill with a disappearing root to termination_unconfirmed", async () => {
    let probeCalls = 0;
    const controller = createPlatformProcessController({
      platform: "win32",
      dependencies: {
        probe: () => probeCalls++ === 0 ? "alive" : "gone",
        runTaskkill: async (pid) => {
          try { process.kill(pid); } catch { /* cleanup is best effort */ }
          return { success: false, error: "taskkill reported failure" };
        },
        sleep: async () => undefined,
        now: (() => {
          let value = 0;
          return () => ++value;
        })(),
      },
    });
    const r = await runVerification(
      makeProfile({
        id: "failed-taskkill",
        args: ["-e", "setInterval(() => {}, 10000)"],
        timeoutMs: 50,
      }),
      "ws-failed-taskkill",
      tempDir,
      { processSupervisor: new ProcessSupervisor({ platformController: controller }) },
    );

    expect(r.status).toBe("termination_unconfirmed");
    expect(r.termination).toMatchObject({ confirmedGone: false });
  }, 10_000);

  it("returns 'spawn_error' when program does not exist (ENOENT)", async () => {
    const missing = `g2m-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const r = await runVerification(
      makeProfile({ id: "missing", program: missing, args: [] }),
      "ws-missing",
      tempDir,
    );
    expect(r.status).toBe("spawn_error");
    expect(r.exitCode).toBeNull();
    expect(r.errorMessage).toMatch(/not found/i);
  });

  it("resultHash is stable for the same logical result (plan §45 anti-replay binding)", async () => {
    const r = await runVerification(
      makeProfile({ id: "stable", args: ["-e", "process.exit(0)"] }),
      "ws-stable",
      tempDir,
    );
    // 手工重算 hash,确认 Runner 用的就是这套字段。
    const expected = sha256({
      profileId: r.profileId,
      workspaceId: r.workspaceId,
      workspacePath: r.workspacePath,
      program: r.program,
      args: r.args,
      status: r.status,
      exitCode: r.exitCode,
      signal: r.signal,
      stdout: r.stdout,
      stderr: r.stderr,
      stdoutBytes: r.stdoutBytes,
      stderrBytes: r.stderrBytes,
      stdoutTruncated: r.stdoutTruncated,
      stderrTruncated: r.stderrTruncated,
      errorMessage: r.errorMessage,
    });
    expect(r.resultHash).toBe(expected);
  });

  it("resultHash does NOT include timing fields (same command twice has same hash)", async () => {
    const r1 = await runVerification(
      makeProfile({ id: "x", args: ["-e", "process.exit(0)"] }),
      "ws-timing",
      tempDir,
    );
    // 模拟第二次跑(同步 sleep 一点时间让 timing 必不同)
    await new Promise((resolve) => setTimeout(resolve, 5));
    const r2 = await runVerification(
      makeProfile({ id: "x", args: ["-e", "process.exit(0)"] }),
      "ws-timing",
      tempDir,
    );
    expect(r1.startedAt).not.toBe(r2.startedAt);
    expect(r1.resultHash).toBe(r2.resultHash);
  });

  it("resultHash differs when status differs", async () => {
    const pass = await runVerification(
      makeProfile({ id: "p", args: ["-e", "process.exit(0)"] }),
      "ws-hash",
      tempDir,
    );
    const fail = await runVerification(
      makeProfile({ id: "p", args: ["-e", "process.exit(1)"] }),
      "ws-hash",
      tempDir,
    );
    expect(pass.resultHash).not.toBe(fail.resultHash);
  });

  it("passes shell metacharacters in args literally (plan §32 no shell)", async () => {
    // 如果走 shell,`<` 和 `>` 会被 cmd.exe 当成重定向。
    // 走 argv 透传,node 拿到的是字面字符串,JS 表达式正常执行。
    const r = await runVerification(
      makeProfile({
        id: "shell-safe",
        args: ["-e", "if (1 < 2 && 2 > 1) process.exit(0); else process.exit(1);"],
      }),
      "ws-shell",
      tempDir,
    );
    expect(r.status).toBe("passed");
  });

  it("threads env vars into the child process when profile.env is set", async () => {
    const r = await runVerification(
      makeProfile({
        id: "env",
        args: [
          "-e",
          'if (process.env.G2M_TEST_VAR === "hello") process.exit(0); else process.exit(1);',
        ],
        env: { G2M_TEST_VAR: "hello" },
      }),
      "ws-env",
      tempDir,
    );
    expect(r.status).toBe("passed");
  });

  it("bounds verification stdout/stderr while preserving exit-code authority", async () => {
    const r = await runVerification(
      makeProfile({
        id: "bounded",
        args: ["-e", "process.stdout.write('x'.repeat(1000)); process.stderr.write('y'.repeat(1000)); process.exit(0)"],
      }),
      "ws-bounded",
      tempDir,
      { maxStdoutBytes: 32, maxStderrBytes: 32 },
    );
    expect(r.status).toBe("passed");
    expect(r.stdoutBytes).toBe(1000);
    expect(r.stderrBytes).toBe(1000);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(true);
    expect(r.stdout.length).toBe(32);
    expect(r.stderr.length).toBe(32);
  });

  it("refuses a changed verification launcher before it runs", async () => {
    const launcher = join(tempDir, "verification-launcher.cmd");
    const marker = join(tempDir, "verification-ran.txt");
    const original = ["@echo off", `echo ran>\"${marker}\"`, "exit /b 0", ""].join("\r\n");
    await writeFile(launcher, original, "utf8");
    const identity = await resolveProgramIdentity(launcher);
    await writeFile(launcher, `${original}\r\n`, "utf8");
    const r = await runVerification(
      makeProfile({ id: "drift", program: launcher, args: [] }),
      "ws-drift",
      tempDir,
      { expectedProgramIdentity: identity },
    );
    expect(r.status).toBe("runtime_drift");
    await expect(readFile(marker)).rejects.toThrow();
  });
});
