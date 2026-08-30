import { execFile } from "node:child_process";

export type ProcessLiveness = "alive" | "gone" | "unknown";

export type TerminationStrategy = "windows_taskkill" | "posix_process_group";

export interface TerminationResult {
  readonly confirmedGone: boolean;
  readonly gracefulAttempted: boolean;
  readonly forcedAttempted: boolean;
  readonly strategy: TerminationStrategy;
  readonly error?: string;
}

export interface PlatformProcessController {
  readonly strategy: TerminationStrategy;
  isAlive(pid: number): ProcessLiveness;
  terminate(
    pid: number,
    options: {
      readonly gracefulTerminationMs: number;
      readonly forceTerminationMs: number;
      readonly forceImmediately?: boolean;
    },
  ): Promise<TerminationResult>;
}

export interface PlatformControllerDependencies {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly probe?: (targetPid: number) => ProcessLiveness;
  readonly sendSignal?: (targetPid: number, signal: NodeJS.Signals) => void;
  readonly runTaskkill?: (
    pid: number,
    force: boolean,
    timeoutMs: number,
  ) => Promise<{ readonly success: boolean; readonly error?: string }>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultProbe(targetPid: number): ProcessLiveness {
  try {
    process.kill(targetPid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    return "unknown";
  }
}

function defaultSendSignal(targetPid: number, signal: NodeJS.Signals): void {
  process.kill(targetPid, signal);
}

function defaultRunTaskkill(
  pid: number,
  force: boolean,
  timeoutMs: number,
): Promise<{ readonly success: boolean; readonly error?: string }> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    execFile(
      "taskkill.exe",
      args,
      // Starting taskkill.exe itself can exceed a very small injected test
      // interval on Windows. Keep the command bounded, but do not let the
      // process-spawn overhead turn a valid tree termination into an
      // unconfirmed result.
      { windowsHide: true, timeout: Math.max(250, timeoutMs) },
      (error) => {
        if (error === null) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: error.message });
        }
      },
    );
  });
}

async function waitForGone(
  probe: (pid: number) => ProcessLiveness,
  pid: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<ProcessLiveness> {
  const deadline = now() + Math.max(0, timeoutMs);
  const maxPolls = Math.max(1, Math.ceil(Math.max(0, timeoutMs) / 10));
  let last = probe(pid);
  for (let poll = 0; poll < maxPolls && last !== "gone"; poll += 1) {
    if (now() >= deadline) break;
    await sleep(Math.min(25, Math.max(1, deadline - now())));
    last = probe(pid);
  }
  return last;
}

function errorText(errors: readonly (string | undefined)[]): string | undefined {
  const values = errors.filter((value): value is string => value !== undefined);
  return values.length === 0 ? undefined : values.join("; ");
}

function makeController(
  platform: NodeJS.Platform,
  dependencies: PlatformControllerDependencies,
): PlatformProcessController {
  const sleep = dependencies.sleep ?? defaultSleep;
  const now = dependencies.now ?? Date.now;
  const probe = dependencies.probe ?? defaultProbe;

  if (platform === "win32") {
    const runTaskkill = dependencies.runTaskkill ?? defaultRunTaskkill;
    return {
      strategy: "windows_taskkill",
      isAlive: (pid) => probe(pid),
      async terminate(pid, options) {
        if (probe(pid) === "gone") {
          return {
            confirmedGone: true,
            gracefulAttempted: false,
            forcedAttempted: false,
            strategy: "windows_taskkill",
          };
        }

        if (options.forceImmediately) {
          const forced = await runTaskkill(pid, true, options.forceTerminationMs);
          const status = await waitForGone(probe, pid, options.forceTerminationMs, sleep, now);
          return {
            confirmedGone: status === "gone",
            gracefulAttempted: false,
            forcedAttempted: true,
            strategy: "windows_taskkill",
            ...(!forced.success && forced.error !== undefined ? { error: forced.error } : {}),
          };
        }

        const graceful = await runTaskkill(pid, false, options.gracefulTerminationMs);
        let status = await waitForGone(probe, pid, options.gracefulTerminationMs, sleep, now);
        if (status === "gone") {
          return {
            confirmedGone: true,
            gracefulAttempted: true,
            forcedAttempted: false,
            strategy: "windows_taskkill",
            ...(!graceful.success && graceful.error !== undefined ? { error: graceful.error } : {}),
          };
        }

        const forced = await runTaskkill(pid, true, options.forceTerminationMs);
        status = await waitForGone(probe, pid, options.forceTerminationMs, sleep, now);
        const error = !forced.success || !graceful.success
          ? errorText([graceful.error, forced.error])
          : undefined;
        return {
          confirmedGone: status === "gone",
          gracefulAttempted: true,
          forcedAttempted: true,
          strategy: "windows_taskkill",
          ...(error !== undefined ? { error } : {}),
        };
      },
    };
  }

  const sendSignal = dependencies.sendSignal ?? defaultSendSignal;
  const probeGroup = (pid: number): ProcessLiveness => probe(-pid);
  return {
    strategy: "posix_process_group",
    isAlive: probeGroup,
    async terminate(pid, options) {
      if (probeGroup(pid) === "gone") {
        return {
          confirmedGone: true,
          gracefulAttempted: false,
          forcedAttempted: false,
          strategy: "posix_process_group",
        };
      }

      const errors: string[] = [];
      const firstSignal = options.forceImmediately ? "SIGKILL" : "SIGTERM";
      try {
        sendSignal(-pid, firstSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          errors.push((error as Error).message);
        }
      }
      let status = await waitForGone(
        probeGroup,
        pid,
        options.forceImmediately ? options.forceTerminationMs : options.gracefulTerminationMs,
        sleep,
        now,
      );
      if (status === "gone") {
        return {
          confirmedGone: true,
          gracefulAttempted: options.forceImmediately !== true,
          forcedAttempted: options.forceImmediately === true,
          strategy: "posix_process_group",
          ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
        };
      }

      if (options.forceImmediately) {
        return {
          confirmedGone: false,
          gracefulAttempted: false,
          forcedAttempted: true,
          strategy: "posix_process_group",
          ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
        };
      }

      try {
        sendSignal(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          errors.push((error as Error).message);
        }
      }
      status = await waitForGone(probeGroup, pid, options.forceTerminationMs, sleep, now);
      return {
        confirmedGone: status === "gone",
        gracefulAttempted: true,
        forcedAttempted: true,
        strategy: "posix_process_group",
        ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      };
    },
  };
}

export function createPlatformProcessController(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly dependencies?: PlatformControllerDependencies;
  } = {},
): PlatformProcessController {
  return makeController(options.platform ?? process.platform, options.dependencies ?? {});
}
