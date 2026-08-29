/**
 * Schema Validator — g2m.code-task.v1 入口校验
 *
 * 三层校验:
 * 1. Plan 第 11 节禁止字段检查(command / shell / raw_argv / powershell / cmd /
 *    api_key / token / credential / mcode_executable / absolute_workspace_path)
 *    在 zod 解析前先扫一遍,任一字段出现就 reject。
 * 2. zod 严格 schema 校验(strip 未知字段改成 reject 未知字段,见 code-task.v1.schema.ts)。
 * 3. Plan 第 12 节交叉字段校验:本地 Policy 永远 ≤ Planner 请求,例如
 *    Planner requested.network = true 但本地 policy.network = false,最终 false。
 *    这一轮只做 Protocol 层校验,Semantic Validator 留到 Workspace Registry 之后。
 */

import {
  CodeTaskV1Schema,
  type CodeTaskV1,
} from "./code-task.v1.schema.js";

/**
 * Plan 第 11 节「Task 中明确禁止出现的字段」原文逐字照抄。
 * 命名风格保持原样(snake_case 跟 camelCase 都涵盖,例如 api_key 和 apiKey)。
 * 任何 Planner 试图塞这些字段,G2M Core 拒绝执行。
 */
const FORBIDDEN_FIELDS: readonly string[] = [
  "command",
  "shell",
  "raw_argv",
  "powershell",
  "cmd",
  "api_key",
  "apiKey",
  "token",
  "credential",
  "mcode_executable",
  "mcodeExecutable",
  "absolute_workspace_path",
  "absoluteWorkspacePath",
];

export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code:
    | "FORBIDDEN_FIELD"
    | "INVALID_TYPE"
    | "MISSING_FIELD"
    | "UNKNOWN_FIELD"
    | "INVALID_VALUE";
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/**
 * 在对象树里找任一 forbidden field 出现的路径。
 * 用 BFS 防止恶意超深嵌套炸栈;最大深度 32 足够覆盖正常 Task。
 */
function findForbiddenFields(
  obj: unknown,
  maxDepth = 32,
): { path: string; field: string }[] {
  const hits: { path: string; field: string }[] = [];
  if (obj === null || typeof obj !== "object") return hits;

  const queue: { node: unknown; path: string; depth: number }[] = [
    { node: obj, path: "$", depth: 0 },
  ];
  while (queue.length > 0) {
    const { node, path, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        queue.push({ node: node[i], path: `${path}[${i}]`, depth: depth + 1 });
      }
      continue;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (FORBIDDEN_FIELDS.includes(key)) {
          hits.push({ path: `${path}.${key}`, field: key });
        }
        // 只对 object/array 继续递归,跳过基本类型
        if (value !== null && typeof value === "object") {
          queue.push({
            node: value,
            path: `${path}.${key}`,
            depth: depth + 1,
          });
        }
      }
    }
  }
  return hits;
}

function zodToValidationErrors(err: unknown): ValidationError[] {
  // zod 5 / zod 3 都暴露 issues 数组
  const issues =
    typeof err === "object" && err !== null && "issues" in err
      ? (err as { issues: unknown[] }).issues
      : [];
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((issue) => {
      const i = issue as {
        path?: (string | number)[];
        message?: string;
        code?: string;
        keys?: unknown;
      };
      const path = (i.path ?? []).map(String).join(".");
      // zod 4 / zod 5 拒未知字段时,issue 会有 keys 字段列出被拒的 key。
      // 兜底认:code 含 "unrecognized" / "unrecognized_keys" 也归 UNKNOWN_FIELD。
      let code: ValidationError["code"] = "INVALID_TYPE";
      if (i.keys !== undefined || (i.code ?? "").toLowerCase().includes("unrecognized")) {
        code = "UNKNOWN_FIELD";
      } else if (i.code === "invalid_type") {
        if (i.message?.toLowerCase().includes("required")) code = "MISSING_FIELD";
        else code = "INVALID_TYPE";
      } else if (i.code === "invalid_value" || i.code === "invalid_enum_value") {
        code = "INVALID_VALUE";
      }
      return { path: path || "$", message: i.message ?? "invalid", code };
    });
  }
  return [
    {
      path: "$",
      message: err instanceof Error ? err.message : "unknown zod error",
      code: "INVALID_TYPE",
    },
  ];
}

/**
 * 校验 raw object 是否符合 g2m.code-task.v1。
 * 返回 ValidationResult,调用方根据 ok 分支处理。
 */
export function validateCodeTask(raw: unknown): ValidationResult<CodeTaskV1> {
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      errors: [
        {
          path: "$",
          message: "task must be a JSON object",
          code: "INVALID_TYPE",
        },
      ],
    };
  }

  const forbidden = findForbiddenFields(raw);
  if (forbidden.length > 0) {
    return {
      ok: false,
      errors: forbidden.map((f) => ({
        path: f.path,
        message: `forbidden field "${f.field}" (plan 第 11 节)`,
        code: "FORBIDDEN_FIELD",
      })),
    };
  }

  const result = CodeTaskV1Schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, errors: zodToValidationErrors(result.error) };
  }
  return { ok: true, value: result.data };
}
