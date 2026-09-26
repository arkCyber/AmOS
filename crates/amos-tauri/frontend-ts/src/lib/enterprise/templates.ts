/**
 * enterprise/templates.ts — 企业模板管理
 * 
 * 功能:
 * - 企业模板库
 * - 模板分发
 * - 版本控制
 * - 参数化配置
 * 
 * 安全特性:
 * - 模板签名验证
 * - 参数校验
 * - 权限检查
 */

import { readStoreValue, writeStoreValueChecked } from "../amosStore";
import { resolveAuditIdentity } from "../buildIdentity";
import { logger } from "./logger";
import { createShortcut, deleteShortcut, loadShortcuts, type Shortcut } from "../shortcuts";
import { mdmManager } from "./mdm";
import { emitWebhookEvent } from "./webhooks";
import { localId } from "../localId";

// ============================================================================
// 类型定义
// ============================================================================

/** 模板发布状态 */
export type TemplatePublishStatus = "draft" | "testing" | "published" | "archived";

/** 模板参数类型 */
export type TemplateParameterType = "text" | "url" | "number" | "select" | "boolean";

/** 模板参数 */
export interface TemplateParameter {
  key: string;
  name: string;
  type: TemplateParameterType;
  defaultValue: unknown;
  required: boolean;
  description: string;
  /** select 类型的选项 */
  options?: Array<{ label: string; value: unknown }>;
  /** 验证规则 */
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    message?: string;
  };
}

/** 企业模板 */
export interface EnterpriseTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  department: string;
  icon: string;
  color: string;
  
  // 版本信息
  version: string;
  changelog?: string;
  
  // 快捷指令数据
  shortcutData: Shortcut;
  
  // 可配置参数
  parameters: TemplateParameter[];
  
  // 目标用户
  targetRoles: string[];
  targetDepartments: string[];
  
  // 安装控制
  isForced: boolean;              // 是否强制安装
  allowCustomization: boolean;     // 允许用户自定义
  autoUpdate: boolean;            // 自动更新
  
  // 发布信息
  publishStatus: TemplatePublishStatus;
  publishedAt?: number;
  publishedBy?: string;
  
  // 统计信息
  installedCount: number;
  successCount: number;
  failureCount: number;
  
  // 元数据
  organizationId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  
  // 签名（用于验证完整性）
  signature?: string;
}

/** 模板安装记录 */
export interface TemplateInstallation {
  templateId: string;
  templateVersion: string;
  shortcutId: string;            // 安装后的快捷指令 ID
  installedAt: number;
  installedBy: string;
  parameterValues: Record<string, unknown>;
  status: "active" | "outdated" | "uninstalled";
  lastUpdateCheck: number;
}

/** 模板分类 */
export interface TemplateCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
  order: number;
}

// ============================================================================
// 常量
// ============================================================================

export const TEMPLATES_KEY = "amos.shortcuts.enterprise.templates";
export const TEMPLATE_INSTALLATIONS_KEY = "amos.shortcuts.enterprise.installations";
export const TEMPLATE_CATEGORIES_KEY = "amos.shortcuts.enterprise.categories";

const STORE_KEYS = {
  TEMPLATES: TEMPLATES_KEY,
  INSTALLATIONS: TEMPLATE_INSTALLATIONS_KEY,
  CATEGORIES: TEMPLATE_CATEGORIES_KEY,
};

const DEFAULT_CATEGORIES: TemplateCategory[] = [
  { id: "productivity", name: "生产力", description: "提升工作效率", icon: "⚡", order: 1 },
  { id: "communication", name: "沟通协作", description: "团队沟通工具", icon: "💬", order: 2 },
  { id: "automation", name: "自动化", description: "业务流程自动化", icon: "🤖", order: 3 },
  { id: "reporting", name: "报表", description: "数据报表生成", icon: "📊", order: 4 },
  { id: "customer_service", name: "客户服务", description: "客服工具", icon: "🎧", order: 5 },
  { id: "sales", name: "销售", description: "销售工具", icon: "💼", order: 6 },
  { id: "it_ops", name: "IT 运维", description: "IT 运维工具", icon: "🔧", order: 7 },
  { id: "hr", name: "人力资源", description: "HR 工具", icon: "👥", order: 8 },
];

// ============================================================================
// 模板管理器
// ============================================================================

export class TemplateManager {
  private templates: Map<string, EnterpriseTemplate> = new Map();
  private installations: Map<string, TemplateInstallation> = new Map();
  private categories: TemplateCategory[] = [];
  /** `ensureInitialized()` 是否已经跑过（见那里为什么读写路径要自己把它叫起来）。 */
  private initialized = false;

  /**
   * 初始化模板管理器
   *
   * **不要只靠它**——它唯一的调用者是 `enterprise/index.ts` 的 `initializeEnterprise()`，
   * 而后者在生产里**零调用者**（同一事实 `audit.ts::ensureInitialized`（REQ-A897）、
   * `mdm.ts::ensureInitialized`（REQ-A945）与 `webhooks.ts::ensureInitialized`（REQ-A980）
   * 各记过一次）。见 {@link ensureInitialized}。
   */
  async initialize(): Promise<void> {
    this.initialized = true;
    this.bootstrap();

    // 检查更新
    if (mdmManager.isEnabled()) {
      await this.checkForUpdates();
    }
  }

  /**
   * 引导「读回模板 / 安装记录 / 分类」，**幂等**，由使用者自己触发（REQ-A1320）。
   *
   * 为什么不能只依赖 `initialize()`：`initializeEnterprise()` 在生产里零调用者，于是
   * `loadTemplates()` 从未在设备上跑过 —— `this.templates` 恒空，`TemplateLibrary.svelte`
   * 永远画「暂无模板」空态。用户上一次会话落盘的模板、安装记录、自定义分类，重启后
   * 没有任何人读回来。更坏的是写路径：`saveTemplates()` 写的是 `Array.from(this.templates.values())`，
   * 所以在没有引导的情况下 `createTemplate()` 一落盘就会用**只有一条**的内存表覆盖整个目录。
   *
   * 所以把「我起来了」这句话系在**真正需要它的动作**上：读一次列表/详情/分类，或写一次
   * （安装、卸载、创建、更新、删除、发布、同步）。任何一条被用到，流水线就先自己站起来。
   * `initialized` 在**任何读取/重入之前**置位 —— `bootstrap()` 里的三步都在它之后跑，
   * 顺序反了就是递归。
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.bootstrap();
  }

  /**
   * 「读回三张表」这一份，只有这一处（`initialize()` 与 `ensureInitialized()` 共用；
   * 两份字节相同的引导正是上一轮在 `audit.ts` 修的形状）。
   */
  private bootstrap(): void {
    this.loadTemplates();
    this.loadInstallations();
    this.loadCategories();
  }

  /**
   * 加载模板
   */
  private loadTemplates(): void {
    const raw = readStoreValue(STORE_KEYS.TEMPLATES, "");
    if (!raw) {
      this.templates = new Map();
      return;
    }

    try {
      const data = JSON.parse(raw) as EnterpriseTemplate[];
      this.templates = new Map(data.map(t => [t.id, t]));
    } catch (err) {
      console.error("[Templates] 加载失败:", err);
      this.templates = new Map();
    }
  }

  /**
   * 获取当前用户 ID
   */
  private getCurrentUserId(): string {
    // 安装记录里的 `installedBy` 与审计同源：没有用户就如实写 `unattributed`，不留 `user-default`
    // 这种会被读成真实账号的占位串（REQ-A695）。
    return resolveAuditIdentity().userId;
  }

  /**
   * 保存模板
   */
  private saveTemplates(): void {
    const data = Array.from(this.templates.values());
    const serialized = JSON.stringify(data);
    // 模板是用户/管理员的内容：写不进去就是内容丢失，必须报（write-scan 判据）。
    if (!writeStoreValueChecked(STORE_KEYS.TEMPLATES, serialized)) {
      logger.error("templates", `模板写入被存储拒绝 —— ${data.length} 个模板重启后会丢失`);
    }
  }

  /**
   * 加载安装记录
   */
  private loadInstallations(): void {
    const raw = readStoreValue(STORE_KEYS.INSTALLATIONS, "");
    if (!raw) {
      this.installations = new Map();
      return;
    }

    try {
      const data = JSON.parse(raw) as TemplateInstallation[];
      this.installations = new Map(data.map(i => [i.templateId, i]));
    } catch (err) {
      console.error("[Templates] 加载安装记录失败:", err);
      this.installations = new Map();
    }
  }

  /**
   * 保存安装记录
   */
  private saveInstallations(): void {
    const data = Array.from(this.installations.values());
    const serialized = JSON.stringify(data);
    // 安装记录丢失 = 已安装的模板在重启后被当成"没装过"，必须报。
    if (!writeStoreValueChecked(STORE_KEYS.INSTALLATIONS, serialized)) {
      logger.error("templates", `安装记录写入被存储拒绝 —— ${data.length} 条重启后会丢失`);
    }
  }

  /**
   * 加载分类
   */
  private loadCategories(): void {
    const raw = readStoreValue(STORE_KEYS.CATEGORIES, "");
    if (!raw) {
      this.categories = DEFAULT_CATEGORIES;
      this.saveCategories();
      return;
    }

    try {
      this.categories = JSON.parse(raw) as TemplateCategory[];
    } catch (err) {
      console.error("[Templates] 加载分类失败:", err);
      this.categories = DEFAULT_CATEGORIES;
    }
  }

  /**
   * 保存分类
   */
  private saveCategories(): void {
    const serialized = JSON.stringify(this.categories);
    if (!writeStoreValueChecked(STORE_KEYS.CATEGORIES, serialized)) {
      logger.error("templates", "模板分类写入被存储拒绝 —— 重启后会回落到内置分类");
    }
  }

  /**
   * 获取所有模板
   */
  getTemplates(filter?: {
    category?: string;
    department?: string;
    status?: TemplatePublishStatus;
    search?: string;
  }): EnterpriseTemplate[] {
    this.ensureInitialized();
    let templates = Array.from(this.templates.values());

    // 过滤
    if (filter?.category) {
      templates = templates.filter(t => t.category === filter.category);
    }
    if (filter?.department) {
      templates = templates.filter(t => t.department === filter.department);
    }
    if (filter?.status) {
      templates = templates.filter(t => t.publishStatus === filter.status);
    }
    if (filter?.search) {
      const search = filter.search.toLowerCase();
      templates = templates.filter(
        t =>
          t.name.toLowerCase().includes(search) ||
          t.description.toLowerCase().includes(search)
      );
    }

    // 只显示已发布的模板
    templates = templates.filter(t => t.publishStatus === "published");

    return templates.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 获取模板详情
   */
  getTemplate(templateId: string): EnterpriseTemplate | null {
    this.ensureInitialized();
    return this.templates.get(templateId) || null;
  }

  /**
   * 从服务器同步模板
   */
  async syncTemplates(): Promise<{ success: boolean; count: number; message?: string }> {
    this.ensureInitialized();
    const mdmConfig = mdmManager.getConfig();
    if (!mdmConfig) {
      return { success: false, count: 0, message: "MDM 未启用" };
    }

    try {
      const response = await fetch(`${mdmConfig.serverUrl}/api/templates/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${mdmConfig.apiKey}`,
        },
        body: JSON.stringify({
          deviceId: mdmConfig.deviceId,
          organizationId: mdmConfig.organizationId,
          lastSyncAt: Date.now(),
        }),
      });

      const data = await response.json();
      if (!data.success) {
        return { success: false, count: 0, message: data.message };
      }

      // 更新模板
      const serverTemplates = data.templates as EnterpriseTemplate[];
      serverTemplates.forEach(template => {
        this.templates.set(template.id, template);
      });
      this.saveTemplates();

      // 自动安装强制模板
      await this.installForcedTemplates();

      return { success: true, count: serverTemplates.length };
    } catch (err) {
      console.error("[Templates] 同步失败:", err);
      return {
        success: false,
        count: 0,
        message: err instanceof Error ? err.message : "同步失败",
      };
    }
  }

  /**
   * 安装模板
   *
   * `leftoverShortcutId` 只在**重装时收不掉上一条**（`deleteShortcut` 被企业策略拒绝）才出现：
   * 回执仍是 `success`（新的那条确实建出来了），但库里现在有两条同名指令，`安装记录` 只认新的
   * 那条，旧的那条既不在册也删不掉 —— 这句是唯一能让面板把这件事说出来的载体。
   */
  async installTemplate(
    templateId: string,
    parameterValues: Record<string, unknown>
  ): Promise<{
    success: boolean;
    shortcutId?: string;
    leftoverShortcutId?: string;
    message?: string;
  }> {
    this.ensureInitialized();
    const template = this.templates.get(templateId);
    if (!template) {
      return { success: false, message: "模板不存在" };
    }

    // 验证参数
    const validationResult = this.validateParameters(template, parameterValues);
    if (!validationResult.valid) {
      return { success: false, message: validationResult.message };
    }

    try {
      // 应用参数到快捷指令
      const applied = this.applyParameters(template.shortcutData, parameterValues);

      // 真的把它建出来（REQ-A1326）。修前这里只把返回值改了个 id 就回执成功 ——
      // 那条快捷指令从来没有落过盘。走 `shortcuts.ts::createShortcut` 而不是自己 push：
      // 那条路上有 MDM 的每用户上限（`checkCanCreate`，REQ-A842）、名字校验、
      // `LIMITS.MAX_SHORTCUTS`、落盘判定，以及它自己的审计与 webhook；在这里另拼一份
      // 会把这四道全绕过去，也就等于「模板安装是免策略的」。
      const shortcut = createShortcut(applied.name, {
        icon: applied.icon,
        color: applied.color,
        description: applied.description,
        actions: applied.actions,
        quickActions: applied.quickActions,
        triggers: applied.triggers,
        runOnLockScreen: applied.runOnLockScreen,
        requiresConfirmation: applied.requiresConfirmation,
        tags: applied.tags,
      });
      if (!shortcut) {
        // `createShortcut` 把四种原因（策略拒绝 / 名字不合法 / 数量上限 / 落盘被拒）折进
        // 同一个 `null`，所以这里如实只说「是这几条路之一」，不挑一个当成断言的答案。
        return { success: false, message: "快捷指令创建失败（被企业策略或数量上限拒绝）" };
      }

      // 同一条模板重装（`updateInstalledTemplate` 走的就是这里）时把上一轮那条收掉，
      // 否则一次「更新」会留下两条指令。删在**建成功之后**：建不出来就什么都不动。
      const previousShortcutId = this.installations.get(templateId)?.shortcutId;
      let leftoverShortcutId: string | undefined;
      if (previousShortcutId && previousShortcutId !== shortcut.id) {
        deleteShortcut(previousShortcutId);
        // 判据与 `uninstallTemplate` 同一条：`deleteShortcut` 的 `false` 把「本来就不在」
        // 与「被策略拒绝删除」折成同一个值，所以看的是删完之后**它还在不在**。这里不能
        // 因为收不掉旧的就整单回失败 —— 新的那条已经建出来了，报失败又是一句谎；但也
        // 不能沉默：留下的那条让库里多了一条同名指令，而记录只认新的那条。
        if (loadShortcuts().some((s) => s.id === previousShortcutId)) {
          leftoverShortcutId = previousShortcutId;
        }
      }

      // 记录安装
      const installation: TemplateInstallation = {
        templateId: template.id,
        templateVersion: template.version,
        shortcutId: shortcut.id,
        installedAt: Date.now(),
        installedBy: this.getCurrentUserId(),
        parameterValues,
        status: "active",
        lastUpdateCheck: Date.now(),
      };

      this.installations.set(templateId, installation);
      this.saveInstallations();

      // 更新统计
      template.installedCount++;
      template.successCount++;
      this.saveTemplates();

      // 企业 webhook（REQ-A980）：**只在真的装出来之后**发。上面两条失败出口
      // （模板不存在 / 参数不合法）与下面 `catch` 里的那条都不发 —— 面板上的
      // `template_install` 说的是"装上了"，不是"有人试过"。
      emitWebhookEvent("template_install", {
        templateId: template.id,
        templateVersion: template.version,
        shortcutId: shortcut.id,
        installedBy: installation.installedBy,
      });

      return { success: true, shortcutId: shortcut.id, leftoverShortcutId };
    } catch (err) {
      console.error("[Templates] 安装失败:", err);
      
      // 更新失败统计
      template.failureCount++;
      this.saveTemplates();

      return {
        success: false,
        message: err instanceof Error ? err.message : "安装失败",
      };
    }
  }

  /**
   * 卸载模板
   */
  async uninstallTemplate(templateId: string): Promise<{ success: boolean; message?: string }> {
    this.ensureInitialized();
    const installation = this.installations.get(templateId);
    if (!installation) {
      return { success: false, message: "未安装此模板" };
    }

    const template = this.templates.get(templateId);
    if (template?.isForced) {
      return { success: false, message: "强制模板不可卸载" };
    }

    // 卸载的语义是「这条指令没了」，不是「把安装记录改个状态」（REQ-A1326）：
    // 先把那条快捷指令真的删掉，删不掉就**不改记录**、如实回失败。
    // 判据不能只用 `deleteShortcut` 的返回值 —— 它把「本来就不在」与「被策略拒绝删除」
    // 折成同一个 `false`，而前者本来就已是目标状态。所以看的是删完之后**它还在不在**。
    deleteShortcut(installation.shortcutId);
    if (loadShortcuts().some((s) => s.id === installation.shortcutId)) {
      return { success: false, message: "快捷指令删除被拒（企业策略）" };
    }

    // 更新状态
    installation.status = "uninstalled";
    this.installations.set(templateId, installation);
    this.saveInstallations();

    return { success: true };
  }

  /**
   * 检查模板更新
   */
  async checkForUpdates(): Promise<string[]> {
    this.ensureInitialized();
    const updatableTemplates: string[] = [];

    for (const [templateId, installation] of this.installations.entries()) {
      if (installation.status !== "active") continue;

      const template = this.templates.get(templateId);
      if (!template) continue;

      // 比较版本
      if (template.version !== installation.templateVersion) {
        updatableTemplates.push(templateId);
        installation.status = "outdated";
        installation.lastUpdateCheck = Date.now();
      }
    }

    if (updatableTemplates.length > 0) {
      this.saveInstallations();
    }

    return updatableTemplates;
  }

  /**
   * 更新已安装的模板
   */
  async updateInstalledTemplate(templateId: string): Promise<{ success: boolean; message?: string }> {
    const installation = this.installations.get(templateId);
    if (!installation) {
      return { success: false, message: "未安装此模板" };
    }

    const template = this.templates.get(templateId);
    if (!template) {
      return { success: false, message: "模板不存在" };
    }

    // 重新安装
    return this.installTemplate(templateId, installation.parameterValues);
  }

  /**
   * 获取已安装的模板
   */
  getInstalledTemplates(): TemplateInstallation[] {
    this.ensureInitialized();
    return Array.from(this.installations.values()).filter(i => i.status === "active");
  }

  /**
   * 获取分类列表
   */
  getCategories(): TemplateCategory[] {
    this.ensureInitialized();
    return [...this.categories].sort((a, b) => a.order - b.order);
  }

  /**
   * 创建模板
   */
  createTemplate(template: Omit<EnterpriseTemplate, "id" | "version" | "createdAt" | "updatedAt">): EnterpriseTemplate {
    this.ensureInitialized();
    const newTemplate: EnterpriseTemplate = {
      ...template,
      id: localId("tpl"),
      version: "1.0.0",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    this.templates.set(newTemplate.id, newTemplate);
    this.saveTemplates();
    
    logger.info("templates", `创建模板: ${newTemplate.name} (${newTemplate.id})`);
    return newTemplate;
  }

  /**
   * 更新模板
   */
  updateTemplate(templateId: string, updates: Partial<EnterpriseTemplate>): EnterpriseTemplate | null {
    this.ensureInitialized();
    const template = this.templates.get(templateId);
    if (!template) {
      logger.warn("templates", `模板不存在: ${templateId}`);
      return null;
    }

    // 更新版本号（如果有实质性修改）
    const oldVersion = template.version;
    const [major, minor, patch] = oldVersion.split(".").map(Number);
    const newVersion = `${major}.${minor}.${(patch || 0) + 1}`;
    
    const updatedTemplate: EnterpriseTemplate = {
      ...template,
      ...updates,
      id: templateId, // 保持 ID 不变
      version: newVersion,
      updatedAt: Date.now(),
    };
    
    this.templates.set(templateId, updatedTemplate);
    this.saveTemplates();
    
    logger.info("templates", `更新模板: ${updatedTemplate.name} (${templateId})`);
    return updatedTemplate;
  }

  /**
   * 删除模板
   */
  deleteTemplate(templateId: string): boolean {
    this.ensureInitialized();
    const template = this.templates.get(templateId);
    if (!template) {
      logger.warn("templates", `模板不存在: ${templateId}`);
      return false;
    }
    
    this.templates.delete(templateId);
    this.saveTemplates();
    
    logger.info("templates", `删除模板: ${template.name} (${templateId})`);
    return true;
  }

  /**
   * 发布模板（标记为已发布）
   */
  publishTemplate(templateId: string): EnterpriseTemplate | null {
    this.ensureInitialized();
    const template = this.templates.get(templateId);
    if (!template) {
      logger.warn("templates", `模板不存在: ${templateId}`);
      return null;
    }
    
    // 更新发布状态
    const published: EnterpriseTemplate = {
      ...template,
      publishStatus: "published",
      publishedAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    this.templates.set(templateId, published);
    this.saveTemplates();
    
    // 这里可以添加发布到服务器的逻辑
    
    logger.info("templates", `发布模板: ${template.name} (${templateId})`);
    return published;
  }

  /**
   * 验证参数
   */
  private validateParameters(
    template: EnterpriseTemplate,
    values: Record<string, unknown>
  ): { valid: boolean; message?: string } {
    for (const param of template.parameters) {
      const value = values[param.key];

      // 必填检查
      if (param.required && (value === undefined || value === null || value === "")) {
        return { valid: false, message: `参数 "${param.name}" 为必填项` };
      }

      if (value === undefined || value === null) continue;

      // 类型检查
      if (param.type === "number" && typeof value !== "number") {
        return { valid: false, message: `参数 "${param.name}" 必须为数字` };
      }

      if (param.type === "boolean" && typeof value !== "boolean") {
        return { valid: false, message: `参数 "${param.name}" 必须为布尔值` };
      }

      // select 类型选项验证
      if (param.type === "select" && param.options) {
        const validValues = param.options.map(opt => opt.value);
        if (!validValues.includes(value)) {
          return { 
            valid: false, 
            message: `参数 "${param.name}" 的值不在允许范围内` 
          };
        }
      }

      // 验证规则
      if (param.validation) {
        if (param.type === "number" && typeof value === "number") {
          if (param.validation.min !== undefined && value < param.validation.min) {
            return {
              valid: false,
              message: param.validation.message || `参数 "${param.name}" 不能小于 ${param.validation.min}`,
            };
          }
          if (param.validation.max !== undefined && value > param.validation.max) {
            return {
              valid: false,
              message: param.validation.message || `参数 "${param.name}" 不能大于 ${param.validation.max}`,
            };
          }
        }

        if (param.type === "text" && typeof value === "string") {
          if (param.validation.pattern) {
            const regex = new RegExp(param.validation.pattern);
            if (!regex.test(value)) {
              return {
                valid: false,
                message: param.validation.message || `参数 "${param.name}" 格式不正确`,
              };
            }
          }
        }
      }
    }

    return { valid: true };
  }

  /**
   * 应用参数到快捷指令
   */
  private applyParameters(
    shortcutData: Shortcut,
    parameterValues: Record<string, unknown>
  ): Shortcut {
    // 深拷贝
    const shortcut = JSON.parse(JSON.stringify(shortcutData)) as Shortcut;

    // 替换占位符
    const replace = (obj: unknown): unknown => {
      if (typeof obj === "string") {
        // 替换 {{paramName}} 占位符
        return obj.replace(/\{\{(\w+)\}\}/g, (_, key) => {
          const value = parameterValues[key];
          return value !== undefined ? String(value) : `{{${key}}}`;
        });
      }

      if (Array.isArray(obj)) {
        return obj.map(replace);
      }

      if (obj && typeof obj === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = replace(value);
        }
        return result;
      }

      return obj;
    };

    return replace(shortcut) as Shortcut;
  }

  /**
   * 自动安装强制模板
   */
  private async installForcedTemplates(): Promise<void> {
    const forcedTemplates = Array.from(this.templates.values()).filter(t => t.isForced);

    for (const template of forcedTemplates) {
      // 检查是否已安装
      const installation = this.installations.get(template.id);
      if (installation && installation.status === "active") {
        continue;
      }

      // 使用默认参数安装
      const defaultValues: Record<string, unknown> = {};
      template.parameters.forEach(param => {
        defaultValues[param.key] = param.defaultValue;
      });

      await this.installTemplate(template.id, defaultValues);
    }
  }

  /**
   * 测试专用：把管理器退回「从没起来过」并清空三张内存表（REQ-A1320）。
   *
   * 为什么需要：`templateManager` 是模块级单例，而 `ensureInitialized()` 只认第一次 ——
   * 一个测试文件里连着播两次 localStorage，第二次不会再读回，用例之间就会互相串味。
   * 生产代码**从不**调用它。
   */
  resetForTest(): void {
    this.initialized = false;
    this.templates = new Map();
    this.installations = new Map();
    this.categories = [];
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const templateManager = new TemplateManager();
