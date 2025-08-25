import { context, getOctokit } from '@actions/github';
import type { ReleaseType } from 'semver';
import core, { logger } from './core';
import { ActionError, COMMENT_CONFIG, COMMENT_TEMPLATES, type PRData, type VersionPreviewData } from './types';

// ==================== GitHub API 客户端 ====================

/** 初始化 GitHub API 客户端 */
const octokit = getOctokit(core.getInput('token', { required: true }));

// ==================== PR 工具类 ====================

/**
 * PR 工具类 - 统一 PR 相关操作
 */
export class PRUtils {
  /**
   * 获取当前 PR 号（优先使用payload数据）
   */
  static getCurrentPRNumber(pr: PRData | null): number | null {
    return context.payload.pull_request?.number || pr?.number || null;
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

    return tempReleaseType;
  }
}

// ==================== PR 信息获取 ====================

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
 * 创建版本管理评论
 */
export async function createVersionPreviewComment(prNumber: number, data: VersionPreviewData): Promise<void> {
  try {
    const commentBody = COMMENT_TEMPLATES.VERSION_PREVIEW(data);
    await updatePRComment(prNumber, commentBody, `## ${COMMENT_CONFIG.title}`);
  } catch (error) {
    throw new ActionError(`创建版本管理评论失败: ${error}`, 'createVersionPreviewComment', error);
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
    await updatePRComment(prNumber, commentBody, `## ${COMMENT_CONFIG.title}`);
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
    await updatePRComment(prNumber, commentBody, `## ${COMMENT_CONFIG.title}`);
  } catch (error) {
    logger.warning(`创建错误评论失败: ${error}`);
  }
}

/**
 * 严格策略：确定版本升级类型 - 只基于PR标签，无智能推断
 * 要求：必须有明确的版本标签（major/minor/patch）才进行版本升级
 */
export async function determineReleaseType(pr: PRData | null, targetBranch: string): Promise<ReleaseType | ''> {
  logger.info(`🔍 开始确定版本升级类型 (PR: ${pr ? `#${pr.number}` : '无'}, 分支: ${targetBranch})`);

  // 🎯 严格要求：只基于PR标签进行版本升级
  if (pr?.labels && pr.labels.length > 0) {
    const labelReleaseType = PRUtils.getReleaseTypeFromLabels(pr.labels);
    if (labelReleaseType) {
      logger.info(`✅ 使用PR标签: ${labelReleaseType} (来源: PR #${pr.number})`);
      return labelReleaseType;
    } else {
      const labelNames = pr.labels.map((l) => l.name).join(', ');
      logger.info(`📝 PR #${pr.number} 有标签但无版本标签: [${labelNames}]，跳过版本升级`);
    }
  } else if (pr) {
    logger.info(`📝 PR #${pr.number} 没有标签，跳过版本升级`);
  } else {
    logger.info(`📝 无PR信息，跳过版本升级`);
  }

  // 🚫 移除智能推断：严格要求明确的版本标签
  logger.info(`❌ 未检测到明确的版本标签 (major/minor/patch)，跳过版本升级`);
  return '';
}

/**
 * 处理预览模式逻辑
 */
export async function handlePreviewMode(
  pr: PRData | null,
  sourceBranch: string,
  targetBranch: string,
  baseVersion: string | null,
  newVersion: string | null,
): Promise<void> {
  const prNumber = PRUtils.getCurrentPRNumber(pr);
  if (!prNumber) {
    logger.warning('无法获取 PR 号，跳过评论更新');
    return;
  }

  try {
    if (!newVersion) {
      await createVersionSkipComment(prNumber, targetBranch, baseVersion);
    } else {
      // 显示版本管理
      await createVersionPreviewComment(prNumber, {
        sourceBranch,
        targetBranch,
        currentVersion: baseVersion || undefined,
        nextVersion: newVersion,
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
