import process from 'node:process';
import { context, getOctokit } from '@actions/github';
import { readPackageJSON, resolvePackageJSON, writePackageJSON } from 'pkg-types';
import { commitChangelog, hasChangelogChanges, updateChangelog } from './changelog';
import { COMMIT_TEMPLATES, ERROR_MESSAGES, GIT_USER_CONFIG } from './constants';
import { logger } from './core';
import { handleNpmPublish } from './npm';
import type { BranchSyncResult, PRData, SupportedBranch } from './types';
import { ActionError, execGit, versionParse } from './utils';
import { updatePackageVersion } from './version';

// ==================== Git 基础操作 ====================

/**
 * 配置 Git 用户信息
 */
export async function configureGitUser(): Promise<void> {
  logger.info('配置 Git 用户信息');
  await execGit(['config', '--global', 'user.name', GIT_USER_CONFIG.NAME]);
  await execGit(['config', '--global', 'user.email', GIT_USER_CONFIG.EMAIL]);
}

/**
 * 在 PR merge 阶段提交版本更改（不推送，因为变更已包含在 merge 中）
 */
export async function commitVersionForMerge(
  version: string,
  targetBranch: SupportedBranch,
  pr: PRData | null = null,
): Promise<void> {
  try {
    const { pkgVersion: packageVersion, targetVersion: fullVersion } = versionParse(version);

    logger.info(`🔄 为 PR #${pr?.number || 'N/A'} 准备版本更改...`);

    // 确保在目标分支上进行操作
    await execGit(['switch', targetBranch]);
    logger.info(`已切换到 ${targetBranch} 分支`);

    // 更新包版本
    await updatePackageVersion(version);

    // 生成 changelog（使用 PR 信息）
    await updateChangelog(pr, version);

    // 检查是否有 changelog 变更
    const hasChanges = await hasChangelogChanges();
    if (!hasChanges) {
      logger.warning('⚠️ CHANGELOG 未生成任何内容，这将跳过 changelog 更新');
    }

    // 添加所有变更到暂存区
    await execGit(['add', '.']);

    // 创建提交
    const commitMessage = `${COMMIT_TEMPLATES.VERSION_BUMP(packageVersion, targetBranch)}\n\n🤖 包含版本升级和 CHANGELOG 更新 (PR #${pr?.number || 'N/A'})`;
    await execGit(['commit', '-m', commitMessage]);

    logger.info(`✅ 版本更改已提交到 ${targetBranch} 分支`);

    // 推送更改到远程分支
    await execGit(['push', 'origin', targetBranch]);
    logger.info(`✅ 更改已推送到远程 ${targetBranch} 分支`);

    logger.info(`🏷️ 标签: ${fullVersion}`);

    // 创建版本标签
    await execGit(['tag', fullVersion]);
    logger.info(`✅ 标签已创建: ${fullVersion}`);
  } catch (error) {
    const message = `为 PR merge 提交版本更改: ${error}`;
    logger.error(message);
    throw new ActionError(message, 'commitVersionForMerge', error);
  }
}

/**
 * 只推送标签（版本提交已在 commitVersionForMerge 中完成）
 */
export async function pushTagsOnly(version: string, targetBranch: SupportedBranch): Promise<void> {
  try {
    const { targetVersion: fullVersion } = versionParse(version);

    logger.info(`🚀 推送标签到远程仓库: ${fullVersion}`);

    // 确保在正确的分支上
    await execGit(['switch', targetBranch]);

    // 推送标签到远程仓库
    await execGit(['push', 'origin', fullVersion]);

    logger.info(`✅ 标签推送成功: ${fullVersion}`);

    // NPM 发布（如果有配置）
    await handleNpmPublish(version, targetBranch);
  } catch (error) {
    const message = `推送标签: ${error}`;
    logger.error(message);
    throw new ActionError(message, 'pushTagsOnly', error);
  }
}

/**
 * 提交并推送版本更改（保留原有的向后兼容）
 */
export async function commitAndPushVersion(version: string, targetBranch: SupportedBranch): Promise<void> {
  try {
    const { pkgVersion: packageVersion, targetVersion: fullVersion } = versionParse(version);

    // 提交版本更改
    await execGit(['add', '.']);
    await execGit(['commit', '-m', COMMIT_TEMPLATES.VERSION_BUMP(packageVersion, targetBranch)]);

    // 创建版本标签
    await execGit(['tag', fullVersion]);
    logger.info(`已创建标签: ${fullVersion}`);

    // 推送更改和标签（添加冲突处理）
    await safePushWithRetry(targetBranch, fullVersion);
  } catch (error) {
    const message = `提交和推送版本更改: ${error}`;
    logger.error(message);
    throw new ActionError(message, '提交和推送版本更改', error);
  }
}

/**
 * 安全推送，处理并发冲突和分支保护
 */
async function safePushWithRetry(targetBranch: SupportedBranch, version: string, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await attemptPush(attempt, maxRetries, targetBranch, version);
      logger.info(`✅ 推送成功 (第${attempt}次尝试)`);
      return;
    } catch (error) {
      await handlePushAttemptError(error, attempt, maxRetries, targetBranch, version);
    }
  }
}

/**
 * 执行单次推送尝试
 */
async function attemptPush(
  attempt: number,
  maxRetries: number,
  targetBranch: SupportedBranch,
  version: string,
): Promise<void> {
  if (attempt > 1) {
    logger.info(`🔄 尝试推送 (第${attempt}/${maxRetries}次)`);
    await prepareForRetry(targetBranch);
  }

  // 推送分支和标签 - 使用 --force-with-lease 处理分支保护
  logger.info('📤 推送分支...');
  await execGit(['push', 'origin', targetBranch, '--force-with-lease']);
  logger.info('🏷️ 推送标签...');
  await execGit(['push', 'origin', version]);
}

/**
 * 为重试准备：拉取最新更改并解决冲突
 */
async function prepareForRetry(targetBranch: SupportedBranch): Promise<void> {
  // 拉取最新更改
  await execGit(['fetch', 'origin', targetBranch]);
  await execGit(['rebase', `origin/${targetBranch}`]);
}

/**
 * 处理推送尝试中的错误
 */
async function handlePushAttemptError(
  error: unknown,
  attempt: number,
  maxRetries: number,
  targetBranch: SupportedBranch,
  version: string,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  if (attempt === maxRetries) {
    await logFinalPushFailure(targetBranch, version, errorMessage);
    throw error;
  }

  logger.warning(`⚠️ 推送失败 (第${attempt}/${maxRetries}次)，可能存在并发冲突: ${errorMessage}`);
  await waitForRetry();
}

/**
 * 记录最终推送失败的详细信息
 */
async function logFinalPushFailure(
  targetBranch: SupportedBranch,
  version: string,
  errorMessage: string,
): Promise<void> {
  logger.error(`❌ 推送失败，已尝试3次: ${errorMessage}`);

  // 提供诊断信息
  logger.info('🔍 推送失败诊断：');
  logger.info(`- 分支: ${targetBranch}`);
  logger.info(`- 标签: ${version}`);

  if (errorMessage.includes('protected')) {
    logger.error('🚨 分支保护问题：请确认 GitHub Actions 有推送权限');
  }
  if (errorMessage.includes('force-with-lease')) {
    logger.error('🚨 强制推送被拒绝：可能存在远程更改冲突');
  }
}

/**
 * 等待随机时间后重试
 */
async function waitForRetry(): Promise<void> {
  // 等待随机时间避免竞态
  const delay = Math.random() * 2000 + 1000; // 1-3秒随机延迟
  logger.info(`⏳ 等待 ${Math.round(delay)}ms 后重试...`);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

// ==================== 分支同步逻辑 ====================

/**
 * 检查是否为自动同步提交
 */
function isAutoSyncCommit(): boolean {
  // 检查最近的提交消息是否包含同步标记
  const commitMessage = context.payload.head_commit?.message || '';
  const isSkipCI = commitMessage.includes('[skip ci]');
  const isSyncCommit = commitMessage.includes('chore: sync') || commitMessage.includes('chore: bump version');

  if (isSkipCI || isSyncCommit) {
    logger.info(`检测到自动提交: ${commitMessage}`);
    return true;
  }

  return false;
}

/**
 * 获取同步提交消息
 */
function getCommitMessage(sourceBranch: SupportedBranch, targetBranch: SupportedBranch, version: string): string {
  if (sourceBranch === 'main' && targetBranch === 'beta') {
    return COMMIT_TEMPLATES.SYNC_MAIN_TO_BETA(version);
  }
  if (sourceBranch === 'beta' && targetBranch === 'alpha') {
    return COMMIT_TEMPLATES.SYNC_BETA_TO_ALPHA(version);
  }
  return `chore: sync ${sourceBranch} v${version} to ${targetBranch} [skip ci]`;
}

/**
 * 手动解决版本相关冲突
 */
async function resolveVersionConflicts(
  sourceBranch: SupportedBranch,
  targetBranch: SupportedBranch,
  sourceVersion: string,
): Promise<void> {
  try {
    // 取消合并
    await execGit(['merge', '--abort']);

    // 只合并非冲突文件，跳过版本文件
    await execGit(['merge', sourceBranch, '--no-commit', '--no-ff']);

    // 手动处理 package.json 版本冲突
    const pkgPath = await resolvePackageJSON();
    const sourcePkg = await readPackageJSON(pkgPath);

    // 确定正确的版本号
    const correctVersion = sourceVersion.replace(/^v/, '');
    sourcePkg.version = correctVersion;

    await writePackageJSON(pkgPath, sourcePkg);
    await execGit(['add', 'package.json']);

    // 完成合并
    const commitMessage = `${getCommitMessage(sourceBranch, targetBranch, sourceVersion)} (resolved version conflicts)`;
    await execGit(['commit', '-m', commitMessage]);

    logger.info(`手动解决版本冲突完成: ${sourceBranch} -> ${targetBranch}`);
  } catch (error) {
    throw new ActionError(`手动解决版本冲突失败: ${error}`, 'resolveVersionConflicts', error);
  }
}

/**
 * 报告合并冲突，创建 issue
 */
async function reportMergeConflict(
  sourceBranch: SupportedBranch,
  targetBranch: SupportedBranch,
  sourceVersion: string,
): Promise<void> {
  try {
    const octokit = getOctokit(process.env.GITHUB_TOKEN || '');

    const issueTitle = `🔀 自动合并冲突: ${sourceBranch} -> ${targetBranch}`;
    const issueBody = `## 合并冲突报告

**源分支**: ${sourceBranch}
**目标分支**: ${targetBranch}  
**版本**: ${sourceVersion}
**时间**: ${new Date().toISOString()}

## 问题描述
自动合并过程中遇到无法自动解决的冲突，需要人工介入处理。

## 需要处理的步骤
1. 检查 ${targetBranch} 分支的本地修改
2. 手动合并 ${sourceBranch} 分支的更改
3. 解决版本冲突
4. 测试合并结果
5. 推送更改

## 自动化日志
详细日志请查看 GitHub Actions 运行记录。

---
*此 issue 由版本管理 Action 自动创建*`;

    await octokit.rest.issues.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title: issueTitle,
      body: issueBody,
      labels: ['merge-conflict', 'automated', 'priority-high'],
    });

    logger.info(`已创建合并冲突 issue: ${issueTitle}`);
  } catch (error) {
    logger.error(`创建合并冲突 issue 失败: ${error}`);
  }
}

/**
 * 处理合并冲突 - 智能合并策略
 */
async function handleMergeConflict(
  sourceBranch: SupportedBranch,
  targetBranch: SupportedBranch,
  sourceVersion: string,
): Promise<void> {
  logger.warning(`${sourceBranch} -> ${targetBranch} 合并冲突，尝试智能处理`);

  try {
    // 第一步：尝试使用源分支的版本策略解决冲突
    await execGit(['merge', '--abort']); // 取消当前合并

    // 第二步：使用策略合并，优先采用源分支的版本文件
    await execGit([
      'merge',
      sourceBranch,
      '-X',
      'theirs',
      '--no-edit',
      '-m',
      `${getCommitMessage(sourceBranch, targetBranch, sourceVersion)} (auto-resolved conflicts)`,
    ]);

    logger.info(`使用策略合并成功解决 ${sourceBranch} -> ${targetBranch} 冲突`);
  } catch (strategyError) {
    logger.warning(`策略合并失败，尝试手动解决版本冲突: ${strategyError}`);

    try {
      // 第三步：手动解决版本相关冲突
      await resolveVersionConflicts(sourceBranch, targetBranch, sourceVersion);
    } catch (manualError) {
      logger.error(`手动解决冲突失败: ${manualError}`);

      // 第四步：最后手段 - 创建 issue 报告冲突
      await reportMergeConflict(sourceBranch, targetBranch, sourceVersion);
      throw new ActionError(ERROR_MESSAGES.MERGE_CONFLICT(sourceBranch, targetBranch), 'handleMergeConflict');
    }
  }
}

/**
 * 同步上游分支到下游分支 (使用 merge)
 */
async function syncDownstream(
  sourceBranch: SupportedBranch,
  targetBranch: SupportedBranch,
  sourceVersion: string,
): Promise<BranchSyncResult> {
  logger.info(`开始 merge 同步 ${sourceBranch} -> ${targetBranch}`);

  try {
    // 切换到目标分支
    await execGit(['fetch', 'origin', targetBranch]);
    await execGit(['switch', targetBranch]);

    // 尝试合并源分支
    const commitMessage = getCommitMessage(sourceBranch, targetBranch, sourceVersion);

    try {
      await execGit(['merge', sourceBranch, '--no-edit', '--no-ff', '-m', commitMessage]);
      logger.info(`${sourceBranch} -> ${targetBranch} merge 成功`);
    } catch {
      logger.warning(`${sourceBranch} -> ${targetBranch} merge 冲突，进行强制同步`);
      await handleMergeConflict(sourceBranch, targetBranch, sourceVersion);
    }

    // 推送更改
    await execGit(['push', 'origin', targetBranch, '--force-with-lease']);
    logger.info(`${targetBranch} 分支 merge 同步完成`);

    return { success: true, version: sourceVersion };
  } catch (error) {
    const errorMsg = `${sourceBranch} -> ${targetBranch} merge 同步失败: ${error}`;
    logger.error(errorMsg);
    return {
      success: false,
      error: errorMsg,
      conflicts: [sourceBranch, targetBranch],
    };
  }
}

/**
 * 同步上游分支到下游分支 (使用 rebase)
 */
async function syncDownstreamWithRebase(
  sourceBranch: SupportedBranch,
  targetBranch: SupportedBranch,
  sourceVersion: string,
): Promise<BranchSyncResult> {
  logger.info(`开始 rebase 同步 ${sourceBranch} -> ${targetBranch}`);

  try {
    // 切换到目标分支
    await execGit(['fetch', 'origin', targetBranch]);
    await execGit(['switch', targetBranch]);

    // 尝试 rebase 源分支
    try {
      await execGit(['rebase', sourceBranch]);
      logger.info(`${sourceBranch} -> ${targetBranch} rebase 成功`);
    } catch {
      logger.warning(`${sourceBranch} -> ${targetBranch} rebase 冲突，尝试处理`);

      // 对于 rebase 冲突，我们采用更保守的策略
      await execGit(['rebase', '--abort']);

      // 改用 merge 策略作为 fallback
      const commitMessage = getCommitMessage(sourceBranch, targetBranch, sourceVersion);
      await execGit(['merge', sourceBranch, '--no-edit', '--no-ff', '-m', commitMessage]);
      logger.info('rebase 失败，改用 merge 策略完成同步');
    }

    // 推送更改
    await execGit(['push', 'origin', targetBranch, '--force-with-lease']);
    logger.info(`${targetBranch} 分支 rebase 同步完成`);

    return { success: true, version: sourceVersion };
  } catch (error) {
    const errorMsg = `${sourceBranch} -> ${targetBranch} rebase 同步失败: ${error}`;
    logger.error(errorMsg);
    return {
      success: false,
      error: errorMsg,
      conflicts: [sourceBranch, targetBranch],
    };
  }
}

/**
 * 执行分支同步 - 根据新的合并策略
 */
export async function syncBranches(targetBranch: SupportedBranch, newVersion: string): Promise<BranchSyncResult[]> {
  // 🔧 修复：只有在 push 事件时才检查自动同步提交，PR merge 事件需要完整同步链
  const isPushEvent = context.eventName === 'push';
  if (isPushEvent && isAutoSyncCommit()) {
    logger.info('检测到 Push 事件的自动同步提交，跳过分支同步避免级联触发');
    return [{ success: true }];
  }

  const results: BranchSyncResult[] = [];

  if (targetBranch === 'main') {
    // Main 分支更新后：使用 rebase 向下游 Beta 分支同步
    logger.info('Main 分支更新，使用 rebase 向 Beta 分支同步');

    const betaResult = await syncDownstreamWithRebase('main', 'beta', newVersion);
    results.push(betaResult);

    if (betaResult.success) {
      // Beta 分支同步成功后，继续向 Alpha 分支 merge
      logger.info('Main → Beta 同步成功，继续 Beta → Alpha merge 同步');
      const alphaResult = await syncDownstream('beta', 'alpha', newVersion);
      results.push(alphaResult);
    } else {
      logger.warning('Main → Beta 同步失败，跳过 Beta → Alpha 级联同步');
    }
  } else if (targetBranch === 'beta') {
    // Beta 分支更新后：使用 merge 向下游 Alpha 分支同步
    logger.info('Beta 分支更新，使用 merge 向 Alpha 分支同步');
    const result = await syncDownstream('beta', 'alpha', newVersion);
    results.push(result);
  }
  // Alpha 分支更新时不自动同步，需要手动 PR 到 Beta

  return results;
}

/**
 * 只创建标签（不更新版本文件）- 用于新的合并策略
 */
export async function createTagOnly(version: string, targetBranch: SupportedBranch): Promise<void> {
  try {
    logger.info('开始创建版本标签...');

    const { targetVersion: fullVersion } = versionParse(version);

    // 确保在正确的分支上
    await execGit(['switch', targetBranch]);

    // 创建版本标签
    await execGit(['tag', fullVersion]);
    logger.info(`已创建标签: ${fullVersion}`);

    // 推送标签到远程
    await execGit(['push', 'origin', fullVersion]);
    logger.info(`✅ 标签 ${fullVersion} 推送成功`);

    // 🚀 发布到 npm - 只对目标分支版本发布
    await handleNpmPublish(version, targetBranch);
  } catch (error) {
    throw new ActionError(`创建标签失败: ${error}`, 'createTagOnly', error);
  }
}

/**
 * 更新版本并创建标签 - 支持基于 PR 的 CHANGELOG 生成和 npm 发布
 */
export async function updateVersionAndCreateTag(
  newVersion: string,
  targetBranch: SupportedBranch,
  pr: PRData | null = null,
): Promise<void> {
  try {
    logger.info('开始执行版本更新...');

    await execGit(['switch', targetBranch]);

    // 更新版本文件
    await updatePackageVersion(newVersion);

    // 提交版本更改并推送
    await commitAndPushVersion(newVersion, targetBranch);

    // 🎯 在打 tag 后更新 CHANGELOG - 使用 PR 信息
    await updateChangelog(pr, newVersion);

    // 检查是否有 CHANGELOG 更改需要提交 - 每次版本发布都必须有 CHANGELOG 变更
    const hasChanges = await hasChangelogChanges();
    if (hasChanges) {
      await commitChangelog(newVersion, targetBranch);
    } else {
      const errorMessage = 'CHANGELOG 未生成任何内容，这不应该发生。请检查 PR 描述或提交历史是否包含足够的变更信息。';
      logger.error(errorMessage);
      throw new ActionError(errorMessage, 'CHANGELOG 生成失败');
    }

    // 🚀 发布到 npm - 只对目标分支版本发布
    await handleNpmPublish(newVersion, targetBranch);
  } catch (error) {
    throw new ActionError(`版本更新和标签创建失败: ${error}`, 'updateVersionAndCreateTag', error);
  }
}
