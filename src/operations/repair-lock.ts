import { hostname } from "node:os";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export class RepairLockBusyError extends Error {
  constructor(readonly path: string) {
    super(`another repair operation owns ${path}`);
    this.name = "RepairLockBusyError";
  }
}

export interface RepairLockHandle {
  readonly path: string;
  readonly operationId: string;
  release(): Promise<void>;
}

export async function acquireRepairLock(
  stateRoot: string,
  options: { readonly operationId: string; readonly nowMs?: number } ,
): Promise<RepairLockHandle> {
  const directory = join(stateRoot, "repair");
  const path = join(directory, "repair.lock");
  await mkdir(directory, { recursive: true });
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RepairLockBusyError(path);
    throw error;
  }
  const metadata = {
    schema_version: "g2m.repair-lock.v1",
    operation_id: options.operationId,
    pid: process.pid,
    hostname: hostname(),
    created_at: options.nowMs ?? Date.now(),
  };
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  let released = false;
  return {
    path,
    operationId: options.operationId,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await rm(path, { force: true });
    },
  };
}

export async function readRepairLock(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
