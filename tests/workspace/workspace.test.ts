/**
 * Workspace 模块集成测试
 *
 * 覆盖:
 * - WorkspaceRegistry:register / get / unregister / list / 错误路径
 * - WorkspaceResolver:成功 / NOT_FOUND 转换
 * - WorkspaceLock:acquire / release / 二次 acquire 失败 / 错 handle release 失败
 * - captureBaseline:真实 git 仓库(临时目录 git init)测 clean / dirty
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { WorkspaceRegistry, WorkspaceRegistryError } from "../../src/workspace/registry.js";
import { resolveWorkspace, WorkspaceResolverError } from "../../src/workspace/resolver.js";
import { WorkspaceLock, WorkspaceLockError } from "../../src/workspace/lock.js";
import { captureBaseline, BaselineError } from "../../src/workspace/baseline.js";

const execFileAsync = promisify(execFile);

describe("WorkspaceRegistry", () => {
  it("register + get round-trip", () => {
    const r = new WorkspaceRegistry();
    const entry = r.register("robot-arm", "D:/projects/arm");
    expect(entry.workspaceId).toBe("robot-arm");
    expect(r.get("robot-arm").canonicalPath.replace(/\\/g, "/")).toBe(
      "D:/projects/arm",
    );
  });

  it("rejects duplicate register", () => {
    const r = new WorkspaceRegistry();
    r.register("dup", "D:/a");
    expect(() => r.register("dup", "D:/b")).toThrow(WorkspaceRegistryError);
    expect(() => r.register("dup", "D:/b")).toThrow(/already registered/);
  });

  it("rejects relative path (plan §13 absolute path only via G2M mapping)", () => {
    const r = new WorkspaceRegistry();
    expect(() => r.register("rel", "projects/relative")).toThrow(
      /must be absolute/,
    );
  });

  it("accepts Windows drive + UNC paths (POSIX path on Windows is normalized by path.resolve)", () => {
    const r = new WorkspaceRegistry();
    // Windows drive letter
    const winPath = `C:${sep}Users${sep}zhq${sep}x`;
    const winEntry = r.register("win", winPath);
    expect(winEntry.canonicalPath).toMatch(/^[A-Z]:[\\/]/i);
    expect(winEntry.canonicalPath.toLowerCase()).toContain("zhq");
    // UNC path
    const uncPath = "\\\\server\\share\\x";
    const uncEntry = r.register("unc", uncPath);
    expect(uncEntry.canonicalPath).toMatch(/^[\\]{2}server[\\/]share[\\/]x$/);
  });

  it("unregister then get throws NOT_FOUND", () => {
    const r = new WorkspaceRegistry();
    r.register("u", "D:/x");
    r.unregister("u");
    expect(() => r.get("u")).toThrow(/not registered/);
  });

  it("list returns all registered entries", () => {
    const r = new WorkspaceRegistry();
    r.register("a", "D:/a");
    r.register("b", "D:/b");
    const ids = r.list().map((e) => e.workspaceId).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("WorkspaceResolver", () => {
  it("returns canonical path for known id", () => {
    const r = new WorkspaceRegistry();
    r.register("known", "D:/projects/known");
    expect(resolveWorkspace(r, "known").replace(/\\/g, "/")).toBe(
      "D:/projects/known",
    );
  });

  it("throws WorkspaceResolverError.NOT_FOUND for unknown id", () => {
    const r = new WorkspaceRegistry();
    expect(() => resolveWorkspace(r, "ghost")).toThrow(WorkspaceResolverError);
    expect(() => resolveWorkspace(r, "ghost")).toThrow(/cannot resolve/);
  });
});

describe("WorkspaceLock", () => {
  let lock: WorkspaceLock;
  beforeEach(() => {
    lock = new WorkspaceLock();
  });

  it("acquire + release cycle", () => {
    const handle = lock.acquire("ws-1", "exec-1");
    expect(handle.workspaceId).toBe("ws-1");
    expect(handle.executionId).toBe("exec-1");
    expect(lock.isHeld("ws-1")).toBe(true);
    lock.release(handle);
    expect(lock.isHeld("ws-1")).toBe(false);
  });

  it("second acquire on same workspace throws WORKSPACE_BUSY (plan §15)", () => {
    const h1 = lock.acquire("ws-1", "exec-1");
    expect(() => lock.acquire("ws-1", "exec-2")).toThrow(WorkspaceLockError);
    expect(() => lock.acquire("ws-1", "exec-2")).toThrow(/busy/);
    lock.release(h1);
  });

  it("release + re-acquire on same workspace works (lock is reusable)", () => {
    const h1 = lock.acquire("ws-1", "exec-1");
    lock.release(h1);
    const h2 = lock.acquire("ws-1", "exec-2");
    expect(h2.executionId).toBe("exec-2");
    lock.release(h2);
  });

  it("release of stale handle throws NOT_HELD (plan §15 safety)", () => {
    const h1 = lock.acquire("ws-1", "exec-1");
    lock.release(h1);
    // 二次 release 同一个 handle 必须报错,不能静默成功
    expect(() => lock.release(h1)).toThrow(/not held/);
  });

  it("independent workspaces lock independently", () => {
    const h1 = lock.acquire("ws-1", "exec-1");
    const h2 = lock.acquire("ws-2", "exec-2");
    expect([...lock.heldWorkspaceIds()].sort()).toEqual(["ws-1", "ws-2"]);
    lock.release(h1);
    lock.release(h2);
    expect(lock.heldWorkspaceIds()).toEqual([]);
  });
});

describe("captureBaseline", () => {
  let tmpRoot: string;
  let repoDir: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "g2m-baseline-"));
    repoDir = join(tmpRoot, "repo");
    await mkdir(repoDir, { recursive: true });

    // 在临时目录 init 一个真实 git 仓库
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@g2m.local"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "G2M Test"], { cwd: repoDir });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });

    // 第一次 commit,让 HEAD 有 rev
    await writeFile(join(repoDir, "README.md"), "hello\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("captures a clean baseline (plan §16 MVP Clean Worktree)", async () => {
    const b = await captureBaseline(repoDir);
    expect(b.dirty).toBe(false);
    expect(b.statusPorcelain).toBe("");
    expect(b.baseRevision).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("captures a dirty baseline after modifying a file (plan §16)", async () => {
    await writeFile(join(repoDir, "new.txt"), "added\n");
    try {
      const b = await captureBaseline(repoDir);
      expect(b.dirty).toBe(true);
      expect(b.statusPorcelain).toContain("new.txt");
      expect(b.baseRevision).toMatch(/^[0-9a-f]{7,40}$/);
    } finally {
      // 清理 dirty 状态,不影响其它测试
      await execFileAsync("git", ["checkout", "--", "new.txt"], { cwd: repoDir }).catch(() => {});
      await execFileAsync("git", ["clean", "-fd", "--", "new.txt"], { cwd: repoDir }).catch(() => {});
    }
  });

  it("throws NOT_GIT_REPO for a non-git directory", async () => {
    const plainDir = join(tmpRoot, "plain");
    await mkdir(plainDir, { recursive: true });
    await expect(captureBaseline(plainDir)).rejects.toBeInstanceOf(BaselineError);
    await expect(captureBaseline(plainDir)).rejects.toThrow(/not.*git|git.*failed/i);
  });
});
