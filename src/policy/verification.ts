/**
 * Verification Profile — plan §29 + §67 + Phase 6
 *
 * Codex Task 协议层只能写 `verification_profile = "targeted_tests"` 这样的
 * profile name,不能写 shell command 或 argv。真正 program+argv 来自
 * Local Workspace Config(plan §29 严格约束,plan §67 禁止 Planner 构造测试 Shell)。
 *
 * 关键设计:
 * - Profile 是不可变数据,所有字段 readonly。
 * - ProfileRegistry 是内存实现(Phase 9 Event Log 阶段再考虑持久化)。
 * - profileId = "none" 是显式 skip:resolveProfile 返回 undefined。
 * - workspaceId 是 optional scope;不指定 = 全局 profile,所有 workspace 都能用;
 *   指定了 = workspace 专用,优先于全局同名 profile(plan §29 "Local Workspace Config")。
 *
 * 不动 MCodeAdapter / Parser / Runtime Probe(本轮约束)。
 */

export interface VerificationProfile {
  readonly id: string;
  readonly workspaceId?: string;
  readonly description: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Registry 写入时间戳(ms),Registry.register 时填充。
   * 公开出去方便 caller 调试 / 审计;ProfileRegistry 内部用同一字段做存储。
   */
  readonly registeredAt: number;
}

export class ProfileRegistryError extends Error {
  readonly code: "DUPLICATE" | "NOT_FOUND" | "INVALID_PROFILE";
  constructor(
    code: ProfileRegistryError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ProfileRegistryError";
    this.code = code;
  }
}

interface InternalProfile extends VerificationProfile {
  readonly registeredAt: number;
}

/**
 * 内部 key 把 (workspaceId, profileId) 拼成一个字符串。
 * 全局 profile(workspaceId=undefined)用 "*" 占位,避免和 workspace 专用同名 profile 撞 key。
 */
function profileKey(profileId: string, workspaceId: string | undefined): string {
  return workspaceId === undefined ? `*::${profileId}` : `${workspaceId}::${profileId}`;
}

export class ProfileRegistry {
  private readonly profiles = new Map<string, InternalProfile>();

  /**
   * 注册一个 profile。重复 (workspaceId, profileId) 抛 DUPLICATE。
   * program / timeoutMs / id 任何一个不合法都抛 INVALID_PROFILE。
   */
  register(profile: VerificationProfile): VerificationProfile {
    if (profile.id.trim().length === 0) {
      throw new ProfileRegistryError(
        "INVALID_PROFILE",
        "profile id cannot be empty",
      );
    }
    if (profile.program.trim().length === 0) {
      throw new ProfileRegistryError(
        "INVALID_PROFILE",
        `profile "${profile.id}" program cannot be empty`,
      );
    }
    if (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs <= 0) {
      throw new ProfileRegistryError(
        "INVALID_PROFILE",
        `profile "${profile.id}" timeoutMs must be a positive integer`,
      );
    }
    const key = profileKey(profile.id, profile.workspaceId);
    if (this.profiles.has(key)) {
      throw new ProfileRegistryError(
        "DUPLICATE",
        `profile "${key}" already registered`,
      );
    }
    const internal: InternalProfile = {
      ...profile,
      registeredAt: Date.now(),
    };
    this.profiles.set(key, internal);
    return internal;
  }

  /**
   * 注销一个 profile。未注册抛 NOT_FOUND,跟 register 严格对称。
   */
  unregister(profileId: string, workspaceId?: string): void {
    const key = profileKey(profileId, workspaceId);
    if (!this.profiles.delete(key)) {
      throw new ProfileRegistryError(
        "NOT_FOUND",
        `profile "${key}" not registered`,
      );
    }
  }

  /**
   * 查找一个 profile。workspace 专用 profile 优先于全局同名 profile,
   * 都没有就返回 undefined。
   */
  get(profileId: string, workspaceId?: string): VerificationProfile | undefined {
    if (workspaceId !== undefined) {
      const scoped = this.profiles.get(profileKey(profileId, workspaceId));
      if (scoped !== undefined) return scoped;
    }
    return this.profiles.get(profileKey(profileId, undefined));
  }

  /**
   * 列出可见 profile。不传 workspaceId = 全部;传了 = 该 workspace 可见的
   * (全局 + 自身专用)。返回浅拷贝,防止外部修改内部 map。
   */
  list(workspaceId?: string): readonly VerificationProfile[] {
    const all = Array.from(this.profiles.values());
    if (workspaceId === undefined) return all.slice();
    return all.filter(
      (p) => p.workspaceId === undefined || p.workspaceId === workspaceId,
    );
  }

  /**
   * 诊断用:已注册的 profile key 数量(全局 + workspace 专用合并计数)。
   */
  size(): number {
    return this.profiles.size;
  }
}

export class ProfileResolutionError extends Error {
  readonly code: "NOT_FOUND" | "INVALID_ID";
  constructor(code: ProfileResolutionError["code"], message: string) {
    super(message);
    this.name = "ProfileResolutionError";
    this.code = code;
  }
}

/**
 * 任务里写 verification_profile = "none" 等同于"skip independent verification"。
 * 这是 G2M 协议层显式约定的 sentinel,跟具体 profile 注册解耦。
 */
export const NO_VERIFICATION_PROFILE = "none";

/**
 * 把任务里的 verification_profile 字符串解析到实际 Profile。
 * - "none" → 返回 undefined(调用方按 skip 处理)
 * - 找不到注册 → 抛 ProfileResolutionError("NOT_FOUND")(plan §29 严格要求)
 * - 非法 id(空字符串) → 抛 ProfileResolutionError("INVALID_ID")
 *
 * 抛错而不是返回 undefined 的原因:plan §29 明确"真正命令来自 Local Workspace Config",
 * 任务里写了一个没人注册的 profileId 是配置错配,必须显式失败,不能让 Runner 静默跳过。
 */
export function resolveProfile(
  registry: ProfileRegistry,
  workspaceId: string,
  profileId: string,
): VerificationProfile | undefined {
  if (profileId === NO_VERIFICATION_PROFILE) {
    return undefined;
  }
  if (profileId.trim().length === 0) {
    throw new ProfileResolutionError(
      "INVALID_ID",
      "verification_profile id cannot be empty",
    );
  }
  const profile = registry.get(profileId, workspaceId);
  if (profile === undefined) {
    throw new ProfileResolutionError(
      "NOT_FOUND",
      `no verification profile "${profileId}" available for workspace "${workspaceId}" (plan §29: profile command must come from Local Workspace Config)`,
    );
  }
  return profile;
}
