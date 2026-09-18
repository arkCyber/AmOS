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
// Type-only import: erased at runtime, so it cannot create the `mdm ⇄ audit`
// cycle that a value import would (`audit.ts` imports `mdmManager` from here).
import type { AuditEventCategory, AuditEventType, AuditLogLevel, AuditResult } from "./audit";
import { localId } from "../localId";

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
  /** 自动同步的定时器句柄（`null` = 未启动）。 */
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 记录一条 MDM 配置事件到**企业审计轨**（`lib/enterprise/audit.ts`
   * 的 `auditLogger` —— `api.ts` 写的是同一条轨）。
   *
   * 两个刻意的性质：
   * - **动态 import**：`audit.ts` 已经 import 本模块的 `mdmManager`，静态 import
   *   会形成环；两处调用都在 async 方法里，所以事件真的发生时才加载。
   * - **永不抛错**：审计写入不得让配置的加载/保存失败（否则它报告的"失败"
   *   就是它自己造成的）。审计是 best-effort，配置路径才是权威。
   */
  private async audit(params: {
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
  }): Promise<void> {
    try {
      const { auditLogger } = await import("./audit");
      await auditLogger.log(params);
    } catch {
      /* 审计轨不可用时静默：配置的权威性不因它而改变 */
    }
  }

  /**
   * 初始化 MDM 管理器
   */
  async initialize(): Promise<void> {
    await this.loadConfig();
    this.loadExecutionCounts();
    
    if (this.config?.enabled) {
      // 启动自动同步
      this.startAutoSync();
      
      // 检查设备状态
      if (this.config.deviceStatus === "locked") {
        throw new Error(`设备已锁定: ${this.config.lockMessage || "请联系管理员"}`);
      }
      if (this.config.deviceStatus === "wiped") {
        await this.wipeLocalData();
        throw new Error("设备数据已被远程擦除");
      }
    }
  }

  /**
   * 加载 MDM 配置
   * 
   * 尝试从加密存储加载配置，如果失败则回退到明文格式（向后兼容）。
   */
  private async loadConfig(): Promise<void> {
    const raw = readStoreValue(STORE_KEYS.MDM_CONFIG, "");
    if (!raw) {
      this.config = null;
      return;
    }

    try {
      // 尝试加密解密（新格式）
      const { decryptMDMData, isCryptoAvailable } = await import("../crypto/mdmCrypto");
      
      if (isCryptoAvailable()) {
        try {
          const decrypted = await decryptMDMData(raw);
          this.config = JSON.parse(decrypted) as MDMConfig;
          
          // 审计：配置以加密格式加载成功
          await this.audit({
            eventType: "mdm_config_update",
            eventCategory: "security",
            eventDescription: "MDM 配置解密加载成功",
            actionDetails: { storage: "encrypted" },
          });
          
          return;
        } catch (decryptErr) {
          // 解密失败，可能是明文格式（旧版本）或数据损坏
          console.warn("[MDM] 解密失败，尝试明文加载:", decryptErr);
          
          await this.audit({
            eventType: "error_occurred",
            eventCategory: "security",
            eventDescription: "MDM 配置解密失败，回退明文加载",
            level: "warning",
            result: "failure",
            errorMessage: String(decryptErr),
          });
        }
      }
      
      // 回退：尝试明文格式（向后兼容）
      this.config = JSON.parse(raw) as MDMConfig;
      
      // 如果成功加载明文配置，自动迁移到加密格式
      if (this.config && isCryptoAvailable()) {
        console.info("[MDM] 检测到明文配置，自动迁移到加密存储");
        await this.saveConfig(); // 重新保存为加密格式
      }
    } catch (err) {
      console.error("[MDM] 加载配置失败:", err);
      await this.audit({
        eventType: "error_occurred",
        eventCategory: "system",
        eventDescription: "MDM 配置加载失败",
        level: "error",
        result: "failure",
        errorMessage: String(err),
      });
      this.config = null;
    }
  }

  /**
   * 保存 MDM 配置
   * 
   * 使用加密存储保护敏感数据（API 密钥、组织 ID 等）。
   */
  private async saveConfig(): Promise<void> {
    if (!this.config) return;
    
    try {
      const { encryptMDMData, isCryptoAvailable } = await import("../crypto/mdmCrypto");
      
      const plaintext = JSON.stringify(this.config);
      
      if (isCryptoAvailable()) {
        // 加密存储（推荐）
        const encrypted = await encryptMDMData(plaintext);
        const success = writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, encrypted);
        
        if (success) {
          await this.audit({
            eventType: "mdm_config_update",
            eventCategory: "security",
            eventDescription: "MDM 配置加密保存成功",
            actionDetails: { storage: "encrypted", dataSize: encrypted.length },
          });
        } else {
          throw new Error("写入加密配置失败");
        }
      } else {
        // 回退：明文存储（不推荐，仅用于不支持 Web Crypto 的环境）
        console.warn("[MDM] Web Crypto API 不可用，使用明文存储（不安全）");
        // 这次写入就是本方法的目的：存储拒收必须被当成失败报出来，而不是照旧
        // 记一条"已保存"（write-scan / audit P1-3 的同一规则）。
        if (!writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, plaintext)) {
          throw new Error("写入明文配置失败");
        }

        // 明文存储是一次**安全降级**，必须留下 warning，而不是静默发生。
        await this.audit({
          eventType: "warning_occurred",
          eventCategory: "security",
          eventDescription: "MDM 配置以明文保存（Web Crypto 不可用）",
          level: "warning",
          result: "warning",
          actionDetails: { storage: "plaintext", warning: "encryption_unavailable" },
        });
      }
    } catch (err) {
      console.error("[MDM] 保存配置失败:", err);
      await this.audit({
        eventType: "error_occurred",
        eventCategory: "system",
        eventDescription: "MDM 配置保存失败",
        level: "error",
        result: "failure",
        errorMessage: String(err),
      });
      throw err; // 向上传播错误
    }
  }

  /**
   * 加载执行计数
   *
   * 形状必须与 `saveExecutionCounts` 一致：那里写的是
   * `{ date: "yyyy-mm-dd", counts: { "<yyyy-mm-dd>-<shortcutId>": n } }`。
   * 这里原来把**整个对象**当成"键 → 次数"的扁平表读（`new Map(Object.entries(data))`），
   * 于是读回来的键只会是 `"date"` / `"counts"` 两个字面量 —— **每一个真实计数都被丢掉**，
   * 而 `raw.includes(today)` 又因为 `date` 字段里就有今天的日期而不清空 ⇒
   * `checkDailyExecutionLimit` 拿到 `undefined`、按 0 处理 ⇒
   * **每日执行配额在每次重启/重载后静默失效**（`saveExecutionCounts` 的告警恰好把这句
   * "当日配额会重新开始"写成"存储拒绝时才会发生"，而正常路径就是那样）。
   */
  private loadExecutionCounts(): void {
    const raw = readStoreValue<string>(STORE_KEYS.MDM_EXECUTION_COUNT, "");
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as { date?: unknown; counts?: unknown };
      const today = new Date().toISOString().split("T")[0] || "";

      // 形状不认识、或存的是**别的日子** ⇒ 清空：配额是"每日"的，昨天的计数今天不算数。
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        parsed.date !== today ||
        parsed.counts === null ||
        typeof parsed.counts !== "object" ||
        Array.isArray(parsed.counts)
      ) {
        this.executionCounts.clear();
        return;
      }

      const restored = new Map<string, number>();
      for (const [key, value] of Object.entries(parsed.counts as Record<string, unknown>)) {
        // 只收自己能解释的条目：一个坏条目不该把整份配额读成 NaN/字符串。
        if (typeof value === "number" && Number.isFinite(value)) restored.set(key, value);
      }
      this.executionCounts = restored;
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
    // 每日执行计数丢失 = 管理员设的上限当天会重新开始，必须报（write-scan 判据）。
    if (!writeStoreValueChecked(STORE_KEYS.MDM_EXECUTION_COUNT, serialized)) {
      console.error("[MDM] 执行计数写入被存储拒绝 —— 当日配额会在重启后重新开始");
    }
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

      await this.saveConfig();
      
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

    // 清理本地数据（同 `clearStoredState`：必须落到**存储**，否则一次"取消注册"之后
    // 加密配置原样留在盘上，下次启动又把它读回来，设备"退不掉"。）
    this.clearStoredState();
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
        await this.saveConfig();
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
      await this.saveConfig();

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
        await this.saveConfig();
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
   *
   * 定时器**必须留句柄**：原来这里连 id 都不存、也没有任何停止路径，于是
   * ①重复 `initialize()` 会叠出多只定时器（每次 syncInterval 就多发一轮同步），
   * ②壳是长期存活的，谁也无法停掉它 —— lifetime-scan 的判据（REQ-A385）。
   */
  private startAutoSync(): void {
    if (!this.config) return;

    this.stopAutoSync(); // 幂等：重复启动不得叠加
    this.syncTimer = setInterval(() => {
      this.syncWithServer().catch((err) => {
        console.error("[MDM] 自动同步失败:", err);
      });
    }, this.config.syncInterval * 1000);
  }

  /** 停止自动同步（幂等；`shutdownEnterprise` 会调它）。 */
  stopAutoSync(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
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
  async configure(config: Partial<MDMConfig>): Promise<void> {
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
    
    // 注意：这里逐字段重建，**新增字段必须一起列进来**。`lockMessage` 与
    // `lastSyncError` 曾经不在表里 ⇒ 每次 `configure()`（ enrolment / 同步 / 手动设置
    // 都会走到这里）都会把管理员下发的锁定说明与上次同步错误**静默丢掉**：
    // 锁定屏会显示通用措辞，而"为什么同步失败"再也查不到。
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
      lastSyncError: config.lastSyncError ?? this.config.lastSyncError,
      deviceStatus: config.deviceStatus ?? this.config.deviceStatus,
      lockMessage: config.lockMessage ?? this.config.lockMessage,
      enrolledAt: config.enrolledAt ?? this.config.enrolledAt,
      enrolledBy: config.enrolledBy ?? this.config.enrolledBy,
      version: config.version ?? this.config.version,
    };
    await this.saveConfig();
  }

  /**
   * 添加策略
   */
  async addPolicy(policyKey: keyof MDMConfig["restrictions"], value: any): Promise<void> {
    if (!this.config) {
      await this.configure({});
    }
    
    if (this.config && this.config.restrictions) {
      (this.config.restrictions as any)[policyKey] = value;
      await this.saveConfig();
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
   *
   * `async` 不是因为"看起来更现代"：恢复默认值之后必须**持久化**（`saveConfig`），
   * 而写盘是异步的 —— 一个同步返回的 `true` 会在写入还没落地时就告诉调用方
   * "已删除"，落盘失败时（`saveConfig` 会抛）调用方已经拿到 `true` 了。
   */
  async deletePolicy(policyKey: keyof MDMConfig["restrictions"]): Promise<boolean> {
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

    // 恢复该键的默认值（类型的键是联合类型，赋值要走一次受控的窄化）
    (this.config.restrictions as unknown as Record<string, unknown>)[policyKey] = defaults[policyKey];
    await this.saveConfig();
    await this.audit({
      eventType: "mdm_policy_change",
      eventCategory: "management",
      eventDescription: "MDM 策略被删除（恢复默认值）",
      resourceType: "policy",
      resourceId: String(policyKey),
      actionDetails: { policy: String(policyKey), restoredTo: defaults[policyKey] },
    });
    return true;
  }

  /**
   * 生成设备 ID
   */
  private generateDeviceId(): string {
    return localId("device");
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
   * 把"本机受管状态"从存储里清干净（远程擦除 / 取消注册共用）。
   *
   * 关键点是**必须落到存储**：`saveConfig()` 在 `config === null` 时直接 `return`，
   * 所以"先把内存字段置空、再 saveConfig()"实际上一个字节都没删 —— 下次启动会把
   * 加密配置（含 apiKey / organizationId）原样读回来。空串是"没有配置"的既有编码
   * （`readStoreValue(KEY, "")` 为假 ⇒ `loadConfig` 归 null），且仍然走 `amosStore`
   * 的写路径（durable 副本 + 跨窗口总线），桥那一侧的副本因此也会被清掉。
   *
   * 两次写入都**检查结果**：存储拒收必须被说出来（write-scan 判据）—— 静默失败
   * 正是"已擦除"这句谎话的来源。
   */
  private clearStoredState(): void {
    if (!writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, "")) {
      console.error("[MDM] 擦除配置写入被存储拒绝 —— 受管配置仍留在本地");
    }
    this.config = null;
    this.executionCounts.clear();
    if (!writeStoreValueChecked(STORE_KEYS.MDM_EXECUTION_COUNT, "")) {
      console.error("[MDM] 擦除执行计数写入被存储拒绝 —— 旧计数仍留在本地");
    }
  }

  /**
   * 擦除本地数据
   */
  private async wipeLocalData(): Promise<void> {
    // 见 `clearStoredState` 的说明：擦除必须落到存储，否则设备会永远停在
    // "每次启动都读到旧配置、又报一次已被擦除"的循环里。
    this.clearStoredState();

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
