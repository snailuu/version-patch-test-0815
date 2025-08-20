import { exec } from '@actions/exec';
import { context, getOctokit } from '@actions/github';
import { readPackageJSON, resolvePackageJSON, writePackageJSON } from 'pkg-types';
import semver, { type ReleaseType } from 'semver';
import core, { logger } from './core';

// ==================== 配置常量 ====================

/** 支持的分支列表 */
const SUPPORTED_BRANCHES = ['main', 'beta', 'alpha'] as const;

/** Git 用户配置 */
const GIT_USER_CONFIG = {
  name: 'GitHub Action',
  email: 'action@github.com',
} as const;

/** 默认版本号 */
const DEFAULT_VERSIONS = {
  base: '0.0.0',
  beta: '0.0.0-beta.0',
  alpha: '0.0.0-alpha.0',
} as const;

// ==================== 消息模板 ====================

/** 评论模板 */
const COMMENT_TEMPLATES = {
  /** 版本预览评论模板 */
  VERSION_PREVIEW: (data: {
    targetBranch: string;
    currentVersion?: string;
    nextVersion: string;
    releaseType: string;
  }) => `## 📦 版本预览

| 项目 | 值 |
|------|-----|
| **目标分支** | \`${data.targetBranch}\` |
| **当前版本** | \`${data.currentVersion || '无'}\` |
| **下一版本** | \`${data.nextVersion}\` |
| **发布类型** | \`${data.releaseType}\` |

> ℹ️ 这是预览模式，合并 PR 后将自动创建 tag 并更新版本。`,

  /** 错误评论模板 */
  ERROR: (errorMessage: string) => `## ❌ 版本管理错误

${errorMessage}

> 请确保在创建新功能之前，所有已有功能都已完成完整的发布流程（alpha → beta → main）。`,
} as const;

/** 错误消息 */
const ERROR_MESSAGES = {
  UNSUPPORTED_BRANCH: (branch: string) => `不支持的分支: ${branch}，跳过版本管理`,
  UNSUPPORTED_EVENT: (eventName: string) => `不支持的事件类型: ${eventName}`,
} as const;

/** 提交消息模板 */
const COMMIT_TEMPLATES = {
  VERSION_BUMP: (version: string, branch: string) => `chore: bump version to ${version} for ${branch}`,
  SYNC_BETA_TO_ALPHA: (version: string) => `chore: sync beta v${version} to alpha [skip ci]`,
  SYNC_MAIN_TO_BETA: (version: string) => `chore: sync main v${version} to beta [skip ci]`,
  FORCE_SYNC: (version: string) => `chore: force sync from main v${version} [skip ci]`,
} as const;

// ==================== 类型定义 ====================

type SupportedBranch = (typeof SUPPORTED_BRANCHES)[number];
type PRData = Awaited<ReturnType<typeof octokit.rest.pulls.get>>['data'];

interface VersionInfo {
  current: string;
  beta: string;
  currentTag: string | null;
  betaTag: string | null;
}

// ==================== GitHub API 客户端 ====================

/** 初始化 GitHub API 客户端 */
const octokit = getOctokit(core.getInput('token', { required: true }));

// ==================== 工具函数 ====================

/**
 * 配置 Git 用户信息
 */
async function signUser(): Promise<void> {
  logger.info('配置 Git 用户信息');
  await exec('git', ['config', '--global', 'user.name', GIT_USER_CONFIG.name]);
  await exec('git', ['config', '--global', 'user.email', GIT_USER_CONFIG.email]);
}

/**
 * 检查分支是否受支持
 */
function isSupportedBranch(branch: string): branch is SupportedBranch {
  return SUPPORTED_BRANCHES.includes(branch as SupportedBranch);
}

// ==================== PR 信息获取 ====================

/**
 * 获取最近合并到目标分支的 PR 信息
 * 在 push 事件中使用，用于获取 PR 标签
 */
async function getRecentMergedPR(targetBranch: string): Promise<PRData | null> {
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
async function getCurrentPR(): Promise<PRData | null> {
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

// ==================== 版本管理 ====================

/**
 * 获取指定分支的最新 git tag 版本
 */
async function getLatestTagVersion(branchSuffix: string = ''): Promise<string | null> {
  try {
    let stdout = '';
    const pattern = branchSuffix ? `v*-${branchSuffix}.*` : 'v*';

    await exec('git', ['tag', '-l', pattern, '--sort=-version:refname'], {
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
      },
    });

    let tags = stdout
      .trim()
      .split('\n')
      .filter((tag) => tag.trim().length > 0);

    // 如果是获取 main 分支版本（branchSuffix 为空），只保留正式版本（不包含 prerelease）
    if (!branchSuffix) {
      tags = tags.filter((tag) => {
        // 正式版本格式：v1.2.3，不包含 `-`
        // 排除 prerelease 版本：v1.2.3-alpha.0, v1.2.3-beta.0
        return !tag.includes('-');
      });
      logger.info(`过滤后的 main 分支正式版本标签: ${tags.join(', ') || '无'}`);
    }

    if (tags.length === 0) {
      logger.info(`未找到 ${branchSuffix || 'main'} 分支的 tag`);
      return null;
    }

    const latestTag = tags[0];
    // 保持 v 前缀返回完整标签名
    logger.info(`获取最新 ${branchSuffix || 'main'} tag: ${latestTag}`);
    return latestTag;
  } catch (error) {
    logger.warning(`获取 ${branchSuffix || 'main'} tag 失败: ${error}`);
    return null;
  }
}

/**
 * 获取版本信息
 */
async function getVersionInfo(targetBranch: SupportedBranch): Promise<VersionInfo> {
  const currentTagVersion = await getLatestTagVersion(targetBranch === 'main' ? '' : targetBranch);
  const betaTagVersion = await getLatestTagVersion('beta');

  const current = currentTagVersion || DEFAULT_VERSIONS.base;
  const beta = betaTagVersion || DEFAULT_VERSIONS.beta;

  logger.info(`当前 ${targetBranch} tag 版本: ${currentTagVersion || '无'}`);
  logger.info(`当前使用版本: ${current}`);
  logger.info(`beta tag 版本: ${betaTagVersion || '无'}`);

  return {
    current,
    beta,
    currentTag: currentTagVersion,
    betaTag: betaTagVersion,
  };
}

// ==================== PR 评论管理 ====================

/**
 * 创建或更新 PR 评论
 */
async function updatePRComment(prNumber: number, commentBody: string, identifier: string): Promise<void> {
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
async function createVersionPreviewComment(
  prNumber: number,
  data: {
    targetBranch: string;
    currentVersion?: string;
    nextVersion: string;
    releaseType: string;
  },
): Promise<void> {
  const commentBody = COMMENT_TEMPLATES.VERSION_PREVIEW(data);
  await updatePRComment(prNumber, commentBody, '## 📦 版本预览');
}

// ==================== 版本计算 ====================

// 判断新标签的级别
function getReleaseLevel(release: ReleaseType): 'major' | 'minor' | 'patch' {
  if (release === 'premajor') return 'major';
  if (release === 'preminor') return 'minor';
  return 'patch';
}

/**
 * 根据 PR 标签确定版本发布类型
 */
function getReleaseTypeFromLabel(labels: { name: string }[] = []): ReleaseType | '' {
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
 * 计算新版本号 - 统一版本升级逻辑
 */
async function calculateNewVersion(
  targetBranch: SupportedBranch,
  versionInfo: VersionInfo,
  releaseType: ReleaseType | '',
): Promise<string | null> {
  // 获取上游分支的版本作为基础版本
  const baseVersion = await getBaseVersion(targetBranch, versionInfo);
  if (!baseVersion) {
    logger.error(`无法获取 ${targetBranch} 分支的基础版本`);
    return null;
  }

  logger.info(`${targetBranch} 分支基础版本: ${baseVersion}`);

  // 统一的版本升级逻辑
  return calculateVersionUpgrade(baseVersion, targetBranch, releaseType);
}

/**
 * 获取全局最新版本（比较所有分支）
 */
async function getLatestGlobalVersion(): Promise<string> {
  // 获取所有分支的最新版本
  const mainVersion = await getLatestTagVersion(''); // 正式版本
  const betaVersion = await getLatestTagVersion('beta'); // Beta版本
  const alphaVersion = await getLatestTagVersion('alpha'); // Alpha版本

  const versions = [mainVersion, betaVersion, alphaVersion].filter(Boolean);

  if (versions.length === 0) {
    return `v${DEFAULT_VERSIONS.base}`;
  }

  // 找到最高的基础版本号
  let highestBaseVersion = '0.0.0';

  for (const version of versions) {
    const cleanVersion = version!.replace(/^v/, '');
    const parsed = semver.parse(cleanVersion);
    if (parsed) {
      const baseVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
      if (semver.gt(baseVersion, highestBaseVersion)) {
        highestBaseVersion = baseVersion;
      }
    }
  }

  logger.info(`全局版本比较: main=${mainVersion}, beta=${betaVersion}, alpha=${alphaVersion}`);
  logger.info(`全局最高基础版本: v${highestBaseVersion}`);

  return `v${highestBaseVersion}`;
}

/**
 * 获取目标分支的基础版本
 */
async function getBaseVersion(targetBranch: SupportedBranch, versionInfo: VersionInfo): Promise<string | null> {
  switch (targetBranch) {
    case 'alpha': {
      // Alpha 需要比较全局最新版本和当前版本
      const globalLatestVersion = await getLatestGlobalVersion();
      const currentAlphaVersion = versionInfo.currentTag || `v${DEFAULT_VERSIONS.base}`;

      // 比较全局版本和当前Alpha的基础版本
      const globalBase = globalLatestVersion.replace(/^v/, '');
      const currentAlphaClean = currentAlphaVersion.replace(/^v/, '');
      const currentAlphaParsed = semver.parse(currentAlphaClean);

      if (currentAlphaParsed) {
        const currentAlphaBase = `${currentAlphaParsed.major}.${currentAlphaParsed.minor}.${currentAlphaParsed.patch}`;

        // 如果全局版本更高，使用全局版本；否则使用当前Alpha版本
        if (semver.gt(globalBase, currentAlphaBase)) {
          logger.info(`Alpha版本落后，从全局版本 ${globalLatestVersion} 开始升级`);
          return globalLatestVersion;
        } else {
          logger.info(`Alpha版本同步，从当前版本 ${currentAlphaVersion} 继续升级`);
          return currentAlphaVersion;
        }
      }

      return globalLatestVersion;
    }

    case 'beta': {
      // Beta 基于 Alpha 的最新版本进行升级
      const alphaVersion = await getLatestTagVersion('alpha');
      return alphaVersion || `v${DEFAULT_VERSIONS.base}`;
    }

    case 'main': {
      // Main 基于 Beta 的最新版本去掉prerelease标识
      const betaVersion = await getLatestTagVersion('beta');
      return betaVersion || `v${DEFAULT_VERSIONS.base}`;
    }

    default:
      return null;
  }
}

/**
 * 统一的版本升级计算逻辑
 */
function calculateVersionUpgrade(
  baseVersion: string,
  targetBranch: SupportedBranch,
  releaseType: ReleaseType | '',
): string | null {
  const cleanVersion = baseVersion.replace(/^v/, '');
  const parsed = semver.parse(cleanVersion);

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

  return newVersion ? `v${newVersion}` : null;
}

/**
 * 根据标签计算版本升级
 */
function calculateVersionWithLabel(
  baseVersion: string,
  targetBranch: SupportedBranch,
  releaseType: ReleaseType,
): string | null {
  const parsed = semver.parse(baseVersion);
  if (!parsed) return null;

  const isPrerelease = parsed.prerelease && parsed.prerelease.length > 0;
  const currentBranchType = isPrerelease ? (parsed.prerelease[0] as string) : 'release';

  // 标签级别优先级
  const labelPriority = { patch: 1, minor: 2, major: 3 };
  const currentPriority = getCurrentVersionPriority(parsed);
  const labelPriority_value = labelPriority[getReleaseLevel(releaseType)];

  logger.info(
    `版本升级分析: 基础版本=${baseVersion}, 当前优先级=${currentPriority}, 标签优先级=${labelPriority_value}`,
  );

  // 特殊处理：如果基础版本来自不同分支类型，重新开始计数
  if (targetBranch === 'alpha' && currentBranchType !== 'alpha') {
    logger.info(`检测到基础版本跨分支变化 (${currentBranchType} -> alpha)，重新开始Alpha计数`);
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

  const parsed = semver.parse(baseVersion);
  if (!parsed) return null;

  // Beta 和 Main 分支根据上游版本自动升级
  if (targetBranch === 'beta') {
    // 从 alpha 版本生成 beta 版本
    const baseVersionStr = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    return `${baseVersionStr}-beta.0`;
  } else if (targetBranch === 'main') {
    // 从 beta 版本生成正式版本
    return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  }

  return null;
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

// ==================== Git 操作 ====================

/**
 * 更新 CHANGELOG
 */
async function updateChangelog(): Promise<void> {
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

/**
 * 更新版本并创建标签
 */
async function updateVersionAndCreateTag(newVersion: string, targetBranch: SupportedBranch): Promise<void> {
  logger.info('开始执行版本更新...');

  await exec('git', ['switch', targetBranch]);

  // 移除 v 前缀更新 package.json（package.json 中不使用 v 前缀）
  const packageVersion = newVersion.replace(/^v/, '');
  const pkgPath = await resolvePackageJSON();
  const pkgInfo = await readPackageJSON(pkgPath);
  pkgInfo.version = packageVersion;
  await writePackageJSON(pkgPath, pkgInfo);
  logger.info('版本文件已更新');

  // 提交版本更改并推送
  await exec('git', ['add', '.']);
  await exec('git', ['commit', '-m', COMMIT_TEMPLATES.VERSION_BUMP(packageVersion, targetBranch)]);

  // 创建版本标签（newVersion 已包含 v 前缀）
  await exec('git', ['tag', newVersion]);
  logger.info(`已创建标签: ${newVersion}`);

  // 推送更改和标签
  await exec('git', ['push', 'origin', targetBranch]);
  await exec('git', ['push', 'origin', newVersion]);

  // 在打tag后更新 CHANGELOG
  await updateChangelog();

  // 检查是否有 CHANGELOG 更改需要提交
  try {
    // 首先检查 CHANGELOG.md 是否存在
    let changelogExists = false;
    try {
      await exec('test', ['-f', 'CHANGELOG.md']);
      changelogExists = true;
    } catch {
      // 文件不存在
      changelogExists = false;
    }

    if (!changelogExists) {
      logger.info('CHANGELOG.md 文件不存在，跳过提交检查');
      return;
    }

    // 检查是否有 CHANGELOG 文件更改
    let hasChanges = false;
    try {
      // 首先检查文件是否未被跟踪（新文件）
      let stdout = '';
      await exec('git', ['status', '--porcelain', 'CHANGELOG.md'], {
        listeners: {
          stdout: (data: Buffer) => {
            stdout += data.toString();
          },
        },
      });

      // 如果有输出，说明文件有变化（新文件或修改文件）
      if (stdout.trim().length > 0) {
        hasChanges = true;
        logger.info(`检测到 CHANGELOG.md 变化: ${stdout.trim()}`);
      } else {
        // 如果 git status 无输出，再用 git diff 检查已跟踪文件的变化
        try {
          await exec('git', ['diff', '--exit-code', 'CHANGELOG.md']);
          hasChanges = false;
        } catch {
          hasChanges = true;
        }
      }
    } catch (error) {
      logger.warning(`检查 CHANGELOG 变化失败: ${error}`);
      hasChanges = false;
    }

    if (hasChanges) {
      await exec('git', ['add', 'CHANGELOG.md']);
      await exec('git', ['commit', '-m', `docs: update CHANGELOG for ${newVersion}`]);
      await exec('git', ['push', 'origin', targetBranch]);
      logger.info('CHANGELOG 更新已提交并推送');
    } else {
      logger.info('CHANGELOG 无更改，跳过提交');
    }
  } catch (error) {
    logger.warning(`CHANGELOG 提交失败: ${error}`);
  }
}

/**
 * 执行分支同步 - 智能同步避免级联触发
 */
async function syncBranches(targetBranch: SupportedBranch, newVersion: string): Promise<void> {
  // 检查是否为自动同步提交，避免无限循环
  if (isAutoSyncCommit()) {
    logger.info('检测到自动同步提交，跳过分支同步避免级联触发');
    return;
  }

  if (targetBranch === 'main') {
    // Main 更新后，向下游同步稳定代码: Main → Beta → Alpha
    logger.info('Main分支更新，开始向下游同步稳定代码');
    await syncDownstream('main', 'beta', newVersion);
    // 注意：不再自动触发 Beta → Alpha，让Beta分支的工作流处理
  } else if (targetBranch === 'beta') {
    // Beta 更新后，只向 Alpha 同步测试代码: Beta → Alpha
    logger.info('Beta分支更新，向Alpha同步测试代码');
    await syncDownstream('beta', 'alpha', newVersion);
  }
  // Alpha 分支更新时不自动同步，需要手动 PR 到 Beta
}

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
 * 同步上游分支到下游分支
 */
async function syncDownstream(
  sourceBranch: SupportedBranch,
  targetBranch: SupportedBranch,
  sourceVersion: string,
): Promise<void> {
  logger.info(`开始同步 ${sourceBranch} -> ${targetBranch}`);

  try {
    // 切换到目标分支
    await exec('git', ['fetch', 'origin', targetBranch]);
    await exec('git', ['switch', targetBranch]);

    // 尝试合并源分支
    const commitMessage = getCommitMessage(sourceBranch, targetBranch, sourceVersion);

    try {
      await exec('git', ['merge', sourceBranch, '--no-edit', '--no-ff', '-m', commitMessage]);
      logger.info(`${sourceBranch} -> ${targetBranch} 合并成功`);
    } catch (_error) {
      logger.warning(`${sourceBranch} -> ${targetBranch} 合并冲突，进行强制同步`);
      await handleMergeConflict(sourceBranch, targetBranch, sourceVersion);
    }

    // 推送更改
    await exec('git', ['push', 'origin', targetBranch, '--force-with-lease']);
    logger.info(`${targetBranch} 分支同步完成`);
  } catch (error) {
    logger.error(`${sourceBranch} -> ${targetBranch} 同步失败: ${error}`);
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
    await exec('git', ['merge', '--abort']); // 取消当前合并

    // 第二步：使用策略合并，优先采用源分支的版本文件
    await exec('git', [
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
      throw new Error(`无法自动解决 ${sourceBranch} -> ${targetBranch} 的合并冲突，已创建issue需要人工介入`);
    }
  }
}

/**
 * 手动解决版本相关冲突
 */
async function resolveVersionConflicts(
  sourceBranch: SupportedBranch,
  targetBranch: SupportedBranch,
  sourceVersion: string,
): Promise<void> {
  // 取消合并
  await exec('git', ['merge', '--abort']);

  // 只合并非冲突文件，跳过版本文件
  await exec('git', ['merge', sourceBranch, '--no-commit', '--no-ff']);

  // 手动处理package.json版本冲突
  const pkgPath = await resolvePackageJSON();
  const sourcePkg = await readPackageJSON(pkgPath);

  // 确定正确的版本号
  const correctVersion = sourceVersion.replace(/^v/, '');
  sourcePkg.version = correctVersion;

  await writePackageJSON(pkgPath, sourcePkg);
  await exec('git', ['add', 'package.json']);

  // 完成合并
  const commitMessage = `${getCommitMessage(sourceBranch, targetBranch, sourceVersion)} (resolved version conflicts)`;
  await exec('git', ['commit', '-m', commitMessage]);

  logger.info(`手动解决版本冲突完成: ${sourceBranch} -> ${targetBranch}`);
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

// ==================== 主执行函数 ====================

/**
 * 主执行函数 - 自动版本升级和分支同步
 */
async function run(): Promise<void> {
  try {
    // 获取目标分支和事件信息
    let targetBranch = context.ref.split('/').pop()!;
    const isDryRun = context.eventName === 'pull_request';

    // 获取 PR 信息
    let pr: PRData | null = null;
    if (context.payload.pull_request) {
      pr = await getCurrentPR();
      if (!pr || !pr.base) {
        logger.error('无法获取有效的 PR 信息');
        return;
      }
      targetBranch = pr.base.ref || context.payload.pull_request.base.ref;
      logger.info(`PR 事件 (预览模式)，目标分支为: ${targetBranch}`);
    } else if (context.eventName === 'push') {
      pr = await getRecentMergedPR(targetBranch);
      if (!pr) {
        logger.warning('未找到最近合并的 PR，将跳过标签检查');
      }
      logger.info(`Push 事件 (执行模式)，目标分支为: ${targetBranch}`);
    } else {
      logger.info(ERROR_MESSAGES.UNSUPPORTED_EVENT(context.eventName));
      return;
    }

    // 检查分支支持
    if (!isSupportedBranch(targetBranch)) {
      logger.info(ERROR_MESSAGES.UNSUPPORTED_BRANCH(targetBranch));
      return;
    }

    logger.info(`目标分支: ${targetBranch} ${isDryRun ? '(预览模式)' : '(执行模式)'}`);

    // 配置 Git 用户信息
    await signUser();

    // 获取版本信息
    const versionInfo = await getVersionInfo(targetBranch);

    // 确定版本升级类型
    const releaseType = getReleaseTypeFromLabel(pr?.labels);
    logger.info(`版本升级类型: ${releaseType}`);

    // 计算新版本号
    const newVersion = await calculateNewVersion(targetBranch, versionInfo, releaseType);
    logger.info(`${isDryRun ? '预览' : '新'}版本: ${newVersion}`);

    if (!newVersion) {
      logger.info('无需版本升级，跳过');

      // 如果是预览模式，更新 PR 评论显示跳过信息
      if (isDryRun) {
        const prNumber = pr?.number || context.payload.pull_request?.number;
        if (prNumber) {
          const skipComment = `## ⏭️ 版本管理跳过

| 项目 | 值 |
|------|-----|
| **目标分支** | \`${targetBranch}\` |
| **当前版本** | \`${versionInfo.currentTag || '无'}\` |
| **状态** | \`跳过 - 无需升级\` |

> ℹ️ 根据当前分支状态和标签，无需进行版本升级。`;
          await updatePRComment(prNumber, skipComment, '## ⏭️ 版本管理跳过');
        }
      }

      return;
    }

    if (isDryRun) {
      // 预览模式：创建版本预览评论
      const prNumber = pr?.number || context.payload.pull_request?.number;
      if (prNumber) {
        await createVersionPreviewComment(prNumber, {
          targetBranch,
          currentVersion: versionInfo.currentTag || undefined,
          nextVersion: newVersion,
          releaseType,
        });
      }

      core.setOutput('preview-version', newVersion);
      core.setOutput('is-preview', 'true');
      return;
    }

    // 执行模式：更新版本并同步分支
    await updateVersionAndCreateTag(newVersion, targetBranch);
    await syncBranches(targetBranch, newVersion);

    core.setOutput('next-version', newVersion);
    core.setOutput('is-preview', 'false');
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

// ==================== 执行入口 ====================

run();
