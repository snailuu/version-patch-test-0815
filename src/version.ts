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

    logger.info(`📊 版本概览: main=${this.cache.main || '无'}, beta=${this.cache.beta || '无'}, alpha=${this.cache.alpha || '无'}`);
    
    this.isInitialized = true;
  }

  /**
   * 一次性获取所有版本标签
   */
  private async getAllTags(): Promise<string[]> {
    const prefix = VersionUtils.getVersionPrefix();
    const stdout = await execGitWithOutput(['tag', '-l', `${prefix}*`, '--sort=-version:refname']);
    return stdout.split('\n').filter(tag => tag.trim().length > 0);
  }

  /**
   * 解析主分支版本（排除预发布版本）
   */
  private parseMainVersion(tags: string[]): string | null {
    const mainTags = tags.filter(tag => !tag.includes('-'));
    const latest = mainTags[0] || null;
    return latest ? VersionUtils.normalizeVersion(latest) : null;
  }

  /**
   * 解析分支版本
   */
  private parseBranchVersion(tags: string[], branchSuffix: string): string | null {
    const branchTags = tags.filter(tag => tag.includes(`-${branchSuffix}.`));
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

// ==================== 版本计算逻辑 ====================

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

/**
 * 检查是否需要跨分支升级
 */
function needsBranchUpgrade(currentBranchType: string, targetBranch: SupportedBranch): boolean {
  const branchOrder = { alpha: 1, beta: 2, release: 3 };
  const currentOrder = branchOrder[currentBranchType as keyof typeof branchOrder] || 0;
  const targetOrder = branchOrder[targetBranch as keyof typeof branchOrder] || (targetBranch === 'main' ? 3 : 0);

  return targetOrder > currentOrder;
}

/**
 * 获取目标分支的基础版本
 */
export async function getBaseVersion(targetBranch: SupportedBranch, versionInfo: VersionInfo): Promise<string | null> {
  switch (targetBranch) {
    case 'alpha': {
      // Alpha 需要比较全局最新版本和当前版本
      const globalLatestVersion = await versionManager.getGlobalHighestVersion();
      const currentAlphaVersion = versionInfo.currentTag || VersionUtils.createDefaultVersion('base');

      // 比较全局版本和当前Alpha的基础版本
      const globalBase = VersionUtils.getBaseVersionString(globalLatestVersion);
      const currentAlphaBase = VersionUtils.getBaseVersionString(currentAlphaVersion);

      // 检查Main分支是否有正式版本发布
      const mainVersion = await versionManager.getLatestVersion('main');
      const hasMainRelease = mainVersion !== null;

      if (hasMainRelease) {
        // 如果Main分支有正式版本，Alpha应该基于Main版本进行新功能开发
        logger.info(`检测到Main分支正式版本 ${mainVersion}，Alpha将基于此版本进行新功能开发`);
        return mainVersion;
      } else if (semver.gt(globalBase, currentAlphaBase)) {
        // 如果全局版本更高，使用全局版本
        logger.info(`Alpha版本落后，从全局版本 ${globalLatestVersion} 开始升级`);
        return globalLatestVersion;
      } else {
        // 否则使用当前Alpha版本继续递增
        logger.info(`Alpha版本同步，从当前版本 ${currentAlphaVersion} 继续升级`);
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
 * 根据标签计算版本升级
 */
function calculateVersionWithLabel(
  baseVersion: string,
  targetBranch: SupportedBranch,
  releaseType: ReleaseType,
): string | null {
  const parsed = VersionUtils.parseVersion(baseVersion);
  if (!parsed) return null;

  const isPrerelease = parsed.prerelease && parsed.prerelease.length > 0;
  const currentBranchType = isPrerelease ? (parsed.prerelease[0] as string) : 'release';

  // 标签级别优先级
  const labelPriority = { patch: 1, minor: 2, major: 3 };
  const currentPriority = getCurrentVersionPriority(parsed);
  const labelPriority_value = labelPriority[getReleaseLevel(releaseType)];

  logger.info(
    `🔧 版本升级分析: 基础版本=${baseVersion}, 当前优先级=${currentPriority}, 标签优先级=${labelPriority_value}`,
  );

  // 特殊处理：如果基础版本来自不同分支类型，重新开始计数
  if (targetBranch === 'alpha' && currentBranchType !== 'alpha') {
    logger.info(`🔄 检测到基础版本跨分支变化 (${currentBranchType} -> alpha)，重新开始Alpha计数`);
    return semver.inc(baseVersion, releaseType, 'alpha');
  }

  // 如果标签优先级更高，或者需要跨分支升级，执行版本升级
  if (labelPriority_value > currentPriority || needsBranchUpgrade(currentBranchType, targetBranch)) {
    const branchSuffix = targetBranch === 'main' ? undefined : targetBranch;
    return semver.inc(baseVersion, releaseType, branchSuffix);
  } else {
    // 同级别或更低优先级：递增预发布版本
    if (currentBranchType === targetBranch) {
      return semver.inc(baseVersion, 'prerelease', targetBranch);
    } else {
      // 跨分支：重新开始计数
      const branchSuffix = targetBranch === 'main' ? undefined : targetBranch;
      return semver.inc(baseVersion, 'patch', branchSuffix);
    }
  }
}

/**
 * 无标签时的版本升级
 */
function calculateVersionWithoutLabel(baseVersion: string, targetBranch: SupportedBranch): string | null {
  if (targetBranch === 'alpha') {
    return null; // Alpha 必须有标签
  }

  const parsed = VersionUtils.parseVersion(baseVersion);
  if (!parsed) return null;

  // Beta 和 Main 分支根据上游版本自动升级
  if (targetBranch === 'beta') {
    // 从 alpha 版本生成 beta 版本
    const baseVersionStr = VersionUtils.getBaseVersionString(baseVersion);
    return `${baseVersionStr}-beta.0`;
  } else if (targetBranch === 'main') {
    // 从 beta 版本生成正式版本
    return VersionUtils.getBaseVersionString(baseVersion);
  }

  return null;
}

/**
 * 统一的版本升级计算逻辑
 */
function calculateVersionUpgrade(
  baseVersion: string,
  targetBranch: SupportedBranch,
  releaseType: ReleaseType | '',
): string | null {
  const cleanVersion = VersionUtils.cleanVersion(baseVersion);
  const parsed = VersionUtils.parseVersion(baseVersion);

  if (!parsed) {
    logger.error(`无法解析基础版本: ${baseVersion}`);
    return null;
  }

  // Alpha 分支必须有标签才能升级
  if (targetBranch === 'alpha' && !releaseType) {
    logger.info('Alpha 分支没有版本标签，跳过升级');
    return null;
  }

  // 计算新版本
  let newVersion: string | null = null;

  if (releaseType) {
    // 有标签：根据标签和基础版本计算
    newVersion = calculateVersionWithLabel(cleanVersion, targetBranch, releaseType);
  } else {
    // 无标签：Beta和Main分支自动升级
    newVersion = calculateVersionWithoutLabel(cleanVersion, targetBranch);
  }

  return newVersion ? VersionUtils.addVersionPrefix(newVersion) : null;
}

/**
 * 计算新版本号 - 统一版本升级逻辑
 */
export async function calculateNewVersion(
  targetBranch: SupportedBranch,
  versionInfo: VersionInfo,
  releaseType: ReleaseType | '',
): Promise<string | null> {
  try {
    // 获取上游分支的版本作为基础版本
    const baseVersion = await getBaseVersion(targetBranch, versionInfo);
    if (!baseVersion) {
      logger.error(`❌ 无法获取 ${targetBranch} 分支的基础版本`);
      return null;
    }

    logger.info(`📌 ${targetBranch} 分支基础版本: ${baseVersion}`);

    // 统一的版本升级逻辑
    const result = calculateVersionUpgrade(baseVersion, targetBranch, releaseType);
    
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
