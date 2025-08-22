import { exec } from '@actions/exec';
import { readPackageJSON, resolvePackageJSON, writePackageJSON } from 'pkg-types';
import semver, { type ReleaseType } from 'semver';
import { logger } from './core';
import {
  ActionError,
  DEFAULT_VERSIONS,
  type SupportedBranch,
  VERSION_PREFIX_CONFIG,
  type VersionInfo,
  type VersionSummary,
} from './types';

// ==================== 版本工具类 ====================

/**
 * 版本工具类 - 统一版本相关操作
 */
export class VersionUtils {
  /**
   * 获取当前使用的版本前缀
   */
  static getVersionPrefix(): string {
    return VERSION_PREFIX_CONFIG.custom;
  }

  /**
   * 检查字符串是否有版本前缀
   */
  static hasVersionPrefix(version: string): boolean {
    const prefix = VersionUtils.getVersionPrefix();
    return version.startsWith(prefix);
  }

  /**
   * 智能清理版本号前缀（支持自定义前缀）
   */
  static cleanVersion(version: string): string {
    const prefix = VersionUtils.getVersionPrefix();
    if (version.startsWith(prefix)) {
      return version.slice(prefix.length);
    }

    // 兼容处理：如果不是当前前缀，尝试清理支持的前缀
    for (const supportedPrefix of VERSION_PREFIX_CONFIG.supported) {
      if (version.startsWith(supportedPrefix)) {
        logger.warning(`版本 ${version} 使用了非标准前缀 "${supportedPrefix}"，建议统一使用 "${prefix}"`);
        return version.slice(supportedPrefix.length);
      }
    }
    return version;
  }

  /**
   * 添加版本号前缀（使用配置的前缀）
   */
  static addVersionPrefix(version: string): string {
    const prefix = VersionUtils.getVersionPrefix();
    const cleanVer = VersionUtils.cleanVersion(version);
    return `${prefix}${cleanVer}`;
  }

  /**
   * 标准化版本号（确保使用正确的前缀）
   */
  static normalizeVersion(version: string): string {
    return VersionUtils.addVersionPrefix(VersionUtils.cleanVersion(version));
  }

  /**
   * 安全解析版本号
   */
  static parseVersion(version: string): semver.SemVer | null {
    return semver.parse(VersionUtils.cleanVersion(version));
  }

  /**
   * 获取版本的基础版本号（不含预发布标识）
   */
  static getBaseVersionString(version: string): string {
    const parsed = VersionUtils.parseVersion(version);
    if (!parsed) return '0.0.0';
    return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  }

  /**
   * 比较两个版本的基础版本号
   */
  static compareBaseVersions(version1: string, version2: string): number {
    const base1 = VersionUtils.getBaseVersionString(version1);
    const base2 = VersionUtils.getBaseVersionString(version2);
    if (semver.gt(base1, base2)) return 1;
    if (semver.lt(base1, base2)) return -1;
    return 0;
  }

  /**
   * 获取版本的分支类型
   */
  static getBranchType(version: string): string {
    const parsed = VersionUtils.parseVersion(version);
    if (!parsed || !parsed.prerelease || parsed.prerelease.length === 0) {
      return 'release';
    }
    return parsed.prerelease[0] as string;
  }

  /**
   * 创建默认版本（带正确前缀）
   */
  static createDefaultVersion(type: keyof typeof DEFAULT_VERSIONS = 'base'): string {
    return VersionUtils.addVersionPrefix(DEFAULT_VERSIONS[type]);
  }

  /**
   * 验证版本号格式是否正确
   */
  static isValidVersion(version: string): boolean {
    const cleaned = VersionUtils.cleanVersion(version);
    return semver.valid(cleaned) !== null;
  }

  /**
   * 获取版本信息摘要（用于日志记录）
   */
  static getVersionSummary(version: string): VersionSummary {
    const prefix = VersionUtils.getVersionPrefix();
    const hasPrefix = VersionUtils.hasVersionPrefix(version);
    const clean = VersionUtils.cleanVersion(version);
    const normalized = VersionUtils.normalizeVersion(version);
    const isValid = VersionUtils.isValidVersion(version);

    return {
      original: version,
      normalized,
      clean,
      hasPrefix,
      isValid,
      prefix,
    };
  }
}

// ==================== 版本缓存机制 ====================

/**
 * 版本缓存接口
 */
interface VersionCache {
  main?: string | null;
  beta?: string | null;
  alpha?: string | null;
}

/**
 * 版本管理器 - 统一版本查询和缓存
 */
class VersionManager {
  private cache: VersionCache = {};
  private isInitialized = false;

  /**
   * 初始化版本缓存 - 一次性获取所有版本信息
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    logger.info('🔍 初始化版本信息...');

    // 一次性获取所有标签，避免重复查询
    const allTags = await this.getAllTags();

    if (allTags.length === 0) {
      logger.info('📝 未找到任何版本标签，将使用默认版本');
    } else {
      logger.info(`📋 找到 ${allTags.length} 个版本标签`);
    }

    // 解析各分支的最新版本
    this.cache.main = this.parseMainVersion(allTags);
    this.cache.beta = this.parseBranchVersion(allTags, 'beta');
    this.cache.alpha = this.parseBranchVersion(allTags, 'alpha');

    logger.info(
      `📊 版本概览: main=${this.cache.main || '无'}, beta=${this.cache.beta || '无'}, alpha=${this.cache.alpha || '无'}`,
    );

    this.isInitialized = true;
  }

  /**
   * 一次性获取所有版本标签
   */
  private async getAllTags(): Promise<string[]> {
    const prefix = VersionUtils.getVersionPrefix();
    const stdout = await execGitWithOutput(['tag', '-l', `${prefix}*`, '--sort=-version:refname']);
    return stdout.split('\n').filter((tag) => tag.trim().length > 0);
  }

  /**
   * 解析主分支版本（排除预发布版本）
   */
  private parseMainVersion(tags: string[]): string | null {
    const mainTags = tags.filter((tag) => !tag.includes('-'));
    const latest = mainTags[0] || null;
    return latest ? VersionUtils.normalizeVersion(latest) : null;
  }

  /**
   * 解析分支版本
   */
  private parseBranchVersion(tags: string[], branchSuffix: string): string | null {
    const branchTags = tags.filter((tag) => tag.includes(`-${branchSuffix}.`));
    const latest = branchTags[0] || null;
    return latest ? VersionUtils.normalizeVersion(latest) : null;
  }

  /**
   * 获取指定分支的最新版本
   */
  async getLatestVersion(branch: 'main' | 'beta' | 'alpha'): Promise<string | null> {
    await this.initialize();
    return this.cache[branch] || null;
  }

  /**
   * 获取全局最高基础版本
   */
  async getGlobalHighestVersion(): Promise<string> {
    await this.initialize();

    const versions = [this.cache.main, this.cache.beta, this.cache.alpha].filter(Boolean);

    if (versions.length === 0) {
      return VersionUtils.createDefaultVersion('base');
    }

    // 找到最高的基础版本号
    let highestBaseVersion = '0.0.0';
    for (const version of versions) {
      const baseVersion = VersionUtils.getBaseVersionString(version!);
      if (semver.gt(baseVersion, highestBaseVersion)) {
        highestBaseVersion = baseVersion;
      }
    }

    const result = VersionUtils.addVersionPrefix(highestBaseVersion);
    logger.info(`🏆 全局最高基础版本: ${result}`);
    return result;
  }

  /**
   * 清除缓存（用于测试或重新初始化）
   */
  clearCache(): void {
    this.cache = {};
    this.isInitialized = false;
  }
}

// 全局版本管理器实例
const versionManager = new VersionManager();

// ==================== Git 版本操作 ====================

/**
 * 执行 git 命令并捕获输出
 */
async function execGitWithOutput(args: string[]): Promise<string> {
  let stdout = '';
  await exec('git', args, {
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString();
      },
    },
  });
  return stdout.trim();
}

/**
 * 获取指定分支的最新 git tag 版本
 * @deprecated 使用 versionManager.getLatestVersion() 替代
 */
export async function getLatestTagVersion(branchSuffix: string = ''): Promise<string | null> {
  const branch = branchSuffix || 'main';
  if (branch === 'main' || branch === 'beta' || branch === 'alpha') {
    return await versionManager.getLatestVersion(branch as 'main' | 'beta' | 'alpha');
  }

  // 兼容旧的调用方式
  logger.warning(`使用了已弃用的 getLatestTagVersion('${branchSuffix}')，建议使用 versionManager.getLatestVersion()`);
  return await versionManager.getLatestVersion('main');
}

/**
 * 获取版本信息
 */
export async function getVersionInfo(targetBranch: SupportedBranch): Promise<VersionInfo> {
  const currentTagVersion = await versionManager.getLatestVersion(targetBranch === 'main' ? 'main' : targetBranch);
  const betaTagVersion = await versionManager.getLatestVersion('beta');

  const current = currentTagVersion || DEFAULT_VERSIONS.base;
  const beta = betaTagVersion || DEFAULT_VERSIONS.beta;

  return {
    current,
    beta,
    currentTag: currentTagVersion,
    betaTag: betaTagVersion,
  };
}

/**
 * 获取全局最新版本（比较所有分支）
 */
export async function getLatestGlobalVersion(): Promise<string> {
  return await versionManager.getGlobalHighestVersion();
}

// ==================== 版本升级规则定义 ====================

/**
 * 版本升级策略接口
 */
interface VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean;
  execute(context: VersionUpgradeContext): string | null | Promise<string | null>;
  description: string;
}

/**
 * 版本升级上下文
 */
interface VersionUpgradeContext {
  baseVersion: string;
  targetBranch: SupportedBranch;
  releaseType: ReleaseType | '';
  currentBranchType: string;
  parsed: semver.SemVer;
  hasLabel: boolean;
  labelPriority: number;
  currentPriority: number;
  sourceBranch?: string; // 新增：源分支信息
}

/**
 * 创建版本升级上下文
 */
function createUpgradeContext(
  baseVersion: string,
  targetBranch: SupportedBranch,
  releaseType: ReleaseType | '',
  sourceBranch?: string,
): VersionUpgradeContext | null {
  const parsed = VersionUtils.parseVersion(baseVersion);
  if (!parsed) return null;

  const isPrerelease = parsed.prerelease && parsed.prerelease.length > 0;
  const currentBranchType = isPrerelease ? (parsed.prerelease[0] as string) : 'release';
  const hasLabel = !!releaseType;

  const labelPriorityMap = { patch: 1, minor: 2, major: 3 };
  const labelPriority = hasLabel ? labelPriorityMap[getReleaseLevel(releaseType)] : 0;
  const currentPriority = getCurrentVersionPriority(parsed);

  return {
    baseVersion: VersionUtils.cleanVersion(baseVersion),
    targetBranch,
    releaseType,
    currentBranchType,
    parsed,
    hasLabel,
    labelPriority,
    currentPriority,
    sourceBranch,
  };
}

/**
 * Alpha分支无标签策略 - 跳过升级
 */
class AlphaNoLabelStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return context.targetBranch === 'alpha' && !context.hasLabel;
  }

  execute(context: VersionUpgradeContext): string | null {
    logger.info(`📛 Alpha分支无版本标签，跳过版本升级`);
    return null;
  }

  description = 'Alpha分支无标签时跳过升级';
}

/**
 * Alpha分支有标签策略 - 检查基础号是否已发布
 */
class AlphaWithLabelStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return context.targetBranch === 'alpha' && context.hasLabel;
  }

  async execute(context: VersionUpgradeContext): Promise<string | null> {
    const { baseVersion, releaseType, currentBranchType, labelPriority, currentPriority } = context;

    // 跨分支升级
    if (currentBranchType !== 'alpha') {
      logger.info(`🔄 检测到基础版本跨分支变化 (${currentBranchType} -> alpha)，重新开始Alpha计数`);
      return semver.inc(baseVersion, releaseType as ReleaseType, 'alpha');
    }

    // Alpha分支核心逻辑：检查基础号是否已发布
    const baseVersionString = VersionUtils.getBaseVersionString(baseVersion);
    const isBaseVersionReleased = await this.checkIfBaseVersionReleased(baseVersionString);

    if (isBaseVersionReleased) {
      // 基础号已发布：根据label创建新基础号
      logger.info(`🔼 基础号 ${baseVersionString} 已发布，根据标签 ${releaseType} 创建新基础号`);
      return semver.inc(baseVersionString, releaseType as ReleaseType, 'alpha');
    } else {
      // 基础号未发布：递增测试号
      if (labelPriority > currentPriority) {
        // 标签优先级更高：升级基础号
        logger.info(`🔼 标签优先级更高，升级基础号`);
        return semver.inc(baseVersion, releaseType as ReleaseType, 'alpha');
      } else {
        // 标签优先级同级或更低：递增测试号
        logger.info(`🔄 基础号 ${baseVersionString} 未发布，递增测试号`);
        return semver.inc(baseVersion, 'prerelease', 'alpha');
      }
    }
  }

  /**
   * 检查基础版本号是否已有正式版发布
   */
  private async checkIfBaseVersionReleased(baseVersion: string): Promise<boolean> {
    const mainVersion = await versionManager.getLatestVersion('main');
    if (!mainVersion) return false;

    const mainBaseVersion = VersionUtils.getBaseVersionString(mainVersion);
    return semver.gte(mainBaseVersion, baseVersion);
  }

  description = 'Alpha分支有标签时检查基础号发布状态';
}

/**
 * Beta分支Alpha转换策略 - Alpha → Beta (基础号比较)
 */
class BetaFromAlphaStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return context.targetBranch === 'beta' && context.currentBranchType === 'alpha';
  }

  async execute(context: VersionUpgradeContext): Promise<string | null> {
    const { baseVersion, hasLabel, releaseType } = context;
    const alphaBaseVersion = VersionUtils.getBaseVersionString(baseVersion);

    // 获取当前Beta分支的版本
    const currentBetaVersion = await versionManager.getLatestVersion('beta');

    if (!currentBetaVersion) {
      // 没有Beta版本，直接转换
      const betaVersion = `${alphaBaseVersion}-beta.0`;
      logger.info(`🔄 首次从Alpha转换为Beta: ${betaVersion}`);
      return betaVersion;
    }

    const betaBaseVersion = VersionUtils.getBaseVersionString(currentBetaVersion);

    if (hasLabel) {
      // 有标签：根据标签优先级决定
      logger.info(`🔼 根据标签 ${releaseType} 从Alpha转换Beta`);
      return semver.inc(alphaBaseVersion, releaseType as ReleaseType, 'beta');
    } else {
      // 无标签：比较基础号
      if (semver.eq(alphaBaseVersion, betaBaseVersion)) {
        // 基础号相同：不升级
        logger.info(`📌 Alpha和Beta基础号相同 (${alphaBaseVersion})，跳过升级`);
        return null;
      } else if (semver.gt(alphaBaseVersion, betaBaseVersion)) {
        // Alpha基础号更高：升级到Alpha的基础号
        const betaVersion = `${alphaBaseVersion}-beta.0`;
        logger.info(`🔼 Alpha基础号更高 (${alphaBaseVersion} > ${betaBaseVersion})，升级Beta基础号`);
        return betaVersion;
      } else {
        // Alpha基础号更低：不应该发生，但保持当前Beta版本
        logger.info(`⚠️ Alpha基础号低于Beta基础号，保持当前Beta版本`);
        return null;
      }
    }
  }

  description = 'Alpha版本转换为Beta版本时的基础号比较';
}

/**
 * Beta分支内部策略 - Beta内部升级
 */
class BetaInternalStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return context.targetBranch === 'beta' && context.currentBranchType === 'beta';
  }

  execute(context: VersionUpgradeContext): string | null {
    const { baseVersion, hasLabel, releaseType } = context;

    if (hasLabel) {
      // 有标签：根据标签类型升级
      logger.info(`🔼 Beta版本根据标签 ${releaseType} 升级`);
      return semver.inc(baseVersion, releaseType as ReleaseType, 'beta');
    } else {
      // 无标签：递增预发布版本
      logger.info(`🔄 Beta版本递增预发布号`);
      return semver.inc(baseVersion, 'prerelease', 'beta');
    }
  }

  description = 'Beta分支内部升级';
}

/**
 * Beta分支从正式版策略 - Release → Beta
 */
class BetaFromReleaseStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return context.targetBranch === 'beta' && context.currentBranchType === 'release';
  }

  execute(context: VersionUpgradeContext): string | null {
    const { baseVersion, hasLabel, releaseType } = context;

    if (hasLabel) {
      // 有标签：根据标签创建Beta版本
      logger.info(`🔼 从正式版本 ${baseVersion} 根据标签 ${releaseType} 创建Beta版本`);
      return semver.inc(baseVersion, releaseType as ReleaseType, 'beta');
    } else {
      // 无标签：创建补丁Beta版本
      logger.info(`🔄 从正式版本 ${baseVersion} 创建Beta版本`);
      return semver.inc(baseVersion, 'prepatch', 'beta');
    }
  }

  description = '正式版本创建Beta版本';
}

/**
 * Beta分支非Alpha源策略 - 当目标分支为beta但源分支不是alpha时增加计数
 */
class BetaFromNonAlphaStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return (
      context.targetBranch === 'beta' &&
      context.sourceBranch != null &&
      !context.sourceBranch.includes('alpha')
    );
  }

  async execute(context: VersionUpgradeContext): Promise<string | null> {
    const { sourceBranch } = context;
    
    // 获取当前Beta分支的版本
    const currentBetaVersion = await versionManager.getLatestVersion('beta');
    if (!currentBetaVersion) {
      logger.info(`📝 Beta分支还没有版本，跳过非Alpha源修复策略`);
      return null;
    }
    
    logger.info(`🔧 Beta分支非Alpha源修复 (源分支: ${sourceBranch})，基于当前Beta版本增加计数`);
    const cleanVersion = VersionUtils.cleanVersion(currentBetaVersion);
    return semver.inc(cleanVersion, 'prerelease', 'beta');
  }

  description = 'Beta分支非Alpha源时增加计数（修复场景）';
}

/**
 * Main分支从Beta策略 - Beta → Release (仅接受Beta来源)
 */
class MainFromBetaStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return context.targetBranch === 'main' && context.currentBranchType === 'beta';
  }

  async execute(context: VersionUpgradeContext): Promise<string | null> {
    const { baseVersion, hasLabel, releaseType } = context;
    const betaBaseVersion = VersionUtils.getBaseVersionString(baseVersion);

    // 获取当前Main分支的版本
    const currentMainVersion = await versionManager.getLatestVersion('main');

    if (!currentMainVersion) {
      // 没有Main版本，直接转换
      logger.info(`🔄 首次从Beta转换为正式版: ${betaBaseVersion}`);
      return betaBaseVersion;
    }

    const mainBaseVersion = VersionUtils.getBaseVersionString(currentMainVersion);

    if (hasLabel) {
      // 有标签：根据标签优先级决定
      logger.info(`🔼 根据标签 ${releaseType} 从Beta转换正式版`);
      return semver.inc(betaBaseVersion, releaseType as ReleaseType);
    } else {
      // 无标签：比较基础号
      if (semver.eq(betaBaseVersion, mainBaseVersion)) {
        // 基础号相同：不升级
        logger.info(`📌 Beta和Main基础号相同 (${betaBaseVersion})，跳过升级`);
        return null;
      } else if (semver.gt(betaBaseVersion, mainBaseVersion)) {
        // Beta基础号更高：升级到Beta的基础号
        logger.info(`🔼 Beta基础号更高 (${betaBaseVersion} > ${mainBaseVersion})，升级Main基础号`);
        return betaBaseVersion;
      } else {
        // Beta基础号更低：不应该发生，但保持当前Main版本
        logger.info(`⚠️ Beta基础号低于Main基础号，保持当前Main版本`);
        return null;
      }
    }
  }

  description = 'Beta版本转换为正式版本时的基础号比较';
}

/**
 * Main分支内部策略 - Release内部升级
 */
class MainInternalStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return context.targetBranch === 'main' && context.currentBranchType === 'release';
  }

  execute(context: VersionUpgradeContext): string | null {
    const { baseVersion, hasLabel, releaseType } = context;

    if (hasLabel) {
      // 有标签：根据标签升级
      logger.info(`🔼 正式版本根据标签 ${releaseType} 升级`);
      return semver.inc(baseVersion, releaseType as ReleaseType);
    } else {
      // 无标签：递增补丁版本
      logger.info(`🔄 正式版本递增补丁号`);
      return semver.inc(baseVersion, 'patch');
    }
  }

  description = '正式版本内部升级';
}

/**
 * Main分支非Beta源策略 - 当目标分支为main但源分支不是beta时增加补丁号
 */
class MainFromNonBetaStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return (
      context.targetBranch === 'main' &&
      context.sourceBranch != null &&
      !context.sourceBranch.includes('beta')
    );
  }

  async execute(context: VersionUpgradeContext): Promise<string | null> {
    const { sourceBranch } = context;
    
    // 获取当前Main分支的版本
    const currentMainVersion = await versionManager.getLatestVersion('main');
    if (!currentMainVersion) {
      logger.info(`📝 Main分支还没有版本，跳过非Beta源修复策略`);
      return null;
    }
    
    logger.info(`🔧 Main分支非Beta源修复 (源分支: ${sourceBranch})，基于当前Main版本增加补丁号`);
    const cleanVersion = VersionUtils.cleanVersion(currentMainVersion);
    return semver.inc(cleanVersion, 'patch');
  }

  description = 'Main分支非Beta源时增加补丁号（修复场景）';
}

/**
 * 版本升级策略管理器
 */
class VersionUpgradeManager {
  private strategies: VersionUpgradeStrategy[] = [
    new AlphaNoLabelStrategy(),
    new AlphaWithLabelStrategy(),
    new BetaFromNonAlphaStrategy(), // 新增：Beta分支非Alpha源策略（优先级高）
    new BetaFromAlphaStrategy(),
    new BetaInternalStrategy(),
    new BetaFromReleaseStrategy(),
    new MainFromNonBetaStrategy(), // 新增：Main分支非Beta源策略（优先级高）
    new MainFromBetaStrategy(),
    new MainInternalStrategy(),
  ];

  /**
   * 执行版本升级
   */
  async upgrade(context: VersionUpgradeContext): Promise<string | null> {
    for (const strategy of this.strategies) {
      if (strategy.canHandle(context)) {
        logger.info(`📋 使用策略: ${strategy.description}`);
        const result = strategy.execute(context);
        return await Promise.resolve(result);
      }
    }

    logger.error(`❌ 未找到适用的版本升级策略`);
    return null;
  }

  /**
   * 获取所有策略的描述（用于调试）
   */
  getStrategiesDescription(): string[] {
    return this.strategies.map((s) => s.description);
  }
}

// 全局策略管理器实例
const upgradeManager = new VersionUpgradeManager();

// ==================== 重构后的版本计算逻辑 ====================

/**
 * 判断新标签的级别
 */
function getReleaseLevel(release: ReleaseType): 'major' | 'minor' | 'patch' {
  if (release === 'premajor') return 'major';
  if (release === 'preminor') return 'minor';
  return 'patch';
}

/**
 * 获取当前版本的优先级
 */
function getCurrentVersionPriority(parsed: semver.SemVer): number {
  const levelPriority = { patch: 1, minor: 2, major: 3 };
  if (parsed.major > 0) return levelPriority.major;
  if (parsed.minor > 0) return levelPriority.minor;
  return levelPriority.patch;
}

// ==================== 版本升级规则表 ====================

/**
 * 版本升级规则表 (修正版)
 *
 * 基本概念：
 * - 基础号: 0.0.1 (major.minor.patch)
 * - 测试号: alpha.x 或 beta.x
 * - 完整版本: 0.0.1-alpha.0
 * - 分支流向: feature → alpha → beta → main
 *
 * 核心原则：
 * 1. Alpha分支：检查基础号是否已发布决定升级策略
 * 2. Beta分支：比较Alpha和Beta的基础号决定是否升级
 * 3. Main分支：仅接受Beta来源，比较基础号决定升级
 *
 * 详细规则：
 *
 * Alpha分支 (feature → alpha):
 * - 有标签 + 基础号已发布 → 根据label创建新基础号
 *   例: 0.1.0-alpha.0 + minor (且0.1.0已发布) → 0.2.0-alpha.0
 * - 有标签 + 基础号未发布 + 高优先级 → 升级基础号
 *   例: 0.1.0-alpha.0 + major (且0.1.0未发布) → 1.0.0-alpha.0
 * - 有标签 + 基础号未发布 + 同级优先级 → 递增测试号
 *   例: 0.1.0-alpha.0 + minor (且0.1.0未发布) → 0.1.0-alpha.1
 * - 无标签 → 跳过
 *
 * Beta分支 (alpha → beta):
 * - 有标签 → 根据label升级
 *   例: 0.1.0-alpha.1 + minor → 0.2.0-beta.0
 * - 无标签 + 基础号相同 → 跳过
 *   例: 0.1.0-alpha.1 vs 0.1.0-beta.0 → 跳过
 * - 无标签 + Alpha基础号更高 → 升级基础号
 *   例: 0.2.0-alpha.0 vs 0.1.0-beta.0 → 0.2.0-beta.0
 *
 * Main分支 (beta → main):
 * - 有标签 → 根据label升级
 *   例: 0.1.0-beta.0 + patch → 0.1.1
 * - 无标签 + 基础号相同 → 跳过
 *   例: 0.1.0-beta.0 vs 0.1.0 → 跳过
 * - 无标签 + Beta基础号更高 → 升级基础号
 *   例: 0.2.0-beta.0 vs 0.1.0 → 0.2.0
 */

/**
 * 获取目标分支的基础版本
 */
export async function getBaseVersion(targetBranch: SupportedBranch, versionInfo: VersionInfo): Promise<string | null> {
  switch (targetBranch) {
    case 'alpha': {
      // Alpha 需要比较全局最新版本和当前版本
      const globalLatestVersion = await versionManager.getGlobalHighestVersion();
      const currentAlphaVersion = versionInfo.currentTag || VersionUtils.createDefaultVersion('base');
      const mainVersion = await versionManager.getLatestVersion('main');

      // 比较全局版本和当前Alpha的基础版本
      const globalBase = VersionUtils.getBaseVersionString(globalLatestVersion);
      const currentAlphaBase = VersionUtils.getBaseVersionString(currentAlphaVersion);
      const mainBase = mainVersion ? VersionUtils.getBaseVersionString(mainVersion) : '0.0.0';

      // 🔧 关键修复：检查是否存在版本发布周期问题
      // 如果当前Alpha的基础版本已经有对应的正式版发布，应该推进到下一个版本
      if (mainVersion && semver.gte(mainBase, currentAlphaBase)) {
        // 情况1：正式版已发布当前或更高版本，Alpha应该推进到下一个版本周期
        const nextVersionBase = semver.inc(mainBase, 'patch'); // 基于已发布版本推进
        const nextVersion = VersionUtils.addVersionPrefix(nextVersionBase || '0.0.1');
        logger.info(`🔄 检测到正式版 ${mainVersion} 已发布，Alpha推进到下一版本周期: ${nextVersion}`);
        return nextVersion;
      } else if (semver.gt(globalBase, currentAlphaBase)) {
        // 情况2：全局版本更高，使用全局版本
        logger.info(`Alpha版本落后，从全局版本 ${globalLatestVersion} 开始升级`);
        return globalLatestVersion;
      } else {
        // 情况3：Alpha版本领先，继续当前版本的开发
        logger.info(`Alpha版本领先，从当前版本 ${currentAlphaVersion} 继续升级`);
        return currentAlphaVersion;
      }
    }

    case 'beta': {
      // Beta 基于 Alpha 的最新版本进行升级
      const alphaVersion = await versionManager.getLatestVersion('alpha');
      return alphaVersion || VersionUtils.createDefaultVersion('base');
    }

    case 'main': {
      // Main 基于 Beta 的最新版本去掉prerelease标识
      const betaVersion = await versionManager.getLatestVersion('beta');
      return betaVersion || VersionUtils.createDefaultVersion('base');
    }

    default:
      return null;
  }
}

/**
 * 统一的版本升级计算逻辑 - 使用策略模式
 */
async function calculateVersionUpgrade(
  baseVersion: string,
  targetBranch: SupportedBranch,
  releaseType: ReleaseType | '',
  sourceBranch?: string,
): Promise<string | null> {
  // 创建升级上下文
  const context = createUpgradeContext(baseVersion, targetBranch, releaseType, sourceBranch);
  if (!context) {
    logger.error(`无法解析基础版本: ${baseVersion}`);
    return null;
  }

  // 使用策略管理器执行升级
  const newVersion = await upgradeManager.upgrade(context);
  return newVersion ? VersionUtils.addVersionPrefix(newVersion) : null;
}

/**
 * 版本计算结果
 */
export interface VersionCalculationResult {
  newVersion: string | null;
  actualBaseVersion: string | null; // 实际使用的基础版本（用于显示当前版本）
}

/**
 * 计算新版本号 - 统一版本升级逻辑
 */
export async function calculateNewVersion(
  targetBranch: SupportedBranch,
  versionInfo: VersionInfo,
  releaseType: ReleaseType | '',
  sourceBranch?: string,
): Promise<VersionCalculationResult> {
  try {
    // 获取上游分支的版本作为基础版本
    const baseVersion = await getBaseVersion(targetBranch, versionInfo);
    if (!baseVersion) {
      logger.error(`❌ 无法获取 ${targetBranch} 分支的基础版本`);
      return { newVersion: null, actualBaseVersion: null };
    }

    logger.info(`📌 ${targetBranch} 分支基础版本: ${baseVersion}`);
    if (sourceBranch) {
      logger.info(`📌 源分支: ${sourceBranch}`);
    }

    // 检查是否触发修复策略
    let actualBaseVersion = baseVersion;
    
    // 对于beta分支的非alpha源修复
    if (targetBranch === 'beta' && sourceBranch && !sourceBranch.includes('alpha')) {
      const currentBetaVersion = await versionManager.getLatestVersion('beta');
      if (currentBetaVersion) {
        actualBaseVersion = currentBetaVersion;
        logger.info(`🔧 Beta修复场景，实际基础版本: ${actualBaseVersion}`);
      }
    }
    
    // 对于main分支的非beta源修复
    if (targetBranch === 'main' && sourceBranch && !sourceBranch.includes('beta')) {
      const currentMainVersion = await versionManager.getLatestVersion('main');
      if (currentMainVersion) {
        actualBaseVersion = currentMainVersion;
        logger.info(`🔧 Main修复场景，实际基础版本: ${actualBaseVersion}`);
      }
    }

    // 统一的版本升级逻辑
    const result = await calculateVersionUpgrade(baseVersion, targetBranch, releaseType, sourceBranch);

    if (result) {
      logger.info(`🎯 计算出新版本: ${result}`);
    } else {
      logger.info(`⏭️ 无需版本升级`);
    }

    return { newVersion: result, actualBaseVersion };
  } catch (error) {
    throw new ActionError(`版本计算失败: ${error}`, 'calculateNewVersion', error);
  }
}

// ==================== 版本文件操作 ====================

/**
 * 安全地更新版本文件
 */
export async function updatePackageVersion(version: string): Promise<void> {
  try {
    const packageVersion = VersionUtils.cleanVersion(version);
    const pkgPath = await resolvePackageJSON();
    const pkgInfo = await readPackageJSON(pkgPath);
    pkgInfo.version = packageVersion;
    await writePackageJSON(pkgPath, pkgInfo);
    logger.info(`版本文件已更新到: ${packageVersion}`);
  } catch (error) {
    throw new ActionError(`更新版本文件失败: ${error}`, 'updatePackageVersion', error);
  }
}
