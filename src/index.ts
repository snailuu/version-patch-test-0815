import { context } from '@actions/github';
import core, { logger } from './core';
import { configureGitUser, syncBranches, updateVersionAndCreateTag } from './git';
import { createErrorComment, handlePreviewMode, PRUtils } from './pr';
import { ActionError, isSupportedBranch, type PRData, type SupportedBranch } from './types';
import { calculateNewVersion, getBaseVersion } from './version';

// ==================== 主执行函数 ====================

/**
 * 处理执行模式逻辑
 */
async function handleExecutionMode(
  newVersion: string,
  targetBranch: SupportedBranch,
  pr: PRData | null,
): Promise<void> {
  await updateVersionAndCreateTag(newVersion, targetBranch, pr);
  const syncResults = await syncBranches(targetBranch, newVersion);

  // 检查同步结果
  const failedSyncs = syncResults.filter((result) => !result.success);
  if (failedSyncs.length > 0) {
    logger.warning(`部分分支同步失败: ${failedSyncs.map((r) => r.error).join(', ')}`);
  }
}

/**
 * 主执行函数 - 自动版本升级和分支同步
 */
async function run(): Promise<void> {
  try {
    // 1. 直接从 GitHub context 获取必要信息
    if (context.eventName !== 'pull_request') {
      logger.info(`只支持 pull_request 事件，当前事件: ${context.eventName}`);
      return;
    }

    const prPayload = context.payload.pull_request;
    if (!prPayload) {
      logger.error('PR payload 不存在');
      return;
    }

    // 获取源分支和目标分支信息（直接使用payload数据，保证一致性）
    const targetBranch = prPayload.base.ref;
    const sourceBranch = prPayload.head.ref;
    const prNumber = prPayload.number;

    // 🔍 调试信息：输出完整的分支信息和运行实例标识
    const runId = process.env.GITHUB_RUN_ID;
    const runNumber = process.env.GITHUB_RUN_NUMBER;
    logger.info(`🔍 ===== Action运行实例信息 =====`);
    logger.info(`  - Action运行ID: ${runId}`);
    logger.info(`  - Action运行编号: ${runNumber}`);
    logger.info(`  - 工作流名称: ${process.env.GITHUB_WORKFLOW}`);
    logger.info(`  - 事件类型: ${context.eventName}`);
    logger.info(`  - 事件动作: ${context.payload.action}`);
    logger.info(`🔍 ===== PR信息 =====`);
    logger.info(`  - payload.pull_request.number: ${context.payload.pull_request?.number}`);
    logger.info(`  - prPayload.number: ${prPayload.number}`);
    logger.info(`  - prNumber: ${prNumber}`);
    logger.info(`  - 源分支 (head.ref): ${sourceBranch}`);
    logger.info(`  - 目标分支 (base.ref): ${targetBranch}`);
    logger.info(`  - PR标题: ${prPayload.title || '无'}`);
    logger.info(`  - PR URL: ${prPayload.html_url || '无'}`);
    logger.info(`🔍 ===== Context完整信息 =====`);
    logger.info(`  - context.sha: ${context.sha}`);
    logger.info(`  - context.ref: ${context.ref}`);
    logger.info(`  - context.payload keys: ${Object.keys(context.payload).join(', ')}`);

    // 构建PR数据对象（使用payload数据，避免API重新获取导致的不一致）
    const pr: PRData = prPayload as PRData;
    const isMerged = prPayload.state === 'closed' && prPayload.merged === true;
    const isDryRun = !isMerged;
    const eventType = isMerged ? 'merge' : 'preview';

    // 类型守卫：确保 targetBranch 是支持的分支类型
    if (!isSupportedBranch(targetBranch)) {
      logger.info(`不支持的分支: ${targetBranch}，跳过版本管理`);
      return;
    }

    logger.info(
      `分支合并方向: ${sourceBranch} → ${targetBranch} (${eventType}模式${isDryRun ? ' - 预览' : ' - 执行'})`,
    );

    // 2. 配置 Git 用户信息
    await configureGitUser();

    // 3. 获取基础版本（用于显示当前版本）
    const baseVersion = await getBaseVersion(targetBranch, sourceBranch, pr);

    // 4. 根据分支策略计算新版本号（策略内部自行判断是否需要PR标签）
    const newVersion = await calculateNewVersion(targetBranch, sourceBranch, pr);

    // 改进日志输出，提供更多调试信息
    if (newVersion) {
      logger.info(`🎯 ${isDryRun ? '预览' : '新'}版本: ${newVersion}`);
    } else {
      logger.warning(
        `⚠️ 版本计算结果为空 - 合并方向: ${sourceBranch} → ${targetBranch}, 基础版本: ${baseVersion || '无'}`,
      );
    }

    // 5. 根据模式执行相应操作
    if (isDryRun) {
      // 预览模式：更新 PR 评论
      logger.info('📝 执行预览模式...');
      await handlePreviewMode(pr, sourceBranch, targetBranch, baseVersion, newVersion);
      core.setOutput('preview-version', newVersion || '');
      core.setOutput('is-preview', 'true');
    } else {
      // 执行模式：无论是否有新版本都要处理
      logger.info('🚀 执行版本更新模式...');

      if (newVersion) {
        // 有新版本：更新版本并同步分支 - 传递PR信息给CHANGELOG生成
        await handleExecutionMode(newVersion, targetBranch, pr);
        core.setOutput('next-version', newVersion);
        logger.info(`✅ 版本更新完成: ${newVersion}`);
      } else {
        // 无新版本：记录详细信息但不阻塞流程
        logger.info(`ℹ️ 无需版本升级 - 合并方向: ${sourceBranch} → ${targetBranch}, 当前版本: ${baseVersion || '无'}`);
        core.setOutput('next-version', '');
      }

      core.setOutput('is-preview', 'false');
    }
  } catch (error: unknown) {
    // 尝试获取PR信息来创建错误评论
    let errorMessage = '';
    if (error instanceof ActionError) {
      errorMessage = `${error.context}: ${error.message}`;
      logger.error(`Action执行失败: ${error.message} (${error.context})`);
      core.setFailed(errorMessage);
    } else {
      errorMessage = String(error);
      logger.error(`未知错误: ${error}`);
      core.setFailed(errorMessage);
    }

    // 尝试在PR中创建错误评论（如果存在PR）
    try {
      const prPayload = context.payload.pull_request;
      if (prPayload) {
        const prNumber = PRUtils.getCurrentPRNumber(prPayload as PRData);
        if (prNumber) {
          await createErrorComment(prNumber, errorMessage);
          logger.info(`已在 PR #${prNumber} 创建错误评论`);
        }
      }
    } catch (commentError) {
      logger.warning(`创建错误评论失败: ${commentError}`);
    }
  }
}

// ==================== 执行入口 ====================

run();
