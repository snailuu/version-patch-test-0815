import type { getOctokit } from '@actions/github';
import type { ReleaseType } from 'semver';
import core from './core';

// ==================== 基础类型定义 ====================

export const SUPPORTED_BRANCHES = core
  .getInput('supported-branches')
  ?.split(',')
  .map((b) => b.trim()) || ['main', 'beta', 'alpha'];
export type SupportedBranch = 'main' | 'beta' | 'alpha';

export type PRData = Awaited<ReturnType<ReturnType<typeof getOctokit>['rest']['pulls']['get']>>['data'];

export interface VersionInfo {
  current: string;
  beta: string;
  currentTag: string | null;
  betaTag: string | null;
}

export interface EventInfo {
  targetBranch: SupportedBranch;
  isDryRun: boolean;
  pr: PRData | null;
}

export interface VersionPreviewData {
  sourceBranch: string;
  targetBranch: string;
  currentVersion?: string;
  nextVersion: string;
}

// ==================== 配置常量 ====================

/** 版本前缀配置 */
export const VERSION_PREFIX_CONFIG = {
  /** 默认版本前缀 */
  default: 'v',
  /** 自定义前缀（可通过action输入覆盖） */
  custom: core.getInput('version-prefix') || 'v',
  /** 支持的前缀列表（用于兼容性处理） */
  supported: ['v', 'version-', 'ver-', 'rel-'],
} as const;

/** Git 用户配置 */
export const GIT_USER_CONFIG = {
  name: core.getInput('git-user-name') || 'GitHub Action',
  email: core.getInput('git-user-email') || 'action@github.com',
} as const;

/** 评论配置 */
export const COMMENT_CONFIG = {
  /** 评论标题（可通过action输入覆盖） */
  title: core.getInput('comment-title') || '📦 版本管理',
} as const;

/** 默认版本号 */
export const DEFAULT_VERSIONS = {
  base: '0.0.0',
  beta: '0.0.0-beta.0',
  alpha: '0.0.0-alpha.0',
} as const;

// ==================== 消息模板 ====================

/** 评论模板 */
export const COMMENT_TEMPLATES = {
  /** 版本管理评论模板 */
  VERSION_PREVIEW: (data: VersionPreviewData) => `## ${COMMENT_CONFIG.title}

| 项目 | 值 |
|------|-----|
| **源分支** | \`${data.sourceBranch}\` |
| **目标分支** | \`${data.targetBranch}\` |
| **当前版本** | \`${data.currentVersion || '无'}\` |
| **下一版本** | \`${data.nextVersion}\` |

> ℹ️ 这是预览模式，合并 PR 后将自动创建 tag 并更新版本。`,

  /** 错误评论模板 */
  ERROR: (errorMessage: string) => `## ${COMMENT_CONFIG.title}

❌ **错误信息**

${errorMessage}

> 请确保在创建新功能之前，所有已有功能都已完成完整的发布流程（alpha → beta → main）。`,

  /** 版本跳过模板 */
  VERSION_SKIP: (targetBranch: string, baseVersion: string | null) => `## ${COMMENT_CONFIG.title}

| 项目 | 值 |
|------|-----|
| **目标分支** | \`${targetBranch}\` |
| **当前版本** | \`${baseVersion || '无'}\` |
| **状态** | \`跳过 - 无需升级\` |

> ℹ️ 根据当前分支状态和标签，无需进行版本升级。`,
} as const;

/** 错误消息 */
export const ERROR_MESSAGES = {
  UNSUPPORTED_BRANCH: (branch: string) => `不支持的分支: ${branch}，跳过版本管理`,
  UNSUPPORTED_EVENT: (eventName: string) => `不支持的事件类型: ${eventName}`,
  INVALID_VERSION: (version: string) => `无效的版本号: ${version}`,
  MERGE_CONFLICT: (sourceBranch: string, targetBranch: string) =>
    `无法自动解决 ${sourceBranch} -> ${targetBranch} 的合并冲突，已创建issue需要人工介入`,
} as const;

/** 提交消息模板 */
export const COMMIT_TEMPLATES = {
  VERSION_BUMP: (version: string, branch: string) => `chore: bump version to ${version} for ${branch}`,
  SYNC_BETA_TO_ALPHA: (version: string) => `chore: sync beta v${version} to alpha [skip ci]`,
  SYNC_MAIN_TO_BETA: (version: string) => `chore: sync main v${version} to beta [skip ci]`,
  FORCE_SYNC: (version: string) => `chore: force sync from main v${version} [skip ci]`,
  CHANGELOG_UPDATE: (version: string) => `docs: update CHANGELOG for ${version}`,
} as const;

// ==================== 工具函数类型 ====================

export interface VersionSummary {
  original: string;
  normalized: string;
  clean: string;
  hasPrefix: boolean;
  isValid: boolean;
  prefix: string;
}

export interface BranchSyncResult {
  success: boolean;
  conflicts?: string[];
  version?: string;
  error?: string;
}

// ==================== 常用类型守卫 ====================

export function isSupportedBranch(branch: string): branch is SupportedBranch {
  return SUPPORTED_BRANCHES.includes(branch);
}

export function isValidReleaseType(type: string): type is ReleaseType {
  return ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'].includes(type);
}

// ==================== 错误处理类型 ====================

export class ActionError extends Error {
  constructor(
    message: string,
    public readonly context: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

export interface ErrorContext {
  operation: string;
  branch?: string;
  version?: string;
  pr?: number;
}
