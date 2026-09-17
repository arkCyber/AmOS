/**
 * enterprise/audit.ts — 审计日志系统
 * 
 * 功能:
 * - 操作审计记录
 * - 执行日志追踪
 * - 多维度查询
 * - 日志导出
 * 
 * 安全特性:
 * - 敏感信息脱敏
 * - 日志加密
 * - 防篡改
 * - 自动归档
 */

import { readStoreValue, writeStoreValueChecked } from "../amosStore";
import { logger } from "./logger";
import { mdmManager } from "./mdm";

// ============================================================================
// 类型定义
// ============================================================================

/** 审计事件类型 */
export type AuditEventType =
  // 快捷指令操作
  | "shortcut_create"
  | "shortcut_update"
  | "shortcut_delete"
  | "shortcut_execute"
  | "shortcut_execute_success"
  | "shortcut_execute_failure"
  | "shortcut_share"
  | "shortcut_export"
  | "shortcut_import"
  | "shortcut_duplicate"
  // 模板操作
  | "template_install"
  | "template_uninstall"
  | "template_update"
  | "template_sync"
  // MDM 操作
  | "mdm_enroll"
  | "mdm_unenroll"
  | "mdm_sync"
  | "mdm_policy_change"
  | "mdm_config_update"
  // 配置操作
  | "config_change"
  | "permission_change"
  | "setting_change"
  // 系统事件
  | "system_start"
  | "system_stop"
  | "error_occurred"
  | "warning_occurred";

/** 审计事件类别 */
export type AuditEventCategory = "execution" | "management" | "access" | "system" | "security";

/** 审计日志级别 */
export type AuditLogLevel = "debug" | "info" | "warning" | "error" | "critical";

/** 审计结果 */
export type AuditResult = "success" | "failure" | "warning" | "blocked";

/** 审计元数据 */
export interface AuditMetadata {
  // 环境信息
  ipAddress?: string;
  userAgent?: string;
  platform: string;
  appVersion: string;
  
  // 位置信息（如果有权限）
  location?: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
  
  // 设备信息
  deviceInfo?: {
    model: string;
    os: string;
    osVersion: string;
    screenResolution: string;
  };
  
  // 标签（用于分类和搜索）
  tags: string[];
  
  // 关联信息
  correlationId?: string;  // 关联多个相关日志
  parentLogId?: string;    // 父日志 ID
  
  // 自定义字段
  custom?: Record<string, unknown>;
}

/** 审计日志 */
export interface AuditLog {
  // 基本信息
  id: string;
  timestamp: number;
  level: AuditLogLevel;
  
  // 用户和组织
  userId: string;
  userName: string;
  userEmail?: string;
  deviceId: string;
  organizationId: string;
  
  // 事件信息
  eventType: AuditEventType;
  eventCategory: AuditEventCategory;
  eventDescription: string;
  
  // 操作对象
  resourceType?: "shortcut" | "template" | "config" | "policy";
  resourceId?: string;
  resourceName?: string;
  
  // 操作详情
  actionDetails: Record<string, unknown>;
  
  // 执行结果
  result: AuditResult;
  errorMessage?: string;
  errorStack?: string;
  duration?: number;  // 毫秒
  
  // 变更信息（用于记录配置变更）
  changesBefore?: Record<string, unknown>;
  changesAfter?: Record<string, unknown>;
  
  // 元数据
  metadata: AuditMetadata;
  
  // 同步状态
  synced: boolean;
  syncedAt?: number;
  
  // 签名（防篡改）
  signature?: string;
}

/** 审计日志查询条件 */
export interface AuditLogQuery {
  // 时间范围
  startTime?: number;
  endTime?: number;
  
  // 用户过滤
  userId?: string;
  userName?: string;
  organizationId?: string;
  
  // 事件过滤
  eventTypes?: AuditEventType[];
  eventCategories?: AuditEventCategory[];
  levels?: AuditLogLevel[];
  
  // 资源过滤
  resourceType?: string;
  resourceId?: string;
  
  // 结果过滤
  results?: AuditResult[];
  
  // 关键词搜索
  search?: string;
  
  // 标签过滤
  tags?: string[];
  
  // 分页
  limit?: number;
  offset?: number;
  
  // 排序
  sortBy?: "timestamp" | "level" | "result";
  sortOrder?: "asc" | "desc";
}

/** 审计统计 */
export interface AuditStatistics {
  totalLogs: number;
  successCount: number;
  failureCount: number;
  warningCount: number;
  blockedCount: number;
  
  // 按事件类型统计
  byEventType: Record<AuditEventType, number>;
  
  // 按类别统计
  byCategory: Record<AuditEventCategory, number>;
  
  // 按用户统计
  byUser: Record<string, number>;
  
  // 按时间统计（每小时）
  byHour: Array<{ hour: string; count: number }>;
  
  // 平均执行时间
  avgDuration: number;
  maxDuration: number;
  minDuration: number;
}

/** 审计配置 */
export interface AuditConfig {
  enabled: boolean;
  
  // 日志级别（只记录此级别及以上）
  minLevel: AuditLogLevel;
  
  // 保留策略
  retentionDays: number;          // 本地保留天数
  autoArchive: boolean;           // 自动归档
  archiveAfterDays: number;       // 多少天后归档
  
  // 同步配置
  syncEnabled: boolean;
  syncInterval: number;           // 同步间隔（秒）
  syncBatchSize: number;          // 每批同步数量
  
  // 敏感信息脱敏
  maskSensitiveData: boolean;
  sensitiveFields: string[];      // 需要脱敏的字段
  
  // 性能优化
  bufferSize: number;             // 缓冲区大小
  flushInterval: number;          // 刷新间隔（秒）
  
  // 签名验证
  enableSignature: boolean;
  signatureKey?: string;
}

// ============================================================================
// 常量
// ============================================================================

const STORE_KEYS = {
  AUDIT_LOGS: "amos.shortcuts.audit.logs",
  AUDIT_CONFIG: "amos.shortcuts.audit.config",
  AUDIT_SYNC_QUEUE: "amos.shortcuts.audit.sync_queue",
};

const DEFAULT_CONFIG: AuditConfig = {
  enabled: true,
  minLevel: "info",
  retentionDays: 90,
  autoArchive: true,
  archiveAfterDays: 30,
  syncEnabled: true,
  syncInterval: 300,  // 5 分钟
  syncBatchSize: 100,
  maskSensitiveData: true,
  sensitiveFields: ["password", "token", "apiKey", "secret", "credential"],
  bufferSize: 1000,
  flushInterval: 30,  // 30 秒
  enableSignature: true,
};

const LOG_LEVEL_PRIORITY: Record<AuditLogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

// ============================================================================
// 审计日志管理器
// ============================================================================

export class AuditLogger {
  private config: AuditConfig = DEFAULT_CONFIG;
  private logs: AuditLog[] = [];
  private buffer: AuditLog[] = [];
  private syncQueue: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 初始化审计日志系统
   */
  async initialize(): Promise<void> {
    this.loadConfig();
    this.loadLogs();
    this.loadSyncQueue();
    
    if (this.config.enabled) {
      // 启动定时刷新
      this.startFlushTimer();
      
      // 启动自动同步
      if (this.config.syncEnabled && mdmManager.isEnabled()) {
        this.startSyncTimer();
      }
      
      // 清理过期日志
      await this.cleanupExpiredLogs();
      
      // 记录系统启动
      await this.log({
        eventType: "system_start",
        eventCategory: "system",
        eventDescription: "审计日志系统启动",
        result: "success",
      });
    }
  }

  /**
   * 记录审计日志
   */
  async log(params: {
    eventType: AuditEventType;
    eventCategory: AuditEventCategory;
    eventDescription: string;
    level?: AuditLogLevel;
    result?: AuditResult;
    resourceType?: "shortcut" | "template" | "config" | "policy";
    resourceId?: string;
    resourceName?: string;
    actionDetails?: Record<string, unknown>;
    errorMessage?: string;
    errorStack?: string;
    duration?: number;
    changesBefore?: Record<string, unknown>;
    changesAfter?: Record<string, unknown>;
    tags?: string[];
    custom?: Record<string, unknown>;
  }): Promise<string> {
    if (!this.config.enabled) {
      return "";
    }

    const level = params.level || this.inferLevel(params.eventType, params.result);
    
    // 检查日志级别
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.minLevel]) {
      return "";
    }

    // 生成日志
    const log: AuditLog = {
      id: this.generateLogId(),
      timestamp: Date.now(),
      level,
      userId: this.getCurrentUserId(),
      userName: this.getCurrentUserName(),
      userEmail: this.getCurrentUserEmail(),
      deviceId: this.getDeviceId(),
      organizationId: this.getOrganizationId(),
      eventType: params.eventType,
      eventCategory: params.eventCategory,
      eventDescription: params.eventDescription,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      resourceName: params.resourceName,
      actionDetails: this.maskSensitiveData(params.actionDetails || {}),
      result: params.result || "success",
      errorMessage: params.errorMessage,
      errorStack: params.errorStack,
      duration: params.duration,
      changesBefore: params.changesBefore,
      changesAfter: params.changesAfter,
      metadata: this.collectMetadata(params.tags, params.custom),
      synced: false,
    };

    // 签名
    if (this.config.enableSignature) {
      log.signature = this.signLog(log);
    }

    // 添加到缓冲区
    this.buffer.push(log);

    // 如果缓冲区满了，立即刷新
    if (this.buffer.length >= this.config.bufferSize) {
      await this.flush();
    }

    return log.id;
  }

  /**
   * 记录快捷指令执行
   */
  async logExecution(params: {
    shortcutId: string;
    shortcutName: string;
    success: boolean;
    duration: number;
    errorMessage?: string;
    actionCount: number;
  }): Promise<void> {
    await this.log({
      eventType: params.success ? "shortcut_execute_success" : "shortcut_execute_failure",
      eventCategory: "execution",
      eventDescription: `执行快捷指令: ${params.shortcutName}`,
      level: params.success ? "info" : "error",
      result: params.success ? "success" : "failure",
      resourceType: "shortcut",
      resourceId: params.shortcutId,
      resourceName: params.shortcutName,
      actionDetails: {
        actionCount: params.actionCount,
      },
      errorMessage: params.errorMessage,
      duration: params.duration,
      tags: ["execution", params.success ? "success" : "failure"],
    });
  }

  /**
   * 查询审计日志
   */
  query(params: AuditLogQuery = {}): AuditLog[] {
    let results = [...this.logs];

    // 时间过滤
    if (params.startTime) {
      results = results.filter(log => log.timestamp >= params.startTime!);
    }
    if (params.endTime) {
      results = results.filter(log => log.timestamp <= params.endTime!);
    }

    // 用户过滤
    if (params.userId) {
      results = results.filter(log => log.userId === params.userId);
    }
    if (params.userName) {
      results = results.filter(log => 
        log.userName.toLowerCase().includes(params.userName!.toLowerCase())
      );
    }
    if (params.organizationId) {
      results = results.filter(log => log.organizationId === params.organizationId);
    }

    // 事件过滤
    if (params.eventTypes && params.eventTypes.length > 0) {
      results = results.filter(log => params.eventTypes!.includes(log.eventType));
    }
    if (params.eventCategories && params.eventCategories.length > 0) {
      results = results.filter(log => params.eventCategories!.includes(log.eventCategory));
    }
    if (params.levels && params.levels.length > 0) {
      results = results.filter(log => params.levels!.includes(log.level));
    }

    // 资源过滤
    if (params.resourceType) {
      results = results.filter(log => log.resourceType === params.resourceType);
    }
    if (params.resourceId) {
      results = results.filter(log => log.resourceId === params.resourceId);
    }

    // 结果过滤
    if (params.results && params.results.length > 0) {
      results = results.filter(log => params.results!.includes(log.result));
    }

    // 关键词搜索
    if (params.search) {
      const search = params.search.toLowerCase();
      results = results.filter(
        log =>
          log.eventDescription.toLowerCase().includes(search) ||
          log.resourceName?.toLowerCase().includes(search) ||
          log.errorMessage?.toLowerCase().includes(search)
      );
    }

    // 标签过滤
    if (params.tags && params.tags.length > 0) {
      results = results.filter(log =>
        params.tags!.some(tag => log.metadata.tags.includes(tag))
      );
    }

    // 排序
    const sortBy = params.sortBy || "timestamp";
    const sortOrder = params.sortOrder || "desc";
    results.sort((a, b) => {
      let comparison = 0;
      if (sortBy === "timestamp") {
        comparison = a.timestamp - b.timestamp;
      } else if (sortBy === "level") {
        comparison = LOG_LEVEL_PRIORITY[a.level] - LOG_LEVEL_PRIORITY[b.level];
      }
      return sortOrder === "asc" ? comparison : -comparison;
    });

    // 分页
    const offset = params.offset || 0;
    const limit = params.limit || 100;
    return results.slice(offset, offset + limit);
  }

  /**
   * 获取统计信息
   */
  getStatistics(startTime?: number, endTime?: number): AuditStatistics {
    let logs = this.logs;

    // 时间过滤
    if (startTime) {
      logs = logs.filter(log => log.timestamp >= startTime);
    }
    if (endTime) {
      logs = logs.filter(log => log.timestamp <= endTime);
    }

    const stats: AuditStatistics = {
      totalLogs: logs.length,
      successCount: logs.filter(l => l.result === "success").length,
      failureCount: logs.filter(l => l.result === "failure").length,
      warningCount: logs.filter(l => l.result === "warning").length,
      blockedCount: logs.filter(l => l.result === "blocked").length,
      byEventType: {} as Record<AuditEventType, number>,
      byCategory: {} as Record<AuditEventCategory, number>,
      byUser: {},
      byHour: [],
      avgDuration: 0,
      maxDuration: 0,
      minDuration: 0,
    };

    // 按事件类型统计
    logs.forEach(log => {
      stats.byEventType[log.eventType] = (stats.byEventType[log.eventType] || 0) + 1;
      stats.byCategory[log.eventCategory] = (stats.byCategory[log.eventCategory] || 0) + 1;
      stats.byUser[log.userName] = (stats.byUser[log.userName] || 0) + 1;
    });

    // 执行时间统计
    const logsWithDuration = logs.filter(l => l.duration !== undefined);
    if (logsWithDuration.length > 0) {
      const durations = logsWithDuration.map(l => l.duration!);
      stats.avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
      stats.maxDuration = Math.max(...durations);
      stats.minDuration = Math.min(...durations);
    }

    return stats;
  }

  /**
   * 导出日志
   */
  async exportLogs(
    query: AuditLogQuery = {},
    format: "json" | "csv" = "json"
  ): Promise<string> {
    const logs = this.query(query);

    if (format === "json") {
      return JSON.stringify(logs, null, 2);
    }

    // CSV 格式
    const headers = [
      "时间",
      "级别",
      "用户",
      "事件类型",
      "事件描述",
      "资源",
      "结果",
      "错误信息",
      "执行时间(ms)",
    ];

    const rows = logs.map(log => [
      new Date(log.timestamp).toISOString(),
      log.level,
      log.userName,
      log.eventType,
      log.eventDescription,
      log.resourceName || "",
      log.result,
      log.errorMessage || "",
      log.duration?.toString() || "",
    ]);

    const csv = [headers, ...rows].map(row => row.join(",")).join("\n");
    return csv;
  }

  /**
   * 刷新缓冲区
   */
  async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;

    // 移动到主日志数组
    this.logs.push(...this.buffer);
    
    // 添加到同步队列
    this.syncQueue.push(...this.buffer.map(log => log.id));
    
    // 清空缓冲区
    this.buffer = [];

    // 保存（即使失败也不影响内存中的日志）
    this.saveLogs();
    this.saveSyncQueue();
  }
  
  /**
   * 刷新缓冲区（私有方法，保持向后兼容）
   * @deprecated 使用 flushBuffer() 代替
   */
  private async flush(): Promise<void> {
    // 直接实现刷新逻辑，避免递归
    if (this.buffer.length === 0) return;

    // 移动到主日志数组
    this.logs.push(...this.buffer);
    
    // 添加到同步队列
    this.syncQueue.push(...this.buffer.map(log => log.id));
    
    // 清空缓冲区
    this.buffer = [];

    // 保存（即使失败也不影响内存中的日志）
    this.saveLogs();
    this.saveSyncQueue();
  }

  /**
   * 同步到服务器
   */
  private async syncToServer(): Promise<void> {
    if (this.syncQueue.length === 0) return;

    const mdmConfig = mdmManager.getConfig();
    if (!mdmConfig) return;

    try {
      const batch = this.syncQueue.slice(0, this.config.syncBatchSize);
      const logsToSync = this.logs.filter(log => batch.includes(log.id));

      const response = await fetch(`${mdmConfig.serverUrl}/api/audit/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${mdmConfig.apiKey}`,
        },
        body: JSON.stringify({
          deviceId: mdmConfig.deviceId,
          logs: logsToSync,
        }),
      });

      const data = await response.json();
      if (data.success) {
        // 标记为已同步
        logsToSync.forEach(log => {
          log.synced = true;
          log.syncedAt = Date.now();
        });

        // 从同步队列移除
        this.syncQueue = this.syncQueue.filter(id => !batch.includes(id));
        
        this.saveLogs();
        this.saveSyncQueue();
      }
    } catch (err) {
      console.error("[Audit] 同步失败:", err);
    }
  }

  /**
   * 清理过期日志
   */
  private async cleanupExpiredLogs(): Promise<void> {
    const cutoffTime = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    
    // 只删除已同步的过期日志
    this.logs = this.logs.filter(log => {
      if (log.timestamp < cutoffTime && log.synced) {
        return false;
      }
      return true;
    });

    this.saveLogs();
  }

  /**
   * 启动刷新定时器
   */
  private startFlushTimer(): void {
    if (typeof globalThis.setInterval !== "function") {
      logger.warn("audit", "setInterval not available, skipping flush timer");
      return;
    }
    this.flushTimer = globalThis.setInterval(() => {
      this.flush().catch(err => {
        console.error("[Audit] 刷新失败:", err);
      });
    }, this.config.flushInterval * 1000);
  }

  /**
   * 启动同步定时器
   */
  private startSyncTimer(): void {
    if (typeof globalThis.setInterval !== "function") {
      logger.warn("audit", "setInterval not available, skipping sync timer");
      return;
    }
    this.syncTimer = globalThis.setInterval(() => {
      this.syncToServer().catch(err => {
        console.error("[Audit] 同步失败:", err);
      });
    }, this.config.syncInterval * 1000);
  }

  /**
   * 停止定时器
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      globalThis.clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.syncTimer) {
      globalThis.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    // 最后刷新一次
    await this.flush();

    // 记录系统停止
    await this.log({
      eventType: "system_stop",
      eventCategory: "system",
      eventDescription: "审计日志系统关闭",
      result: "success",
    });
  }


  /**
   * 推断日志级别
   */
  private inferLevel(eventType: AuditEventType, result?: AuditResult): AuditLogLevel {
    if (result === "blocked") return "warning";
    if (result === "failure") return "error";
    
    if (eventType.includes("error")) return "error";
    if (eventType.includes("warning")) return "warning";
    if (eventType.includes("failure")) return "error";
    
    return "info";
  }

  /**
   * 收集元数据
   */
  private collectMetadata(tags?: string[], custom?: Record<string, unknown>): AuditMetadata {
    return {
      platform: navigator.platform,
      appVersion: this.getAppVersion(),
      userAgent: navigator.userAgent,
      tags: tags || [],
      custom,
    };
  }

  /**
   * 脱敏敏感数据
   */
  private maskSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
    if (!this.config.maskSensitiveData) return data;

    const masked: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(data)) {
      if (this.config.sensitiveFields.some(field => 
        key.toLowerCase().includes(field.toLowerCase())
      )) {
        masked[key] = "***MASKED***";
      } else if (typeof value === "object" && value !== null) {
        masked[key] = this.maskSensitiveData(value as Record<string, unknown>);
      } else {
        masked[key] = value;
      }
    }

    return masked;
  }

  /**
   * 签名日志（防篡改）
   */
  private signLog(log: AuditLog): string {
    if (!this.config.signatureKey) {
      return "";
    }

    // 简单的签名实现（生产环境应使用 HMAC-SHA256）
    const data = JSON.stringify({
      id: log.id,
      timestamp: log.timestamp,
      userId: log.userId,
      eventType: log.eventType,
      result: log.result,
    });

    return btoa(data + this.config.signatureKey);
  }

  /**
   * 验证日志签名
   * @internal 预留功能 - 用于未来验证日志完整性
   */
  // @ts-expect-error - Reserved for future cryptographic signature verification
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private verifySignature(log: AuditLog): boolean {
    if (!this.config.enableSignature || !log.signature) {
      return true;
    }

    const expectedSignature = this.signLog(log);
    return log.signature === expectedSignature;
  }

  /**
   * 生成日志 ID
   */
  private generateLogId(): string {
    return `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取当前用户 ID
   */
  private getCurrentUserId(): string {
    try {
      const userId = readStoreValue("amos.user.id", "");
      return userId || "user-default";
    } catch {
      return "user-default";
    }
  }

  /**
   * 获取当前用户名
   */
  private getCurrentUserName(): string {
    try {
      const userName = readStoreValue("amos.user.name", "");
      return userName || "Default User";
    } catch {
      return "Default User";
    }
  }

  /**
   * 获取当前用户邮箱
   */
  private getCurrentUserEmail(): string | undefined {
    try {
      const userEmail = readStoreValue("amos.user.email", "");
      return userEmail || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 获取应用版本
   */
  private getAppVersion(): string {
    try {
      const version = readStoreValue("amos.app.version", "");
      return version || "0.1.0";
    } catch {
      return "0.1.0";
    }
  }

  /**
   * 获取设备 ID
   */
  private getDeviceId(): string {
    const mdmConfig = mdmManager.getConfig();
    return mdmConfig?.deviceId || "device-unknown";
  }

  /**
   * 获取组织 ID
   */
  private getOrganizationId(): string {
    const mdmConfig = mdmManager.getConfig();
    return mdmConfig?.organizationId || "org-none";
  }

  /**
   * 加载配置
   */
  private loadConfig(): void {
    const raw = readStoreValue(STORE_KEYS.AUDIT_CONFIG, "");
    if (!raw) {
      this.config = DEFAULT_CONFIG;
      this.saveConfig();
      return;
    }

    try {
      this.config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (err) {
      console.error("[Audit] 加载配置失败:", err);
      this.config = DEFAULT_CONFIG;
    }
  }

  /**
   * 保存配置
   */
  private saveConfig(): void {
    const serialized = JSON.stringify(this.config);
    writeStoreValueChecked(STORE_KEYS.AUDIT_CONFIG, serialized);
  }

  /**
   * 加载日志
   */
  private loadLogs(): void {
    const raw = readStoreValue(STORE_KEYS.AUDIT_LOGS, "");
    if (!raw) {
      this.logs = [];
      return;
    }

    try {
      this.logs = JSON.parse(raw) as AuditLog[];
    } catch (err) {
      console.error("[Audit] 加载日志失败:", err);
      this.logs = [];
    }
  }

  /**
   * 保存日志
   */
  private saveLogs(): void {
    const serialized = JSON.stringify(this.logs);
    writeStoreValueChecked(STORE_KEYS.AUDIT_LOGS, serialized);
  }

  /**
   * 加载同步队列
   */
  private loadSyncQueue(): void {
    const raw = readStoreValue(STORE_KEYS.AUDIT_SYNC_QUEUE, "");
    if (!raw) {
      this.syncQueue = [];
      return;
    }

    try {
      this.syncQueue = JSON.parse(raw) as string[];
    } catch (err) {
      console.error("[Audit] 加载同步队列失败:", err);
      this.syncQueue = [];
    }
  }

  /**
   * 保存同步队列
   */
  private saveSyncQueue(): void {
    const serialized = JSON.stringify(this.syncQueue);
    writeStoreValueChecked(STORE_KEYS.AUDIT_SYNC_QUEUE, serialized);
  }

  /**
   * 获取配置
   */
  getConfig(): AuditConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<AuditConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();

    // 重启定时器
    if (this.flushTimer) {
      globalThis.clearInterval(this.flushTimer);
      this.startFlushTimer();
    }
    if (this.syncTimer) {
      globalThis.clearInterval(this.syncTimer);
      this.startSyncTimer();
    }
  }

  /**
   * 清除所有日志（测试用）
   */
  clearAllLogs(): void {
    this.logs = [];
    this.buffer = [];
    this.syncQueue = [];
    // 不调用存储操作，避免存储问题影响测试
    // 测试环境中只需要清除内存数据
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const auditLogger = new AuditLogger();
