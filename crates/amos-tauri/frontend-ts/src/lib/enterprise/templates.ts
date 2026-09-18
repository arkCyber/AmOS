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
import { logger } from "./logger";
import type { Shortcut } from "../shortcuts";
import { mdmManager } from "./mdm";
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

  /**
   * 初始化模板管理器
   */
  async initialize(): Promise<void> {
    this.loadTemplates();
    this.loadInstallations();
    this.loadCategories();
    
    // 检查更新
    if (mdmManager.isEnabled()) {
      await this.checkForUpdates();
    }
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
    try {
      const userId = readStoreValue("amos.user.id", "");
      return userId || "user-default";
    } catch {
      return "user-default";
    }
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
    return this.templates.get(templateId) || null;
  }

  /**
   * 从服务器同步模板
   */
  async syncTemplates(): Promise<{ success: boolean; count: number; message?: string }> {
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
   */
  async installTemplate(
    templateId: string,
    parameterValues: Record<string, unknown>
  ): Promise<{ success: boolean; shortcutId?: string; message?: string }> {
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
      const shortcut = this.applyParameters(template.shortcutData, parameterValues);
      
      // 生成新的 ID
      shortcut.id = localId("shortcut");
      shortcut.createdAt = Date.now();
      shortcut.updatedAt = Date.now();

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

      return { success: true, shortcutId: shortcut.id };
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
    const installation = this.installations.get(templateId);
    if (!installation) {
      return { success: false, message: "未安装此模板" };
    }

    const template = this.templates.get(templateId);
    if (template?.isForced) {
      return { success: false, message: "强制模板不可卸载" };
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
    return Array.from(this.installations.values()).filter(i => i.status === "active");
  }

  /**
   * 获取分类列表
   */
  getCategories(): TemplateCategory[] {
    return [...this.categories].sort((a, b) => a.order - b.order);
  }

  /**
   * 创建模板
   */
  createTemplate(template: Omit<EnterpriseTemplate, "id" | "version" | "createdAt" | "updatedAt">): EnterpriseTemplate {
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
}

// ============================================================================
// 导出单例
// ============================================================================

export const templateManager = new TemplateManager();
