/**
 * APISettings.test.ts - API 和 Webhook 配置组件单元测试
 * 
 * 测试覆盖:
 * - API 配置渲染和交互
 * - API 连接测试
 * - 配置保存
 * - Webhook 列表显示
 * - Webhook 创建/编辑/删除
 * - Webhook 测试
 * - 表单验证
 * - 错误处理
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import APISettings from "../APISettings.svelte";
import { apiClient, webhookManager } from "../../../lib/enterprise";
import type { APIConfig } from "../../../lib/enterprise/api";
import type { WebhookConfig } from "../../../lib/enterprise/webhooks";

// Mock 企业模块
vi.mock("../../../lib/enterprise", () => ({
  apiClient: {
    getConfig: vi.fn(),
    configure: vi.fn(),
    request: vi.fn(),
  },
  webhookManager: {
    getWebhooks: vi.fn(),
    addWebhook: vi.fn(),
    updateWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    testWebhook: vi.fn(),
  },
}));

// Mock 国际化
vi.mock("../../locale.svelte", () => ({
  t: vi.fn((key: string, params?: Record<string, any>) => {
    const translations: Record<string, string> = {
      "api.title": "API 集成",
      "api.subtitle": "配置企业 API 和 Webhook 集成",
      "api.configSection": "API 配置",
      "api.enable": "启用 API",
      "api.baseUrl": "基础 URL",
      "api.authMethod": "认证方式",
      "api.authHint": "当前仅支持 Bearer Token 认证",
      "api.apiKeyPlaceholder": "输入 API Key",
      "api.hideToken": "隐藏 Token",
      "api.showToken": "显示 Token",
      "api.timeoutMs": "超时时间 (ms)",
      "api.retryCount": "重试次数",
      "api.retryDelayMs": "重试延迟 (ms)",
      "api.testing": "测试中...",
      "api.testConnection": "测试连接",
      "api.saving": "保存中...",
      "api.saveConfig": "保存配置",
      "api.connectOk": "连接成功",
      "api.connectFailed": "连接失败",
      "api.configSaved": "配置已保存",
      "api.saveFailed": "保存失败",
      "api.webhooksSection": "Webhook 管理",
      "api.addWebhook": "添加 Webhook",
      "api.noWebhooks": "暂无 Webhook",
      "api.noWebhooksHint": "点击右上角添加按钮创建第一个 Webhook",
      "api.enabled": "已启用",
      "api.disabled": "已禁用",
      "api.eventLabel": "监听事件",
      "api.triggerLabel": "触发次数",
      "api.timesCount": `${params?.count || 0} 次`,
      "api.successLabel": "成功",
      "api.edit": "编辑",
      "api.test": "测试",
      "api.delete": "删除",
      "api.close": "关闭",
      "api.editWebhookTitle": "编辑 Webhook",
      "api.addWebhookTitle": "添加 Webhook",
      "api.nameLabel": "名称",
      "api.namePlaceholder": "例如：Slack 通知",
      "api.methodLabel": "HTTP 方法",
      "api.eventsLabel": "订阅事件",
      "api.secretLabel": "签名密钥",
      "api.secretPlaceholder": "可选的 HMAC 签名密钥",
      "api.secretHint": "用于验证请求来源",
      "api.webhookTimeoutMs": "超时 (ms)",
      "api.cancel": "取消",
      "api.update": "更新",
      "api.add": "添加",
      "api.needNameAndUrl": "请填写名称和 URL",
      "api.needOneEvent": "请至少选择一个事件",
      "api.saveFailedReason": `保存失败: ${params?.reason}`,
      "api.unknownError": "未知错误",
      "api.confirmDeleteWebhook": "确定要删除此 Webhook？",
      "api.testOk": `测试成功 (${params?.ms}ms)`,
      "api.testFailed": `测试失败: ${params?.reason}`,
      "api.event.shortcut_create": "快捷指令创建",
      "api.event.shortcut_run": "快捷指令运行",
      "api.event.shortcut_update": "快捷指令更新",
      "api.event.shortcut_delete": "快捷指令删除",
      "api.event.shortcut_share": "快捷指令分享",
      "api.event.template_install": "模板安装",
      "api.event.mdm_policy_change": "MDM 策略变更",
    };
    return translations[key] || key;
  }),
}));

// Mock 焦点陷阱
vi.mock("../../../lib/focusTrap", () => ({
  attachFocusTrap: vi.fn(() => () => {}),
}));

describe("APISettings", () => {
  // 测试数据
  const mockAPIConfig: APIConfig = {
    enabled: true,
    baseUrl: "https://api.example.com",
    apiKey: "test-api-key-123",
    timeout: 30000,
    retryCount: 3,
    retryDelay: 2000,
  };

  const mockWebhooks: WebhookConfig[] = [
    {
      id: "webhook-1",
      name: "Slack 通知",
      description: "发送到 Slack 频道",
      url: "https://hooks.slack.com/services/xxx",
      method: "POST",
      events: ["shortcut_run", "shortcut_create"],
      secret: "secret-key",
      headers: {},
      timeout: 5000,
      retryCount: 3,
      enabled: true,
      triggerCount: 100,
      successCount: 95,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "webhook-2",
      name: "钉钉机器人",
      description: "企业钉钉通知",
      url: "https://oapi.dingtalk.com/robot/send",
      method: "POST",
      events: ["template_install"],
      secret: "",
      headers: {},
      timeout: 5000,
      retryCount: 3,
      enabled: false,
      triggerCount: 50,
      successCount: 48,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (apiClient.getConfig as any).mockReturnValue(mockAPIConfig);
    (webhookManager.getWebhooks as any).mockReturnValue(mockWebhooks);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("基础渲染", () => {
    it("应该渲染标题和副标题", () => {
      render(APISettings);
      
      expect(screen.getByText("API 集成")).toBeInTheDocument();
      expect(screen.getByText("配置企业 API 和 Webhook 集成")).toBeInTheDocument();
    });

    it("应该渲染 API 配置区域", () => {
      render(APISettings);
      
      expect(screen.getByText("API 配置")).toBeInTheDocument();
    });

    it("应该渲染 Webhook 管理区域", () => {
      render(APISettings);
      
      expect(screen.getByText("Webhook 管理")).toBeInTheDocument();
    });
  });

  describe("API 配置", () => {
    it("应该显示当前 API 配置", () => {
      render(APISettings);
      
      const baseUrlInput = screen.getByLabelText("基础 URL") as HTMLInputElement;
      expect(baseUrlInput.value).toBe("https://api.example.com");
      
      const timeoutInput = screen.getByLabelText("超时时间 (ms)") as HTMLInputElement;
      expect(timeoutInput.value).toBe("30000");
    });

    it("应该显示启用开关", () => {
      render(APISettings);
      
      const toggle = screen.getByRole("switch") as HTMLInputElement;
      expect(toggle.checked).toBe(true);
    });

    it("点击开关应该切换启用状态", async () => {
      render(APISettings);
      
      const toggle = screen.getByRole("switch") as HTMLInputElement;
      await fireEvent.change(toggle, { target: { checked: false } });
      
      expect(toggle.checked).toBe(false);
    });

    it("禁用 API 时应该禁用所有输入", async () => {
      (apiClient.getConfig as any).mockReturnValue({ ...mockAPIConfig, enabled: false });
      
      render(APISettings);
      
      const baseUrlInput = screen.getByLabelText("基础 URL") as HTMLInputElement;
      expect(baseUrlInput.disabled).toBe(true);
    });

    it("应该支持修改基础 URL", async () => {
      render(APISettings);
      
      const input = screen.getByLabelText("基础 URL") as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "https://new.api.com" } });
      
      expect(input.value).toBe("https://new.api.com");
    });

    it("应该支持修改 API Key", async () => {
      render(APISettings);
      
      const input = screen.getByLabelText("API Key") as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "new-key" } });
      
      expect(input.value).toBe("new-key");
    });

    it("API Key 默认应该隐藏", () => {
      render(APISettings);
      
      const input = screen.getByLabelText("API Key") as HTMLInputElement;
      expect(input.type).toBe("password");
    });

    it("点击眼睛图标应该显示/隐藏 API Key", async () => {
      render(APISettings);
      
      const toggleBtn = screen.getByLabelText("显示 Token");
      const input = screen.getByLabelText("API Key") as HTMLInputElement;
      
      await fireEvent.click(toggleBtn);
      expect(input.type).toBe("text");
      
      await fireEvent.click(screen.getByLabelText("隐藏 Token"));
      expect(input.type).toBe("password");
    });

    it("应该支持修改超时时间", async () => {
      render(APISettings);
      
      const input = screen.getByLabelText("超时时间 (ms)") as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "60000" } });
      
      expect(input.value).toBe("60000");
    });

    it("应该支持修改重试次数", async () => {
      render(APISettings);
      
      const input = screen.getByLabelText("重试次数") as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "5" } });
      
      expect(input.value).toBe("5");
    });

    it("应该支持修改重试延迟", async () => {
      render(APISettings);
      
      const input = screen.getByLabelText("重试延迟 (ms)") as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "3000" } });
      
      expect(input.value).toBe("3000");
    });
  });

  describe("API 连接测试", () => {
    it("应该显示测试连接按钮", () => {
      render(APISettings);
      
      expect(screen.getByText("测试连接")).toBeInTheDocument();
    });

    it("成功测试连接应该显示成功消息", async () => {
      (apiClient.request as any).mockResolvedValue({ status: "ok" });
      
      render(APISettings);
      
      const testBtn = screen.getByText("测试连接");
      await fireEvent.click(testBtn);
      
      await waitFor(() => {
        expect(screen.getByText(/连接成功/)).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveClass("success");
      });
    });

    it("失败测试连接应该显示错误消息", async () => {
      (apiClient.request as any).mockRejectedValue(new Error("网络错误"));
      
      render(APISettings);
      
      const testBtn = screen.getByText("测试连接");
      await fireEvent.click(testBtn);
      
      await waitFor(() => {
        expect(screen.getByText(/网络错误/)).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveClass("error");
      });
    });

    it("测试过程中应该禁用按钮并显示加载状态", async () => {
      (apiClient.request as any).mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 100))
      );
      
      render(APISettings);
      
      const testBtn = screen.getByText("测试连接") as HTMLButtonElement;
      await fireEvent.click(testBtn);
      
      await waitFor(() => {
        const loadingBtn = screen.getByText("测试中...") as HTMLButtonElement;
        expect(loadingBtn.disabled).toBe(true);
      });
    });

    it("API 禁用时应该禁用测试按钮", () => {
      (apiClient.getConfig as any).mockReturnValue({ ...mockAPIConfig, enabled: false });
      
      render(APISettings);
      
      const testBtn = screen.getByText("测试连接") as HTMLButtonElement;
      expect(testBtn.disabled).toBe(true);
    });
  });

  describe("配置保存", () => {
    it("应该显示保存按钮", () => {
      render(APISettings);
      
      expect(screen.getByText("保存配置")).toBeInTheDocument();
    });

    it("成功保存应该显示成功消息", async () => {
      render(APISettings);
      
      const saveBtn = screen.getByText("保存配置");
      await fireEvent.click(saveBtn);
      
      await waitFor(() => {
        expect(screen.getByText(/配置已保存/)).toBeInTheDocument();
      });
      
      expect(apiClient.configure).toHaveBeenCalled();
    });

    it("保存失败应该显示错误消息", async () => {
      (apiClient.configure as any).mockImplementation(() => {
        throw new Error("保存失败");
      });
      
      render(APISettings);
      
      const saveBtn = screen.getByText("保存配置");
      await fireEvent.click(saveBtn);
      
      await waitFor(() => {
        expect(screen.getByText(/保存失败/)).toBeInTheDocument();
      });
    });

    it("保存过程中应该禁用按钮", async () => {
      render(APISettings);
      
      const saveBtn = screen.getByText("保存配置") as HTMLButtonElement;
      await fireEvent.click(saveBtn);
      
      await waitFor(() => {
        const savingBtn = screen.getByText("保存中...") as HTMLButtonElement;
        expect(savingBtn.disabled).toBe(true);
      });
    });
  });

  describe("Webhook 列表", () => {
    it("应该显示所有 Webhook", () => {
      render(APISettings);
      
      expect(screen.getByText("Slack 通知")).toBeInTheDocument();
      expect(screen.getByText("钉钉机器人")).toBeInTheDocument();
    });

    it("应该显示 Webhook URL", () => {
      render(APISettings);
      
      expect(screen.getByText("https://hooks.slack.com/services/xxx")).toBeInTheDocument();
      expect(screen.getByText("https://oapi.dingtalk.com/robot/send")).toBeInTheDocument();
    });

    it("应该显示订阅的事件", () => {
      render(APISettings);
      
      expect(screen.getByText(/shortcut_run, shortcut_create/)).toBeInTheDocument();
    });

    it("应该显示触发统计", () => {
      render(APISettings);
      
      expect(screen.getByText("100 次")).toBeInTheDocument();
      expect(screen.getByText(/95 \(95%\)/)).toBeInTheDocument();
    });

    it("应该显示启用状态", () => {
      render(APISettings);
      
      expect(screen.getByText("已启用")).toBeInTheDocument();
      expect(screen.getByText("已禁用")).toBeInTheDocument();
    });

    it("禁用的 Webhook 应该有视觉标记", () => {
      const { container } = render(APISettings);
      
      const webhookItems = container.querySelectorAll(".webhook-item");
      expect(webhookItems[1]).toHaveClass("disabled");
    });

    it("空列表时应该显示空状态", () => {
      (webhookManager.getWebhooks as any).mockReturnValue([]);
      
      render(APISettings);
      
      expect(screen.getByText("暂无 Webhook")).toBeInTheDocument();
      expect(screen.getByText("点击右上角添加按钮创建第一个 Webhook")).toBeInTheDocument();
    });
  });

  describe("Webhook 操作", () => {
    it("应该支持切换 Webhook 启用状态", async () => {
      render(APISettings);
      
      const checkbox = screen.getAllByRole("checkbox")[1] as HTMLInputElement; // 第一个是 API toggle
      await fireEvent.change(checkbox);
      
      expect(webhookManager.updateWebhook).toHaveBeenCalled();
    });

    it("点击编辑应该打开编辑模态框", async () => {
      render(APISettings);
      
      const editBtns = screen.getAllByText("编辑");
      await fireEvent.click(editBtns[0]);
      
      await waitFor(() => {
        expect(screen.getByText("编辑 Webhook")).toBeInTheDocument();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });
    });

    it("点击删除应该确认并删除", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      
      render(APISettings);
      
      const deleteBtns = screen.getAllByText("删除");
      await fireEvent.click(deleteBtns[0]);
      
      expect(confirmSpy).toHaveBeenCalledWith("确定要删除此 Webhook？");
      expect(webhookManager.deleteWebhook).toHaveBeenCalledWith("webhook-1");
      
      confirmSpy.mockRestore();
    });

    it("取消删除不应该执行删除", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      
      render(APISettings);
      
      const deleteBtns = screen.getAllByText("删除");
      await fireEvent.click(deleteBtns[0]);
      
      expect(webhookManager.deleteWebhook).not.toHaveBeenCalled();
      
      confirmSpy.mockRestore();
    });

    it("点击测试应该测试 Webhook", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      (webhookManager.testWebhook as any).mockResolvedValue({
        success: true,
        duration: 150,
      });
      
      render(APISettings);
      
      const testBtns = screen.getAllByText("测试");
      await fireEvent.click(testBtns[0]);
      
      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("测试成功"));
      });
      
      alertSpy.mockRestore();
    });

    it("测试失败应该显示错误", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      (webhookManager.testWebhook as any).mockResolvedValue({
        success: false,
        error: "连接超时",
      });
      
      render(APISettings);
      
      const testBtns = screen.getAllByText("测试");
      await fireEvent.click(testBtns[0]);
      
      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("连接超时"));
      });
      
      alertSpy.mockRestore();
    });
  });

  describe("Webhook 创建/编辑", () => {
    it("点击添加按钮应该打开创建模态框", async () => {
      render(APISettings);
      
      const addBtn = screen.getByText("添加 Webhook");
      await fireEvent.click(addBtn);
      
      await waitFor(() => {
        expect(screen.getByText("添加 Webhook")).toBeInTheDocument();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });
    });

    it("创建模态框应该显示空表单", async () => {
      render(APISettings);
      
      await fireEvent.click(screen.getByText("添加 Webhook"));
      
      await waitFor(() => {
        const nameInput = screen.getByLabelText("名称") as HTMLInputElement;
        const urlInput = screen.getByLabelText(/URL/) as HTMLInputElement;
        
        expect(nameInput.value).toBe("");
        expect(urlInput.value).toBe("");
      });
    });

    it("编辑模态框应该预填充数据", async () => {
      render(APISettings);
      
      const editBtns = screen.getAllByText("编辑");
      await fireEvent.click(editBtns[0]);
      
      await waitFor(() => {
        const nameInput = screen.getByLabelText("名称") as HTMLInputElement;
        const urlInput = screen.getByLabelText(/URL/) as HTMLInputElement;
        
        expect(nameInput.value).toBe("Slack 通知");
        expect(urlInput.value).toBe("https://hooks.slack.com/services/xxx");
      });
    });

    it("应该显示所有可用事件", async () => {
      render(APISettings);
      
      await fireEvent.click(screen.getByText("添加 Webhook"));
      
      await waitFor(() => {
        expect(screen.getByText("快捷指令创建")).toBeInTheDocument();
        expect(screen.getByText("快捷指令运行")).toBeInTheDocument();
        expect(screen.getByText("模板安装")).toBeInTheDocument();
      });
    });

    it("应该支持选择事件", async () => {
      render(APISettings);
      
      await fireEvent.click(screen.getByText("添加 Webhook"));
      
      await waitFor(async () => {
        const checkbox = screen.getByText("快捷指令创建").previousElementSibling as HTMLInputElement;
        await fireEvent.change(checkbox);
        
        expect(checkbox.checked).toBe(true);
      });
    });

    it("缺少名称和 URL 应该提示错误", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      
      render(APISettings);
      
      await fireEvent.click(screen.getByText("添加 Webhook"));
      
      await waitFor(async () => {
        const saveBtn = screen.getByText("添加");
        await fireEvent.click(saveBtn);
      });
      
      expect(alertSpy).toHaveBeenCalledWith("请填写名称和 URL");
      
      alertSpy.mockRestore();
    });

    it("未选择事件应该提示错误", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      
      render(APISettings);
      
      await fireEvent.click(screen.getByText("添加 Webhook"));
      
      await waitFor(async () => {
        const nameInput = screen.getByLabelText("名称") as HTMLInputElement;
        await fireEvent.input(nameInput, { target: { value: "测试" } });
        
        const urlInput = screen.getByLabelText(/URL/) as HTMLInputElement;
        await fireEvent.input(urlInput, { target: { value: "https://test.com" } });
        
        const saveBtn = screen.getByText("添加");
        await fireEvent.click(saveBtn);
      });
      
      expect(alertSpy).toHaveBeenCalledWith("请至少选择一个事件");
      
      alertSpy.mockRestore();
    });

    it("成功创建应该关闭模态框", async () => {
      render(APISettings);
      
      await fireEvent.click(screen.getByText("添加 Webhook"));
      
      await waitFor(async () => {
        const nameInput = screen.getByLabelText("名称") as HTMLInputElement;
        await fireEvent.input(nameInput, { target: { value: "新 Webhook" } });
        
        const urlInput = screen.getByLabelText(/URL/) as HTMLInputElement;
        await fireEvent.input(urlInput, { target: { value: "https://test.com" } });
        
        const checkbox = screen.getByText("快捷指令创建").previousElementSibling as HTMLInputElement;
        await fireEvent.change(checkbox);
        
        const saveBtn = screen.getByText("添加");
        await fireEvent.click(saveBtn);
      });
      
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      
      expect(webhookManager.addWebhook).toHaveBeenCalled();
    });

    it("点击取消应该关闭模态框", async () => {
      render(APISettings);
      
      await fireEvent.click(screen.getByText("添加 Webhook"));
      
      await waitFor(async () => {
        const cancelBtn = screen.getByText("取消");
        await fireEvent.click(cancelBtn);
      });
      
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("点击关闭按钮应该关闭模态框", async () => {
      render(APISettings);
      
      await fireEvent.click(screen.getByText("添加 Webhook"));
      
      await waitFor(async () => {
        const closeBtn = screen.getByLabelText("关闭");
        await fireEvent.click(closeBtn);
      });
      
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });
  });

  describe("边界情况", () => {
    it("应该处理无效的超时值", async () => {
      render(APISettings);
      
      const input = screen.getByLabelText("超时时间 (ms)") as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "" } });
      
      // 应该回退到默认值
      expect(input.value).toBe("30000");
    });

    it("应该处理无效的重试次数", async () => {
      render(APISettings);
      
      const input = screen.getByLabelText("重试次数") as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "abc" } });
      
      // 应该回退到默认值
      expect(input.value).toBe("3");
    });

    it("应该正确计算成功率", () => {
      render(APISettings);
      
      // Webhook 1: 95/100 = 95%
      expect(screen.getByText(/95 \(95%\)/)).toBeInTheDocument();
      
      // Webhook 2: 48/50 = 96%
      expect(screen.getByText(/48 \(96%\)/)).toBeInTheDocument();
    });

    it("触发次数为 0 时成功率应该是 0%", () => {
      const zeroWebhook: WebhookConfig = {
        ...mockWebhooks[0],
        triggerCount: 0,
        successCount: 0,
      };
      (webhookManager.getWebhooks as any).mockReturnValue([zeroWebhook]);
      
      render(APISettings);
      
      expect(screen.getByText(/0 \(0%\)/)).toBeInTheDocument();
    });

    it("保存 Webhook 失败应该显示错误", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      (webhookManager.addWebhook as any).mockImplementation(() => {
        throw new Error("网络错误");
      });
      
      render(APISettings);
      
      await fireEvent.click(screen.getByText("添加 Webhook"));
      
      await waitFor(async () => {
        const nameInput = screen.getByLabelText("名称") as HTMLInputElement;
        await fireEvent.input(nameInput, { target: { value: "测试" } });
        
        const urlInput = screen.getByLabelText(/URL/) as HTMLInputElement;
        await fireEvent.input(urlInput, { target: { value: "https://test.com" } });
        
        const checkbox = screen.getByText("快捷指令创建").previousElementSibling as HTMLInputElement;
        await fireEvent.change(checkbox);
        
        const saveBtn = screen.getByText("添加");
        await fireEvent.click(saveBtn);
      });
      
      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("网络错误"));
      
      alertSpy.mockRestore();
    });
  });

  describe("辅助函数", () => {
    it("getSuccessRate 应该正确计算成功率", () => {
      render(APISettings);
      
      // 通过渲染的统计信息验证计算正确
      expect(screen.getByText(/95 \(95%\)/)).toBeInTheDocument();
      expect(screen.getByText(/48 \(96%\)/)).toBeInTheDocument();
    });
  });
});
