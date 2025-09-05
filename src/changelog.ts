import * as fs from 'node:fs';
import { exec } from '@actions/exec';
import { COMMIT_TEMPLATES, LABEL_TO_CHANGELOG_TYPE, PR_SECTION_PATTERNS } from './constants';
import { getBooleanInput, logger } from './core';
import type { PRData } from './types';
import { addVersionPrefix, commitAndPushFile, hasFileChanges } from './utils';

// ==================== CHANGELOG 操作 ====================

/**
 * 从 PR 标签推断变更类型
 */
function getChangeTypeFromLabels(labels: { name: string }[] | undefined): string {
  if (!labels) {
    return LABEL_TO_CHANGELOG_TYPE.OTHER;
  }

  const labelNames = labels.map((label) => label.name);

  // 按优先级依次判断
  if (labelNames.includes('major')) {
    return LABEL_TO_CHANGELOG_TYPE.MAJOR;
  }
  if (labelNames.includes('minor')) {
    return LABEL_TO_CHANGELOG_TYPE.MINOR;
  }
  if (labelNames.includes('patch')) {
    return LABEL_TO_CHANGELOG_TYPE.PATCH;
  }

  return LABEL_TO_CHANGELOG_TYPE.OTHER;
}

/**
 * 处理 section 内容：清理空行，限制行数，统一格式
 */
function processSectionContent(content: string): string {
  const lines: string[] = content.trim().split('\n');
  const resultLines: string[] = [];

  for (let i = 0; i < lines.length && resultLines.length < 5; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    resultLines.push(line.startsWith('- ') ? `  ${line}` : `  - ${line}`);
  }

  return resultLines.length > 0 ? `${resultLines.join('\n')}\n` : '';
}

/**
 * 从 PR body 中提取 section 内容
 */
function extractSectionFromBody(body: string): string {
  for (let i = 0; i < PR_SECTION_PATTERNS.length; i++) {
    const section = PR_SECTION_PATTERNS[i];
    const sectionIndex = body.indexOf(section);

    if (sectionIndex === -1) {
      continue;
    }

    const sectionContent = body.substring(sectionIndex + section.length);
    const nextSectionIndex = sectionContent.search(/^##/m);
    const content = nextSectionIndex > 0 ? sectionContent.substring(0, nextSectionIndex) : sectionContent;

    const processedContent = processSectionContent(content);
    if (processedContent) {
      return processedContent;
    }
  }

  return '';
}

/**
 * 基于 PR 信息生成 CHANGELOG 条目
 */
async function generateChangelogFromPR(pr: PRData | null, version: string): Promise<string> {
  if (!pr) {
    return `### Changes\n- Version ${version} release\n`;
  }

  // 推断变更类型
  const changeType = getChangeTypeFromLabels(pr.labels);

  // 构建基础条目
  const prTitle = pr.title || `PR #${pr.number}`;
  const prUrl = pr.html_url;
  let changelogEntry = `### ${changeType}\n`;
  changelogEntry += `- ${prTitle} ([#${pr.number}](${prUrl}))\n`;

  // 添加 PR body 的相关内容
  if (pr.body && pr.body.trim()) {
    const bodyContent = extractSectionFromBody(pr.body.trim());
    changelogEntry += bodyContent;
  }

  return changelogEntry;
}

/**
 * 更新 CHANGELOG - 基于 PR 信息生成
 */
export async function updateChangelog(pr: PRData | null = null, version = ''): Promise<void> {
  // 检查是否启用 CHANGELOG 生成
  const enableChangelog = getBooleanInput('enable-changelog');
  if (!enableChangelog) {
    logger.info('CHANGELOG 生成已禁用，跳过');
    return;
  }

  // 校验版本号有效性
  if (!version || typeof version !== 'string' || version.trim() === '') {
    logger.warning('版本号为空或无效，跳过 CHANGELOG 生成');
    return;
  }

  try {
    logger.info('开始生成基于 PR 的 CHANGELOG...');

    const currentDate = new Date().toISOString().split('T')[0];
    const versionTag = version.startsWith('v') ? version : `v${version}`;

    // 生成基于 PR 的 CHANGELOG 条目
    const changelogEntry = await generateChangelogFromPR(pr, version);

    const newEntry = `## [${versionTag}] - ${currentDate}

${changelogEntry}
`;

    // 读取现有 CHANGELOG 内容（使用 fs 替代 exec，提高性能）
    // TODO 流式写入
    let existingContent = '';
    try {
      if (fs.existsSync('CHANGELOG.md')) {
        existingContent = fs.readFileSync('CHANGELOG.md', 'utf8');
        logger.info('成功读取 CHANGELOG.md');
      } else {
        // 如果文件不存在，创建初始内容
        existingContent = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`;
        logger.info('CHANGELOG.md 不存在，将创建新文件');
      }
    } catch (error) {
      logger.warning(`读取 CHANGELOG.md 时出错: ${error}`);
      // 如果读取失败，使用默认内容
      existingContent = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`;
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

    // 写回文件（使用 fs.writeFileSync 替代 shell 命令）
    const newContent = lines.join('\n');
    fs.writeFileSync('CHANGELOG.md', newContent, 'utf8');

    logger.info(`✅ CHANGELOG 已更新，添加版本 ${versionTag}`);

    // 显示新增的内容预览（限制大小，避免日志过多）
    try {
      const previewLines = newContent.split('\n').slice(0, 15);
      const preview = previewLines.join('\n');
      logger.info('📋 CHANGELOG 预览:');
      logger.info(preview);
    } catch (error) {
      logger.warning(`无法显示 CHANGELOG 预览: ${error}`);
    }
  } catch (error) {
    logger.warning(`基于 PR 的 CHANGELOG 生成失败: ${error}`);

    // 如果失败，使用原来的 conventional-changelog 逻辑作为备用
    await fallbackToConventionalChangelog();
  }
}

/**
 * 备用方案：使用 conventional-changelog
 */
async function fallbackToConventionalChangelog(): Promise<void> {
  try {
    logger.info('使用 conventional-changelog 作为备用方案...');

    // 检查是否已安装，如果未安装则尝试本地安装（不使用-g）
    try {
      await exec('npx', ['--no-install', 'conventional-changelog-cli', '--version'], { silent: true });
      logger.info('检测到 conventional-changelog-cli 已安装');
    } catch {
      logger.info('未检测到 conventional-changelog-cli，尝试本地安装...');
      try {
        // 使用本地安装而不是全局安装，避免权限问题和环境污染
        await exec(
          'npm',
          [
            'install',
            '--no-save',
            '--no-audit',
            '--no-fund',
            'conventional-changelog-cli',
            'conventional-changelog-conventionalcommits',
          ],
          {
            silent: true,
          },
        );
        logger.info('本地安装 conventional-changelog-cli 完成');
      } catch (installError) {
        throw new Error(`无法安装 conventional-changelog-cli: ${installError}`);
      }
    }

    // 执行 conventional-changelog，添加静默选项以减少日志噪音
    await exec(
      'npx',
      [
        '--no-install',
        'conventional-changelog-cli',
        '-p',
        'conventionalcommits',
        '-i',
        'CHANGELOG.md',
        '-s',
        '-r',
        '0',
      ],
      { silent: true },
    );

    logger.info('✅ 使用 conventional-changelog 生成完成');
  } catch (error) {
    logger.warning(`备用 CHANGELOG 生成失败: ${error}`);
  }
}

/**
 * 检查 CHANGELOG 文件是否有变化
 */
export async function hasChangelogChanges(): Promise<boolean> {
  return await hasFileChanges('CHANGELOG.md');
}

/**
 * 提交 CHANGELOG 文件更改
 */
export async function commitChangelog(version: string, targetBranch: string): Promise<void> {
  const fullVersion = addVersionPrefix(version);
  await commitAndPushFile('CHANGELOG.md', COMMIT_TEMPLATES.CHANGELOG_UPDATE(fullVersion), targetBranch as any);
  logger.info('✅ CHANGELOG 更新已提交');
}
