import { exec } from '@actions/exec';
import { context, getOctokit } from '@actions/github';
import { readPackageJSON, resolvePackageJSON, writePackageJSON } from 'pkg-types';
import { logger } from './core';
import {
  ActionError,
  type BranchSyncResult,
  COMMIT_TEMPLATES,
  ERROR_MESSAGES,
  GIT_USER_CONFIG,
  type SupportedBranch,
} from './types';
import { VersionUtils } from './version';

// ==================== Git 基础操作 ====================

/**
 * 统一的错误处理函数
 */
function handleGitError(error: unknown, context: string, shouldThrow = false): void {
  const message = `${context}: ${error}`;
  logger.error(message);
  if (shouldThrow) throw new ActionError(message, context, error);
}

/**
 * 执行 git 命令并捕获输出
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
 * 配置 Git 用户信息
 */
export async function configureGitUser(): Promise<void> {
  logger.info('配置 Git 用户信息');
  await execGit(['config', '--global', 'user.name', GIT_USER_CONFIG.name]);
  await execGit(['config', '--global', 'user.email', GIT_USER_CONFIG.email]);
}

/**
 * 检查文件是否有变化
 */
export async function hasFileChanges(filepath: string): Promise<boolean> {
  try {
    // 检查文件是否存在
    await exec('test', ['-f', filepath]);

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
  } catch {
    return false;
  }
}

/**
 * 提交并推送文件更改
 */
export async function commitAndPushFile(
  filepath: string,
  commitMessage: string,
  targetBranch: SupportedBranch,
): Promise<void> {
  try {
    await execGit(['add', filepath]);
    await execGit(['commit', '-m', commitMessage]);
    await execGit(['push', 'origin', targetBranch]);
    logger.info(`${filepath} 更新已提交并推送`);
  } catch (error) {
    handleGitError(error, `提交和推送 ${filepath}`, true);
  }
}

/**
 * 提交并推送版本更改
 */
export async function commitAndPushVersion(version: string, targetBranch: SupportedBranch): Promise<void> {
  try {
    const packageVersion = VersionUtils.cleanVersion(version);
    const fullVersion = VersionUtils.addVersionPrefix(version);

    // 提交版本更改
    await execGit(['add', '.']);
    await execGit(['commit', '-m', COMMIT_TEMPLATES.VERSION_BUMP(packageVersion, targetBranch)]);

    // 创建版本标签
    await execGit(['tag', fullVersion]);
    logger.info(`已创建标签: ${fullVersion}`);

    // 推送更改和标签（添加冲突处理）
    await safePushWithRetry(targetBranch, fullVersion);
  } catch (error) {
    handleGitError(error, '提交和推送版本更改', true);
  }
}

/**
 * 安全推送，处理并发冲突
 */
async function safePushWithRetry(targetBranch: SupportedBranch, version: string, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        logger.info(`🔄 尝试推送 (第${attempt}/${maxRetries}次)`);
        // 拉取最新更改
        await execGit(['fetch', 'origin', targetBranch]);
        await execGit(['rebase', `origin/${targetBranch}`]);
      }
      
      // 推送分支和标签
      await execGit(['push', 'origin', targetBranch]);
      await execGit(['push', 'origin', version]);
      
      logger.info(`✅ 推送成功 (第${attempt}次尝试)`);
      return;
      
    } catch (error) {
      if (attempt === maxRetries) {
        logger.error(`❌ 推送失败，已尝试${maxRetries}次: ${error}`);
        throw error;
      }
      
      logger.warning(`⚠️ 推送失败 (第${attempt}/${maxRetries}次)，可能存在并发冲突: ${error}`);
      
      // 等待随机时间避免竞态
      const delay = Math.random() * 2000 + 1000; // 1-3秒随机延迟
      logger.info(`⏳ 等待 ${Math.round(delay)}ms 后重试...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ==================== CHANGELOG 操作 ====================

/**
 * 更新 CHANGELOG
 */
export async function updateChangelog(): Promise<void> {
  try {
    logger.info('开始生成 CHANGELOG...');

    // 检查 CHANGELOG.md 是否存在，如果不存在则创建初始版本
    try {
      await exec('ls', ['CHANGELOG.md']);
      logger.info('CHANGELOG.md 已存在，增量更新');
    } catch {
      logger.info('CHANGELOG.md 不存在，创建初始版本');
      // 创建初始 CHANGELOG，包含所有历史
      await exec('npx', [
        'conventional-changelog-cli',
        '-p',
        'conventionalcommits',
        '-i',
        'CHANGELOG.md',
        '-s',
        '-r',
        '0', // 包含所有发布记录
      ]);
    }

    // 如果上面的步骤没有创建文件，使用标准增量更新
    try {
      await exec('ls', ['CHANGELOG.md']);
    } catch {
      // 使用 npx 确保能找到包，即使没有全局安装
      await exec('npx', ['conventional-changelog-cli', '-p', 'conventionalcommits', '-i', 'CHANGELOG.md', '-s']);
    }

    logger.info('CHANGELOG 生成完成');
  } catch (error) {
    // 如果 conventional-changelog-cli 不存在，尝试安装后再执行
    logger.warning(`CHANGELOG 生成失败，尝试安装依赖: ${error}`);

    try {
      // 临时安装 conventional-changelog-cli
      await exec('npm', ['install', '-g', 'conventional-changelog-cli', 'conventional-changelog-conventionalcommits']);

      // 重新尝试生成（包含所有历史）
      await exec('npx', [
        'conventional-changelog-cli',
        '-p',
        'conventionalcommits',
        '-i',
        'CHANGELOG.md',
        '-s',
        '-r',
        '0',
      ]);

      logger.info('CHANGELOG 生成完成（已安装依赖）');
    } catch (retryError) {
      logger.warning(`CHANGELOG 生成最终失败: ${retryError}`);
      // 不阻塞主流程，继续执行
    }
  }
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
  } else if (sourceBranch === 'beta' && targetBranch === 'alpha') {
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

    // 手动处理package.json版本冲突
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
 * 报告合并冲突，创建issue
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
*此issue由版本管理Action自动创建*`;

    await octokit.rest.issues.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title: issueTitle,
      body: issueBody,
      labels: ['merge-conflict', 'automated', 'priority-high'],
    });

    logger.info(`已创建合并冲突issue: ${issueTitle}`);
  } catch (error) {
    logger.error(`创建合并冲突issue失败: ${error}`);
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

      // 第四步：最后手段 - 创建issue报告冲突
      await reportMergeConflict(sourceBranch, targetBranch, sourceVersion);
      throw new ActionError(ERROR_MESSAGES.MERGE_CONFLICT(sourceBranch, targetBranch), 'handleMergeConflict');
    }
  }
}

/**
 * 同步上游分支到下游分支
 */
async function syncDownstream(
  sourceBranch: SupportedBranch,
  targetBranch: SupportedBranch,
  sourceVersion: string,
): Promise<BranchSyncResult> {
  logger.info(`开始同步 ${sourceBranch} -> ${targetBranch}`);

  try {
    // 切换到目标分支
    await execGit(['fetch', 'origin', targetBranch]);
    await execGit(['switch', targetBranch]);

    // 尝试合并源分支
    const commitMessage = getCommitMessage(sourceBranch, targetBranch, sourceVersion);

    try {
      await execGit(['merge', sourceBranch, '--no-edit', '--no-ff', '-m', commitMessage]);
      logger.info(`${sourceBranch} -> ${targetBranch} 合并成功`);
    } catch (_error) {
      logger.warning(`${sourceBranch} -> ${targetBranch} 合并冲突，进行强制同步`);
      await handleMergeConflict(sourceBranch, targetBranch, sourceVersion);
    }

    // 推送更改
    await execGit(['push', 'origin', targetBranch, '--force-with-lease']);
    logger.info(`${targetBranch} 分支同步完成`);

    return { success: true, version: sourceVersion };
  } catch (error) {
    const errorMsg = `${sourceBranch} -> ${targetBranch} 同步失败: ${error}`;
    logger.error(errorMsg);
    return {
      success: false,
      error: errorMsg,
      conflicts: [sourceBranch, targetBranch],
    };
  }
}

/**
 * 执行分支同步 - 智能同步避免级联触发
 */
export async function syncBranches(targetBranch: SupportedBranch, newVersion: string): Promise<BranchSyncResult[]> {
  // 检查是否为自动同步提交，避免无限循环
  if (isAutoSyncCommit()) {
    logger.info('检测到自动同步提交，跳过分支同步避免级联触发');
    return [{ success: true }];
  }

  const results: BranchSyncResult[] = [];

  if (targetBranch === 'main') {
    // Main 更新后，向下游同步稳定代码: Main → Beta → Alpha
    logger.info('Main分支更新，开始向下游同步稳定代码');
    const result = await syncDownstream('main', 'beta', newVersion);
    results.push(result);
    // 注意：不再自动触发 Beta → Alpha，让Beta分支的工作流处理
  } else if (targetBranch === 'beta') {
    // Beta 更新后，只向 Alpha 同步测试代码: Beta → Alpha
    logger.info('Beta分支更新，向Alpha同步测试代码');
    const result = await syncDownstream('beta', 'alpha', newVersion);
    results.push(result);
  }
  // Alpha 分支更新时不自动同步，需要手动 PR 到 Beta

  return results;
}

// ==================== 版本更新和标签创建 ====================

/**
 * 更新版本并创建标签
 */
export async function updateVersionAndCreateTag(newVersion: string, targetBranch: SupportedBranch): Promise<void> {
  try {
    logger.info('开始执行版本更新...');

    await execGit(['switch', targetBranch]);

    // 更新版本文件
    const { updatePackageVersion } = await import('./version');
    await updatePackageVersion(newVersion);

    // 提交版本更改并推送
    await commitAndPushVersion(newVersion, targetBranch);

    // 在打tag后更新 CHANGELOG
    await updateChangelog();

    // 检查是否有 CHANGELOG 更改需要提交
    const hasChanges = await hasFileChanges('CHANGELOG.md');
    if (hasChanges) {
      const fullVersion = VersionUtils.addVersionPrefix(newVersion);
      await commitAndPushFile('CHANGELOG.md', COMMIT_TEMPLATES.CHANGELOG_UPDATE(fullVersion), targetBranch);
    } else {
      logger.info('CHANGELOG 无更改，跳过提交');
    }
  } catch (error) {
    throw new ActionError(`版本更新和标签创建失败: ${error}`, 'updateVersionAndCreateTag', error);
  }
}
