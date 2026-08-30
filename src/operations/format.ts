type JsonObject = { readonly [key: string]: unknown };

function snakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCase);
  if (value === null || typeof value !== "object") return value;
  const object = value as JsonObject;
  return Object.fromEntries(
    Object.keys(object).sort().map((key) => [snakeCase(key), toSnakeCase(object[key])]),
  );
}

export function renderJson(value: unknown): string {
  return `${JSON.stringify(toSnakeCase(value), null, 2)}\n`;
}

function scalarText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function renderText(value: unknown): string {
  if (value === null || typeof value !== "object") return `${scalarText(value)}\n`;
  const object = value as JsonObject;
  const lines: string[] = [];
  if (typeof object.schemaVersion === "string") lines.push(object.schemaVersion);
  if (typeof object.status === "string") lines.push(`Status: ${object.status}`);
  const checks = object.checks;
  if (Array.isArray(checks)) {
    for (const check of checks) {
      if (check !== null && typeof check === "object") {
        const item = check as JsonObject;
        lines.push(`${scalarText(item.status)} ${scalarText(item.id)}: ${scalarText(item.message)}`);
      }
    }
  }
  for (const key of Object.keys(object).sort()) {
    if (key === "schemaVersion" || key === "status" || key === "checks") continue;
    const child = object[key];
    if (child !== null && typeof child === "object") continue;
    lines.push(`${key}: ${scalarText(child)}`);
  }
  return `${lines.join("\n")}\n`;
}
