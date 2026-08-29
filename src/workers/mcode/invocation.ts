/**
 * mcode argv Builder — plan 第 32 节 Process Invocation
 *
 * 正式 invocation 模板:
 *   mcode exec
 *     --cwd <trusted path>
 *     --permission <effective policy>
 *     --timeout <effective timeout>
 *     --max-steps <effective steps>
 *     --output-format stream-json
 *     --input -
 *     --input-format text
 *     [prompt through stdin]
 *
 * 硬约束(plan §32):
 * - 永远不构造 shell string,只构造 argv 数组(program + args)
 * - Prompt 永远是 data,不是 shell
 *
 * Permission mapping 由 LocalPermissionPolicy 负责；本 Builder 只构造
 * 已授权的参数和独立的 stdin 数据。
 */

export type MCodeOutputFormat = "stream-json" | "json" | "text";

export interface MCodeInvocationInputs {
  readonly workspacePath: string;
  readonly prompt: string;
  readonly permissionPolicy: string;
  readonly timeoutMs: number;
  readonly maxSteps: number;
  readonly outputFormat?: MCodeOutputFormat;
  readonly outputSchema?: Record<string, unknown>;
  readonly file?: string;
  readonly sessionId?: string;
}

export interface MCodeInvocation {
  readonly program: string;
  readonly args: readonly string[];
  /** Prompt is sent through stdin so shell wrappers never parse model text. */
  readonly stdin: string;
}

/** Convert G2M milliseconds to the duration syntax accepted by mcode exec. */
export function formatMCodeDuration(timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * 构造一次 mcode exec 调用的 argv。
 * 调用方负责把 program + args 喂给 child_process.spawn/execFile(shell=false)。
 *
 * 不接收 plan 第 11 节禁止字段(命令 / shell / raw_argv / powershell / cmd /
 * api_key / token / credential / mcode_executable / absolute_workspace_path):
 * workspacePath 必须是 G2M 解析过的 canonical path(program caller 传),不允许
 * 调用方塞 raw shell 字符串。
 */
export function buildMCodeInvocation(
  descriptorExecutable: string,
  inputs: MCodeInvocationInputs,
): MCodeInvocation {
  const args: string[] = ["exec"];

  // plan §32:--cwd 必须 trusted path,不在此函数做 canonical 化(plan §13 上游负责)
  args.push("--cwd", inputs.workspacePath);

  args.push("--permission", inputs.permissionPolicy);
  args.push("--timeout", formatMCodeDuration(inputs.timeoutMs));
  args.push("--max-steps", String(inputs.maxSteps));
  args.push(
    "--output-format",
    inputs.outputFormat ?? "stream-json",
  );
  // mcode exec 0.2.7 supports --input -, which avoids passing arbitrary
  // model text through a Windows .cmd shell command line.
  args.push("--input", "-", "--input-format", "text");
  if (inputs.outputSchema !== undefined) {
    // plan §25:schema 接受 JSON object 或 file path。
    // 这一轮 inline 模式,跟 mcode 真实契约对齐等 Phase 4 实测。
    args.push("--output-schema", JSON.stringify(inputs.outputSchema));
  }
  if (inputs.file !== undefined) {
    args.push("--file", inputs.file);
  }
  if (inputs.sessionId !== undefined) {
    args.push("--session", inputs.sessionId);
  }

  return { program: descriptorExecutable, args, stdin: inputs.prompt };
}
