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

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, join, isAbsolute } from "node:path";
import { BoundedOutput } from "../../runtime/bounded-output.js";
import { ProcessSupervisor, type ProcessOutcome } from "../../process/supervisor.js";

export type MCodeLaunchKind = "exe" | "cmd" | "ps1" | "js" | "unknown";

/**
 * plan §21 Runtime Capability Snapshot 的 launch-specific 字段。
 * 这一轮 Resolver 只产出这一段,完整 snapshot 在 MCodeAdapter probe() 时合。
 */
export interface MCodeLaunchDescriptor {
  readonly kind: MCodeLaunchKind;
  /** Resolved 真实文件路径(plan §13 canonical path,不是 PATH 里的字符串) */
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly executableBytes: number;
  readonly version: string;
  readonly helpText: string;
  readonly helpSha256: string;
  readonly execHelpText: string;
  readonly execHelpSha256: string;
  readonly outputSchemaSupported: boolean;
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
    | "EXEC_HELP_PROBE_FAILED"
    | "PROBE_OUTPUT_LIMIT"
    | "PROBE_TERMINATION_UNCONFIRMED";
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
const DEFAULT_PROBE_OUTPUT_BYTES = 2_097_152;

class ProbeFailure extends Error {
  constructor(
    readonly code: "PROBE_OUTPUT_LIMIT" | "PROBE_TERMINATION_UNCONFIRMED",
    message: string,
  ) {
    super(message);
    this.name = "ProbeFailure";
  }
}

interface LaunchResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function probeCommand(executablePath: string, args: readonly string[]): {
  readonly program: string;
  readonly args: readonly string[];
} {
  if (kindFromPath(executablePath) === "ps1" && process.platform === "win32") {
    return {
      program: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", executablePath, ...args],
    };
  }
  return { program: executablePath, args };
}

async function launch(
  executablePath: string,
  args: readonly string[],
  options: { readonly maxOutputBytes: number; readonly processSupervisor: ProcessSupervisor },
): Promise<LaunchResult> {
  const command = probeCommand(executablePath, args);
  const managed = options.processSupervisor.spawn({
    program: command.program,
    args: command.args,
    cwd: process.cwd(),
    timeoutMs: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  const stdout = new BoundedOutput(options.maxOutputBytes);
  const stderr = new BoundedOutput(options.maxOutputBytes);
  let outputOverflow = false;
  let termination: Promise<import("../../process/supervisor.js").TerminationResult> | undefined;
  const capture = (target: BoundedOutput) => (chunk: Buffer | string): void => {
    target.push(chunk);
    if (target.truncated && !outputOverflow) {
      outputOverflow = true;
      termination = managed.terminate("cleanup");
    }
  };
  managed.stdout?.on("data", capture(stdout));
  managed.stderr?.on("data", capture(stderr));

  const outcome: ProcessOutcome = await managed.wait();
  if (outputOverflow) {
    const result = await (termination ?? managed.terminate("cleanup"));
    if (!result.confirmedGone) {
      throw new ProbeFailure(
        "PROBE_TERMINATION_UNCONFIRMED",
        `probe output exceeded ${options.maxOutputBytes} bytes and process termination could not be confirmed`,
      );
    }
    throw new ProbeFailure("PROBE_OUTPUT_LIMIT", `probe output exceeded ${options.maxOutputBytes} bytes`);
  }
  if (outcome.kind === "spawn_error") throw outcome.error;
  if (outcome.kind === "timed_out") {
    if (!outcome.termination.confirmedGone) {
      throw new ProbeFailure(
        "PROBE_TERMINATION_UNCONFIRMED",
        "probe timed out and process termination could not be confirmed",
      );
    }
    throw new Error(`process timed out after ${PROBE_TIMEOUT_MS}ms`);
  }
  if (outcome.kind === "termination_unconfirmed") {
    throw new Error(outcome.reason);
  }
  return { stdout: stdout.capturedText(), stderr: stderr.capturedText(), code: outcome.exitCode };
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

interface ProbeOptions {
  readonly maxOutputBytes: number;
  readonly processSupervisor: ProcessSupervisor;
}

async function probeVersion(executablePath: string, options: ProbeOptions): Promise<string> {
  try {
    const { stdout, stderr, code } = await launch(executablePath, ["--version"], options);
    if (code !== 0) throw new Error(`exit=${code} stderr=${stderr.trim()}`);
    return stdout.trim();
  } catch (e) {
    throw new MCodeResolverError(
      e instanceof ProbeFailure ? e.code : "VERSION_PROBE_FAILED",
      `mcode --version failed for ${executablePath}: ${(e as Error).message}`,
      e,
    );
  }
}

async function probeHelp(executablePath: string, options: ProbeOptions): Promise<string> {
  try {
    const { stdout, stderr, code } = await launch(executablePath, ["--help"], options);
    if (code !== 0 && stdout.length === 0) {
      throw new Error(`exit=${code} stderr=${stderr.trim()}`);
    }
    return stdout;
  } catch (e) {
    throw new MCodeResolverError(
      e instanceof ProbeFailure ? e.code : "HELP_PROBE_FAILED",
      `mcode --help failed for ${executablePath}: ${(e as Error).message}`,
      e,
    );
  }
}

async function probeExecHelp(executablePath: string, options: ProbeOptions): Promise<string> {
  try {
    const { stdout, stderr, code } = await launch(executablePath, ["exec", "--help"], options);
    if (code !== 0 && stdout.length === 0) {
      throw new Error(`exit=${code} stderr=${stderr.trim()}`);
    }
    if (!/(^|\s)--output-schema(?:\s|$)/m.test(stdout)) {
      throw new Error("mcode exec --help does not advertise --output-schema");
    }
    return stdout;
  } catch (e) {
    throw new MCodeResolverError(
      e instanceof ProbeFailure ? e.code : "EXEC_HELP_PROBE_FAILED",
      `mcode exec --help failed for ${executablePath}: ${(e as Error).message}`,
      e,
    );
  }
}

async function buildDescriptor(
  executablePath: string,
  resolvedVia: MCodeLaunchDescriptor["resolvedVia"],
  options: ProbeOptions,
): Promise<MCodeLaunchDescriptor> {
  const [version, helpText, execHelpText] = await Promise.all([
    probeVersion(executablePath, options),
    probeHelp(executablePath, options),
    probeExecHelp(executablePath, options),
  ]);
  const executable = await hashFile(executablePath);
  return {
    kind: kindFromPath(executablePath),
    executablePath,
    executableSha256: executable.sha256,
    executableBytes: executable.bytes,
    version,
    helpText,
    helpSha256: hashText(helpText),
    execHelpText,
    execHelpSha256: hashText(execHelpText),
    outputSchemaSupported: true,
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
  /** Maximum bytes retained per probe stream before the probe is refused. */
  readonly maxProbeOutputBytes?: number;
  /** Injected supervisor for deterministic lifecycle tests. */
  readonly processSupervisor?: ProcessSupervisor;
  /** Preserve the original provenance when rechecking a frozen path. */
  readonly preserveResolvedVia?: MCodeLaunchDescriptor["resolvedVia"];
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
  const probeOptions: ProbeOptions = {
    maxOutputBytes: options.maxProbeOutputBytes ?? DEFAULT_PROBE_OUTPUT_BYTES,
    processSupervisor: options.processSupervisor ?? new ProcessSupervisor(),
  };
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
    const canonicalPath = await realpath(override);
    if (options.skipProbe) {
      const executable = await hashFile(canonicalPath);
      return {
        kind: kindFromPath(canonicalPath),
        executablePath: canonicalPath,
        executableSha256: executable.sha256,
        executableBytes: executable.bytes,
        version: "(skipped)",
        helpText: "(skipped)",
        helpSha256: hashText("(skipped)"),
        execHelpText: "(skipped)",
        execHelpSha256: hashText("(skipped)"),
        outputSchemaSupported: false,
        resolvedAt: Date.now(),
        resolvedVia: options.preserveResolvedVia ?? "trusted-override",
      };
    }
    return buildDescriptor(
      canonicalPath,
      options.preserveResolvedVia ?? "trusted-override",
      probeOptions,
    );
  }

  const onPath = await locateOnPath();
  if (!onPath) {
    throw new MCodeResolverError(
      "NOT_FOUND",
      `mcode not found on PATH (looked for ${CANDIDATE_NAMES.join(", ")})`,
    );
  }
  const canonicalPath = await realpath(onPath);
  if (options.skipProbe) {
    const executable = await hashFile(canonicalPath);
    return {
      kind: kindFromPath(canonicalPath),
      executablePath: canonicalPath,
      executableSha256: executable.sha256,
      executableBytes: executable.bytes,
      version: "(skipped)",
      helpText: "(skipped)",
      helpSha256: hashText("(skipped)"),
      execHelpText: "(skipped)",
      execHelpSha256: hashText("(skipped)"),
      outputSchemaSupported: false,
      resolvedAt: Date.now(),
      resolvedVia: "path-lookup",
    };
  }
  return buildDescriptor(canonicalPath, "path-lookup", probeOptions);
}
