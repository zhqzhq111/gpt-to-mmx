import { existsSync, statSync } from "node:fs";
import { dirname, win32 } from "node:path";

export interface VolumeInfo {
  readonly volumeId: string;
  readonly rootPath: string;
  readonly freeBytes: number;
}

export interface VolumeRoot {
  readonly rootPath: string;
  readonly roles: readonly string[];
}

export interface VolumeResolverOptions {
  readonly platform?: NodeJS.Platform | "win32";
  readonly deviceNumber?: number;
}

export class VolumeResolver {
  constructor(private readonly options: VolumeResolverOptions = {}) {}

  resolve(path: string): VolumeInfo {
    return {
      volumeId: volumeIdForPath(path, this.options.platform, this.options.deviceNumber),
      rootPath: path,
      freeBytes: 0,
    };
  }
}

function uncVolume(path: string): string | undefined {
  const match = path.replaceAll("/", "\\").match(/^\\\\([^\\]+)\\([^\\]+)/);
  return match === null ? undefined : `win32-unc:\\\\${match[1]!.toLowerCase()}\\${match[2]!.toLowerCase()}`;
}

export function volumeIdForPath(path: string, platform: NodeJS.Platform | "win32" = process.platform, deviceNumber?: number): string {
  if (platform === "win32") {
    const unc = uncVolume(path);
    if (unc !== undefined) return unc;
    const root = win32.parse(path).root;
    if (root.length === 0) throw new Error(`cannot resolve Windows volume for path: ${path}`);
    return `win32:${root.toLowerCase()}`;
  }
  let existingPath = path;
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) throw new Error(`cannot resolve POSIX volume for path: ${path}`);
    existingPath = parent;
  }
  const dev = deviceNumber ?? Number(statSync(existingPath).dev);
  return `posix-dev:${dev}`;
}

export function deduplicateVolumeRoots(
  roots: readonly VolumeRoot[],
  options: VolumeResolverOptions = {},
): ReadonlyMap<string, readonly VolumeRoot[]> {
  const result = new Map<string, VolumeRoot[]>();
  for (const root of roots) {
    const id = volumeIdForPath(root.rootPath, options.platform, options.deviceNumber);
    const existing = result.get(id);
    if (existing === undefined) result.set(id, [{ ...root, roles: [...root.roles] }]);
    else existing.push({ ...root, roles: [...new Set([...existing.at(-1)!.roles, ...root.roles])] });
  }
  return result;
}
