import { exec } from '@actions/exec';
import { readPackageJSON, resolvePackageJSON, writePackageJSON } from 'pkg-types';
import semver, { type ReleaseType } from 'semver';
import { logger } from './core';
import { createErrorComment, PRUtils } from './pr';
import {
  ActionError,
  DEFAULT_VERSIONS,
  type PRData,
  type SupportedBranch,
  VERSION_PREFIX_CONFIG,
  type VersionInfo,
  type VersionSummary,
} from './types';

// ==================== 错误处理辅助函数 ====================

/**
 * 抛出错误并创建PR评论（如果有PR）
 */
async function throwErrorWithComment(
  errorMsg: string,
  context: string,
  pr: PRData | null = null,
  originalError?: unknown,
): Promise<never> {
  // 尝试创建PR评论
  if (pr) {
    const prNumber = PRUtils.getCurrentPRNumber(pr);
    if (prNumber) {
      try {
        await createErrorComment(prNumber, errorMsg);
        logger.info(`已在 PR #${prNumber} 创建错误评论`);
      } catch (commentError) {
        logger.warning(`创建PR错误评论失败: ${commentError}`);
      }
    }
  }

  // 抛出原始错误
  throw new ActionError(errorMsg, context, originalError);
}

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
   * 安全解析版本号（处理不规范的prerelease格式）
   */
  static parseVersion(version: string): semver.SemVer | null {
    let cleanVersion = VersionUtils.cleanVersion(version);

    // 修复不规范的prerelease格式（如 1.0.0-0-alpha.0 -> 1.0.0-alpha.0）
    cleanVersion = cleanVersion.replace(/-0-(alpha|beta)\./, '-$1.');

    return semver.parse(cleanVersion);
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
   * 一次性获取所有版本标签（按时间倒序排列）
   */
  private async getAllTags(): Promise<string[]> {
    const prefix = VersionUtils.getVersionPrefix();
    // 使用 --sort=-creatordate 按创建时间倒序排列，最新的tag在前面
    const stdout = await execGitWithOutput(['tag', '-l', `${prefix}*`, '--sort=-creatordate']);
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
   * 解析 beta/alpha 分支版本
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
   * 获取最新的tag（按创建时间）
   */
  async getLatestTag(): Promise<string | null> {
    const allTags = await this.getAllTags();
    return allTags.length > 0 ? allTags[0] : null;
  }

  /**
   * 检查tag的类型
   */
  getTagType(tag: string): 'release' | 'beta' | 'alpha' | 'unknown' {
    if (!tag) return 'unknown';

    if (tag.includes('-alpha.')) return 'alpha';
    if (tag.includes('-beta.')) return 'beta';
    if (!tag.includes('-')) return 'release';
    return 'unknown';
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

// ==================== 版本状态验证 ====================

/**
 * 验证目标分支是否允许进行版本升级（基于最新tag状态）
 */
async function validateBranchVersionState(targetBranch: SupportedBranch, pr: PRData | null = null): Promise<void> {
  const latestTag = await versionManager.getLatestTag();

  if (!latestTag) {
    // 没有任何tag，允许任何分支开始
    logger.info(`📋 项目无版本标签，允许 ${targetBranch} 分支开始开发`);
    return;
  }

  const latestTagType = versionManager.getTagType(latestTag);
  logger.info(`📋 最新版本标签: ${latestTag} (类型: ${latestTagType})`);

  // 基于最新tag类型和目标分支检查是否允许
  switch (targetBranch) {
    case 'alpha':
      // Alpha分支：只接受来自正式版本或Alpha版本
      if (latestTagType !== 'release' && latestTagType !== 'alpha') {
        const errorMsg = `Alpha分支只能在正式版本或Alpha版本后继续开发，当前最新版本: ${latestTag} (${latestTagType})`;
        logger.error(`❌ ${errorMsg}`);
        await throwErrorWithComment(errorMsg, 'validateBranchVersionState', pr);
      }
      break;

    case 'beta':
      // Beta分支：只接受来自Alpha版本或Beta版本
      if (latestTagType !== 'alpha' && latestTagType !== 'beta') {
        const errorMsg = `Beta分支只能在Alpha版本或Beta版本后继续开发，当前最新版本: ${latestTag} (${latestTagType})`;
        logger.error(`❌ ${errorMsg}`);
        await throwErrorWithComment(errorMsg, 'validateBranchVersionState', pr);
      }
      break;

    case 'main':
      // Main分支：只接受来自Beta版本
      if (latestTagType !== 'beta') {
        const errorMsg = `Main分支只能在Beta测试完成后发布，当前最新版本: ${latestTag} (${latestTagType})`;
        logger.error(`❌ ${errorMsg}`);
        await throwErrorWithComment(errorMsg, 'validateBranchVersionState', pr);
      }
      break;
  }

  logger.info(`✅ ${targetBranch} 分支允许在当前版本状态 (${latestTagType}) 下进行开发`);
}

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
  sourceBranch: string;
  currentBranchType: string;
  parsed: semver.SemVer;
  pr: PRData | null;
}

/**
 * 创建版本升级上下文
 */
function createUpgradeContext(
  baseVersion: string,
  targetBranch: SupportedBranch,
  sourceBranch: string,
  pr: PRData | null,
): VersionUpgradeContext | null {
  const parsed = VersionUtils.parseVersion(baseVersion);
  if (!parsed) return null;

  const isPrerelease = parsed.prerelease && parsed.prerelease.length > 0;
  const currentBranchType = isPrerelease ? (parsed.prerelease[0] as string) : 'release';

  return {
    baseVersion: VersionUtils.cleanVersion(baseVersion),
    targetBranch,
    sourceBranch,
    currentBranchType,
    parsed,
    pr,
  };
}

/**
 * Alpha分支策略 - 基于PR标签处理
 */
class AlphaStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return context.targetBranch === 'alpha';
  }

  async execute(context: VersionUpgradeContext): Promise<string | null> {
    const { pr } = context;

    // 检查PR标签
    if (!pr?.labels || pr.labels.length === 0) {
      logger.info(`📛 Alpha分支无PR标签，跳过版本升级`);
      return null;
    }

    // 从PR标签获取发布类型
    const releaseType = this.getReleaseTypeFromLabels(pr.labels);
    if (!releaseType) {
      const labelNames = pr.labels.map((l) => l.name).join(', ');
      logger.info(`📝 PR #${pr.number} 有标签但无版本标签: [${labelNames}]，跳过版本升级`);
      return null;
    }

    // 🚫 业务规则检查：基于最新tag状态验证是否允许Alpha开发
    await validateBranchVersionState('alpha', pr);

    logger.info(`✅ 使用PR标签: ${releaseType} (来源: PR #${pr.number})`);
    return await this.calculateAlphaVersion(context, releaseType);
  }

  private getReleaseTypeFromLabels(labels: { name: string }[]): ReleaseType | null {
    const labelNames = labels.map((label) => label.name);

    if (labelNames.includes('major')) {
      logger.info('检测到 major 标签，使用 premajor 发布类型');
      return 'premajor';
    } else if (labelNames.includes('minor')) {
      logger.info('检测到 minor 标签，使用 preminor 发布类型');
      return 'preminor';
    } else if (labelNames.includes('patch')) {
      logger.info('检测到 patch 标签，使用 prepatch 发布类型');
      return 'prepatch';
    }

    return null;
  }

  private async calculateAlphaVersion(context: VersionUpgradeContext, releaseType: ReleaseType): Promise<string> {
    const { baseVersion } = context;

    // 获取Main分支的版本作为基础
    const mainVersion = await versionManager.getLatestVersion('main');
    const mainBaseVersion = mainVersion ? VersionUtils.getBaseVersionString(mainVersion) : '0.0.0';

    // 将prerelease类型转换为对应的正式版本类型
    const baseReleaseType: ReleaseType =
      releaseType === 'premajor'
        ? 'major'
        : releaseType === 'preminor'
          ? 'minor'
          : releaseType === 'prepatch'
            ? 'patch'
            : releaseType;

    // 根据标签类型从Main版本推导目标基础版本号
    const targetBaseVersion = semver.inc(mainBaseVersion, baseReleaseType);
    if (!targetBaseVersion) {
      logger.error(`无法根据标签 ${releaseType} 从Main版本 ${mainBaseVersion} 推导目标版本`);
      return baseVersion;
    }

    logger.info(`🏷️ 根据标签 ${releaseType} 从Main版本推导目标版本: ${mainBaseVersion} -> ${targetBaseVersion}`);

    // 获取当前Alpha分支的最新版本
    const currentAlphaVersion = await versionManager.getLatestVersion('alpha');
    const currentAlphaBaseVersion = currentAlphaVersion
      ? VersionUtils.getBaseVersionString(currentAlphaVersion)
      : '0.0.0';

    // 判断Alpha基础号与Main基础号的关系
    if (currentAlphaBaseVersion === mainBaseVersion) {
      // Alpha基础号与Main一致，说明是新功能进入Alpha测试，直接使用目标版本
      const newAlphaVersion = `${targetBaseVersion}-alpha.0`;
      logger.info(`🆕 Alpha基础号与Main一致，创建新功能Alpha版本: ${newAlphaVersion}`);
      return newAlphaVersion;
    } else {
      // Alpha基础号与Main不一致，说明已有新功能在Alpha测试
      // 比较 main+label 和当前 alpha 版本，取版本号高的

      if (semver.gt(targetBaseVersion, currentAlphaBaseVersion)) {
        // main+label 版本更高，修改基础号并重置测试号
        const newAlphaVersion = `${targetBaseVersion}-alpha.0`;
        logger.info(
          `🔼 目标版本高于当前Alpha基础版本 (${targetBaseVersion} > ${currentAlphaBaseVersion})，重置版本线: ${newAlphaVersion}`,
        );
        return newAlphaVersion;
      } else {
        // main+label 版本不高于当前alpha，增加测试号计数
        const incrementedVersion = semver.inc(currentAlphaVersion!, 'prerelease', 'alpha');
        logger.info(
          `🔄 目标版本不高于当前Alpha基础版本 (${targetBaseVersion} <= ${currentAlphaBaseVersion})，递增测试号: ${incrementedVersion}`,
        );
        return incrementedVersion || currentAlphaVersion!;
      }
    }
  }

  description = 'Alpha分支基于PR标签处理版本升级';
}

/**
 * Beta分支策略 - 基于源分支判断处理方式
 */
class BetaStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return context.targetBranch === 'beta';
  }

  async execute(context: VersionUpgradeContext): Promise<string | null> {
    const { sourceBranch, baseVersion, pr } = context;

    // 🚫 业务规则检查：基于最新tag状态验证Beta分支操作
    await validateBranchVersionState('beta', pr);

    if (sourceBranch === 'alpha') {
      // 源分支是Alpha：取Alpha的基础号并重置测试号
      const alphaBaseVersion = VersionUtils.getBaseVersionString(baseVersion);
      const newBetaVersion = `${alphaBaseVersion}-beta.0`;
      logger.info(`🆕 从Alpha创建/升级Beta版本: ${baseVersion} -> ${newBetaVersion}`);
      return newBetaVersion;
    } else {
      // 源分支不是Alpha：递增Beta测试号
      const incrementedVersion = semver.inc(baseVersion, 'prerelease', 'beta');
      logger.info(`🔄 递增Beta测试号: ${baseVersion} -> ${incrementedVersion} (源分支: ${sourceBranch})`);
      return incrementedVersion || baseVersion;
    }
  }

  description = 'Beta分支基于源分支类型处理版本升级';
}

/**
 * Main分支策略 - 只接受Beta分支来源
 */
class MainStrategy implements VersionUpgradeStrategy {
  canHandle(context: VersionUpgradeContext): boolean {
    return context.targetBranch === 'main';
  }

  async execute(context: VersionUpgradeContext): Promise<string | null> {
    const { baseVersion, pr } = context;

    // 🚫 业务规则检查：基于最新tag状态验证Main分支发布
    await validateBranchVersionState('main', pr);

    // 从Beta转换到Main：取Beta的基础号作为正式版本号
    const betaBaseVersion = VersionUtils.getBaseVersionString(baseVersion);

    logger.info(`🚀 从Beta转换为正式版: ${baseVersion} -> ${betaBaseVersion}`);
    return betaBaseVersion;
  }

  description = 'Main分支只接受Beta来源，转换为正式版本';
}

/**
 * 版本升级策略管理器
 */
class VersionUpgradeManager {
  private strategies: VersionUpgradeStrategy[] = [new AlphaStrategy(), new BetaStrategy(), new MainStrategy()];

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

// ==================== 版本升级逻辑 ====================

/**
 * 获取目标分支的基础版本 - 基于源分支和目标分支的完整判断逻辑
 */
export async function getBaseVersion(
  targetBranch: SupportedBranch,
  sourceBranch: string,
  pr: PRData | null = null,
): Promise<string | null> {
  switch (targetBranch) {
    case 'alpha': {
      // Alpha分支：判断源分支类型
      if (sourceBranch === 'beta' || sourceBranch === 'main') {
        const errorMsg = `Alpha分支不接受来自${sourceBranch}分支的合并，Alpha分支只能用于新功能开发`;
        logger.error(`❌ ${errorMsg}`);
        await throwErrorWithComment(errorMsg, 'getBaseVersion-alpha', pr);
      }

      const currentAlphaVersion = await versionManager.getLatestVersion('alpha');
      const mainVersion = await versionManager.getLatestVersion('main');
      const mainBaseVersion = mainVersion ? VersionUtils.getBaseVersionString(mainVersion) : '0.0.0';

      if (!currentAlphaVersion) {
        // 没有Alpha版本，基于Main分支版本开始
        const baseVersion = mainVersion || VersionUtils.createDefaultVersion('base');
        logger.info(`📌 Alpha分支基础版本: ${baseVersion} (无Alpha版本，基于Main版本)`);
        return baseVersion;
      }

      // 比较Alpha基础号和Main版本
      const alphaBaseVersion = VersionUtils.getBaseVersionString(currentAlphaVersion);

      if (alphaBaseVersion === mainBaseVersion) {
        // Alpha基础号与Main一致，说明是新功能要进入Alpha测试
        logger.info(
          `📌 Alpha分支基础版本: ${mainVersion || VersionUtils.createDefaultVersion('base')} (Alpha基础号与Main一致，准备新功能测试)`,
        );
        return mainVersion || VersionUtils.createDefaultVersion('base');
      } else {
        // Alpha基础号与Main不一致，说明已有新功能在Alpha测试
        // 具体的版本计算逻辑（main+label vs current alpha）将在Strategy中处理
        logger.info(`📌 Alpha分支基础版本: ${currentAlphaVersion} (Alpha基础号与Main不一致，已有功能在测试)`);
        return currentAlphaVersion;
      }
    }

    case 'beta': {
      // Beta分支：严格基于源分支判断
      const currentBetaVersion = await versionManager.getLatestVersion('beta');
      const alphaVersion = await versionManager.getLatestVersion('alpha');

      if (sourceBranch === 'alpha') {
        // 源分支是Alpha：新功能进入Beta测试
        if (!alphaVersion) {
          const errorMsg = `从Alpha合并到Beta失败：没有可用的Alpha版本`;
          logger.error(`❌ ${errorMsg}`);
          await throwErrorWithComment(errorMsg, 'getBaseVersion-beta', pr);
        }
        logger.info(`📌 Beta分支基础版本: ${alphaVersion} (源分支Alpha，新功能进入Beta测试)`);
        return alphaVersion;
      } else {
        // 源分支不是Alpha：Beta版本的增量更新
        if (!currentBetaVersion) {
          const errorMsg = `非Alpha分支合并到Beta失败：没有对应的Beta版本，全新功能必须先经过Alpha测试 (源分支: ${sourceBranch})`;
          logger.error(`❌ ${errorMsg}`);
          await throwErrorWithComment(errorMsg, 'getBaseVersion-beta', pr);
        }

        // 检查是否有对应基础号的Alpha版本（确保功能经过了Alpha测试）
        if (alphaVersion) {
          const betaBaseVersion = VersionUtils.getBaseVersionString(currentBetaVersion!);
          const alphaBaseVersion = VersionUtils.getBaseVersionString(alphaVersion);

          if (betaBaseVersion !== alphaBaseVersion) {
            const errorMsg = `Beta版本基础号 (${betaBaseVersion}) 与Alpha版本基础号 (${alphaBaseVersion}) 不匹配，说明该功能未经过完整的Alpha测试流程`;
            logger.error(`❌ ${errorMsg}`);
            await throwErrorWithComment(errorMsg, 'getBaseVersion-beta', pr);
          }
        }

        logger.info(`📌 Beta分支基础版本: ${currentBetaVersion} (非Alpha源分支，递增Beta版本)`);
        return currentBetaVersion;
      }
    }

    case 'main': {
      // Main分支：只接受Beta分支来源
      if (sourceBranch !== 'beta') {
        const errorMsg = `Main分支只接受来自Beta分支的合并，当前源分支: ${sourceBranch}`;
        logger.error(`❌ ${errorMsg}`);
        await throwErrorWithComment(errorMsg, 'getBaseVersion-main', pr);
      }

      const betaVersion = await versionManager.getLatestVersion('beta');
      if (!betaVersion) {
        const errorMsg = `Main分支发布失败：没有可用的Beta版本。Main分支只能用于发布已完成测试的Beta版本`;
        logger.error(`❌ ${errorMsg}`);
        await throwErrorWithComment(errorMsg, 'getBaseVersion-main', pr);
      }

      logger.info(`📌 Main分支基础版本: ${betaVersion} (基于Beta版本)`);
      return betaVersion;
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
  sourceBranch: string,
  pr: PRData | null,
): Promise<string | null> {
  // 创建升级上下文
  const context = createUpgradeContext(baseVersion, targetBranch, sourceBranch, pr);
  if (!context) {
    logger.error(`无法解析基础版本: ${baseVersion}`);
    return null;
  }

  // 使用策略管理器执行升级
  const newVersion = await upgradeManager.upgrade(context);
  return newVersion ? VersionUtils.addVersionPrefix(newVersion) : null;
}

/**
 * 计算新版本号 - 统一版本升级逻辑
 */
export async function calculateNewVersion(
  targetBranch: SupportedBranch,
  sourceBranch: string,
  pr: PRData | null,
): Promise<string | null> {
  try {
    // 获取上游分支的版本作为基础版本
    const baseVersion = await getBaseVersion(targetBranch, sourceBranch, pr);
    if (!baseVersion) {
      logger.error(`❌ 无法获取 ${targetBranch} 分支的基础版本`);
      return null;
    }

    logger.info(`📌 ${targetBranch} 分支基础版本: ${baseVersion}`);

    // 统一的版本升级逻辑
    const result = await calculateVersionUpgrade(baseVersion, targetBranch, sourceBranch, pr);

    if (result) {
      logger.info(`🎯 计算出新版本: ${result}`);
    } else {
      logger.info(`⏭️ 无需版本升级`);
    }

    return result;
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
