/**
 * MCode Resolver + Invocation Builder 测试
 *
 * 策略:
 * - Resolver 测试用 mock mcode.cmd(skipped mode 跟真实 spawn 都覆盖)
 * - Invocation builder 是纯函数,无副作用
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  resolveMCode,
  MCodeResolverError,
} from "../../../src/workers/mcode/resolver.js";
import { buildMCodeInvocation } from "../../../src/workers/mcode/invocation.js";

describe("resolveMCode (plan §33-35)", () => {
  let tmpRoot: string;
  let mockMcode: string;
  let oversizedMcode: string;
  let noSchemaMcode: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "g2m-resolver-"));
    mockMcode = join(tmpRoot, "mcode.cmd");
    // 写一个真正能被 execFile 调起来的 .cmd:
    //   --version → "mcode 9.9.9"
    //   --help    → 帮助文本
    //   exec --help → exec 帮助文本
    const script = [
      "@echo off",
      "if \"%~1\"==\"--version\" (echo mcode 9.9.9 & exit /b 0)",
      "if \"%~1\"==\"--help\" (echo Usage: mcode ^<command^> & echo. & echo Commands: & echo   exec & echo   acp & exit /b 0)",
      "if \"%~1\"==\"exec\" if \"%~2\"==\"--help\" (echo Usage: mcode exec & echo. & echo Flags: & echo   --cwd & echo   --permission & echo   --output-schema & exit /b 0)",
      "exit /b 1",
      "",
    ].join("\r\n");
    await writeFile(mockMcode, script, "utf8");
    oversizedMcode = join(tmpRoot, "mcode-oversized.cmd");
    await writeFile(
      oversizedMcode,
      [
        "@echo off",
        "if \"%~1\"==\"--version\" (echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx & exit /b 0)",
        "if \"%~1\"==\"--help\" (echo Usage: mcode & exit /b 0)",
        "if \"%~1\"==\"exec\" if \"%~2\"==\"--help\" (echo --output-schema & exit /b 0)",
        "exit /b 1",
        "",
      ].join("\r\n"),
      "utf8",
    );
    noSchemaMcode = join(tmpRoot, "mcode-no-schema.cmd");
    await writeFile(
      noSchemaMcode,
      [
        "@echo off",
        "if \"%~1\"==\"--version\" (echo mcode 1.0.0 & exit /b 0)",
        "if \"%~1\"==\"--help\" (echo Usage: mcode & exit /b 0)",
        "if \"%~1\"==\"exec\" if \"%~2\"==\"--help\" (echo Usage: mcode exec & exit /b 0)",
        "exit /b 1",
        "",
      ].join("\r\n"),
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("trusted override: G2M_MCODE_PATH points at mock mcode.cmd", async () => {
    process.env["G2M_MCODE_PATH"] = mockMcode;
    try {
      const d = await resolveMCode();
      expect(d.executablePath).toBe(mockMcode);
      expect(d.resolvedVia).toBe("trusted-override");
      expect(d.kind).toBe("cmd");
      expect(d.version).toBe("mcode 9.9.9");
      expect(d.executableSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(d.executableBytes).toBeGreaterThan(0);
      expect(d.outputSchemaSupported).toBe(true);
      expect(d.helpText.toLowerCase()).toContain("usage");
      expect(d.execHelpText.toLowerCase()).toContain("--cwd");
    } finally {
      delete process.env["G2M_MCODE_PATH"];
    }
  });

  it("explicitPath option overrides G2M_MCODE_PATH env", async () => {
    process.env["G2M_MCODE_PATH"] = "C:/definitely/does/not/exist";
    try {
      const d = await resolveMCode({ explicitPath: mockMcode });
      expect(d.executablePath).toBe(mockMcode);
      expect(d.resolvedVia).toBe("trusted-override");
    } finally {
      delete process.env["G2M_MCODE_PATH"];
    }
  });

  it("trusted override pointing at non-existent path throws TRUSTED_PATH_INVALID", async () => {
    process.env["G2M_MCODE_PATH"] = "C:/totally/not/a/real/path/mcode.exe";
    try {
      await expect(resolveMCode()).rejects.toBeInstanceOf(MCodeResolverError);
      await expect(resolveMCode()).rejects.toMatchObject({
        code: "TRUSTED_PATH_INVALID",
      });
    } finally {
      delete process.env["G2M_MCODE_PATH"];
    }
  });

  it("PATH lookup: throws NOT_FOUND when G2M_MCODE_PATH is unset and PATH has no mcode", async () => {
    delete process.env["G2M_MCODE_PATH"];
    // 用一个不可能存在的 PATH 让 locateOnPath 必空
    const original = process.env["PATH"];
    process.env["PATH"] = join(tmpRoot, "no-such-bin-dir");
    try {
      await expect(resolveMCode()).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      process.env["PATH"] = original;
    }
  });

  it("skipProbe mode: trusted override returns stub descriptor without spawning", async () => {
    process.env["G2M_MCODE_PATH"] = mockMcode;
    try {
      const d = await resolveMCode({ skipProbe: true });
      expect(d.version).toBe("(skipped)");
      expect(d.resolvedVia).toBe("trusted-override");
    } finally {
      delete process.env["G2M_MCODE_PATH"];
    }
  });

  it("PATH lookup with tmp dir containing mock mcode (skipProbe) finds it", async () => {
    delete process.env["G2M_MCODE_PATH"];
    const original = process.env["PATH"];
    process.env["PATH"] = tmpRoot;
    try {
      const d = await resolveMCode({ skipProbe: true });
      expect(d.executablePath).toBe(mockMcode);
      expect(d.resolvedVia).toBe("path-lookup");
    } finally {
      process.env["PATH"] = original;
    }
  });

  it("refuses probe output beyond the configured bound", async () => {
    await expect(
      resolveMCode({ explicitPath: oversizedMcode, maxProbeOutputBytes: 32 }),
    ).rejects.toThrow(/exceeded 32 bytes/i);
  });

  it("requires locally verified --output-schema support", async () => {
    await expect(resolveMCode({ explicitPath: noSchemaMcode })).rejects.toMatchObject({
      code: "EXEC_HELP_PROBE_FAILED",
    });
  });
});

describe("buildMCodeInvocation (plan §32)", () => {
  it("builds minimal exec argv with all defaults", () => {
    const inv = buildMCodeInvocation("D:/mcode/mcode.exe", {
      workspacePath: "D:/robotics/arm_ws",
      prompt: "Fix the trajectory test",
      permissionPolicy: "smart",
      timeoutMs: 600_000,
      maxSteps: 20,
    });
    expect(inv.program).toBe("D:/mcode/mcode.exe");
    expect(inv.args[0]).toBe("exec");
    // --cwd trusted path
    expect(inv.args).toContain("--cwd");
    expect(inv.args[inv.args.indexOf("--cwd") + 1]).toBe("D:/robotics/arm_ws");
    // --permission / --timeout / --max-steps
    expect(inv.args).toContain("--permission");
    expect(inv.args).toContain("smart");
    expect(inv.args).toContain("--timeout");
    expect(inv.args).toContain("10m");
    expect(inv.args).toContain("--max-steps");
    expect(inv.args).toContain("20");
    // output-format default = stream-json
    expect(inv.args).toContain("--output-format");
    expect(inv.args[inv.args.indexOf("--output-format") + 1]).toBe("stream-json");
    // Prompt is transported as stdin, not as a shell-sensitive argv value.
    expect(inv.args).toContain("--input");
    expect(inv.args[inv.args.indexOf("--input") + 1]).toBe("-");
    expect(inv.args).toContain("--input-format");
    expect(inv.stdin).toBe("Fix the trajectory test");
  });

  it("includes --file when provided (plan §2.1)", () => {
    const inv = buildMCodeInvocation("mcode", {
      workspacePath: "D:/x",
      prompt: "review changes",
      permissionPolicy: "smart",
      timeoutMs: 60_000,
      maxSteps: 5,
      file: "D:/x/error.log",
    });
    expect(inv.args).toContain("--file");
    expect(inv.args[inv.args.indexOf("--file") + 1]).toBe("D:/x/error.log");
  });

  it("includes --session when sessionId is provided (plan §22, §48)", () => {
    const inv = buildMCodeInvocation("mcode", {
      workspacePath: "D:/x",
      prompt: "continue",
      permissionPolicy: "smart",
      timeoutMs: 60_000,
      maxSteps: 5,
      sessionId: "verified-session-xyz",
    });
    expect(inv.args).toContain("--session");
    expect(inv.args[inv.args.indexOf("--session") + 1]).toBe(
      "verified-session-xyz",
    );
  });

  it("includes --output-schema as JSON string when provided (plan §25)", () => {
    const schema = { type: "object", required: ["summary"] };
    const inv = buildMCodeInvocation("mcode", {
      workspacePath: "D:/x",
      prompt: "p",
      permissionPolicy: "smart",
      timeoutMs: 60_000,
      maxSteps: 5,
      outputSchema: schema,
    });
    expect(inv.args).toContain("--output-schema");
    const idx = inv.args.indexOf("--output-schema");
    expect(JSON.parse(inv.args[idx + 1] as string)).toEqual(schema);
  });

  it("includes an explicitly pinned model in the invocation", () => {
    const inv = buildMCodeInvocation("mcode", {
      workspacePath: "D:/x",
      prompt: "p",
      permissionPolicy: "smart",
      timeoutMs: 60_000,
      maxSteps: 5,
      model: "MiniMax-M2",
    });
    expect(inv.args).toContain("--model");
    expect(inv.args[inv.args.indexOf("--model") + 1]).toBe("MiniMax-M2");
  });

  it("does NOT construct any shell string (plan §32: argv only)", () => {
    const inv = buildMCodeInvocation("mcode", {
      workspacePath: "D:/x",
      prompt: 'p with "quotes" and $vars',
      permissionPolicy: "smart",
      timeoutMs: 60_000,
      maxSteps: 5,
    });
    // 整个 args 数组里不应该出现任何 shell meta char 拼成的字符串
    for (const a of inv.args) {
      // 这里只是 sanity:不限制 args 内容,但 program 必须是 executable path,不是 shell
      expect(inv.program).not.toMatch(/[&|;<>]/);
    }
    // Prompt 不再进入 argv，因此 shell 不会接触其引号或变量语法。
    expect(inv.args).not.toContain('p with "quotes" and $vars');
    expect(inv.stdin).toBe('p with "quotes" and $vars');
  });
});
