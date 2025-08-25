import { exec } from '@actions/exec';
import { context, getOctokit } from '@actions/github';
import { readPackageJSON, resolvePackageJSON, writePackageJSON } from 'pkg-types';
import core, { logger } from './core';
import {
  ActionError,
  type BranchSyncResult,
  COMMIT_TEMPLATES,
  ERROR_MESSAGES,
  GIT_USER_CONFIG,
  type PRData,
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
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ==================== CHANGELOG 操作 ====================

/**
 * 基于PR信息生成CHANGELOG条目
 */
async function generateChangelogFromPR(pr: PRData | null, version: string): Promise<string> {
  if (!pr) {
    return `### Changes\n- Version ${version} release\n`;
  }

  // PR标签到CHANGELOG类型的映射
  const labelToChangelogType: Record<string, string> = {
    major: '💥 Breaking Changes',
    minor: '✨ Features',
    patch: '🐛 Bug Fixes',
    enhancement: '⚡ Improvements',
    performance: '🚀 Performance',
    security: '🔒 Security',
    documentation: '📚 Documentation',
    dependencies: '⬆️ Dependencies',
  };

  // 从PR标签推断变更类型
  let changeType = '📝 Changes';
  if (pr.labels) {
    for (const label of pr.labels) {
      if (labelToChangelogType[label.name]) {
        changeType = labelToChangelogType[label.name];
        break;
      }
    }

    // 如果没找到特定类型，基于版本标签推断
    if (changeType === '📝 Changes') {
      const versionLabels = pr.labels.map((l) => l.name);
      if (versionLabels.includes('major')) changeType = '💥 Breaking Changes';
      else if (versionLabels.includes('minor')) changeType = '✨ Features';
      else if (versionLabels.includes('patch')) changeType = '🐛 Bug Fixes';
    }
  }

  // 构建CHANGELOG条目
  let changelogEntry = `### ${changeType}\n`;

  // 添加PR标题和链接
  const prUrl = pr.html_url;
  const prTitle = pr.title || `PR #${pr.number}`;
  changelogEntry += `- ${prTitle} ([#${pr.number}](${prUrl}))\n`;

  // 如果PR有body，提取关键信息
  if (pr.body && pr.body.trim()) {
    const body = pr.body.trim();

    // 查找特定的section（如 "### Changes", "## What's Changed" 等）
    const sections = [
      '### Changes',
      '## Changes',
      "### What's Changed",
      "## What's Changed",
      '### Summary',
      '## Summary',
    ];
    for (const section of sections) {
      const sectionIndex = body.indexOf(section);
      if (sectionIndex !== -1) {
        const sectionContent = body.substring(sectionIndex + section.length);
        const nextSectionIndex = sectionContent.search(/^##/m);
        const content = nextSectionIndex !== -1 ? sectionContent.substring(0, nextSectionIndex) : sectionContent;

        const cleanContent = content
          .trim()
          .split('\n')
          .filter((line) => line.trim())
          .slice(0, 5) // 最多5行
          .map((line) => (line.startsWith('- ') ? `  ${line}` : `  - ${line}`))
          .join('\n');

        if (cleanContent) {
          changelogEntry += `${cleanContent}\n`;
          break;
        }
      }
    }
  }

  return changelogEntry;
}

/**
 * 更新 CHANGELOG - 基于PR信息生成
 */
export async function updateChangelog(pr: PRData | null = null, version: string = ''): Promise<void> {
  // 检查是否启用CHANGELOG生成
  const enableChangelog = core.getInput('enable-changelog')?.toLowerCase() !== 'false';
  if (!enableChangelog) {
    logger.info('CHANGELOG 生成已禁用，跳过');
    return;
  }

  try {
    logger.info('开始生成基于PR的 CHANGELOG...');

    const currentDate = new Date().toISOString().split('T')[0];
    const versionTag = version.startsWith('v') ? version : `v${version}`;

    // 生成基于PR的CHANGELOG条目
    const changelogEntry = await generateChangelogFromPR(pr, version);

    const newEntry = `## [${versionTag}] - ${currentDate}

${changelogEntry}
`;

    // 读取现有CHANGELOG内容
    let existingContent = '';
    try {
      let stdout = '';
      await exec('cat', ['CHANGELOG.md'], {
        listeners: {
          stdout: (data: Buffer) => {
            stdout += data.toString();
          },
        },
      });
      existingContent = stdout;
      logger.info('读取现有CHANGELOG内容');
    } catch {
      // 如果文件不存在，创建初始内容
      existingContent = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`;
      logger.info('CHANGELOG.md 不存在，创建新文件');
    }

    // 插入新条目到第一个版本记录之前
    const lines = existingContent.split('\n');
    let insertIndex = lines.length;

    // 查找第一个版本标题的位置
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/^## \[.*\]/)) {
        insertIndex = i;
        break;
      }
    }

    // 插入新条目
    const entryLines = newEntry.split('\n');
    lines.splice(insertIndex, 0, ...entryLines);

    // 写回文件
    const newContent = lines.join('\n');
    await exec('sh', ['-c', `cat > CHANGELOG.md << 'EOF'\n${newContent}\nEOF`]);

    logger.info(`✅ CHANGELOG 已更新，添加版本 ${versionTag}`);

    // 显示新增的内容预览
    try {
      let stdout = '';
      await exec('head', ['-15', 'CHANGELOG.md'], {
        listeners: {
          stdout: (data: Buffer) => {
            stdout += data.toString();
          },
        },
      });
      logger.info('📋 CHANGELOG 预览:');
      logger.info(stdout);
    } catch {
      logger.info('无法显示CHANGELOG预览');
    }
  } catch (error) {
    logger.warning(`基于PR的CHANGELOG生成失败: ${error}`);

    // 如果失败，使用原来的conventional-changelog逻辑作为备用
    await fallbackToConventionalChangelog();
  }
}

/**
 * 备用方案：使用conventional-changelog
 */
async function fallbackToConventionalChangelog(): Promise<void> {
  try {
    logger.info('使用conventional-changelog作为备用方案...');

    // 检查是否已安装
    try {
      await exec('npx', ['conventional-changelog-cli', '--version']);
    } catch {
      await exec('npm', ['install', '-g', 'conventional-changelog-cli', 'conventional-changelog-conventionalcommits']);
    }

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

    logger.info('✅ 使用conventional-changelog生成完成');
  } catch (error) {
    logger.warning(`备用CHANGELOG生成也失败: ${error}`);
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
 * 同步上游分支到下游分支 (使用merge)
 */
async function syncDownstream(
  sourceBranch: SupportedBranch,
  targetBranch: SupportedBranch,
  sourceVersion: string,
): Promise<BranchSyncResult> {
  logger.info(`开始merge同步 ${sourceBranch} -> ${targetBranch}`);

  try {
    // 切换到目标分支
    await execGit(['fetch', 'origin', targetBranch]);
    await execGit(['switch', targetBranch]);

    // 尝试合并源分支
    const commitMessage = getCommitMessage(sourceBranch, targetBranch, sourceVersion);

    try {
      await execGit(['merge', sourceBranch, '--no-edit', '--no-ff', '-m', commitMessage]);
      logger.info(`${sourceBranch} -> ${targetBranch} merge成功`);
    } catch {
      logger.warning(`${sourceBranch} -> ${targetBranch} merge冲突，进行强制同步`);
      await handleMergeConflict(sourceBranch, targetBranch, sourceVersion);
    }

    // 推送更改
    await execGit(['push', 'origin', targetBranch, '--force-with-lease']);
    logger.info(`${targetBranch} 分支merge同步完成`);

    return { success: true, version: sourceVersion };
  } catch (error) {
    const errorMsg = `${sourceBranch} -> ${targetBranch} merge同步失败: ${error}`;
    logger.error(errorMsg);
    return {
      success: false,
      error: errorMsg,
      conflicts: [sourceBranch, targetBranch],
    };
  }
}

/**
 * 同步上游分支到下游分支 (使用rebase)
 */
async function syncDownstreamWithRebase(
  sourceBranch: SupportedBranch,
  targetBranch: SupportedBranch,
  sourceVersion: string,
): Promise<BranchSyncResult> {
  logger.info(`开始rebase同步 ${sourceBranch} -> ${targetBranch}`);

  try {
    // 切换到目标分支
    await execGit(['fetch', 'origin', targetBranch]);
    await execGit(['switch', targetBranch]);

    // 尝试rebase源分支
    try {
      await execGit(['rebase', sourceBranch]);
      logger.info(`${sourceBranch} -> ${targetBranch} rebase成功`);
    } catch {
      logger.warning(`${sourceBranch} -> ${targetBranch} rebase冲突，尝试处理`);

      // 对于rebase冲突，我们采用更保守的策略
      await execGit(['rebase', '--abort']);

      // 改用merge策略作为fallback
      const commitMessage = getCommitMessage(sourceBranch, targetBranch, sourceVersion);
      await execGit(['merge', sourceBranch, '--no-edit', '--no-ff', '-m', commitMessage]);
      logger.info(`rebase失败，改用merge策略完成同步`);
    }

    // 推送更改
    await execGit(['push', 'origin', targetBranch, '--force-with-lease']);
    logger.info(`${targetBranch} 分支rebase同步完成`);

    return { success: true, version: sourceVersion };
  } catch (error) {
    const errorMsg = `${sourceBranch} -> ${targetBranch} rebase同步失败: ${error}`;
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
  // 🔧 修复：只有在push事件时才检查自动同步提交，PR merge事件需要完整同步链
  const isPushEvent = context.eventName === 'push';
  if (isPushEvent && isAutoSyncCommit()) {
    logger.info('检测到Push事件的自动同步提交，跳过分支同步避免级联触发');
    return [{ success: true }];
  }

  const results: BranchSyncResult[] = [];

  if (targetBranch === 'main') {
    // Main分支更新后：使用rebase向下游Beta分支同步
    logger.info('Main分支更新，使用rebase向Beta分支同步');

    const betaResult = await syncDownstreamWithRebase('main', 'beta', newVersion);
    results.push(betaResult);

    if (betaResult.success) {
      // Beta分支同步成功后，继续向Alpha分支merge
      logger.info('Main → Beta 同步成功，继续 Beta → Alpha merge同步');
      const alphaResult = await syncDownstream('beta', 'alpha', newVersion);
      results.push(alphaResult);
    } else {
      logger.warning('Main → Beta 同步失败，跳过 Beta → Alpha 级联同步');
    }
  } else if (targetBranch === 'beta') {
    // Beta分支更新后：使用merge向下游Alpha分支同步
    logger.info('Beta分支更新，使用merge向Alpha分支同步');
    const result = await syncDownstream('beta', 'alpha', newVersion);
    results.push(result);
  }
  // Alpha 分支更新时不自动同步，需要手动 PR 到 Beta

  return results;
}

// ==================== NPM 发布功能 ====================

/**
 * 检查是否启用npm发布
 */
function isNpmPublishEnabled(): boolean {
  const enablePublish = core.getInput('enable-npm-publish')?.toLowerCase();
  return enablePublish === 'true';
}

/**
 * 获取npm发布配置
 */
function getNpmPublishConfig() {
  const registry = core.getInput('npm-registry') || 'https://registry.npmjs.org/';
  const token = core.getInput('npm-token');
  const tag = core.getInput('npm-tag') || 'latest';
  const access = core.getInput('npm-access') || 'public';

  return { registry, token, tag, access };
}

/**
 * 配置npm认证
 */
async function configureNpmAuth(registry: string, token: string): Promise<void> {
  try {
    // 设置registry
    await exec('npm', ['config', 'set', 'registry', registry]);
    logger.info(`配置npm registry: ${registry}`);

    // 设置认证token
    if (token) {
      const registryUrl = new URL(registry);
      const authKey = `${registryUrl.host}/:_authToken`;
      await exec('npm', ['config', 'set', authKey, token]);
      logger.info('配置npm认证token');
    }
  } catch (error) {
    throw new ActionError(`配置npm认证失败: ${error}`, 'configureNpmAuth', error);
  }
}

/**
 * 确定npm发布标签
 */
function determineNpmTag(version: string, targetBranch: SupportedBranch, configTag: string): string {
  // 如果用户指定了特定标签，使用用户指定的标签
  if (configTag !== 'latest') {
    return configTag;
  }

  // 根据分支和版本自动确定标签
  if (targetBranch === 'main') {
    // 主分支使用latest标签
    return 'latest';
  } else if (targetBranch === 'beta') {
    // Beta分支使用beta标签
    return 'beta';
  } else if (targetBranch === 'alpha') {
    // Alpha分支使用alpha标签
    return 'alpha';
  }

  // 如果是预发布版本，根据prerelease标识确定标签
  const cleanVersion = VersionUtils.cleanVersion(version);
  const parsed = VersionUtils.parseVersion(cleanVersion);
  if (parsed?.prerelease && parsed.prerelease.length > 0) {
    const prereleaseId = parsed.prerelease[0] as string;
    if (prereleaseId === 'alpha') return 'alpha';
    if (prereleaseId === 'beta') return 'beta';
  }

  return 'latest';
}

/**
 * 执行npm发布
 */
async function publishToNpm(
  version: string,
  targetBranch: SupportedBranch,
  config: { registry: string; token: string; tag: string; access: string },
): Promise<void> {
  try {
    // 确定发布标签
    const publishTag = determineNpmTag(version, targetBranch, config.tag);

    logger.info(`准备发布到npm: 版本=${version}, 标签=${publishTag}, 分支=${targetBranch}`);

    // 配置npm认证
    await configureNpmAuth(config.registry, config.token);

    // 构建发布命令
    const publishArgs = ['publish'];

    // 添加访问权限
    if (config.access) {
      publishArgs.push('--access', config.access);
    }

    // 添加标签
    publishArgs.push('--tag', publishTag);

    // 执行发布
    await exec('npm', publishArgs);

    logger.info(`✅ 成功发布到npm: ${version} (标签: ${publishTag})`);

    // 设置输出
    core.setOutput('published-version', version);
    core.setOutput('published-tag', publishTag);
    core.setOutput('npm-registry', config.registry);
  } catch (error) {
    // 检查是否是版本已存在的错误
    const errorMessage = String(error);
    if (
      errorMessage.includes('version already exists') ||
      errorMessage.includes('You cannot publish over the previously published versions')
    ) {
      logger.warning(`版本 ${version} 已存在于npm registry，跳过发布`);
      return;
    }

    throw new ActionError(`npm发布失败: ${error}`, 'publishToNpm', error);
  }
}

/**
 * 处理npm发布逻辑 - 只对目标分支版本发布
 */
export async function handleNpmPublish(version: string, targetBranch: SupportedBranch): Promise<void> {
  if (!isNpmPublishEnabled()) {
    logger.info('npm发布已禁用，跳过');
    return;
  }

  try {
    logger.info(`开始npm发布流程: 版本=${version}, 目标分支=${targetBranch}`);

    const config = getNpmPublishConfig();

    // 验证必需的配置
    if (!config.token) {
      throw new ActionError('npm-token未配置，无法发布到npm', 'handleNpmPublish');
    }

    // 只对目标分支的版本进行发布，不处理下游分支
    await publishToNpm(version, targetBranch, config);

    logger.info(`✅ ${targetBranch}分支版本 ${version} npm发布完成`);
  } catch (error) {
    // npm发布失败不应该中断整个流程
    logger.error(`npm发布失败: ${error}`);
    core.setOutput('npm-publish-failed', 'true');
    core.setOutput('npm-publish-error', String(error));

    // 如果用户要求严格模式，则抛出错误
    const strictMode = core.getInput('npm-publish-strict')?.toLowerCase() === 'true';
    if (strictMode) {
      throw error;
    }
  }
}

// ==================== 版本更新和标签创建 ====================

/**
 * 更新版本并创建标签 - 支持基于PR的CHANGELOG生成和npm发布
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
    const { updatePackageVersion } = await import('./version');
    await updatePackageVersion(newVersion);

    // 提交版本更改并推送
    await commitAndPushVersion(newVersion, targetBranch);

    // 🎯 在打tag后更新 CHANGELOG - 使用PR信息
    await updateChangelog(pr, newVersion);

    // 检查是否有 CHANGELOG 更改需要提交
    const hasChanges = await hasFileChanges('CHANGELOG.md');
    if (hasChanges) {
      const fullVersion = VersionUtils.addVersionPrefix(newVersion);
      await commitAndPushFile('CHANGELOG.md', COMMIT_TEMPLATES.CHANGELOG_UPDATE(fullVersion), targetBranch);
      logger.info('✅ CHANGELOG 更新已提交');
    } else {
      logger.info('CHANGELOG 无更改，跳过提交');
    }

    // 🚀 发布到npm - 只对目标分支版本发布
    await handleNpmPublish(newVersion, targetBranch);
  } catch (error) {
    throw new ActionError(`版本更新和标签创建失败: ${error}`, 'updateVersionAndCreateTag', error);
  }
}
