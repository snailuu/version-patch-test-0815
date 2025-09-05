import { context, getOctokit } from '@actions/github';
import { COMMENT_CONFIG, COMMENT_TEMPLATES } from './constants';
import { getInput, logger } from './core';
import type { PRData, SupportedBranch, VersionPreviewData } from './types';

// ==================== GitHub API 客户端 ====================

/** 初始化 GitHub API 客户端 */
const octokit = getOctokit(getInput('token', { required: true }));

// ==================== PR 工具函数 ====================

/**
 * 获取当前 PR 号（优先使用 payload 数据）
 */
export function getCurrentPRNumber(pr: PRData | null): number | null {
  return context.payload.pull_request?.number || pr?.number || null;
}

// ==================== PR 信息获取 ====================

// /**
//  * 获取当前 Pull Request 信息
//  */
// export async function getCurrentPR(): Promise<PRData | null> {
//   if (!context.payload.pull_request) {
//     return null;
//   }

//   try {
//     const { data: pr } = await octokit.rest.pulls.get({
//       owner: context.repo.owner,
//       repo: context.repo.repo,
//       pull_number: context.payload.pull_request.number,
//     });
//     return pr;
//   } catch (error) {
//     logger.warning(`获取当前 PR 失败: ${error}`);
//     return null;
//   }
// }

// ==================== PR 评论管理 ====================

/**
 * 创建或更新 PR 评论
 */
export async function updatePRComment(
  prNumber: number,
  commentBody: string,
  identifier = `## ${COMMENT_CONFIG.TITLE}`,
): Promise<void> {
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      // biome-ignore lint/style/useNamingConvention: GitHub API requires this property name
      issue_number: prNumber,
    });

    const existingComment = comments.find(
      (comment) => comment.user?.type === 'Bot' && comment.body?.includes(identifier),
    );

    if (existingComment) {
      await octokit.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        // biome-ignore lint/style/useNamingConvention: GitHub API requires this property name
        comment_id: existingComment.id,
        body: commentBody,
      });
      logger.info(`已更新 PR #${prNumber} 的评论`);
    } else {
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        // biome-ignore lint/style/useNamingConvention: GitHub API requires this property name
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
 * 创建错误评论
 */
export async function createErrorComment(prNumber: number, errorMessage: string): Promise<void> {
  try {
    const commentBody = COMMENT_TEMPLATES.ERROR(errorMessage);
    await updatePRComment(prNumber, commentBody);
  } catch (error) {
    logger.warning(`创建错误评论失败: ${error}`);
  }
}

/**
 * 处理预览模式 - 在 PR 中显示版本预览信息
 */
export async function handlePreviewMode(
  pr: PRData | null,
  sourceBranch: string,
  targetBranch: SupportedBranch,
  baseVersion: string | null,
  newVersion: string | null,
): Promise<void> {
  const prNumber = getCurrentPRNumber(pr);
  if (!prNumber) {
    logger.warning('无法获取 PR 号，跳过评论更新');
    return;
  }

  // 构建版本预览数据
  const previewData: VersionPreviewData = {
    sourceBranch,
    targetBranch,
    currentVersion: baseVersion || undefined,
    nextVersion: newVersion || '无需升级',
  };

  // 根据是否有新版本选择合适的模板
  const commentBody = newVersion
    ? COMMENT_TEMPLATES.VERSION_PREVIEW(previewData)
    : COMMENT_TEMPLATES.VERSION_SKIP(targetBranch, baseVersion);

  // 更新 PR 评论
  await updatePRComment(prNumber, commentBody);
  logger.info(`已更新 PR #${prNumber} 的版本预览信息`);
}

// /**
//  * 严格策略：确定版本升级类型 - 只基于 PR 标签，无智能推断
//  * 要求：必须有明确的版本标签（major/minor/patch）才进行版本升级
//  */
// export async function determineReleaseType(pr: PRData | null, targetBranch: string): Promise<ReleaseType | ''> {
//   logger.info(`🔍 开始确定版本升级类型 (PR: ${pr ? `#${pr.number}` : '无'}, 分支: ${targetBranch})`);

//   // 🎯 严格要求：只基于 PR 标签进行版本升级
//   if (pr?.labels && pr.labels.length > 0) {
//     const labelReleaseType = getReleaseTypeFromLabels(pr.labels);
//     if (labelReleaseType) {
//       logger.info(`✅ 使用 PR 标签: ${labelReleaseType} (来源: PR #${pr.number})`);
//       return labelReleaseType;
//     } else {
//       const labelNames = pr.labels.map((l) => l.name).join(', ');
//       logger.info(`📝 PR #${pr.number} 有标签但无版本标签: [${labelNames}]，跳过版本升级`);
//     }
//   } else if (pr) {
//     logger.info(`📝 PR #${pr.number} 没有标签，跳过版本升级`);
//   } else {
//     logger.info(`📝 无 PR 信息，跳过版本升级`);
//   }

//   // 🚫 移除智能推断：严格要求明确的版本标签
//   logger.info(`❌ 未检测到明确的版本标签 (major/minor/patch)，跳过版本升级`);
//   return '';
// }
