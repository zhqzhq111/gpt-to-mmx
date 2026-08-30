import { statfs, lstat } from "node:fs/promises";
import { dirname } from "node:path";

export interface FreeSpaceProvider {
  freeBytes(path: string): Promise<number>;
}

export const nodeFreeSpaceProvider: FreeSpaceProvider = {
  async freeBytes(path: string): Promise<number> {
    let probePath = path;
    while (true) {
      try {
        await lstat(probePath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(probePath);
        if (parent === probePath) throw error;
        probePath = parent;
      }
    }
    const info = await statfs(probePath);
    return Number(info.bavail) * Number(info.bsize);
  },
};
