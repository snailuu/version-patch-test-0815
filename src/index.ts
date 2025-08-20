import core, { logger } from './core';
import { configureGitUser, syncBranches, updateVersionAndCreateTag } from './git';
import { determineReleaseType, getEventInfo, handlePreviewMode } from './pr';
import { ActionError, isSupportedBranch, type SupportedBranch } from './types';
import { calculateNewVersion, getBaseVersion, getVersionInfo } from './version';

// ==================== 主执行函数 ====================

/**
 * 处理执行模式逻辑
 */
async function handleExecutionMode(newVersion: string, targetBranch: SupportedBranch): Promise<void> {
  await updateVersionAndCreateTag(newVersion, targetBranch);
  const syncResults = await syncBranches(targetBranch, newVersion);

  // 检查同步结果
  const failedSyncs = syncResults.filter((result) => !result.success);
  if (failedSyncs.length > 0) {
    logger.warning(`部分分支同步失败: ${failedSyncs.map((r) => r.error).join(', ')}`);
  }
}

/**
 * 主执行函数 - 自动版本升级和分支同步
 * 简化的流程控制，将复杂逻辑委托给各个模块
 */
async function run(): Promise<void> {
  try {
    // 1. 获取事件信息和目标分支
    const eventInfo = await getEventInfo();
    if (!eventInfo) return;

    const { targetBranch, isDryRun, pr } = eventInfo;

    // 类型守卫：确保 targetBranch 是支持的分支类型
    if (!isSupportedBranch(targetBranch)) {
      logger.info(`不支持的分支: ${targetBranch}，跳过版本管理`);
      return;
    }

    logger.info(`目标分支: ${targetBranch} ${isDryRun ? '(预览模式)' : '(执行模式)'}`);

    // 2. 配置 Git 用户信息
    await configureGitUser();

    // 3. 获取版本信息
    const versionInfo = await getVersionInfo(targetBranch);

    // 4. 使用混合策略确定版本升级类型
    const releaseType = await determineReleaseType(pr, targetBranch);
    logger.info(`📋 版本升级类型: ${releaseType || '无'}`);

    // 5. 获取基础版本（用于显示真实的当前版本）
    const baseVersion = await getBaseVersion(targetBranch, versionInfo);

    // 6. 计算新版本号（两种模式使用相同逻辑）
    const newVersion = await calculateNewVersion(targetBranch, versionInfo, releaseType);
    
    // 改进日志输出，提供更多调试信息
    if (newVersion) {
      logger.info(`🎯 ${isDryRun ? '预览' : '新'}版本: ${newVersion}`);
    } else {
      logger.warning(`⚠️ 版本计算结果为空 - 目标分支: ${targetBranch}, 发布类型: ${releaseType || '无'}, 基础版本: ${baseVersion || '无'}`);
    }

    // 7. 根据模式执行相应操作
    if (isDryRun) {
      // 预览模式：更新 PR 评论
      logger.info('📝 执行预览模式...');
      await handlePreviewMode(pr, targetBranch, baseVersion, newVersion, releaseType);
      core.setOutput('preview-version', newVersion || '');
      core.setOutput('is-preview', 'true');
    } else {
      // 执行模式：无论是否有新版本都要处理
      logger.info('🚀 执行版本更新模式...');
      
      if (newVersion) {
        // 有新版本：更新版本并同步分支
        await handleExecutionMode(newVersion, targetBranch);
        core.setOutput('next-version', newVersion);
        logger.info(`✅ 版本更新完成: ${newVersion}`);
      } else {
        // 无新版本：记录详细信息但不阻塞流程
        logger.info(`ℹ️ 无需版本升级 - 目标分支: ${targetBranch}, 当前版本: ${baseVersion || '无'}, 发布类型: ${releaseType || '无'}`);
        core.setOutput('next-version', '');
      }
      
      core.setOutput('is-preview', 'false');
    }
  } catch (error: unknown) {
    if (error instanceof ActionError) {
      logger.error(`Action执行失败: ${error.message} (${error.context})`);
      core.setFailed(`${error.context}: ${error.message}`);
    } else {
      logger.error(`未知错误: ${error}`);
      core.setFailed(String(error));
    }
  }
}

// ==================== 执行入口 ====================

run();
