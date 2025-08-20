import { context, getOctokit } from '@actions/github';
import type { ReleaseType } from 'semver';
import core, { logger } from './core';
import { ActionError, COMMENT_TEMPLATES, type PRData, type VersionPreviewData } from './types';

// ==================== GitHub API 客户端 ====================

/** 初始化 GitHub API 客户端 */
const octokit = getOctokit(core.getInput('token', { required: true }));

// ==================== PR 工具类 ====================

/**
 * PR 工具类 - 统一 PR 相关操作
 */
export class PRUtils {
  /**
   * 获取当前 PR 号
   */
  static getCurrentPRNumber(pr: PRData | null): number | null {
    return pr?.number || context.payload.pull_request?.number || null;
  }

  /**
   * 从 PR 标签获取发布类型
   */
  static getReleaseTypeFromLabels(labels: { name: string }[] = []): ReleaseType | '' {
    const labelNames = labels.map((label) => label.name);

    // 按优先级顺序检查标签（major > minor > patch）
    let tempReleaseType = '' as ReleaseType;

    if (labelNames.includes('major')) {
      tempReleaseType = 'premajor';
      logger.info('检测到 major 标签，使用 premajor 发布类型');
    } else if (labelNames.includes('minor')) {
      tempReleaseType = 'preminor';
      logger.info('检测到 minor 标签，使用 preminor 发布类型');
    } else if (labelNames.includes('patch')) {
      tempReleaseType = 'prepatch';
      logger.info('检测到 patch 标签，使用 prepatch 发布类型');
    }

    // 如果有多个标签，记录所有检测到的标签
    const versionLabels = labelNames.filter((name) => ['major', 'minor', 'patch'].includes(name));
    if (versionLabels.length > 1) {
      logger.info(`检测到多个版本标签: ${versionLabels.join(', ')}，使用最高优先级: ${tempReleaseType}`);
    }

    return tempReleaseType;
  }

  /**
   * 验证PR标签的有效性
   */
  static validatePRLabels(labels: { name: string }[] = []): { isValid: boolean; errors: string[] } {
    const versionLabels = labels.filter((label) => ['major', 'minor', 'patch'].includes(label.name));
    const errors: string[] = [];

    if (versionLabels.length > 1) {
      errors.push(`检测到多个版本标签: ${versionLabels.map((l) => l.name).join(', ')}，请只保留一个`);
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}

// ==================== PR 信息获取 ====================

/**
 * 获取最近合并到目标分支的 PR 信息
 * @deprecated 不再使用，已改为智能推断版本升级类型
 * 
 * 之前在 push 事件中使用，用于获取 PR 标签
 * 现在统一使用智能推断逻辑，简化流程
 */
export async function getRecentMergedPR(targetBranch: string): Promise<PRData | null> {
  logger.info('⚠️ getRecentMergedPR 已弃用，现在使用智能推断逻辑');
  return null;
}

/**
 * 获取当前 Pull Request 信息
 */
export async function getCurrentPR(): Promise<PRData | null> {
  if (!context.payload.pull_request) {
    return null;
  }

  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
    });
    return pr;
  } catch (error) {
    logger.warning(`获取当前 PR 失败: ${error}`);
    return null;
  }
}

// ==================== PR 评论管理 ====================

/**
 * 创建或更新 PR 评论
 */
export async function updatePRComment(prNumber: number, commentBody: string, identifier: string): Promise<void> {
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
    });

    const existingComment = comments.find(
      (comment) => comment.user?.type === 'Bot' && comment.body?.includes(identifier),
    );

    if (existingComment) {
      await octokit.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: existingComment.id,
        body: commentBody,
      });
      logger.info(`已更新 PR #${prNumber} 的评论`);
    } else {
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        body: commentBody,
      });
      logger.info(`已在 PR #${prNumber} 创建评论`);
    }
  } catch (error) {
    logger.warning(`更新 PR 评论失败: ${error}`);
  }
}

/**
 * 创建版本预览评论
 */
export async function createVersionPreviewComment(prNumber: number, data: VersionPreviewData): Promise<void> {
  try {
    const commentBody = COMMENT_TEMPLATES.VERSION_PREVIEW(data);
    await updatePRComment(prNumber, commentBody, '## 📦 版本预览');
  } catch (error) {
    throw new ActionError(`创建版本预览评论失败: ${error}`, 'createVersionPreviewComment', error);
  }
}

/**
 * 创建版本跳过评论
 */
export async function createVersionSkipComment(
  prNumber: number,
  targetBranch: string,
  baseVersion: string | null,
): Promise<void> {
  try {
    const commentBody = COMMENT_TEMPLATES.VERSION_SKIP(targetBranch, baseVersion);
    await updatePRComment(prNumber, commentBody, '## ⏭️ 版本管理跳过');
  } catch (error) {
    throw new ActionError(`创建版本跳过评论失败: ${error}`, 'createVersionSkipComment', error);
  }
}

/**
 * 创建错误评论
 */
export async function createErrorComment(prNumber: number, errorMessage: string): Promise<void> {
  try {
    const commentBody = COMMENT_TEMPLATES.ERROR(errorMessage);
    await updatePRComment(prNumber, commentBody, '## ❌ 版本管理错误');
  } catch (error) {
    logger.warning(`创建错误评论失败: ${error}`);
  }
}

// ==================== PR 处理逻辑 ====================

/**
 * 处理预览模式逻辑
 */
export async function handlePreviewMode(
  pr: PRData | null,
  targetBranch: string,
  baseVersion: string | null,
  newVersion: string | null,
  releaseType: ReleaseType | '',
): Promise<void> {
  const prNumber = PRUtils.getCurrentPRNumber(pr);
  if (!prNumber) {
    logger.warning('无法获取 PR 号，跳过评论更新');
    return;
  }

  try {
    // 验证PR标签
    if (pr?.labels) {
      const validation = PRUtils.validatePRLabels(pr.labels);
      if (!validation.isValid) {
        await createErrorComment(prNumber, validation.errors.join('\\n'));
        return;
      }
    }

    if (!newVersion) {
      // 显示跳过信息
      await createVersionSkipComment(prNumber, targetBranch, baseVersion);
    } else {
      // 显示版本预览
      await createVersionPreviewComment(prNumber, {
        targetBranch,
        currentVersion: baseVersion || undefined,
        nextVersion: newVersion,
        releaseType,
      });
    }
  } catch (error) {
    logger.error(`预览模式处理失败: ${error}`);
    // 尝试创建错误评论
    try {
      await createErrorComment(prNumber, `预览处理失败: ${error}`);
    } catch (commentError) {
      logger.error(`创建错误评论也失败了: ${commentError}`);
    }
  }
}

// ==================== 事件信息处理 ====================

/**
 * 验证分支是否受支持
 */
function validateBranch(branch: string): boolean {
  const supportedBranches = ['main', 'beta', 'alpha'];
  return supportedBranches.includes(branch);
}

/**
 * 获取事件信息和目标分支
 */
export async function getEventInfo(): Promise<{
  targetBranch: string;
  isDryRun: boolean;
  pr: PRData | null;
} | null> {
  try {
    let targetBranch = context.ref.split('/').pop()!;
    const isDryRun = context.eventName === 'pull_request';
    let pr: PRData | null = null;

    // 获取 PR 信息
    if (context.payload.pull_request) {
      pr = await getCurrentPR();
      if (!pr || !pr.base) {
        logger.error('无法获取有效的 PR 信息');
        return null;
      }
      targetBranch = pr.base.ref || context.payload.pull_request.base.ref;
      logger.info(`PR 事件 (预览模式)，目标分支为: ${targetBranch}`);
    } else if (context.eventName === 'push') {
      // Push事件：PR已经合并，不需要查找PR信息，使用智能推断
      pr = null;
      logger.info(`Push 事件 (执行模式)，目标分支为: ${targetBranch}`);
    } else {
      logger.info(`不支持的事件类型: ${context.eventName}`);
      return null;
    }

    // 检查分支支持
    if (!validateBranch(targetBranch)) {
      logger.info(`不支持的分支: ${targetBranch}，跳过版本管理`);
      return null;
    }

    return { targetBranch, isDryRun, pr };
  } catch (error) {
    throw new ActionError(`获取事件信息失败: ${error}`, 'getEventInfo', error);
  }
}
