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
 * 基于 Conventional Commits 的版本升级映射
 * https://www.conventionalcommits.org/
 */
const COMMIT_TYPE_TO_RELEASE: Record<string, ReleaseType> = {
  // Breaking changes - Major version
  'BREAKING CHANGE': 'premajor',
  'BREAKING-CHANGE': 'premajor',
  
  // New features - Minor version  
  'feat': 'preminor',
  'feature': 'preminor',
  
  // Bug fixes - Patch version
  'fix': 'prepatch',
  'bugfix': 'prepatch',
  'hotfix': 'prepatch',
  
  // Other patch-level changes
  'perf': 'prepatch',        // Performance improvements
  'security': 'prepatch',    // Security fixes
  'revert': 'prepatch',      // Reverts
  
  // No version bump needed for: docs, style, refactor, test, chore
};

/**
 * 从 commit message 中提取 conventional commit 类型
 */
function parseConventionalCommit(commitMessage: string): { type: string; hasBreaking: boolean } {
  const lines = commitMessage.split('\n');
  const firstLine = lines[0].trim();
  
  // 匹配格式: type(scope): description 或 type: description
  const conventionalMatch = firstLine.match(/^(\w+)(?:\([^)]+\))?\s*:\s*(.+)$/);
  
  let type = '';
  if (conventionalMatch) {
    type = conventionalMatch[1].toLowerCase();
  } else {
    // 如果不是标准格式，尝试从开头提取关键词
    const typeMatch = firstLine.match(/^(feat|fix|docs|style|refactor|test|chore|perf|security|revert|bugfix|hotfix|feature)/i);
    if (typeMatch) {
      type = typeMatch[1].toLowerCase();
    }
  }
  
  // 检查是否包含 Breaking Change
  const fullMessage = commitMessage.toLowerCase();
  const hasBreaking = fullMessage.includes('breaking change') || 
                     fullMessage.includes('breaking-change') ||
                     firstLine.includes('!:'); // type!: description format
  
  return { type, hasBreaking };
}

/**
 * 从最近的 commit 历史中推断版本升级类型
 */
export async function inferReleaseTypeFromCommits(targetBranch: string): Promise<ReleaseType | ''> {
  try {
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha: targetBranch,
      per_page: 10, // 检查最近10个commit
    });

    if (commits.length === 0) {
      logger.info('📝 未找到最近的commit，无法推断版本类型');
      return '';
    }

    let highestPriority: ReleaseType | '' = '';
    const priorityOrder: ReleaseType[] = ['premajor', 'preminor', 'prepatch'];
    const foundTypes: string[] = [];

    // 分析最近的commits，找出最高优先级的变更类型
    for (const commit of commits) {
      // 跳过merge commit（通常是PR合并产生的）
      if (commit.parents && commit.parents.length > 1) {
        continue;
      }

      const { type, hasBreaking } = parseConventionalCommit(commit.commit.message);
      
      if (hasBreaking) {
        highestPriority = 'premajor';
        foundTypes.push(`BREAKING(${type})`);
        break; // Breaking change是最高优先级，直接退出
      }
      
      if (type && COMMIT_TYPE_TO_RELEASE[type]) {
        const releaseType = COMMIT_TYPE_TO_RELEASE[type];
        foundTypes.push(type);
        
        // 更新为更高优先级的类型
        const currentIndex = priorityOrder.indexOf(highestPriority as ReleaseType);
        const newIndex = priorityOrder.indexOf(releaseType);
        
        if (currentIndex === -1 || (newIndex !== -1 && newIndex < currentIndex)) {
          highestPriority = releaseType;
        }
      }
    }

    if (highestPriority) {
      logger.info(`🤖 基于commit历史推断版本类型: ${highestPriority} (发现类型: ${foundTypes.join(', ')})`);
    } else {
      logger.info(`📝 未从commit历史中发现需要版本升级的变更类型 (检查了${commits.length}个commit)`);
    }

    return highestPriority;
  } catch (error) {
    logger.warning(`从commit历史推断版本类型失败: ${error}`);
    return '';
  }
}

/**
 * 获取最近合并到目标分支的 PR 信息
 * 现在会尝试多种方法获取版本信息：PR标签 -> commit分析 -> 智能推断
 */
export async function getRecentMergedPR(targetBranch: string): Promise<PRData | null> {
  try {
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha: targetBranch,
      per_page: 10,
    });

    // 查找最近的 merge commit
    for (const commit of commits) {
      if (commit.commit.message.includes('Merge pull request #')) {
        const prMatch = commit.commit.message.match(/Merge pull request #(\d+)/);
        if (prMatch) {
          const prNumber = parseInt(prMatch[1]);
          const { data: pr } = await octokit.rest.pulls.get({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: prNumber,
          });
          logger.info(`找到最近合并的 PR #${prNumber}`);
          return pr;
        }
      }
    }

    logger.info('未找到最近合并的 PR');
    return null;
  } catch (error) {
    logger.warning(`获取最近合并的 PR 失败: ${error}`);
    return null;
  }
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

/**
 * 混合策略：确定版本升级类型 - 针对merge阶段优化
 * 优先级：PR标签 > commit分析 > 智能推断
 */
export async function determineReleaseType(
  pr: PRData | null,
  targetBranch: string
): Promise<ReleaseType | ''> {
  logger.info(`🔍 开始确定版本升级类型 (PR: ${pr ? `#${pr.number}` : '无'}, 分支: ${targetBranch})`);
  
  // 1. 优先使用PR标签（merge阶段和预览模式都有完整PR信息）
  if (pr?.labels && pr.labels.length > 0) {
    const labelReleaseType = PRUtils.getReleaseTypeFromLabels(pr.labels);
    if (labelReleaseType) {
      logger.info(`✅ 使用PR标签推断: ${labelReleaseType} (来源: PR #${pr.number})`);
      return labelReleaseType;
    } else {
      const labelNames = pr.labels.map(l => l.name).join(', ');
      logger.info(`📝 PR #${pr.number} 有标签但无版本标签: [${labelNames}]`);
    }
  } else if (pr) {
    logger.info(`📝 PR #${pr.number} 没有标签`);
  }
  
  // 2. 尝试从commit历史推断（兜底方案）
  logger.info(`🔍 尝试从commit历史推断版本类型...`);
  const commitReleaseType = await inferReleaseTypeFromCommits(targetBranch);
  if (commitReleaseType) {
    logger.info(`🤖 使用commit历史推断: ${commitReleaseType}`);
    return commitReleaseType;
  }
  
  // 3. 基于分支特性的智能推断（最后的兜底）
  if (targetBranch === 'alpha') {
    logger.info(`🎯 Alpha分支智能推断: prepatch (默认patch升级)`);
    return 'prepatch';
  } else if (targetBranch === 'beta') {
    logger.info(`🎯 Beta分支智能推断: prerelease (从alpha升级)`);
    return 'prerelease';
  } else if (targetBranch === 'main') {
    logger.info(`🎯 Main分支智能推断: patch (从beta发布)`);
    return 'patch';
  }
  
  logger.info(`❌ 无法推断版本升级类型，将跳过升级`);
  return '';
}

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
 * 获取事件信息和目标分支 - 支持merge阶段触发
 */
export async function getEventInfo(): Promise<{
  targetBranch: string;
  isDryRun: boolean;
  pr: PRData | null;
  eventType: 'preview' | 'merge' | 'push';
} | null> {
  try {
    let targetBranch = '';
    let isDryRun = false;
    let pr: PRData | null = null;
    let eventType: 'preview' | 'merge' | 'push' = 'push';

    if (context.eventName === 'pull_request') {
      const prPayload = context.payload.pull_request;
      
      if (!prPayload) {
        logger.error('PR payload 不存在');
        return null;
      }

      // 获取完整的PR信息
      pr = await getCurrentPR();
      if (!pr || !pr.base) {
        logger.error('无法获取有效的 PR 信息');
        return null;
      }

      targetBranch = pr.base.ref;

      // 🎯 关键：检查是否是merge事件
      if (prPayload.state === 'closed' && prPayload.merged === true) {
        // PR刚刚被合并 - 这是执行版本管理的最佳时机
        isDryRun = false;
        eventType = 'merge';
        logger.info(`🎯 PR #${pr.number} 已合并到 ${targetBranch} (Merge阶段触发)`);
      } else {
        // PR还未合并 - 预览模式
        isDryRun = true;
        eventType = 'preview';
        logger.info(`👁️ PR #${pr.number} 预览模式，目标分支: ${targetBranch}`);
      }
      
    } else if (context.eventName === 'push') {
      // Push事件：作为兜底方案保留
      targetBranch = context.ref.split('/').pop()!;
      pr = await getRecentMergedPR(targetBranch);
      isDryRun = false;
      eventType = 'push';
      
      if (pr) {
        logger.info(`🔄 Push事件，找到相关PR #${pr.number}，目标分支: ${targetBranch}`);
      } else {
        logger.info(`🔄 Push事件，未找到相关PR，将使用commit分析，目标分支: ${targetBranch}`);
      }
      
    } else if (context.eventName === 'repository_dispatch') {
      // 支持手动触发
      const dispatchPayload = context.payload.client_payload as any;
      targetBranch = dispatchPayload?.target_branch || 'main';
      isDryRun = false;
      eventType = 'push';
      logger.info(`📡 手动触发事件，目标分支: ${targetBranch}`);
      
    } else {
      logger.info(`❌ 不支持的事件类型: ${context.eventName}`);
      return null;
    }

    // 检查分支支持
    if (!validateBranch(targetBranch)) {
      logger.info(`❌ 不支持的分支: ${targetBranch}，跳过版本管理`);
      return null;
    }

    return { targetBranch, isDryRun, pr, eventType };
  } catch (error) {
    throw new ActionError(`获取事件信息失败: ${error}`, 'getEventInfo', error);
  }
}
