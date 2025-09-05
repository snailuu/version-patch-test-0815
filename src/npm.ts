import process from 'node:process';
import { exec } from '@actions/exec';
import { getBooleanInput, getInput, logger, setOutput } from './core';
import type { SupportedBranch } from './types';
import { ActionError, cleanVersion } from './utils';
import { parseVersion } from './version';

// ==================== NPM 发布功能 ====================

/**
 * 检查是否启用 npm 发布
 */
function isNpmPublishEnabled(): boolean {
  return getBooleanInput('enable-npm-publish');
}

/**
 * 获取 npm 发布配置
 */
function getNpmPublishConfig() {
  const registry = getInput('npm-registry') || 'https://registry.npmjs.org/';
  const token = getInput('npm-token');
  const tag = (getInput('npm-tag') || 'auto').toLowerCase();
  const access = getInput('npm-access') || 'public';

  return { registry, token, tag, access };
}

/**
 * 配置 npm 认证
 */
async function configureNpmAuth(registry: string, token: string): Promise<void> {
  try {
    // 设置 registry
    await exec('npm', ['config', 'set', 'registry', registry]);
    logger.info(`配置 npm registry: ${registry}`);

    // 设置认证 token
    if (token) {
      const registryUrl = new URL(registry);
      // 确保带上 pathname 且以 / 结尾，兼容带路径的 registry
      const pathname = registryUrl.pathname.endsWith('/') ? registryUrl.password : `${registryUrl.pathname}/`;
      const scopedKey = `//${registryUrl.host}${pathname}`;
      await exec('npm', ['config', 'set', `${scopedKey}:_authToken`, token]);
      await exec('npm', ['config', 'set', `${scopedKey}:always-auth`, token]);
      logger.info('配置 npm 认证 token');
    }
  } catch (error) {
    throw new ActionError(`配置 npm 认证失败: ${error}`, 'configureNpmAuth', error);
  }
}

/**
 * 确定 npm 发布标签
 */
function determineNpmTag(version: string, targetBranch: SupportedBranch, configTag: string): string {
  // 如果用户指定了特定标签，使用用户指定的标签
  if (configTag !== 'auto') {
    return configTag;
  }

  // 根据分支和版本自动确定标签
  if (targetBranch === 'main') {
    // 主分支使用 latest 标签
    return 'latest';
  }
  if (targetBranch === 'beta') {
    // Beta 分支使用 beta 标签
    return 'beta';
  }
  if (targetBranch === 'alpha') {
    // Alpha 分支使用 alpha 标签
    return 'alpha';
  }

  // 如果是预发布版本，根据 prerelease 标识确定标签
  const cleanedVersion = cleanVersion(version);
  const parsed = parseVersion(cleanedVersion);
  if (parsed?.prerelease && parsed.prerelease.length > 0) {
    const prereleaseId = parsed.prerelease[0] as string;
    if (prereleaseId === 'alpha') {
      return 'alpha';
    }
    if (prereleaseId === 'beta') {
      return 'beta';
    }
  }

  return 'latest';
}

/**
 * 执行 npm 发布
 */
async function publishToNpm(
  version: string,
  targetBranch: SupportedBranch,
  config: { registry: string; token: string; tag: string; access: string },
): Promise<void> {
  try {
    // 确定发布标签
    const publishTag = determineNpmTag(version, targetBranch, config.tag);

    logger.info(`准备发布到 npm: 版本=${version}, 标签=${publishTag}, 分支=${targetBranch}`);

    // 配置 npm 认证
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
    const code = await exec('npm', publishArgs, {
      env: { ...process.env, NODE_AUTH_TOKEN: config.token || '' },
    });
    if (code !== 0) {
      throw new Error(`npm publish 失败，退出码：${code}`);
    }

    logger.info(`✅ 成功发布到 npm: ${version} (标签: ${publishTag})`);

    // 设置输出
    setOutput('published-version', version);
    setOutput('published-tag', publishTag);
    setOutput('npm-registry', config.registry);
  } catch (error) {
    // 检查是否是版本已存在的错误
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      /version already exists/i.test(errorMessage) ||
      /previously published versions/i.test(errorMessage) ||
      /EPUBLISHCONFLICT/i.test(errorMessage) ||
      /\bE403\b/.test(errorMessage)
    ) {
      logger.warning(`版本 ${version} 已存在于 npm registry，跳过发布`);
      return;
    }

    throw new ActionError(`npm 发布失败: ${error}`, 'publishToNpm', error);
  }
}

/**
 * 处理 npm 发布逻辑 - 只对目标分支版本发布
 */
export async function handleNpmPublish(version: string, targetBranch: SupportedBranch): Promise<void> {
  if (!isNpmPublishEnabled()) {
    logger.info('npm 发布已禁用，跳过');
    return;
  }

  try {
    logger.info(`开始 npm 发布流程: 版本=${version}, 目标分支=${targetBranch}`);

    const config = getNpmPublishConfig();

    // 验证必需的配置
    if (!config.token) {
      throw new ActionError('npm-token 未配置，无法发布到 npm', 'handleNpmPublish');
    }

    // 只对目标分支的版本进行发布，不处理下游分支
    await publishToNpm(version, targetBranch, config);

    logger.info(`✅ ${targetBranch}分支版本 ${version} npm 发布完成`);
  } catch (error) {
    // npm 发布失败不应该中断整个流程
    logger.error(`npm 发布失败: ${error}`);
    setOutput('npm-publish-failed', 'true');
    setOutput('npm-publish-error', String(error));

    // 如果用户要求严格模式，则抛出错误
    const strictMode = getInput('npm-publish-strict')?.toLowerCase() === 'true';
    if (strictMode) {
      throw error;
    }
  }
}
