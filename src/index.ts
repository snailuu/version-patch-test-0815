import { exec } from '@actions/exec';
import { context, getOctokit } from '@actions/github';
import { readPackageJSON, resolvePackageJSON, writePackageJSON } from 'pkg-types';
import semver, { type ReleaseType } from 'semver';
import core, { logger } from './core';

/**
 * 配置 Git 用户信息
 * 为 GitHub Action 设置全局 Git 用户名和邮箱，用于后续的 Git 提交操作
 */
async function signUser() {
  logger.info('sign action user');
  await exec('git', ['config', '--global', 'user.name', 'GitHub Action']);
  await exec('git', ['config', '--global', 'user.email', 'action@github.com']);
}

// 初始化 GitHub API 客户端，使用 GitHub Token 进行认证
const octokit = (() => {
  return getOctokit(core.getInput('token', { required: true }));
})();

/**
 * 获取最近合并到目标分支的 PR 信息
 * 在 push 事件中使用，用于获取 PR 标签
 */
async function getRecentMergedPR(targetBranch: string) {
  try {
    // 获取最近的提交，查找合并提交
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha: targetBranch,
      per_page: 10
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
            pull_number: prNumber
          });
          logger.info(`找到最近合并的 PR #${prNumber}`);
          return pr;
        }
      }
    }
    
    logger.info('未找到最近合并的 PR');
    return {} as any;
  } catch (error) {
    logger.warning(`获取最近合并的 PR 失败: ${error}`);
    return {} as any;
  }
}

/**
 * 获取当前 Pull Request 信息
 * 如果当前事件不是 PR 事件，返回空对象；否则从 GitHub API 获取完整的 PR 信息
 */
async function getCurentPR() {
  if (!context.payload.pull_request) {
    return {} as Awaited<ReturnType<typeof octokit.rest.pulls.get>>['data'];
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  });

  return pr;
}

/**
 * 获取指定分支的最新 git tag 版本
 * @param branchSuffix 分支后缀，如 'alpha', 'beta', 或空字符串表示正式版本
 * @returns 最新的 tag 版本号，如果没有找到则返回 null
 */
async function getLatestTagVersion(branchSuffix: string = ''): Promise<string | null> {
  try {
    let stdout = '';
    const pattern = branchSuffix ? `*-${branchSuffix}.*` : '*';
    
    await exec('git', ['tag', '-l', pattern, '--sort=-version:refname'], {
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        }
      }
    });
    
    const tags = stdout.trim().split('\n').filter(tag => tag.trim().length > 0);
    
    if (tags.length === 0) {
      logger.info(`未找到 ${branchSuffix || 'main'} 分支的 tag`);
      return null;
    }
    
    const latestTag = tags[0];
    logger.info(`获取最新 ${branchSuffix || 'main'} tag: ${latestTag}`);
    return latestTag;
  } catch (error) {
    logger.warning(`获取 ${branchSuffix || 'main'} tag 失败: ${error}`);
    return null;
  }
}

/**
 * 检查 alpha 版本是否已经封版（对应的 beta 版本是否存在）
 * @param alphaVersion alpha 版本号，如 "1.1.0-alpha.0"
 * @returns 是否已封版
 */
async function isAlphaVersionSealed(alphaVersion: string): Promise<boolean> {
  try {
    // 提取基础版本号：1.1.0-alpha.0 → 1.1.0
    const parsed = semver.parse(alphaVersion);
    if (!parsed || !parsed.prerelease || parsed.prerelease[0] !== 'alpha') {
      return false;
    }
    
    const baseVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    
    // 使用 git tag -l 匹配所有对应的 beta 版本 (1.1.0-beta.*)
    try {
      // 获取所有匹配的 beta tags
      let stdout = '';
      let stderr = '';
      
      const exitCode = await exec('git', ['tag', '-l', `${baseVersion}-beta.*`], {
        listeners: {
          stdout: (data: Buffer) => {
            stdout += data.toString();
          },
          stderr: (data: Buffer) => {
            stderr += data.toString();
          }
        }
      });
      
      const betaTags = stdout.trim();
      const hasBetalTags = betaTags.length > 0;
      
      if (hasBetalTags) {
        const tagList = betaTags.split('\n').filter(tag => tag.trim().length > 0);
        logger.info(`检查封版状态: ${alphaVersion} 基础版本 ${baseVersion} 已封版 (找到 ${tagList.length} 个beta版本: ${tagList.join(', ')})`);
      } else {
        logger.info(`检查封版状态: ${alphaVersion} 基础版本 ${baseVersion} 未封版 (无beta版本)`);
      }
      
      return hasBetalTags;
    } catch (error) {
      logger.info(`检查封版状态: ${alphaVersion} 基础版本 ${baseVersion} 未封版 (git tag 查询失败)`);
      return false;
    }
  } catch (error) {
    logger.warning(`封版检测失败: ${error}`);
    return false;
  }
}

/**
 * 根据 PR 标签确定版本发布类型
 * @param labels PR 的标签列表
 * @param betaVersion beta 分支的当前版本
 * @param currentVersion 当前分支的版本
 * @returns 语义化版本发布类型（premajor/preminor/prepatch/prerelease）
 */
function getReleaseTypeFromLabel(labels: { name: string }[] = [], betaVersion: string, currentVersion: string) {
  const labelNames = labels.map((label) => label.name);
  let tempReleaseType = '' as ReleaseType;
  
  // 根据 PR 标签确定基础发布类型
  if (labelNames.includes('major')) {
    tempReleaseType = 'premajor';
  } else if (labelNames.includes('minor')) {
    tempReleaseType = 'preminor';
  } else if (labelNames.includes('patch')) {
    tempReleaseType = 'prepatch';
  }

  // 如果当前版本已经高于 beta 版本，则只需要升级预发布版本号
  if (tempReleaseType && semver.gt(currentVersion, betaVersion)) {
    tempReleaseType = 'prerelease';
  }

  return tempReleaseType;
}

/**
 * 主执行函数 - 自动版本升级和分支同步
 * 
 * 工作流程：
 * 1. 确定目标分支（main/beta/alpha）
 * 2. 获取 beta 分支版本作为参考
 * 3. 根据 PR 标签确定版本升级类型
 * 4. 计算新版本号并更新 package.json
 * 5. 提交并推送更改
 * 6. 执行分支同步（beta → alpha，main → beta）
 */
async function run() {
  try {
    // 从 GitHub 上下文获取目标分支
    let targetBranch = context.ref.split('/').pop()!;
    
    // 判断是否为 dry-run 模式（PR 事件为预览，push 事件为实际执行）
    const isDryRun = context.eventName === 'pull_request';
    
    // 根据事件类型获取 PR 信息
    let pr: any;
    if (context.payload.pull_request) {
      // PR 事件：获取当前 PR
      pr = await getCurentPR();
      targetBranch = pr.base?.ref || context.payload.pull_request.base.ref;
      logger.info(`PR 事件 (预览模式)，目标分支为: ${targetBranch}`);
    } else if (context.eventName === 'push') {
      // Push 事件：查找最近合并的 PR
      pr = await getRecentMergedPR(targetBranch);
      logger.info(`Push 事件 (执行模式)，目标分支为: ${targetBranch}`);
    } else {
      logger.info(`不支持的事件类型: ${context.eventName}`);
      return;
    }

    // 检查是否为支持的分支
    if (targetBranch !== 'alpha' && targetBranch !== 'beta' && targetBranch !== 'main') {
      logger.info(`不支持的分支: ${targetBranch}，跳过版本管理`);
      return;
    }

    logger.info(`目标分支: ${targetBranch} ${isDryRun ? '(预览模式)' : '(执行模式)'}`);

    // 配置 Git 用户信息
    await signUser();
    const pkgPath = await resolvePackageJSON();

    // 读取当前分支 package.json 版本（用于后备）
    const pkgInfo = await readPackageJSON(pkgPath);
    
    // 获取各分支的最新 tag 版本（以 tag 为准）
    const currentTagVersion = await getLatestTagVersion(
      targetBranch === 'main' ? '' : targetBranch
    );
    const betaTagVersion = await getLatestTagVersion('beta');
    
    // 确定当前版本和 beta 版本（使用 package.json 作为后备）
    const currentVersion = currentTagVersion || pkgInfo.version || '0.0.0';
    const betaVersion = betaTagVersion || '0.0.0-beta.0';
    
    logger.info(`当前 ${targetBranch} tag 版本: ${currentTagVersion || '无'}`);
    logger.info(`当前使用版本: ${currentVersion}`);
    logger.info(`beta tag 版本: ${betaTagVersion || '无'}`);

    // 根据 PR 标签确定版本升级类型
    const releaseType = getReleaseTypeFromLabel(pr.labels, betaVersion, currentVersion);
    logger.info(`版本升级类型: ${releaseType}`);

    if (!releaseType) {
      logger.warning(`版本升级类型为空, 跳过`);
      return;
    }

    // 根据目标分支计算新版本号
    let newVersion: string | null = null;

    if (targetBranch === 'alpha') {
      // Alpha 分支：基于封版重新计数规则计算版本
      
      if (!currentTagVersion) {
        // 情况1: 没有 alpha tag，这是第一个 alpha 版本
        logger.info(`没有找到 alpha tag，基于当前版本 (${currentVersion}) 创建第一个 alpha 版本`);
        newVersion = semver.inc(currentVersion, releaseType, 'alpha');
      } else {
        // 情况2: 已有 alpha tag，检查是否封版
        const lastSemver = semver.parse(currentTagVersion);
        
        if (lastSemver && (!lastSemver.prerelease || lastSemver.prerelease[0] !== 'alpha')) {
          // 版本来自 beta 或 main 分支
          logger.info(`上一个版本 (${currentTagVersion}) 来自 beta 或 main, 需要提升版本。`);
          newVersion = semver.inc(currentTagVersion, releaseType, 'alpha');
        } else {
          // 已经是 alpha 版本，检查是否封版
          const isSealed = await isAlphaVersionSealed(currentTagVersion);
          
          if (isSealed) {
            // 已封版：重新计数，基于 beta tag 版本计算新的 alpha 版本
            logger.info(`当前 alpha 版本 (${currentTagVersion}) 已封版，重新计数。`);
            newVersion = semver.inc(betaVersion, releaseType, 'alpha');
          } else {
            // 未封版：继续递增预发布版本号
            logger.info(`当前 alpha 版本 (${currentTagVersion}) 未封版，递增预发布版本号。`);
            newVersion = semver.inc(currentTagVersion, 'prerelease', 'alpha');
          }
        }
      }
    } else if (targetBranch === 'beta') {
      // Beta 分支：升级 beta 预发布版本
      const baseVersion = betaTagVersion || currentVersion;
      newVersion = semver.inc(baseVersion, 'prerelease', 'beta');
    } else if (targetBranch === 'main') {
      // Main 分支：去除预发布标识，转为正式版本
      const baseVersion = currentTagVersion || currentVersion;
      newVersion = semver.inc(baseVersion, 'patch');
    }

    logger.info(`${isDryRun ? '预览' : '新'}版本: ${newVersion}`);

    if (isDryRun) {
      // PR 预览模式：只显示版本号，不执行实际操作
      logger.info('='.repeat(50));
      logger.info(`🔍 版本预览 (PR #${pr.number || 'unknown'})`);
      logger.info(`📋 目标分支: ${targetBranch}`);
      logger.info(`🏷️  当前版本: ${currentTagVersion}`);
      logger.info(`🆕 新版本: ${newVersion}`);
      logger.info(`📝 发布类型: ${releaseType}`);
      logger.info('='.repeat(50));
      logger.info('ℹ️  这是预览模式，不会创建 tag 或修改文件');
      
      // 输出预览信息供后续步骤使用
      core.setOutput('preview-version', newVersion);
      core.setOutput('is-preview', 'true');
      return;
    }

    // 执行模式：实际更新版本
    logger.info('开始执行版本更新...');

    await exec('git', ['switch', targetBranch]);

    // 更新 package.json 版本
    pkgInfo.version = newVersion!;
    await writePackageJSON(pkgPath, pkgInfo);
    logger.info('版本文件已更新');

    // 提交版本更改并推送
    await exec('git', ['add', '.']);
    await exec('git', ['commit', '-m', `chore: bump version to ${newVersion} for ${targetBranch}`]);
    
    // 创建版本标签
    await exec('git', ['tag', newVersion!]);
    logger.info(`已创建标签: ${newVersion}`);
    
    // 推送更改和标签
    await exec('git', ['push', 'origin', targetBranch]);
    await exec('git', ['push', 'origin', newVersion!]);

    // 执行分支同步逻辑
    if (targetBranch === 'beta') {
      // Beta 更新后同步到 Alpha 分支
      await exec('git', ['fetch', 'origin', 'alpha']);
      await exec('git', ['switch', 'alpha']);
      const alphaTagVersion = await getLatestTagVersion('alpha');
      const alphaCurrentVersion = alphaTagVersion || '0.0.0-alpha.0';
      logger.info(`alpha tag 版本 ${alphaTagVersion || '无'}`);
      logger.info(`beta tag 版本 ${newVersion}`);
      await exec('git', [
        'merge',
        'beta',
        '--no-edit',
        '--no-ff',
        '-m',
        `chore: sync beta v${newVersion} to alpha [skip ci]`,
      ]).catch(async () => {
        logger.warning('Alpha 合并冲突');
        if (alphaTagVersion && semver.gt(alphaTagVersion, newVersion!)) {
          // Alpha 版本更高，保持 Alpha 版本不变
          logger.info('Alpha 版本号大于 beta 版本号, 忽略版本变更');
          const newAlphaPkgInfo = await readPackageJSON(pkgPath);
          newAlphaPkgInfo.version = alphaCurrentVersion;
          logger.info(`alpha pkg info: ${JSON.stringify(newAlphaPkgInfo)}`);
          await writePackageJSON(pkgPath, newAlphaPkgInfo);
          await exec('git', ['add', '.']);
          await exec('git', ['commit', '-m', `chore: sync beta v${newVersion} to alpha [skip ci]`]);
        } else {
          logger.error('Alpha 版本号小于 beta 版本号, 无法自动合并, 尝试打开 pr 进行处理');
        }
      });
      await exec('git', ['push', 'origin', 'alpha', '--force-with-lease']).catch(() => {
        logger.info('Alpha 推送失败');
      });
    } else if (targetBranch === 'main') {
      // Main 更新后同步到 Beta 分支
      await exec('git', ['fetch', 'origin', 'main']);
      await exec('git', ['fetch', 'origin', 'beta']);
      await exec('git', ['switch', 'beta']);
      await exec('git', [
        'merge',
        'origin/main',
        '--no-edit',
        '--no-ff',
        '-m',
        `chore: sync main v${newVersion} to beta [skip ci]`,
      ]).catch(async () => {
        // 合并冲突时强制重置为 main 分支状态
        logger.info('Beta 合并冲突, 强制同步');
        await exec('git', ['reset', '--hard', 'origin/main']);
        await exec('git', ['commit', '--allow-empty', '-m', `chore: force sync from main v${newVersion} [skip ci]`]);
      });
      await exec('git', ['push', 'origin', 'beta', '--force-with-lease']).catch(() => {
        logger.info('Beta 推送失败');
      });
    }

    // 输出新版本号供后续步骤使用
    core.setOutput('next-version', newVersion);
    core.setOutput('is-preview', 'false');
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
