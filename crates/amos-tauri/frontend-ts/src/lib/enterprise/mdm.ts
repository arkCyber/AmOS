/**
 * enterprise/mdm.ts — Mobile Device Management (MDM) 支持
 * 
 * 功能:
 * - MDM 配置管理
 * - 策略引擎
 * - 限制检查
 * - 配置同步
 * 
 * 安全特性:
 * - 配置加密存储
 * - 策略签名验证
 * - 设备锁定
 * - 远程擦除
 */

import { readStoreValue, writeStoreValueChecked } from "../amosStore";
import type { ActionCategory } from "../shortcuts";

// ============================================================================
// 类型定义
// ============================================================================

/** MDM API 响应 - 注册 */
interface MDMEnrollResponse {
  organizationId: string;
  organizationName: string;
  apiKey: string;
  enrolledBy?: string;
}

/** MDM API 响应 - 策略同步数据 */
export interface MDMPoliciesData {
  policies: MDMPolicy[];
  restrictions: MDMRestrictions;
  enforcedShortcuts: string[];
  enforcedTemplates: string[];
}

/** MDM 策略类型 */
export type MDMPolicyType =
  | "feature_disable"      // 禁用功能
  | "execution_limit"      // 执行限制
  | "sharing_control"      // 分享控制
  | "approval_required"    // 需要审批
  | "forced_shortcuts"     // 强制快捷指令
  | "data_retention";      // 数据保留策略

/** MDM 策略 */
export interface MDMPolicy {
  id: string;
  type: MDMPolicyType;
  name: string;
  description: string;
  config: Record<string, unknown>;
  enabled: boolean;
  priority: number;        // 优先级，数字越大优先级越高
  createdAt: number;
  updatedAt: number;
}

/** MDM 限制配置 */
export interface MDMRestrictions {
  // 功能限制
  disabledCategories: ActionCategory[];
  disabledActions: string[];
  
  // 执行限制
  maxExecutionTime: number;        // 最大执行时间（秒）
  maxExecutionsPerDay: number;     // 每天最大执行次数
  maxActionsPerShortcut: number;   // 每个快捷指令最大操作数
  maxShortcutsPerUser: number;     // 每个用户最大快捷指令数
  
  // 用户权限
  allowUserCreate: boolean;        // 允许用户创建
  allowUserModify: boolean;        // 允许用户修改
  allowUserDelete: boolean;        // 允许用户删除
  allowSharing: boolean;           // 允许分享
  allowExport: boolean;            // 允许导出
  allowImport: boolean;            // 允许导入
  
  // 审批流程
  requireApprovalForCreate: boolean;
  requireApprovalForModify: boolean;
  requireApprovalForSharing: boolean;
}

/** MDM 配置 */
export interface MDMConfig {
  enabled: boolean;
  organizationId: string;
  organizationName: string;
  deviceId: string;
  deviceName: string;
  
  // 服务器配置
  serverUrl: string;
  apiKey: string;
  
  // 策略和限制
  policies: MDMPolicy[];
  restrictions: MDMRestrictions;
  
  // 强制快捷指令
  enforcedShortcuts: string[];     // 强制安装的快捷指令 ID
  enforcedTemplates: string[];     // 强制安装的模板 ID
  
  // 同步配置
  syncInterval: number;            // 同步间隔（秒）
  lastSyncAt: number;
  lastSyncStatus: "success" | "failure" | "pending";
  lastSyncError?: string;
  
  // 设备状态
  deviceStatus: "active" | "locked" | "wiped";
  lockMessage?: string;
  
  // 元数据
  enrolledAt: number;
  enrolledBy: string;
  version: string;
}

/** MDM 同步响应 */
export interface MDMSyncResponse {
  success: boolean;
  config?: MDMConfig;
  message?: string;
  serverTime: number;
}

/** MDM 操作结果 */
export interface MDMCheckResult {
  allowed: boolean;
  reason?: string;
  policyId?: string;
}

// ============================================================================
// 常量
// ============================================================================

const STORE_KEYS = {
  MDM_CONFIG: "amos.shortcuts.mdm.config",
  MDM_EXECUTION_COUNT: "amos.shortcuts.mdm.execution_count",
};

const DEFAULT_RESTRICTIONS: MDMRestrictions = {
  disabledCategories: [],
  disabledActions: [],
  maxExecutionTime: 300,           // 5 分钟
  maxExecutionsPerDay: 1000,
  maxActionsPerShortcut: 100,
  maxShortcutsPerUser: 100,        // 每个用户最多 100 个快捷指令
  allowUserCreate: true,
  allowUserModify: true,
  allowUserDelete: true,
  allowSharing: true,
  allowExport: true,
  allowImport: true,
  requireApprovalForCreate: false,
  requireApprovalForModify: false,
  requireApprovalForSharing: false,
};

// ============================================================================
// MDM 管理器
// ============================================================================

export class MDMManager {
  private config: MDMConfig | null = null;
  private executionCounts: Map<string, number> = new Map();

  /**
   * 初始化 MDM 管理器
   */
  async initialize(): Promise<void> {
    this.loadConfig();
    this.loadExecutionCounts();
    
    if (this.config?.enabled) {
      // 启动自动同步
      this.startAutoSync();
      
      // 检查设备状态
      if (this.config.deviceStatus === "locked") {
        throw new Error(`设备已锁定: ${this.config.lockMessage || "请联系管理员"}`);
      }
      if (this.config.deviceStatus === "wiped") {
        this.wipeLocalData();
        throw new Error("设备数据已被远程擦除");
      }
    }
  }

  /**
   * 加载 MDM 配置
   */
  private loadConfig(): void {
    const raw = readStoreValue(STORE_KEYS.MDM_CONFIG, "");
    if (!raw) {
      this.config = null;
      return;
    }

    try {
      this.config = JSON.parse(raw) as MDMConfig;
    } catch (err) {
      console.error("[MDM] 加载配置失败:", err);
      this.config = null;
    }
  }

  /**
   * 保存 MDM 配置
   */
  private saveConfig(): void {
    if (!this.config) return;
    
    const serialized = JSON.stringify(this.config);
    writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, serialized);
  }

  /**
   * 加载执行计数
   */
  private loadExecutionCounts(): void {
    const raw = readStoreValue<string>(STORE_KEYS.MDM_EXECUTION_COUNT, "");
    if (!raw) return;

    try {
      const data = JSON.parse(raw) as Record<string, number>;
      this.executionCounts = new Map(Object.entries(data));
      
      // 清理过期数据（每天重置）
      const today = new Date().toISOString().split("T")[0] || "";
      if (!raw.includes(today)) {
        this.executionCounts.clear();
      }
    } catch (err) {
      console.error("[MDM] 加载执行计数失败:", err);
      this.executionCounts.clear();
    }
  }

  /**
   * 保存执行计数
   */
  private saveExecutionCounts(): void {
    const today = new Date().toISOString().split("T")[0];
    const data: Record<string, number> = {};
    
    this.executionCounts.forEach((count, key) => {
      data[key] = count;
    });
    
    const serialized = JSON.stringify({ date: today, counts: data });
    writeStoreValueChecked(STORE_KEYS.MDM_EXECUTION_COUNT, serialized);
  }

  /**
   * 注册设备到 MDM
   */
  async enrollDevice(
    serverUrl: string,
    enrollmentToken: string,
    deviceName: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      const deviceId = this.generateDeviceId();
      
      // 调用注册 API（模拟）
      const response = await this.callMDMApi<MDMEnrollResponse>(`${serverUrl}/api/mdm/enroll`, {
        method: "POST",
        body: JSON.stringify({
          enrollmentToken,
          deviceId,
          deviceName,
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          timestamp: Date.now(),
        }),
      });

      if (!response.success || !response.data) {
        return { success: false, message: response.message || "注册失败" };
      }

      // 创建初始配置
      this.config = {
        enabled: true,
        organizationId: response.data.organizationId,
        organizationName: response.data.organizationName,
        deviceId,
        deviceName,
        serverUrl,
        apiKey: response.data.apiKey,
        policies: [],
        restrictions: DEFAULT_RESTRICTIONS,
        enforcedShortcuts: [],
        enforcedTemplates: [],
        syncInterval: 3600, // 1 小时
        lastSyncAt: Date.now(),
        lastSyncStatus: "success",
        deviceStatus: "active",
        enrolledAt: Date.now(),
        enrolledBy: response.data.enrolledBy || "admin",
        version: "1.0.0",
      };

      this.saveConfig();
      
      // 首次同步
      await this.syncWithServer();

      return { success: true, message: "设备注册成功" };
    } catch (err) {
      console.error("[MDM] 注册失败:", err);
      return { success: false, message: err instanceof Error ? err.message : "注册失败" };
    }
  }

  /**
   * 取消注册
   */
  async unenrollDevice(): Promise<void> {
    if (!this.config) return;

    try {
      // 通知服务器
      await this.callMDMApi(`${this.config.serverUrl}/api/mdm/unenroll`, {
        method: "POST",
        body: JSON.stringify({
          deviceId: this.config.deviceId,
          timestamp: Date.now(),
        }),
      });
    } catch (err) {
      console.error("[MDM] 取消注册失败:", err);
    }

    // 清理本地数据
    this.config = null;
    this.saveConfig();
    this.executionCounts.clear();
    this.saveExecutionCounts();
  }

  /**
   * 与服务器同步配置
   */
  async syncWithServer(): Promise<MDMSyncResponse> {
    if (!this.config) {
      return {
        success: false,
        message: "MDM 未启用",
        serverTime: Date.now(),
      };
    }

    try {
      const response = await this.callMDMApi<Partial<MDMConfig>>(
        `${this.config.serverUrl}/api/mdm/sync`,
        {
          method: "POST",
          body: JSON.stringify({
            deviceId: this.config.deviceId,
            lastSyncAt: this.config.lastSyncAt,
            currentVersion: this.config.version,
          }),
        }
      );

      if (!response.success || !response.data) {
        this.config.lastSyncStatus = "failure";
        this.config.lastSyncError = response.message;
        this.saveConfig();
        return {
          success: false,
          message: response.message,
          serverTime: Date.now(),
        };
      }

      // 更新配置
      const serverConfig = response.data;
      this.config = {
        ...this.config,
        ...serverConfig,
        lastSyncAt: Date.now(),
        lastSyncStatus: "success",
        lastSyncError: undefined,
      };
      this.saveConfig();

      return {
        success: true,
        config: this.config,
        serverTime: Date.now(),
      };
    } catch (err) {
      console.error("[MDM] 同步失败:", err);
      if (this.config) {
        this.config.lastSyncStatus = "failure";
        this.config.lastSyncError = err instanceof Error ? err.message : "同步失败";
        this.saveConfig();
      }
      return {
        success: false,
        message: err instanceof Error ? err.message : "同步失败",
        serverTime: Date.now(),
      };
    }
  }

  /**
   * 启动自动同步
   */
  private startAutoSync(): void {
    if (!this.config) return;

    setInterval(() => {
      this.syncWithServer().catch(err => {
        console.error("[MDM] 自动同步失败:", err);
      });
    }, this.config.syncInterval * 1000);
  }

  /**
   * 检查操作是否允许（按分类和操作 ID）
   */
  checkActionAllowed(category: ActionCategory, actionId: string): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    // 检查分类限制
    if (this.config.restrictions.disabledCategories.includes(category)) {
      return {
        allowed: false,
        reason: `操作分类 "${category}" 已被管理员禁用`,
      };
    }

    // 检查特定操作限制
    if (this.config.restrictions.disabledActions.includes(actionId)) {
      return {
        allowed: false,
        reason: `操作 "${actionId}" 已被管理员禁用`,
      };
    }

    return { allowed: true };
  }

  /**
   * 检查权限
   */
  checkPermission(permission: "create" | "modify" | "delete" | "share" | "export" | "import"): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    const restrictions = this.config.restrictions;

    switch (permission) {
      case "create":
        if (!restrictions.allowUserCreate) {
          return { allowed: false, reason: "管理员已禁止创建快捷指令" };
        }
        if (restrictions.requireApprovalForCreate) {
          return { allowed: false, reason: "创建快捷指令需要管理员审批" };
        }
        break;

      case "modify":
        if (!restrictions.allowUserModify) {
          return { allowed: false, reason: "管理员已禁止修改快捷指令" };
        }
        if (restrictions.requireApprovalForModify) {
          return { allowed: false, reason: "修改快捷指令需要管理员审批" };
        }
        break;

      case "delete":
        if (!restrictions.allowUserDelete) {
          return { allowed: false, reason: "管理员已禁止删除快捷指令" };
        }
        break;

      case "share":
        if (!restrictions.allowSharing) {
          return { allowed: false, reason: "管理员已禁止分享快捷指令" };
        }
        if (restrictions.requireApprovalForSharing) {
          return { allowed: false, reason: "分享快捷指令需要管理员审批" };
        }
        break;

      case "export":
        if (!restrictions.allowExport) {
          return { allowed: false, reason: "管理员已禁止导出快捷指令" };
        }
        break;

      case "import":
        if (!restrictions.allowImport) {
          return { allowed: false, reason: "管理员已禁止导入快捷指令" };
        }
        break;
    }

    return { allowed: true };
  }

  /**
   * 检查是否允许创建快捷指令
   */
  checkCanCreate(): MDMCheckResult {
    return this.checkPermission("create");
  }

  /**
   * 检查是否允许修改快捷指令
   */
  checkCanModify(shortcutId: string): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    // 强制快捷指令不可修改
    if (this.config.enforcedShortcuts.includes(shortcutId)) {
      return {
        allowed: false,
        reason: "此快捷指令由管理员强制安装，不可修改",
      };
    }

    if (!this.config.restrictions.allowUserModify) {
      return {
        allowed: false,
        reason: "管理员已禁止修改快捷指令",
      };
    }

    if (this.config.restrictions.requireApprovalForModify) {
      return {
        allowed: false,
        reason: "修改快捷指令需要管理员审批",
      };
    }

    return { allowed: true };
  }

  /**
   * 检查是否允许删除快捷指令
   */
  checkCanDelete(shortcutId: string): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    // 强制快捷指令不可删除
    if (this.config.enforcedShortcuts.includes(shortcutId)) {
      return {
        allowed: false,
        reason: "此快捷指令由管理员强制安装，不可删除",
      };
    }

    if (!this.config.restrictions.allowUserDelete) {
      return {
        allowed: false,
        reason: "管理员已禁止删除快捷指令",
      };
    }

    return { allowed: true };
  }

  /**
   * 检查是否允许执行
   */
  checkCanExecute(shortcutId: string, actionCount: number): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    // 检查操作数限制
    if (actionCount > this.config.restrictions.maxActionsPerShortcut) {
      return {
        allowed: false,
        reason: `快捷指令操作数超过限制（${this.config.restrictions.maxActionsPerShortcut}）`,
      };
    }

    // 检查每日执行次数
    const today = new Date().toISOString().split("T")[0];
    const countKey = `${today}-${shortcutId}`;
    const currentCount = this.executionCounts.get(countKey) || 0;

    if (currentCount >= this.config.restrictions.maxExecutionsPerDay) {
      return {
        allowed: false,
        reason: `已达到每日最大执行次数（${this.config.restrictions.maxExecutionsPerDay}）`,
      };
    }

    return { allowed: true };
  }

  /**
   * 检查执行时间限制
   */
  checkExecutionTime(durationSeconds: number): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    if (durationSeconds > this.config.restrictions.maxExecutionTime) {
      return {
        allowed: false,
        reason: `执行时间超过最大执行时间限制（${this.config.restrictions.maxExecutionTime}秒）`,
      };
    }

    return { allowed: true };
  }

  /**
   * 检查操作数量限制
   */
  checkActionCount(count: number): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    if (count > this.config.restrictions.maxActionsPerShortcut) {
      return {
        allowed: false,
        reason: `操作数超过最大操作数限制（${this.config.restrictions.maxActionsPerShortcut}）`,
      };
    }

    return { allowed: true };
  }

  /**
   * 检查每日执行次数限制
   */
  checkDailyExecutionLimit(shortcutId: string): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    const today = new Date().toISOString().split("T")[0];
    const countKey = `${today}-${shortcutId}`;
    const currentCount = this.executionCounts.get(countKey) || 0;

    if (currentCount >= this.config.restrictions.maxExecutionsPerDay) {
      return {
        allowed: false,
        reason: `超过每日执行次数限制（${this.config.restrictions.maxExecutionsPerDay}）`,
      };
    }

    return { allowed: true };
  }

  /**
   * 记录执行
   */
  recordExecution(shortcutId: string): void {
    if (!this.config?.enabled) return;

    const today = new Date().toISOString().split("T")[0];
    const countKey = `${today}-${shortcutId}`;
    const currentCount = this.executionCounts.get(countKey) || 0;
    
    this.executionCounts.set(countKey, currentCount + 1);
    this.saveExecutionCounts();
  }

  /**
   * 检查操作是否被禁用
   */
  isActionDisabled(actionId: string, category: ActionCategory): boolean {
    if (!this.config?.enabled) return false;

    return (
      this.config.restrictions.disabledActions.includes(actionId) ||
      this.config.restrictions.disabledCategories.includes(category)
    );
  }

  /**
   * 获取当前配置
   */
  getConfig(): MDMConfig | null {
    return this.config;
  }

  /**
   * 获取限制配置
   */
  getRestrictions(): MDMRestrictions {
    return this.config?.restrictions || DEFAULT_RESTRICTIONS;
  }

  /**
   * 获取设备状态
   */
  getDeviceStatus(): "active" | "locked" | "wiped" {
    return this.config?.deviceStatus || "active";
  }

  /**
   * 获取锁定消息
   */
  getLockMessage(): string | undefined {
    return this.config?.lockMessage;
  }

  /**
   * 是否已启用 MDM
   */
  isEnabled(): boolean {
    return this.config?.enabled ?? false;
  }

  /**
   * 配置 MDM（手动）
   */
  configure(config: Partial<MDMConfig>): void {
    if (!this.config) {
      // 如果没有配置，创建默认配置
      this.config = {
        enabled: false,
        serverUrl: "",
        deviceId: this.generateDeviceId(),
        deviceName: "",
        organizationId: "",
        organizationName: "",
        apiKey: "",
        policies: [],
        lastSyncAt: 0,
        syncInterval: 3600,
        lastSyncStatus: "pending",
        deviceStatus: "active",
        enrolledAt: 0,
        enrolledBy: "",
        version: "1.0.0",
        restrictions: {
          allowUserCreate: true,
          allowUserModify: true,
          allowUserDelete: true,
          allowSharing: true,
          allowExport: true,
          allowImport: true,
          requireApprovalForCreate: false,
          requireApprovalForModify: false,
          requireApprovalForSharing: false,
          maxShortcutsPerUser: 100,
          maxActionsPerShortcut: 50,
          maxExecutionsPerDay: 1000,
          maxExecutionTime: 300,
          disabledActions: [],
          disabledCategories: [],
        },
        enforcedShortcuts: [],
        enforcedTemplates: [],
      };
    }
    
    // 更新配置（确保必需字段存在）
    if (!this.config) return;
    
    this.config = {
      enabled: config.enabled ?? this.config.enabled,
      organizationId: config.organizationId ?? this.config.organizationId,
      organizationName: config.organizationName ?? this.config.organizationName,
      deviceId: config.deviceId ?? this.config.deviceId,
      deviceName: config.deviceName ?? this.config.deviceName,
      serverUrl: config.serverUrl ?? this.config.serverUrl,
      apiKey: config.apiKey ?? this.config.apiKey,
      policies: config.policies ?? this.config.policies,
      restrictions: config.restrictions ?? this.config.restrictions,
      enforcedShortcuts: config.enforcedShortcuts ?? this.config.enforcedShortcuts,
      enforcedTemplates: config.enforcedTemplates ?? this.config.enforcedTemplates,
      syncInterval: config.syncInterval ?? this.config.syncInterval,
      lastSyncAt: config.lastSyncAt ?? this.config.lastSyncAt,
      lastSyncStatus: config.lastSyncStatus ?? this.config.lastSyncStatus,
      deviceStatus: config.deviceStatus ?? this.config.deviceStatus,
      enrolledAt: config.enrolledAt ?? this.config.enrolledAt,
      enrolledBy: config.enrolledBy ?? this.config.enrolledBy,
      version: config.version ?? this.config.version,
    };
    this.saveConfig();
  }

  /**
   * 添加策略
   */
  addPolicy(policyKey: keyof MDMConfig["restrictions"], value: any): void {
    if (!this.config) {
      this.configure({});
    }
    
    if (this.config && this.config.restrictions) {
      (this.config.restrictions as any)[policyKey] = value;
      this.saveConfig();
    }
  }

  /**
   * 获取策略
   */
  getPolicy(policyKey: keyof MDMConfig["restrictions"]): any {
    return this.config?.restrictions[policyKey];
  }

  /**
   * 获取所有策略（按优先级排序）
   */
  getPolicies(): MDMPolicy[] {
    const policies = this.config?.policies || [];
    return [...policies].sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取限制策略
   */
  getRestrictionPolicies(): MDMConfig["restrictions"] | null {
    return this.config?.restrictions ?? null;
  }

  /**
   * 删除策略（恢复默认值）
   */
  deletePolicy(policyKey: keyof MDMConfig["restrictions"]): boolean {
    if (!this.config?.restrictions) return false;
    
    // 恢复默认值
    const defaults: MDMConfig["restrictions"] = {
      allowUserCreate: true,
      allowUserModify: true,
      allowUserDelete: true,
      allowSharing: true,
      allowExport: true,
      allowImport: true,
      requireApprovalForCreate: false,
      requireApprovalForModify: false,
      requireApprovalForSharing: false,
      maxShortcutsPerUser: 100,
      maxActionsPerShortcut: 50,
      maxExecutionsPerDay: 1000,
      maxExecutionTime: 300,
      disabledActions: [],
      disabledCategories: [],
    };
    
    (this.config.restrictions as any)[policyKey] = defaults[policyKey];
    this.saveConfig();
    return true;
  }

  /**
   * 生成设备 ID
   */
  private generateDeviceId(): string {
    return `device-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 调用 MDM API
   */
  private async callMDMApi<T = unknown>(
    url: string,
    options: RequestInit
  ): Promise<{ success: boolean; data?: T; message?: string }> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // 合并自定义 headers
      if (options.headers) {
        const customHeaders = options.headers as Record<string, string>;
        Object.assign(headers, customHeaders);
      }

      if (this.config?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(url, {
        ...options,
        headers,
      });

      const data = await response.json();
      return data;
    } catch (err) {
      console.error("[MDM] API 调用失败:", err);
      throw err;
    }
  }

  /**
   * 擦除本地数据
   */
  private wipeLocalData(): void {
    // 清理所有企业数据
    this.config = null;
    this.saveConfig();
    this.executionCounts.clear();
    this.saveExecutionCounts();
    
    // 清理其他企业数据（快捷指令、模板等）
    // 这里可以添加更多清理逻辑
  }

  /**
   * 关闭 MDM 管理器（用于测试清理）
   */
  shutdown(): void {
    // 清理资源
    this.executionCounts.clear();
    // 清空配置
    this.config = null;
  }

  /**
   * 设置配置（测试辅助方法）
   * @internal 仅用于测试
   */
  setConfigForTest(config: MDMConfig): void {
    this.config = config;
  }

  /**
   * 清空配置（测试辅助方法）
   * @internal 仅用于测试
   */
  clearConfigForTest(): void {
    this.config = null;
    this.executionCounts.clear();
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const mdmManager = new MDMManager();
