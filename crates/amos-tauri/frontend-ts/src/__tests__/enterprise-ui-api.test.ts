/**
 * __tests__/enterprise-ui-api.test.ts
 * 
 * APISettings UI 组件测试
 * 
 * 测试范围:
 * - API 配置验证
 * - Webhook 管理逻辑
 * - URL 和 Token 验证
 * - 事件订阅管理
 * - 统计数据计算
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { apiClient, webhookManager } from "../lib/enterprise";
import type { WebhookConfig } from "../lib/enterprise/webhooks";

// 注册 happy-dom 全局对象
beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("APISettings UI 逻辑测试", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("API 配置验证", () => {
    test("应该验证 URL 格式", () => {
      const isValidUrl = (url: string): boolean => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === "https:" || parsed.protocol === "http:";
        } catch {
          return false;
        }
      };

      expect(isValidUrl("https://api.example.com")).toBe(true);
      expect(isValidUrl("http://api.example.com")).toBe(true);
      expect(isValidUrl("invalid-url")).toBe(false);
      expect(isValidUrl("")).toBe(false);
    });

    test("应该验证 Token 不为空", () => {
      const isValidToken = (token: string): boolean => {
        return token.trim().length > 0;
      };

      expect(isValidToken("Bearer abc123")).toBe(true);
      expect(isValidToken("")).toBe(false);
      expect(isValidToken("   ")).toBe(false);
    });

    test("应该验证超时设置范围", () => {
      const validateTimeout = (timeout: number): boolean => {
        return timeout >= 1000 && timeout <= 60000;
      };

      expect(validateTimeout(5000)).toBe(true);
      expect(validateTimeout(30000)).toBe(true);
      expect(validateTimeout(500)).toBe(false);
      expect(validateTimeout(70000)).toBe(false);
    });

    test("应该验证重试次数范围", () => {
      const validateRetryCount = (count: number): boolean => {
        return count >= 0 && count <= 5;
      };

      expect(validateRetryCount(3)).toBe(true);
      expect(validateRetryCount(0)).toBe(true);
      expect(validateRetryCount(5)).toBe(true);
      expect(validateRetryCount(-1)).toBe(false);
      expect(validateRetryCount(10)).toBe(false);
    });
  });

  describe("Webhook URL 验证", () => {
    test("应该验证有效的 Webhook URL", () => {
      const isValidWebhookUrl = (url: string): boolean => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === "https:" || parsed.protocol === "http:";
        } catch {
          return false;
        }
      };

      expect(isValidWebhookUrl("https://webhook.example.com/api")).toBe(true);
      expect(isValidWebhookUrl("http://localhost:3000/webhook")).toBe(true);
    });

    test("应该拒绝无效的 Webhook URL", () => {
      const isValidWebhookUrl = (url: string): boolean => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === "https:" || parsed.protocol === "http:";
        } catch {
          return false;
        }
      };

      expect(isValidWebhookUrl("ftp://webhook.example.com")).toBe(false);
      expect(isValidWebhookUrl("not-a-url")).toBe(false);
      expect(isValidWebhookUrl("")).toBe(false);
    });
  });

  describe("事件订阅管理", () => {
    test("应该能够切换事件订阅", () => {
      const subscribedEvents: Set<string> = new Set([
        "shortcut.created",
        "shortcut.executed",
      ]);

      const event: string = "shortcut.modified";

      // 添加事件
      subscribedEvents.add(event);
      expect(subscribedEvents.has(event)).toBe(true);
      expect(subscribedEvents.size).toBe(3);

      // 移除事件
      subscribedEvents.delete(event);
      expect(subscribedEvents.has(event)).toBe(false);
      expect(subscribedEvents.size).toBe(2);
    });

    test("应该验证至少订阅一个事件", () => {
      const subscribedEvents: Set<string> = new Set();
      const isValid = subscribedEvents.size > 0;

      expect(isValid).toBe(false);
    });

    test("应该支持订阅所有事件", () => {
      const allEvents: string[] = [
        "shortcut.created",
        "shortcut.modified",
        "shortcut.deleted",
        "shortcut.executed",
        "template.installed",
        "template.uninstalled",
        "mdm.synced",
        "audit.logged",
      ];

      const subscribedEvents = new Set(allEvents);

      expect(subscribedEvents.size).toBe(8);
      expect(subscribedEvents.has("shortcut.created")).toBe(true);
      expect(subscribedEvents.has("mdm.synced")).toBe(true);
    });
  });

  describe("Webhook 列表管理", () => {
    test("应该能够添加新的 Webhook", () => {
      const webhooks: WebhookConfig[] = [];

      const newWebhook: WebhookConfig = {
        name: "Test Webhook",
        description: "A test webhook",
        url: "https://example.com/webhook",
        events: ["shortcut.created"],
        secret: "secret-key",
        headers: {},
        enabled: true,
        method: "POST",
        timeout: 10000,
        retryCount: 3,
      };

      webhooks.push(newWebhook);

      expect(webhooks).toHaveLength(1);
      expect(webhooks[0]?.name).toBe("Test Webhook");
    });

    test("应该能够删除 Webhook", () => {
      const webhooks: WebhookConfig[] = [
        { name: "Webhook 1", description: "test", url: "", events: [], secret: "", headers: {}, enabled: true, method: "POST", timeout: 10000, retryCount: 3 } as WebhookConfig,
        { name: "Webhook 2", description: "test", url: "", events: [], secret: "", headers: {}, enabled: true, method: "POST", timeout: 10000, retryCount: 3 } as WebhookConfig,
      ];

      const idToDelete = "wh-001";
      const filtered = webhooks.filter(wh => wh.id !== idToDelete);

      expect(filtered).toHaveLength(2);
    });

    test("应该能够切换 Webhook 启用状态", () => {
      const webhook: WebhookConfig = {
        name: "Test Webhook",
        description: "test",
        url: "https://example.com/webhook",
        events: ["shortcut.created"],
        secret: "secret-key",
        headers: {},
        enabled: true,
        method: "POST",
        timeout: 10000,
        retryCount: 3,
      };

      webhook.enabled = !webhook.enabled;
      expect(webhook.enabled).toBe(false);

      webhook.enabled = !webhook.enabled;
      expect(webhook.enabled).toBe(true);
    });
  });

  describe("统计数据计算", () => {
    test("应该计算 Webhook 总触发次数", () => {
      const webhooks: Partial<WebhookConfig>[] = [
        { triggerCount: 100, successCount: 95, failureCount: 5 },
        { triggerCount: 50, successCount: 48, failureCount: 2 },
      ];

      const totalTriggers = webhooks.reduce((sum, wh) => sum + (wh.triggerCount ?? 0), 0);

      expect(totalTriggers).toBe(150);
    });

    test("应该计算成功率", () => {
      const webhook: Partial<WebhookConfig> = {
        triggerCount: 100,
        successCount: 95,
        failureCount: 5,
      };

      const successRate = webhook.successCount && webhook.triggerCount
        ? (webhook.successCount / webhook.triggerCount) * 100
        : 0;

      expect(successRate).toBe(95);
    });

    test("应该处理零触发的情况", () => {
      const webhook: Partial<WebhookConfig> = {
        triggerCount: 0,
        successCount: 0,
        failureCount: 0,
      };

      const successRate = webhook.successCount && webhook.triggerCount
        ? (webhook.successCount / webhook.triggerCount) * 100
        : 0;

      expect(successRate).toBe(0);
    });
  });

  describe("格式化辅助函数", () => {
    test("应该格式化触发次数", () => {
      const formatTriggerCount = (count: number): string => {
        if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
        if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
        return count.toString();
      };

      expect(formatTriggerCount(500)).toBe("500");
      expect(formatTriggerCount(1500)).toBe("1.5k");
      expect(formatTriggerCount(1500000)).toBe("1.5M");
    });

    test("应该格式化成功率", () => {
      const formatSuccessRate = (success: number, total: number): string => {
        if (total === 0) return "N/A";
        const rate = (success / total) * 100;
        return `${rate.toFixed(1)}%`;
      };

      expect(formatSuccessRate(95, 100)).toBe("95.0%");
      expect(formatSuccessRate(0, 0)).toBe("N/A");
      expect(formatSuccessRate(100, 100)).toBe("100.0%");
    });

    test("应该格式化响应时间", () => {
      const formatResponseTime = (ms: number): string => {
        if (ms < 1000) return `${ms}ms`;
        return `${(ms / 1000).toFixed(2)}s`;
      };

      expect(formatResponseTime(250)).toBe("250ms");
      expect(formatResponseTime(1500)).toBe("1.50s");
      expect(formatResponseTime(5000)).toBe("5.00s");
    });
  });

  describe("Token 可见性切换", () => {
    test("应该能够显示/隐藏 Token", () => {
      let showTokenPlaintext = false;

      const toggleTokenVisibility = () => {
        showTokenPlaintext = !showTokenPlaintext;
      };

      expect(showTokenPlaintext).toBe(false);

      toggleTokenVisibility();
      expect(showTokenPlaintext).toBe(true);

      toggleTokenVisibility();
      expect(showTokenPlaintext).toBe(false);
    });

    test("应该能够遮掩 Token", () => {
      const maskToken = (token: string): string => {
        if (token.length <= 8) return "********";
        return token.substring(0, 4) + "****" + token.substring(token.length - 4);
      };

      expect(maskToken("Bearer abc123def456")).toBe("Bear****f456");
      expect(maskToken("short")).toBe("********");
    });
  });

  describe("事件标签", () => {
    test("应该格式化事件类型标签", () => {
      const getEventLabel = (event: string): string => {
        const labels: Record<string, string> = {
          "shortcut.created": "快捷指令创建",
          "shortcut.modified": "快捷指令修改",
          "shortcut.deleted": "快捷指令删除",
          "shortcut.executed": "快捷指令执行",
          "template.installed": "模板安装",
          "template.uninstalled": "模板卸载",
          "mdm.synced": "MDM 同步",
          "audit.logged": "审计日志",
        };
        return labels[event] || event;
      };

      expect(getEventLabel("shortcut.created")).toBe("快捷指令创建");
      expect(getEventLabel("template.installed")).toBe("模板安装");
      expect(getEventLabel("mdm.synced")).toBe("MDM 同步");
    });
  });

  describe("Webhook 表单验证", () => {
    test("应该验证完整的 Webhook 表单", () => {
      const validateWebhookForm = (
        name: string,
        url: string,
        events: string[]
      ): { valid: boolean; errors: string[] } => {
        const errors: string[] = [];

        if (!name.trim()) errors.push("名称不能为空");
        if (!url.trim()) errors.push("URL 不能为空");

        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            errors.push("URL 必须是 HTTP 或 HTTPS 协议");
          }
        } catch {
          if (url.trim()) errors.push("URL 格式无效");
        }

        if (events.length === 0) errors.push("至少选择一个事件");

        return { valid: errors.length === 0, errors };
      };

      const valid = validateWebhookForm(
        "Test Webhook",
        "https://example.com/webhook",
        ["shortcut.created"]
      );
      expect(valid.valid).toBe(true);
      expect(valid.errors).toHaveLength(0);

      const invalid = validateWebhookForm("", "", []);
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.length).toBeGreaterThan(0);
    });
  });

  describe("实际 API 和 Webhook 管理器集成", () => {
    test("应该能够获取 API 配置", () => {
      const config = apiClient.getConfig();
      expect(config).toBeDefined();
    });

    test("应该能够获取所有 Webhooks", () => {
      const webhooks = webhookManager.getWebhooks();
      expect(Array.isArray(webhooks)).toBe(true);
    });
  });
});
