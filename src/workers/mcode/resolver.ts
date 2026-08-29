/**
 * MCode Resolver — plan 第 33-35 节 Windows Resolver
 *
 * 正式 Windows Resolver 顺序(plan §34):
 * 1. Local trusted override(G2M_MCODE_PATH 环境变量)
 * 2. PATH 原始顺序
 * 3. 找到 mcode candidate
 * 4. mcode --version
 * 5. mcode --help
 * 6. mcode exec --help
 * 7. Cache Launch Descriptor
 *
 * 禁止(plan §34):
 * - 硬编码 AppData
 * - 硬编码用户目录
 * - 猜安装路径
 *
 * .cmd / .ps1 处理(plan §35):
 * - shell = false(优先让成熟 Process Runner 正确调用 Launcher)
 * - 需要 .ps1 时用 `powershell.exe -NoLogo -NoProfile -NonInteractive -File <mcode.ps1>`
 * - 禁止 `PowerShell -Command <模型内容>`
 * - 不自动 `ExecutionPolicy Bypass`
 *
 * 中文路径 / 空格路径(plan §36)Windows CI 必测,这一轮只写路径检测,
 * 真实 launch 留到 Phase 4 MCodeAdapter(需要 mcode 真实可执行)。
 */

import { stat } from "node:fs/promises";
import { extname, join, isAbsolute } from "node:path";
import spawn from "cross-spawn";


export type MCodeLaunchKind = "exe" | "cmd" | "ps1" | "js" | "unknown";

/**
 * plan §21 Runtime Capability Snapshot 的 launch-specific 字段。
 * 这一轮 Resolver 只产出这一段,完整 snapshot 在 MCodeAdapter probe() 时合。
 */
export interface MCodeLaunchDescriptor {
  readonly kind: MCodeLaunchKind;
  /** Resolved 真实文件路径(plan §13 canonical path,不是 PATH 里的字符串) */
  readonly executablePath: string;
  readonly version: string;
  readonly helpText: string;
  readonly execHelpText: string;
  readonly resolvedAt: number;
  /** Resolved via:trusted override / PATH lookup / explicit path */
  readonly resolvedVia: "trusted-override" | "path-lookup" | "explicit";
}

export class MCodeResolverError extends Error {
  readonly code:
    | "NOT_FOUND"
    | "INVOCATION_FAILED"
    | "TRUSTED_PATH_INVALID"
    | "VERSION_PROBE_FAILED"
    | "HELP_PROBE_FAILED"
    | "EXEC_HELP_PROBE_FAILED";
  override readonly cause?: unknown;
  constructor(
    code: MCodeResolverError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "MCodeResolverError";
    this.code = code;
    this.cause = cause;
  }
}

const PROBE_TIMEOUT_MS = 10_000;
const TRUSTED_PATH_ENV = "G2M_MCODE_PATH";

interface LaunchResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

function launch(executablePath: string, args: readonly string[]): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`process timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Windows / POSIX 通用 launcher 探测(plan §33):mcode 可能以多种
 * 扩展名出现,Resolver 必须按 PATH 顺序逐个试。
 */
const CANDIDATE_NAMES: readonly string[] = [
  "mcode",
  "mcode.exe",
  "mcode.cmd",
  "mcode.ps1",
  "mcode.js",
];

function kindFromPath(p: string): MCodeLaunchKind {
  const ext = extname(p).toLowerCase();
  switch (ext) {
    case ".exe":
      return "exe";
    case ".cmd":
    case ".bat":
      return "cmd";
    case ".ps1":
      return "ps1";
    case ".js":
      return "js";
    default:
      return "unknown";
  }
}

/**
 * Walk PATH dirs + 拼接候选名,挨个 stat,直到找到一个存在的文件。
 * 返回绝对路径,找不到返回 null。
 * 走 path.join 而不是手拼,Windows 上 `tmpRoot/mcode.cmd` 这种混合
 * 分隔符路径 stat 偶尔出问题。
 *
 * PATH separator 按平台分:Windows `;` / POSIX `:`。不能用 /[;:]/,
 * 否则 Windows 的 `C:` drive letter 会被切碎。
 */
async function locateOnPath(): Promise<string | null> {
  const sep = process.platform === "win32" ? ";" : ":";
  const pathDirs = (process.env.PATH ?? "").split(sep).filter((d) => d.length > 0);
  for (const dir of pathDirs) {
    if (!isAbsolute(dir)) continue; // 相对路径不靠谱,plan §34 禁止猜路径
    for (const name of CANDIDATE_NAMES) {
      const candidate = join(dir, name);
      try {
        const st = await stat(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // ENOENT 等,继续
      }
    }
  }
  return null;
}

async function probeVersion(executablePath: string): Promise<string> {
  try {
    const { stdout, stderr, code } = await launch(executablePath, ["--version"]);
    if (code !== 0) throw new Error(`exit=${code} stderr=${stderr.trim()}`);
    return stdout.trim();
  } catch (e) {
    throw new MCodeResolverError(
      "VERSION_PROBE_FAILED",
      `mcode --version failed for ${executablePath}: ${(e as Error).message}`,
      e,
    );
  }
}

async function probeHelp(executablePath: string): Promise<string> {
  try {
    const { stdout, stderr, code } = await launch(executablePath, ["--help"]);
    if (code !== 0 && stdout.length === 0) {
      throw new Error(`exit=${code} stderr=${stderr.trim()}`);
    }
    return stdout;
  } catch (e) {
    throw new MCodeResolverError(
      "HELP_PROBE_FAILED",
      `mcode --help failed for ${executablePath}: ${(e as Error).message}`,
      e,
    );
  }
}

async function probeExecHelp(executablePath: string): Promise<string> {
  try {
    const { stdout, stderr, code } = await launch(executablePath, ["exec", "--help"]);
    if (code !== 0 && stdout.length === 0) {
      throw new Error(`exit=${code} stderr=${stderr.trim()}`);
    }
    return stdout;
  } catch (e) {
    throw new MCodeResolverError(
      "EXEC_HELP_PROBE_FAILED",
      `mcode exec --help failed for ${executablePath}: ${(e as Error).message}`,
      e,
    );
  }
}

async function buildDescriptor(
  executablePath: string,
  resolvedVia: MCodeLaunchDescriptor["resolvedVia"],
): Promise<MCodeLaunchDescriptor> {
  const [version, helpText, execHelpText] = await Promise.all([
    probeVersion(executablePath),
    probeHelp(executablePath),
    probeExecHelp(executablePath),
  ]);
  return {
    kind: kindFromPath(executablePath),
    executablePath,
    version,
    helpText,
    execHelpText,
    resolvedAt: Date.now(),
    resolvedVia,
  };
}

export interface ResolveMCodeOptions {
  /**
   * Explicit path(优先级最高,plan §34 "Local trusted override" 的代码注入形式)。
   * 也可以通过 G2M_MCODE_PATH 环境变量传(同一语义)。
   */
  readonly explicitPath?: string;
  /**
   * 跳过真实 --version / --help probe(纯 Resolver 定位测试用)。
   * 不跳过时 Resolver 必须能真 spawn 进程。
   */
  readonly skipProbe?: boolean;
}

/**
 * plan §34 Resolver 顺序:
 * 1. explicit / G2M_MCODE_PATH(同一优先级,显式覆盖环境变量)
 * 2. PATH lookup
 * 找不到抛 MCodeResolverError NOT_FOUND。
 */
export async function resolveMCode(
  options: ResolveMCodeOptions = {},
): Promise<MCodeLaunchDescriptor> {
  const override =
    options.explicitPath ?? process.env[TRUSTED_PATH_ENV] ?? null;

  if (override) {
    try {
      const st = await stat(override);
      if (!st.isFile()) {
        throw new MCodeResolverError(
          "TRUSTED_PATH_INVALID",
          `${TRUSTED_PATH_ENV} points at a non-file: ${override}`,
        );
      }
    } catch (e) {
      if (e instanceof MCodeResolverError) throw e;
      throw new MCodeResolverError(
        "TRUSTED_PATH_INVALID",
        `${TRUSTED_PATH_ENV} = "${override}" not accessible: ${(e as Error).message}`,
        e,
      );
    }
    if (options.skipProbe) {
      return {
        kind: kindFromPath(override),
        executablePath: override,
        version: "(skipped)",
        helpText: "(skipped)",
        execHelpText: "(skipped)",
        resolvedAt: Date.now(),
        resolvedVia: "trusted-override",
      };
    }
    return buildDescriptor(override, "trusted-override");
  }

  const onPath = await locateOnPath();
  if (!onPath) {
    throw new MCodeResolverError(
      "NOT_FOUND",
      `mcode not found on PATH (looked for ${CANDIDATE_NAMES.join(", ")})`,
    );
  }
  if (options.skipProbe) {
    return {
      kind: kindFromPath(onPath),
      executablePath: onPath,
      version: "(skipped)",
      helpText: "(skipped)",
      execHelpText: "(skipped)",
      resolvedAt: Date.now(),
      resolvedVia: "path-lookup",
    };
  }
  return buildDescriptor(onPath, "path-lookup");
}
