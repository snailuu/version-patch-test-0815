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
  INCOMPLETE_FEATURES: (versions: string[]) =>
    `❌ **不允许合并新功能到alpha分支**\n\n当前存在未完成的功能版本：${versions.join(', ')}\n\n请确保所有已有功能都完成完整的发布流程（alpha → beta → main）后，再进行新功能的开发。`,

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

interface IncompleteFeatureCheck {
  hasIncomplete: boolean;
  incompleteVersions: string[];
}

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

    const tags = stdout
      .trim()
      .split('\n')
      .filter((tag) => tag.trim().length > 0);

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

// ==================== 功能完成度检查 ====================

/**
 * 检查 alpha 版本是否已经封版（对应的 beta 版本是否存在）
 */
async function isAlphaVersionSealed(alphaVersion: string): Promise<boolean> {
  try {
    const parsed = semver.parse(alphaVersion);
    if (!parsed || !parsed.prerelease || parsed.prerelease[0] !== 'alpha') {
      return false;
    }

    const baseVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`;

    try {
      let stdout = '';
      await exec('git', ['tag', '-l', `v${baseVersion}-beta.*`], {
        listeners: {
          stdout: (data: Buffer) => {
            stdout += data.toString();
          },
        },
      });

      const betaTags = stdout.trim();
      const hasBetalTags = betaTags.length > 0;

      if (hasBetalTags) {
        const tagList = betaTags.split('\n').filter((tag) => tag.trim().length > 0);
        logger.info(
          `检查封版状态: ${alphaVersion} 基础版本 ${baseVersion} 已封版 (找到 ${tagList.length} 个beta版本: ${tagList.join(', ')})`,
        );
      } else {
        logger.info(`检查封版状态: ${alphaVersion} 基础版本 ${baseVersion} 未封版 (无beta版本)`);
      }

      return hasBetalTags;
    } catch {
      logger.info(`检查封版状态: ${alphaVersion} 基础版本 ${baseVersion} 未封版 (git tag 查询失败)`);
      return false;
    }
  } catch (error) {
    logger.warning(`封版检测失败: ${error}`);
    return false;
  }
}

/**
 * 检查是否有未完成的功能（alpha已合并到beta但未发布到main）
 */
async function checkIncompleteFeatures(): Promise<IncompleteFeatureCheck> {
  try {
    const mainTagVersion = await getLatestTagVersion('');
    const betaTagVersion = await getLatestTagVersion('beta');
    const alphaTagVersion = await getLatestTagVersion('alpha');

    logger.info(`检查未完成功能: main=${mainTagVersion}, beta=${betaTagVersion}, alpha=${alphaTagVersion}`);

    // 如果没有beta tag，说明没有未完成的功能
    if (!betaTagVersion) {
      logger.info('没有beta版本，无未完成功能');
      return { hasIncomplete: false, incompleteVersions: [] };
    }

    // 如果没有main tag，说明有未完成的功能
    if (!mainTagVersion) {
      logger.info('没有main版本，存在未完成功能');
      return { hasIncomplete: true, incompleteVersions: [betaTagVersion] };
    }

    // 比较beta和main版本，如果beta版本更高，说明有未完成的功能
    const betaParsed = semver.parse(betaTagVersion);
    const mainParsed = semver.parse(mainTagVersion);

    if (!betaParsed || !mainParsed) {
      logger.warning('版本解析失败');
      return { hasIncomplete: false, incompleteVersions: [] };
    }

    // 比较基础版本号（不包括prerelease）
    const betaBase = `${betaParsed.major}.${betaParsed.minor}.${betaParsed.patch}`;
    const mainBase = `${mainParsed.major}.${mainParsed.minor}.${mainParsed.patch}`;

    if (semver.gt(betaBase, mainBase)) {
      logger.info(`存在未完成功能: beta基础版本(${betaBase}) > main版本(${mainBase})`);
      return { hasIncomplete: true, incompleteVersions: [betaTagVersion] };
    }

    logger.info('没有未完成功能');
    return { hasIncomplete: false, incompleteVersions: [] };
  } catch (error) {
    logger.warning(`检查未完成功能失败: ${error}`);
    return { hasIncomplete: false, incompleteVersions: [] };
  }
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
 * 创建错误评论
 */
async function createErrorComment(prNumber: number, errorMessage: string): Promise<void> {
  const commentBody = COMMENT_TEMPLATES.ERROR(errorMessage);
  await updatePRComment(prNumber, commentBody, '## ❌ 版本管理错误');
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

// 判断当前版本隐含的最高标签级别
function getCurrentVersionLevel(parsed: semver.SemVer): 'major' | 'minor' | 'patch' {
  if (parsed.major > 0) return 'major';
  if (parsed.minor > 0) return 'minor';
  return 'patch';
}

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
 * 计算新版本号
 */
async function calculateNewVersion(
  targetBranch: SupportedBranch,
  versionInfo: VersionInfo,
  releaseType: ReleaseType,
): Promise<string | null> {
  const { beta, currentTag, betaTag } = versionInfo;

  if (targetBranch === 'alpha') {
    if (!currentTag) {
      logger.info('没有找到 alpha tag，创建第一个 alpha 版本');
      const baseVersion = betaTag ? betaTag.replace(/^v/, '') : DEFAULT_VERSIONS.base;
      const newVersion = semver.inc(baseVersion, releaseType, 'alpha');
      return newVersion ? `v${newVersion}` : null;
    }

    // 移除 v 前缀进行 semver 计算
    const currentVersion = currentTag.replace(/^v/, '');
    const lastSemver = semver.parse(currentVersion);
    if (lastSemver && (!lastSemver.prerelease || lastSemver.prerelease[0] !== 'alpha')) {
      logger.info(`上一个版本 (${currentTag}) 来自 beta 或 main, 需要提升版本。`);
      const newVersion = semver.inc(currentVersion, releaseType, 'alpha');
      return newVersion ? `v${newVersion}` : null;
    }

    const isSealed = await isAlphaVersionSealed(currentVersion);
    if (isSealed) {
      logger.info(`当前 alpha 版本 (${currentTag}) 已封版，重新计数。`);
      const betaVersion = betaTag ? betaTag.replace(/^v/, '') : DEFAULT_VERSIONS.beta;
      const newVersion = semver.inc(betaVersion, releaseType, 'alpha');
      return newVersion ? `v${newVersion}` : null;
    }

    // 根据 releaseType 决定版本升级策略 - 保持高版本原则
    if (releaseType && releaseType !== 'prerelease') {
      const currentParsed = semver.parse(currentVersion);
      if (!currentParsed) {
        logger.error(`无法解析当前版本: ${currentVersion}`);
        return null;
      }

      

      // 标签级别优先级 (数字越大优先级越高)
      const levelPriority = { patch: 1, minor: 2, major: 3 };

      const currentLevel = getCurrentVersionLevel(currentParsed);
      const newLevel = getReleaseLevel(releaseType);
      const currentBase = `${currentParsed.major}.${currentParsed.minor}.${currentParsed.patch}`;

      logger.info(`版本级别比较: 当前 ${currentLevel}(${currentBase}) vs 新标签 ${newLevel}`);

      if (levelPriority[newLevel] > levelPriority[currentLevel]) {
        // 新标签级别更高，升级版本
        logger.info(`${newLevel} 标签级别高于当前 ${currentLevel}，升级版本`);
        const newVersion = semver.inc(currentVersion, releaseType, 'alpha');
        return newVersion ? `v${newVersion}` : null;
      } else if (levelPriority[newLevel] === levelPriority[currentLevel]) {
        // 同级别，递增 prerelease
        logger.info(`${newLevel} 标签与当前 ${currentLevel} 同级别，递增 prerelease`);
        const incrementedVersion = semver.inc(currentVersion, 'prerelease', 'alpha');
        return incrementedVersion ? `v${incrementedVersion}` : null;
      } else {
        // 新标签级别更低，保持高版本，只递增 prerelease
        logger.info(`${newLevel} 标签级别低于当前 ${currentLevel}，保持高版本，递增 prerelease`);
        const incrementedVersion = semver.inc(currentVersion, 'prerelease', 'alpha');
        return incrementedVersion ? `v${incrementedVersion}` : null;
      }
    } else {
      // 没有版本升级标签，跳过版本更新
      logger.info(`当前 alpha 版本 (${currentTag}) 无版本标签，跳过版本更新`);
      return null;
    }
  }

  if (targetBranch === 'beta') {
    const baseVersion = betaTag ? betaTag.replace(/^v/, '') : DEFAULT_VERSIONS.beta;
    const newVersion = semver.inc(baseVersion, 'prerelease', 'beta');
    return newVersion ? `v${newVersion}` : null;
  }

  if (targetBranch === 'main') {
    const baseVersion = currentTag ? currentTag.replace(/^v/, '') : DEFAULT_VERSIONS.base;
    const newVersion = semver.inc(baseVersion, 'patch');
    return newVersion ? `v${newVersion}` : null;
  }

  return null;
}

// ==================== Git 操作 ====================

/**
 * 更新 CHANGELOG
 */
async function updateChangelog(newVersion: string): Promise<void> {
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
        '-p', 'conventionalcommits',
        '-i', 'CHANGELOG.md',
        '-s',
        '-r', '0'  // 包含所有发布记录
      ]);
    }
    
    // 如果上面的步骤没有创建文件，使用标准增量更新
    try {
      await exec('ls', ['CHANGELOG.md']);
    } catch {
      // 使用 npx 确保能找到包，即使没有全局安装
      await exec('npx', [
        'conventional-changelog-cli',
        '-p', 'conventionalcommits',
        '-i', 'CHANGELOG.md',
        '-s'
      ]);
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
        '-p', 'conventionalcommits', 
        '-i', 'CHANGELOG.md',
        '-s',
        '-r', '0'
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
  await updateChangelog(packageVersion);

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
      await exec('git', ['diff', '--exit-code', 'CHANGELOG.md']);
      // 如果没有抛出异常，说明没有更改
      hasChanges = false;
    } catch {
      // 如果 git diff 返回非零退出码，说明有更改
      hasChanges = true;
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
 * 执行分支同步
 */
async function syncBranches(targetBranch: SupportedBranch, newVersion: string): Promise<void> {
  if (targetBranch === 'beta') {
    await syncBetaToAlpha(newVersion);
  } else if (targetBranch === 'main') {
    await syncMainToBeta(newVersion);
  }
}

/**
 * 同步 beta 到 alpha
 */
async function syncBetaToAlpha(newVersion: string): Promise<void> {
  await exec('git', ['fetch', 'origin', 'alpha']);
  await exec('git', ['switch', 'alpha']);

  const alphaTagVersion = await getLatestTagVersion('alpha');
  const alphaCurrentVersion = alphaTagVersion || DEFAULT_VERSIONS.alpha;

  logger.info(`alpha tag 版本 ${alphaTagVersion || '无'}`);
  logger.info(`beta tag 版本 ${newVersion}`);

  try {
    await exec('git', ['merge', 'beta', '--no-edit', '--no-ff', '-m', COMMIT_TEMPLATES.SYNC_BETA_TO_ALPHA(newVersion)]);
  } catch {
    logger.warning('Alpha 合并冲突');

    if (alphaTagVersion && semver.gt(alphaTagVersion, newVersion)) {
      logger.info('Alpha 版本号大于 beta 版本号, 忽略版本变更');
      const pkgPath = await resolvePackageJSON();
      const newAlphaPkgInfo = await readPackageJSON(pkgPath);
      newAlphaPkgInfo.version = alphaCurrentVersion;
      await writePackageJSON(pkgPath, newAlphaPkgInfo);
      await exec('git', ['add', '.']);
      await exec('git', ['commit', '-m', COMMIT_TEMPLATES.SYNC_BETA_TO_ALPHA(newVersion)]);
    } else {
      logger.error('Alpha 版本号小于 beta 版本号, 无法自动合并');
    }
  }

  try {
    await exec('git', ['push', 'origin', 'alpha', '--force-with-lease']);
  } catch {
    logger.info('Alpha 推送失败');
  }
}

/**
 * 同步 main 到 beta
 */
async function syncMainToBeta(newVersion: string): Promise<void> {
  await exec('git', ['fetch', 'origin', 'main']);
  await exec('git', ['fetch', 'origin', 'beta']);
  await exec('git', ['switch', 'beta']);

  try {
    await exec('git', [
      'merge',
      'origin/main',
      '--no-edit',
      '--no-ff',
      '-m',
      COMMIT_TEMPLATES.SYNC_MAIN_TO_BETA(newVersion),
    ]);
  } catch {
    logger.info('Beta 合并冲突, 强制同步');
    await exec('git', ['reset', '--hard', 'origin/main']);
    await exec('git', ['commit', '--allow-empty', '-m', COMMIT_TEMPLATES.FORCE_SYNC(newVersion)]);
  }

  try {
    await exec('git', ['push', 'origin', 'beta', '--force-with-lease']);
  } catch {
    logger.info('Beta 推送失败');
  }
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

    // 检查 alpha 分支的功能完成度
    if (targetBranch === 'alpha') {
      const { hasIncomplete, incompleteVersions } = await checkIncompleteFeatures();

      if (hasIncomplete) {
        const errorMessage = ERROR_MESSAGES.INCOMPLETE_FEATURES(incompleteVersions);
        logger.error(errorMessage);

        if (isDryRun) {
          const prNumber = pr?.number || context.payload.pull_request?.number;
          if (prNumber) {
            await createErrorComment(prNumber, errorMessage);
          }
        }

        core.setFailed('存在未完成的功能，不允许合并新功能到alpha分支');
        return;
      }
    }

    // 确定版本升级类型
    const releaseType = getReleaseTypeFromLabel(pr?.labels);
    logger.info(`版本升级类型: ${releaseType}`);

    if (!releaseType) {
      logger.warning('版本升级类型为空, 跳过');
      
      // 如果是预览模式，更新 PR 评论显示跳过信息
      if (isDryRun) {
        const prNumber = pr?.number || context.payload.pull_request?.number;
        if (prNumber) {
          const skipComment = `## ⏭️ 版本管理跳过

| 项目 | 值 |
|------|-----|
| **目标分支** | \`${targetBranch}\` |
| **当前版本** | \`${versionInfo.currentTag || '无'}\` |
| **状态** | \`跳过 - 无版本标签\` |

> ℹ️ 没有检测到版本标签（major/minor/patch），跳过版本更新。`;
          await updatePRComment(prNumber, skipComment, '## ⏭️ 版本管理跳过');
        }
      }
      
      return;
    }

    // 计算新版本号
    const newVersion = await calculateNewVersion(targetBranch, versionInfo, releaseType);
    logger.info(`${isDryRun ? '预览' : '新'}版本: ${newVersion}`);

    if (!newVersion) {
      logger.error('无法计算新版本号');
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
