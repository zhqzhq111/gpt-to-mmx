/**
 * MCodeAdapter 端到端测试
 *
 * 用 .js mock mcode(走 node,行为由 MOCK_BEHAVIOR env 控制)。
 * 覆盖:
 * - success 路径(完整 result event)
 * - session_id 提取(system init event)
 * - 进程非 0 退出 → AdapterError FAILED
 * - 没 result event + 0 退出 → AdapterError UNKNOWN
 * - cancel 杀进程
 * - resume() NOT_IMPLEMENTED
 * - probe() returns mcode snapshot
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MCodeAdapter } from "../../../src/workers/mcode/adapter.js";
import { ProcessSupervisor } from "../../../src/process/supervisor.js";
import type { PlatformProcessController } from "../../../src/process/platform.js";
import {
  AdapterError,
  type WorkerInvocation,
} from "../../../src/workers/coding-worker.js";

function makeInvocation(
  overrides: Partial<WorkerInvocation> = {},
): WorkerInvocation {
  return {
    executionId: `exec-${Math.random().toString(36).slice(2, 8)}`,
    // prompt 不含空格:.cmd wrapper 的 %* 会按空格切碎 args,导致 mock
    // 收到的 args[0] 不是 "exec",落到 default 分支 exit 1。真实部署用
    // mcode 自己的 argv 解析不会遇到这个问题。
    prompt: "FixTrajectoryTest",
    workspacePath: process.cwd(),
    permissionPolicy: "coding_standard",
    requestedCapabilities: {
      read: true,
      write: true,
      test: true,
      network: false,
    },
    limits: { maxSteps: 20, timeoutMs: 600_000 },
    sessionPolicy: { mode: "new" },
    ...overrides,
  };
}

describe("MCodeAdapter end-to-end (plan §65)", () => {
  let tmpRoot: string;
  let mockCmdPath: string;
  let envelopeCmdPath: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "g2m-adapter-"));
    mockCmdPath = join(tmpRoot, "mcode.cmd");
    await writeFile(
      mockCmdPath,
      [
        "@echo off",
        "if \"%~1\"==\"--version\" (",
        "  echo mcode 9.9.9",
        "  exit /b 0",
        ")",
        "if \"%~1\"==\"--help\" (",
        "  echo Usage: mcode ^<command^>",
        "  echo.",
        "  echo Commands:",
        "  echo   exec  Run a headless task",
        "  echo   acp   Start ACP stdio server",
        "  exit /b 0",
        ")",
        "if \"%~1\"==\"exec\" if \"%~2\"==\"--help\" (",
        "  echo Usage: mcode exec",
        "  echo.",
        "  echo Flags:",
        "  echo   --cwd ^<path^>",
        "  echo   --permission ^<policy^>",
        "  echo   --timeout ^<duration^>",
        "  echo   --max-steps ^<n^>",
        "  echo   --output-format ^<fmt^>",
        "  echo   --output-schema ^<schema^>",
        "  exit /b 0",
        ")",
        "if \"%~1\"==\"exec\" goto :exec",
        "exit /b 1",
        ":exec",
        "if \"%MOCK_BEHAVIOR%\"==\"fail\" (",
        "  echo something bad 1>&2",
        "  exit /b 7",
        ")",
        "if \"%MOCK_BEHAVIOR%\"==\"noresult\" (",
        "  echo {\"type\":\"system\",\"event\":\"init\",\"session_id\":\"mcode-noresult\"}",
        "  echo {\"type\":\"assistant\",\"text\":\"thinking...\"}",
        "  exit /b 0",
        ")",
        "if \"%MOCK_BEHAVIOR%\"==\"slow\" (",
        "  echo {\"type\":\"system\",\"event\":\"init\",\"session_id\":\"mcode-slow\"}",
        "  ping 127.0.0.1 -n 6 >nul",
        "  echo {\"type\":\"result\",\"status\":\"success\",\"summary\":\"slow done\",\"files_changed\":[],\"tests\":[],\"remaining_risks\":[]}",
        "  exit /b 0",
        ")",
        "echo {\"type\":\"system\",\"event\":\"init\",\"session_id\":\"mcode-success-001\"}",
        "echo {\"type\":\"assistant\",\"text\":\"Reading trajectory test...\"}",
        "echo {\"type\":\"result\",\"status\":\"success\",\"summary\":\"Mocked success\",\"files_changed\":[\"src/trajectory.ts\"],\"tests\":[{\"name\":\"trajectory_test\",\"status\":\"passed\"}],\"remaining_risks\":[]}",
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );
    envelopeCmdPath = join(tmpRoot, "mcode-envelope.cmd");
    await writeFile(
      envelopeCmdPath,
      [
        "@echo off",
        "if \"%~1\"==\"--version\" (echo mcode 0.2.7 & exit /b 0)",
        "if \"%~1\"==\"--help\" (echo Usage: mcode ^<command^> & exit /b 0)",
        "if \"%~1\"==\"exec\" if \"%~2\"==\"--help\" (echo Usage: mcode exec & echo --output-schema & exit /b 0)",
        "if \"%~1\"==\"exec\" goto :exec",
        "exit /b 1",
        ":exec",
        "echo {\"schemaVersion\":1,\"sequence\":1,\"timestampMs\":1,\"runId\":\"exec_turn_envelope\",\"sessionId\":\"mvs_envelope\",\"turnId\":\"turn_envelope\",\"type\":\"exec.started\"}",
        "echo {\"schemaVersion\":1,\"sequence\":2,\"timestampMs\":2,\"runId\":\"exec_turn_envelope\",\"sessionId\":\"mvs_envelope\",\"turnId\":\"turn_envelope\",\"type\":\"exec.completed\",\"result\":{\"schemaVersion\":1,\"type\":\"exec.result\",\"runId\":\"exec_turn_envelope\",\"sessionId\":\"mvs_envelope\",\"turnId\":\"turn_envelope\",\"status\":\"succeeded\",\"output\":\"{\\\"summary\\\":\\\"Envelope success\\\",\\\"files_changed\\\":[],\\\"tests\\\":[],\\\"remaining_risks\\\":[]}\",\"model\":{},\"usage\":{},\"durationMs\":1}}",
        "ping 127.0.0.1 -n 5 >nul",
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );
    process.env["G2M_MCODE_PATH"] = mockCmdPath;
  });

  afterAll(async () => {
    delete process.env["G2M_MCODE_PATH"];
    delete process.env["MOCK_BEHAVIOR"];
    await rm(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env["MOCK_BEHAVIOR"];
  });

  it(
    "runs a success path end-to-end with session_id and result event",
    async () => {
      const adapter = new MCodeAdapter();
      const inv = makeInvocation();
      await adapter.start(inv);
      const result = await adapter.collectResult(inv.executionId);
      expect(result.executionId).toBe(inv.executionId);
      expect(result.sessionId).toBe("mcode-success-001");
      expect(result.summary).toBe("Mocked success");
      expect(result.filesChanged).toEqual(["src/trajectory.ts"]);
      expect(result.testsAttempted[0]).toEqual({
        name: "trajectory_test",
        status: "passed",
      });
    },
    15_000,
  );

  it(
    "returns when real exec.completed arrives before a lingering cmd wrapper exits",
    async () => {
      const previous = process.env["G2M_MCODE_PATH"];
      process.env["G2M_MCODE_PATH"] = envelopeCmdPath;
      try {
        const adapter = new MCodeAdapter();
        const inv = makeInvocation();
        const startedAt = Date.now();
        await adapter.start(inv);
        const result = await adapter.collectResult(inv.executionId);

        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(result.sessionId).toBe("mvs_envelope");
        expect(result.summary).toBe("Envelope success");
      } finally {
        if (previous === undefined) delete process.env["G2M_MCODE_PATH"];
        else process.env["G2M_MCODE_PATH"] = previous;
      }
    },
    15_000,
  );

  it(
    "rejects re-starting the same executionId",
    async () => {
      const adapter = new MCodeAdapter();
      const inv = makeInvocation();
      await adapter.start(inv);
      await expect(adapter.start(inv)).rejects.toMatchObject({
        code: "FAILED",
      });
    },
    15_000,
  );

  it(
    "throws AdapterError FAILED when mcode exits non-zero",
    async () => {
      process.env["MOCK_BEHAVIOR"] = "fail";
      const adapter = new MCodeAdapter();
      const inv = makeInvocation();
      await adapter.start(inv);
      await expect(adapter.collectResult(inv.executionId)).rejects.toMatchObject({
        code: "FAILED",
      });
    },
    15_000,
  );

  it(
    "throws AdapterError UNKNOWN when no result event but exit 0",
    async () => {
      process.env["MOCK_BEHAVIOR"] = "noresult";
      const adapter = new MCodeAdapter();
      const inv = makeInvocation();
      await adapter.start(inv);
      await expect(adapter.collectResult(inv.executionId)).rejects.toMatchObject({
        code: "UNKNOWN",
      });
    },
    15_000,
  );

  it(
    "cancel kills the mcode process tree and surfaces CANCELLED",
    async () => {
      process.env["MOCK_BEHAVIOR"] = "slow";
      const adapter = new MCodeAdapter();
      const inv = makeInvocation();
      await adapter.start(inv);
      // 给进程时间启动 setTimeout
      await new Promise((r) => setTimeout(r, 500));
      await adapter.cancel(inv.executionId);
      // 取消是本地明确动作，不应降级成普通 FAILED。
      await expect(adapter.collectResult(inv.executionId)).rejects.toMatchObject({
        code: "CANCELLED",
      });
    },
    15_000,
  );

  it(
    "outer watchdog terminates a worker that exceeds the invocation timeout",
    async () => {
      process.env["MOCK_BEHAVIOR"] = "slow";
      const adapter = new MCodeAdapter();
      const inv = makeInvocation({ limits: { maxSteps: 20, timeoutMs: 500 } });
      const startedAt = Date.now();
      await adapter.start(inv);

      await expect(adapter.collectResult(inv.executionId)).rejects.toMatchObject({
        code: "TIMED_OUT",
      });
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    },
    10_000,
  );

  it(
    "surfaces UNKNOWN when supervisor timeout termination cannot be confirmed",
    async () => {
      process.env["MOCK_BEHAVIOR"] = "slow";
      const controller: PlatformProcessController = {
        strategy: "windows_taskkill",
        isAlive: () => "alive",
        terminate: async (pid) => {
          try { process.kill(pid); } catch { /* cleanup is best effort */ }
          return {
            confirmedGone: false,
            gracefulAttempted: true,
            forcedAttempted: true,
            strategy: "windows_taskkill",
            error: "test probe refused confirmation",
          };
        },
      };
      const options = {
        processSupervisor: new ProcessSupervisor({ platformController: controller }),
      } as unknown as ConstructorParameters<typeof MCodeAdapter>[0];
      const adapter = new MCodeAdapter(options);
      const inv = makeInvocation({ limits: { maxSteps: 20, timeoutMs: 500 } });
      await adapter.start(inv);

      await expect(adapter.collectResult(inv.executionId)).rejects.toMatchObject({
        code: "UNKNOWN",
      });
    },
    10_000,
  );

  it("resume() throws NOT_IMPLEMENTED (plan §48 MVP no --continue)", async () => {
    const adapter = new MCodeAdapter();
    await expect(
      adapter.resume("any-id", "verified-session", "p"),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it(
    "probe() returns a mcode-typed snapshot from G2M_MCODE_PATH override",
    async () => {
      const adapter = new MCodeAdapter();
      const snap = await adapter.probe();
      expect(snap.runtime).toBe("mcode");
      expect(snap.available).toBe(true);
      expect(snap.version).toBeTruthy();
    },
    15_000,
  );
});
