/**
 * __tests__/enterprise.test.ts — 企业功能测试套件
 * 
 * 测试覆盖:
 * - MDM 管理
 * - 企业模板
 * - 审计日志
 * - API 集成
 * - Webhook
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mdmManager,
  templateManager,
  auditLogger,
  apiClient,
  webhookManager,
  initializeEnterprise,
  shutdownEnterprise,
  type MDMConfig,
  type EnterpriseTemplate,
} from "../enterprise/index";

// ============================================================================
// 辅助函数
// ============================================================================

function createMockMDMConfig(): Partial<MDMConfig> {
  return {
    enabled: true,
    serverUrl: "https://mdm.example.com",
    deviceId: "test-device-001",
    organizationId: "org-test-001",
    organizationName: "Test Organization",
    deviceName: "Test Device",
    apiKey: "test-api-key",
    policies: [],
    restrictions: {
      disabledCategories: [],
      disabledActions: [],
      maxExecutionTime: 300,
      maxExecutionsPerDay: 1000,
      maxActionsPerShortcut: 50,
      maxShortcutsPerUser: 100,
      allowUserCreate: true,
      allowUserModify: true,
      allowUserDelete: true,
      allowSharing: true,
      allowExport: true,
      allowImport: true,
      requireApprovalForCreate: false,
      requireApprovalForModify: false,
      requireApprovalForSharing: false,
    },
    enforcedShortcuts: [],
    enforcedTemplates: [],
    lastSyncAt: 0,
    syncInterval: 3600,
    lastSyncStatus: "pending",
    deviceStatus: "active",
    enrolledAt: Date.now(),
    enrolledBy: "test-admin",
    version: "1.0.0",
  };
}

function createMockTemplate(): Omit<EnterpriseTemplate, "id" | "version" | "createdAt" | "updatedAt"> {
  return {
    name: "测试模板",
    description: "用于测试的企业模板",
    category: "productivity",
    department: "IT",
    icon: "briefcase",
    color: "#3B82F6",
    shortcutData: {
      id: "shortcut-template",
      name: "模板快捷指令",
      description: "从模板创建",
      icon: "briefcase",
      color: "#3B82F6",
      actions: [
        {
          id: "action1",
          actionTypeId: "text",
          parameters: { text: "{{param1}}" },
          position: 0,
        },
      ],
      quickActions: [],
      triggers: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runCount: 0,
      runOnLockScreen: false,
      requiresConfirmation: false,
      tags: [],
    },
    parameters: [
      {
        key: "param1",
        name: "参数1",
        description: "第一个参数",
        type: "text",
        required: true,
        defaultValue: "默认值",
      },
    ],
    targetRoles: [],
    targetDepartments: [],
    isForced: false,
    allowCustomization: true,
    autoUpdate: false,
    publishStatus: "published",
    installedCount: 0,
    successCount: 0,
    failureCount: 0,
    organizationId: "org-test-001",
    createdBy: "test-user",
  };
}

// ============================================================================
// MDM 测试
// ============================================================================

describe("MDM 管理", () => {
  beforeEach(async () => {
    await mdmManager.initialize();
  });

  test("应该能够配置 MDM", () => {
    const config = createMockMDMConfig();
    mdmManager.configure(config);
    
    const retrieved = mdmManager.getConfig();
    expect(retrieved).toBeDefined();
    expect(retrieved?.deviceId).toBe("test-device-001");
    expect(retrieved?.organizationId).toBe("org-test-001");
  });

  test("应该能够启用/禁用 MDM", () => {
    const config = createMockMDMConfig();
    mdmManager.configure(config);
    
    expect(mdmManager.isEnabled()).toBe(true);
    
    mdmManager.configure({ ...config, enabled: false });
    expect(mdmManager.isEnabled()).toBe(false);
  });

  test("应该能够添加和获取策略", () => {
    // 先配置 MDM
    mdmManager.configure({
      enabled: true,
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
    });

    // 设置策略值
    mdmManager.addPolicy("allowUserCreate", false);
    mdmManager.addPolicy("maxShortcutsPerUser", 50);

    const policies = mdmManager.getRestrictionPolicies();
    expect(policies).toBeTruthy();
    expect(policies?.allowUserCreate).toBe(false);
    expect(policies?.maxShortcutsPerUser).toBe(50);
    
    const allowCreate = mdmManager.getPolicy("allowUserCreate");
    expect(allowCreate).toBe(false);
  });

  test("应该根据策略检查权限", () => {
    // 启用 MDM 并设置策略
    mdmManager.configure({ enabled: true });
    mdmManager.addPolicy("allowUserCreate", false);

    const check = mdmManager.checkCanCreate();
    expect(check.allowed).toBe(false);
    expect(check.reason).toBeTruthy();
  });

  test("应该能够删除策略", () => {
    // 设置策略
    mdmManager.addPolicy("maxShortcutsPerUser", 50);
    expect(mdmManager.getPolicy("maxShortcutsPerUser")).toBe(50);

    // 删除策略（恢复默认值）
    mdmManager.deletePolicy("maxShortcutsPerUser");
    
    // 应该恢复为默认值
    const policy = mdmManager.getPolicy("maxShortcutsPerUser");
    expect(policy).toBe(100); // DEFAULT_RESTRICTIONS.maxShortcutsPerUser
  });
});

// ============================================================================
// 企业模板测试
// ============================================================================

describe("企业模板", () => {
  beforeEach(async () => {
    await templateManager.initialize();
  });

  test("应该能够创建模板", () => {
    const template = createMockTemplate();
    const created = templateManager.createTemplate(template);
    
    expect(created).toBeTruthy();
    expect(created.id).toBeTruthy();
    expect(created.id.startsWith("tpl-")).toBe(true);
    expect(created.name).toBe(template.name);
  });

  test("应该能够获取所有模板", () => {
    const template1 = createMockTemplate();
    const template2 = { ...createMockTemplate(), name: "模板2" };
    
    templateManager.createTemplate(template1);
    templateManager.createTemplate(template2);
    
    const templates = templateManager.getTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(2);
  });

  test("应该能够按类别过滤模板", () => {
    const template = createMockTemplate();
    templateManager.createTemplate(template);
    
    const filtered = templateManager.getTemplates({ category: "productivity" });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every(t => t.category === "productivity")).toBe(true);
  });

  test("应该能够搜索模板", () => {
    const template = createMockTemplate();
    templateManager.createTemplate(template);
    
    const results = templateManager.getTemplates({ search: "测试" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(t => t.name.includes("测试"))).toBe(true);
  });

  test("应该能够安装模板", async () => {
    const template = createMockTemplate();
    const created = templateManager.createTemplate(template);
    
    const result = await templateManager.installTemplate(created.id, {
      param1: "自定义值",
    });
    
    expect(result.success).toBe(true);
    expect(result.shortcutId).toBeTruthy();
  });

  test("应该能够更新模板", () => {
    const template = createMockTemplate();
    const created = templateManager.createTemplate(template);
    
    const updated = templateManager.updateTemplate(created.id, {
      name: "更新后的模板",
      version: "1.0.1",
    });
    
    expect(updated).toBeTruthy();
    expect(updated?.name).toBe("更新后的模板");
    expect(updated?.version).toBe("1.0.1");
  });

  test("应该能够删除模板", () => {
    const template = createMockTemplate();
    const created = templateManager.createTemplate(template);
    
    const deleted = templateManager.deleteTemplate(created.id);
    expect(deleted).toBe(true);
    
    const retrieved = templateManager.getTemplate(created.id);
    expect(retrieved).toBeNull();
  });
});

// ============================================================================
// 审计日志测试
// ============================================================================

describe("审计日志", () => {
  beforeEach(async () => {
    await auditLogger.initialize();
  });

  afterEach(async () => {
    await auditLogger.shutdown();
  });

  test("应该能够记录审计日志", async () => {
    const logId = await auditLogger.log({
      eventType: "shortcut_create",
      eventCategory: "management",
      eventDescription: "创建快捷指令",
      result: "success",
      resourceType: "shortcut",
      resourceId: "test-shortcut-001",
      resourceName: "测试快捷指令",
    });
    
    expect(logId).toBeTruthy();
    expect(logId.startsWith("audit-")).toBe(true);
  });

  test("应该能够查询审计日志", async () => {
    await auditLogger.log({
      eventType: "shortcut_create",
      eventCategory: "management",
      eventDescription: "创建快捷指令",
      result: "success",
    });

    // 刷新缓冲区
    await auditLogger.flushBuffer();

    const logs = auditLogger.query({
      eventTypes: ["shortcut_create"],
    });
    
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.eventType).toBe("shortcut_create");
  });

  test("应该能够按时间范围查询", async () => {
    const startTime = Date.now();
    
    await auditLogger.log({
      eventType: "shortcut_execute",
      eventCategory: "execution",
      eventDescription: "执行快捷指令",
      result: "success",
    });
    
    const endTime = Date.now();

    // 刷新缓冲区
    await auditLogger.flushBuffer();

    const logs = auditLogger.query({
      startTime: startTime - 1000,
      endTime: endTime + 1000,
    });
    
    expect(logs.length).toBeGreaterThan(0);
  });

  test("应该能够获取统计信息", async () => {
    await auditLogger.log({
      eventType: "shortcut_execute_success",
      eventCategory: "execution",
      eventDescription: "执行成功",
      result: "success",
      duration: 100,
    });

    await auditLogger.log({
      eventType: "shortcut_execute_failure",
      eventCategory: "execution",
      eventDescription: "执行失败",
      result: "failure",
      duration: 50,
    });

    // 刷新缓冲区
    await auditLogger.flushBuffer();

    const stats = auditLogger.getStatistics();
    
    expect(stats.totalLogs).toBeGreaterThan(0);
    expect(stats.successCount).toBeGreaterThan(0);
    expect(stats.failureCount).toBeGreaterThan(0);
  });

  test("应该能够导出日志为 JSON", async () => {
    await auditLogger.log({
      eventType: "shortcut_create",
      eventCategory: "management",
      eventDescription: "创建快捷指令",
      result: "success",
    });

    // 刷新缓冲区
    await auditLogger.flushBuffer();

    const exported = await auditLogger.exportLogs({}, "json");
    
    expect(exported).toBeTruthy();
    expect(() => JSON.parse(exported)).not.toThrow();
  });

  test("应该能够记录快捷指令执行", async () => {
    await auditLogger.logExecution({
      shortcutId: "test-shortcut",
      shortcutName: "测试快捷指令",
      success: true,
      duration: 150,
      actionCount: 5,
    });

    // 刷新缓冲区
    await auditLogger.flushBuffer();

    const logs = auditLogger.query({
      eventTypes: ["shortcut_execute_success"],
    });
    
    expect(logs.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// API 集成测试
// ============================================================================

describe("API 客户端", () => {
  beforeEach(async () => {
    await apiClient.initialize();
  });

  test("应该能够配置 API", () => {
    apiClient.saveConfig({
      enabled: true,
      baseUrl: "https://api.example.com",
      authType: "api_key",
      apiKey: "test-key",
    });

    const config = apiClient.getConfig();
    expect(config.enabled).toBe(true);
    expect(config.baseUrl).toBe("https://api.example.com");
  });

  test("API 未启用时应该返回错误", async () => {
    apiClient.saveConfig({ enabled: false });
    
    const response = await apiClient.get("/test");
    
    expect(response.success).toBe(false);
    expect(response.error).toContain("未启用");
  });
});

// ============================================================================
// Webhook 测试
// ============================================================================

describe("Webhook 管理", () => {
  beforeEach(async () => {
    await webhookManager.initialize();
  });

  afterEach(() => {
    webhookManager.shutdown();
  });

  test("应该能够添加 Webhook", () => {
    const id = webhookManager.addWebhook({
      name: "测试 Webhook",
      description: "用于测试",
      url: "https://webhook.example.com",
      events: ["shortcut_create", "shortcut_execute"],
      secret: "test-secret",
      headers: {},
      enabled: true,
      method: "POST",
      timeout: 5000,
      retryCount: 3,
    });
    
    expect(id).toBeTruthy();
    expect(id.startsWith("webhook-")).toBe(true);
  });

  test("应该能够获取所有 Webhook", () => {
    webhookManager.addWebhook({
      name: "Webhook 1",
      description: "第一个",
      url: "https://webhook1.example.com",
      events: ["shortcut_create"],
      secret: "secret1",
      headers: {},
      enabled: true,
      method: "POST",
      timeout: 5000,
      retryCount: 3,
    });

    webhookManager.addWebhook({
      name: "Webhook 2",
      description: "第二个",
      url: "https://webhook2.example.com",
      events: ["shortcut_execute"],
      secret: "secret2",
      headers: {},
      enabled: true,
      method: "POST",
      timeout: 5000,
      retryCount: 3,
    });

    const webhooks = webhookManager.getWebhooks();
    expect(webhooks.length).toBeGreaterThanOrEqual(2);
  });

  test("应该能够更新 Webhook", () => {
    const id = webhookManager.addWebhook({
      name: "测试 Webhook",
      description: "原始描述",
      url: "https://webhook.example.com",
      events: ["shortcut_create"],
      secret: "secret",
      headers: {},
      enabled: true,
      method: "POST",
      timeout: 5000,
      retryCount: 3,
    });

    const updated = webhookManager.updateWebhook(id, {
      description: "更新后的描述",
      enabled: false,
    });

    expect(updated).toBe(true);

    const webhook = webhookManager.getWebhook(id);
    expect(webhook?.description).toBe("更新后的描述");
    expect(webhook?.enabled).toBe(false);
  });

  test("应该能够删除 Webhook", () => {
    const id = webhookManager.addWebhook({
      name: "待删除 Webhook",
      description: "将被删除",
      url: "https://webhook.example.com",
      events: ["shortcut_create"],
      secret: "secret",
      headers: {},
      enabled: true,
      method: "POST",
      timeout: 5000,
      retryCount: 3,
    });

    const deleted = webhookManager.deleteWebhook(id);
    expect(deleted).toBe(true);

    const webhook = webhookManager.getWebhook(id);
    expect(webhook).toBeNull();
  });

  test("应该能够触发 Webhook", async () => {
    const id = webhookManager.addWebhook({
      name: "测试 Webhook",
      description: "用于测试触发",
      url: "https://webhook.example.com/test",
      events: ["shortcut_create"],
      secret: "test-secret",
      headers: {},
      enabled: true,
      method: "POST",
      timeout: 100, // 使用很短的超时以加快测试
      retryCount: 1, // 只重试一次
    });

    // 触发（实际不会发送，因为 URL 不存在）
    await webhookManager.trigger("shortcut_create", {
      shortcutId: "test-001",
      shortcutName: "测试快捷指令",
    });

    // 等待处理（100ms timeout + 2000ms retry delay + 100ms timeout = ~2300ms）
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 验证 webhook 被触发（会失败，但会更新统计）
    const webhook = webhookManager.getWebhook(id);
    expect(webhook).toBeTruthy();
    expect(webhook?.lastTriggeredAt).toBeGreaterThan(0);
    expect(webhook?.triggerCount).toBeGreaterThan(0);
    expect(webhook?.failureCount).toBeGreaterThan(0);
  });
});

// ============================================================================
// 集成测试
// ============================================================================

describe("企业功能集成", () => {
  test("应该能够初始化所有企业功能", async () => {
    // 直接调用，如果抛出异常测试会失败
    await initializeEnterprise();
    // 验证各个管理器已初始化
    expect(mdmManager).toBeTruthy();
    expect(templateManager).toBeTruthy();
    expect(auditLogger).toBeTruthy();
    expect(apiClient).toBeTruthy();
    expect(webhookManager).toBeTruthy();
  });

  test("应该能够关闭所有企业功能", async () => {
    await initializeEnterprise();
    // 直接调用，如果抛出异常测试会失败
    await shutdownEnterprise();
    // 验证关闭成功（没有抛出异常）
    expect(true).toBe(true);
  });
});
