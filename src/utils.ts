import * as fs from 'node:fs';
import { exec } from '@actions/exec';
import { GIT_USER_CONFIG, SUPPORTED_BRANCHES, VERSION_PREFIX_CONFIG } from './constants';
import { logger } from './core';
import type { SupportedBranch } from './types';

// ==================== 版本处理工具函数 ====================

/**
 * 版本解析结果接口
 */
export interface VersionParseResult {
  /** 原始版本号 */
  original: string;
  /** 用于 package.json 的纯净版本号 (semver 格式，无前缀) */
  pkgVersion: string;
  /** 用于 git tag/发布的目标版本号 (带当前前缀) */
  targetVersion: string;
  /** 当前使用的前缀 */
  prefix: string;
  /** 版本是否有任何前缀 */
  hasPrefix: boolean;
  /** 版本是否有当前配置的前缀 */
  hasCurrentPrefix: boolean;
}

// 版本解析缓存 - 避免重复计算相同版本号
const versionParseCache = new Map<string, VersionParseResult>();

/**
 * 解析版本号 - 一次性获取所有版本信息，避免重复计算
 * 使用缓存机制提升性能，避免重复解析相同版本号
 */
export function versionParse(version: string): VersionParseResult {
  // 检查缓存
  const cached = versionParseCache.get(version);
  if (cached) {
    return cached;
  }

  const prefix = VERSION_PREFIX_CONFIG.CURRENT;
  const supportedPrefixes = VERSION_PREFIX_CONFIG.SUPPORTED;

  // 检查是否有当前前缀
  const hasCurrentPrefix = version.startsWith(prefix);

  let clean: string;

  if (hasCurrentPrefix) {
    // 如果有当前前缀，直接去除
    clean = version.slice(prefix.length);
  } else {
    // 检查其他支持的前缀
    let foundPrefix = false;
    let extractedClean = '';
    for (let i = 0; i < supportedPrefixes.length; i++) {
      const supportedPrefix = supportedPrefixes[i];
      if (version.startsWith(supportedPrefix)) {
        extractedClean = version.slice(supportedPrefix.length);
        foundPrefix = true;
        break;
      }
    }

    // 如果没有找到任何前缀，直接使用原版本
    clean = foundPrefix ? extractedClean : version;
  }

  const result: VersionParseResult = {
    original: version,
    pkgVersion: clean,
    targetVersion: `${prefix}${clean}`,
    prefix,
    hasPrefix: version !== clean, // 任何前缀（包括非当前前缀）
    hasCurrentPrefix,
  };

  // 存入缓存
  versionParseCache.set(version, result);

  return result;
}

/**
 * 获取版本解析缓存统计信息
 */
export function getVersionParseCacheStats(): { size: number; hitRate: number } {
  return {
    size: versionParseCache.size,
    hitRate: 0, // 可以后续扩展统计命中率
  };
}

/**
 * 清理版本解析缓存
 */
export function clearVersionParseCache(): void {
  versionParseCache.clear();
}

/**
 * 获取版本前缀
 */
export function getVersionPrefix(): string {
  return VERSION_PREFIX_CONFIG.CURRENT;
}

/**
 * 移除版本号前缀，支持多种前缀格式
 */
export function cleanVersion(version: string): string {
  return versionParse(version).pkgVersion;
}

/**
 * 添加版本前缀
 */
export function addVersionPrefix(version: string): string {
  return versionParse(version).targetVersion;
}

/**
 * 标准化版本号（确保使用正确的前缀）
 */
export function normalizeVersion(version: string): string {
  return versionParse(version).targetVersion;
}

/**
 * 检查版本是否有当前配置的前缀
 */
export function hasVersionPrefix(version: string): boolean {
  return versionParse(version).hasCurrentPrefix;
}

// ==================== Git 工具函数 ====================

/**
 * Git 错误处理函数
 */
function handleGitError(error: unknown, context: string, shouldThrow = false): void {
  const message = `${context}: ${error}`;
  logger.error(message);
  if (shouldThrow) {
    throw new ActionError(message, context, error);
  }
}

/**
 * 执行 git 命令并返回输出
 */
export async function execGitWithOutput(args: string[]): Promise<string> {
  let stdout = '';
  try {
    await exec('git', args, {
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
      },
    });
    return stdout.trim();
  } catch (error) {
    handleGitError(error, `执行 git ${args.join(' ')}`, true);
    return '';
  }
}

/**
 * 执行 git 命令（无输出捕获）
 */
export async function execGit(args: string[]): Promise<void> {
  try {
    await exec('git', args);
  } catch (error) {
    handleGitError(error, `执行 git ${args.join(' ')}`, true);
  }
}

/**
 * 检查文件是否有未提交的更改
 */
export async function hasFileChanges(filepath: string): Promise<boolean> {
  try {
    // 检查文件是否存在 - 使用 Node.js fs 模块更可靠
    if (!fs.existsSync(filepath)) {
      return false;
    }

    // 检查是否有变化
    const statusOutput = await execGitWithOutput(['status', '--porcelain', filepath]);
    if (statusOutput.length > 0) {
      logger.info(`检测到 ${filepath} 变化: ${statusOutput}`);
      return true;
    }

    // 检查已跟踪文件的变化
    try {
      await exec('git', ['diff', '--exit-code', filepath]);
      return false;
    } catch {
      return true;
    }
  } catch (error) {
    handleGitError(error, `检查 ${filepath} 变化状态`, false);
    return false;
  }
}

/**
 * 提交并推送单个文件
 */
export async function commitAndPushFile(
  filepath: string,
  commitMessage: string,
  targetBranch: SupportedBranch,
): Promise<void> {
  try {
    const changed = await hasFileChanges(filepath);
    if (!changed) {
      logger.info(`${filepath} 无变化，跳过提交和推送`);
      return;
    }
    await execGit(['config', 'user.name', GIT_USER_CONFIG.NAME]);
    await execGit(['config', 'user.email', GIT_USER_CONFIG.EMAIL]);
    await execGit(['add', filepath]);
    await execGit(['commit', '-m', commitMessage]);
    await execGit(['push', 'origin', `HEAD:refs/heads/${targetBranch}`]);
    logger.info(`${filepath} 更新已提交并推送`);
  } catch (error) {
    handleGitError(error, `提交和推送 ${filepath}`, true);
  }
}

// ==================== 错误处理类 ====================

/**
 * Action 自定义错误类
 */
export class ActionError extends Error {
  readonly context: string;
  readonly originalError?: unknown;

  constructor(message: string, context: string, originalError?: unknown) {
    super(message);
    this.name = 'ActionError';
    this.context = context;
    this.originalError = originalError;
  }
}

// ==================== 类型守卫函数 ====================

/**
 * 检查是否为支持的分支
 */
export function isSupportedBranch(branch: string): branch is SupportedBranch {
  return SUPPORTED_BRANCHES.includes(branch);
}
