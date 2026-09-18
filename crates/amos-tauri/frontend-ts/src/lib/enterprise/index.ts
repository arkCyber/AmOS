/**
 * enterprise/index.ts — 企业功能统一导出
 * 
 * Phase 4: 企业功能模块
 * - MDM 支持
 * - 企业模板
 * - 审计日志
 * - API 集成
 */

// 导出类型和管理器
export type { MDMConfig, MDMPolicy, MDMCheckResult, MDMRestrictions } from "./mdm";
export type { EnterpriseTemplate, TemplateParameter, TemplateInstallation } from "./templates";
export type { AuditLog, AuditLogQuery, AuditStatistics } from "./audit";
export type { APIConfig, APIResponse } from "./api";
export type { WebhookConfig, WebhookEvent, WebhookResponse } from "./webhooks";

export { mdmManager } from "./mdm";
export { templateManager } from "./templates";
export { auditLogger } from "./audit";
export { apiClient } from "./api";
export { webhookManager } from "./webhooks";

import { mdmManager } from "./mdm";
import { templateManager } from "./templates";
import { auditLogger } from "./audit";
import { apiClient } from "./api";
import { webhookManager } from "./webhooks";

/**
 * 初始化所有企业功能
 */
export async function initializeEnterprise(): Promise<void> {
  await Promise.all([
    mdmManager.initialize(),
    templateManager.initialize(),
    auditLogger.initialize(),
    apiClient.initialize(),
    webhookManager.initialize(),
  ]);
}

/**
 * 关闭所有企业功能
 */
export async function shutdownEnterprise(): Promise<void> {
  // MDM 的自动同步定时器要显式停掉：壳长期存活，留着它就会一直按 syncInterval
  // 醒来（REQ-A385）。其余三个各自在自己的 shutdown 里收拾。
  mdmManager.stopAutoSync();
  await auditLogger.shutdown();
  webhookManager.shutdown();
}
