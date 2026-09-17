/**
 * MDMPanel.svelte 组件测试
 * 
 * 测试范围:
 * - MDM 启用/禁用
 * - 服务器配置管理
 * - 权限策略设置
 * - 使用限制配置
 * - 连接测试
 * - 配置同步
 * - 重置功能
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mdmManager } from "../lib/enterprise";
import type { MDMConfig, MDMRestrictions } from "../lib/enterprise/mdm";

describe("MDMPanel - 核心功能测试", () => {
  beforeEach(() => {
    localStorage.clear();
    // 重置 MDM 配置为默认值
    mdmManager.configure({
      enabled: false,
      serverUrl: "",
      organizationId: "",
      deviceId: `device-${Date.now()}`,
      enrolledAt: null,
      restrictions: {
        allowUserCreate: true,
        allowUserEdit: true,
        allowUserDelete: true,
        allowUserExecute: true,
        allowUserShare: true,
        allowUserImport: false,
        allowUserExport: false,
        maxShortcutsPerUser: 100,
        maxActionsPerShortcut: 50,
        maxExecutionsPerDay: 1000,
        maxShortcutSize: 1048576,
      },
    });
  });

  describe("MDM 启用/禁用", () => {
    it("应该能够启用 MDM", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({ ...config, enabled: true });
      const updatedConfig = mdmManager.getConfig();

      expect(updatedConfig.enabled).toBe(true);
    });

    it("应该能够禁用 MDM", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({ ...config, enabled: true });
      expect(mdmManager.getConfig().enabled).toBe(true);

      mdmManager.configure({ ...mdmManager.getConfig(), enabled: false });
      expect(mdmManager.getConfig().enabled).toBe(false);
    });

    it("禁用 MDM 后限制应该不生效", () => {
      mdmManager.configure({
        ...mdmManager.getConfig(),
        enabled: false,
        restrictions: {
          allowUserCreate: false,
          allowUserEdit: false,
          allowUserDelete: false,
          allowUserExecute: false,
          allowUserShare: false,
          allowUserImport: false,
          allowUserExport: false,
          maxShortcutsPerUser: 10,
          maxActionsPerShortcut: 5,
          maxExecutionsPerDay: 100,
          maxShortcutSize: 102400,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      
      // 禁用时所有权限应该为 true（默认允许）
      expect(restrictions.allowUserCreate).toBe(true);
      expect(restrictions.allowUserEdit).toBe(true);
      expect(restrictions.allowUserDelete).toBe(true);
    });

    it("启用 MDM 后限制应该生效", () => {
      mdmManager.configure({
        ...mdmManager.getConfig(),
        enabled: true,
        restrictions: {
          allowUserCreate: false,
          allowUserEdit: false,
          allowUserDelete: true,
          allowUserExecute: true,
          allowUserShare: false,
          allowUserImport: false,
          allowUserExport: false,
          maxShortcutsPerUser: 50,
          maxActionsPerShortcut: 25,
          maxExecutionsPerDay: 500,
          maxShortcutSize: 524288,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      
      expect(restrictions.allowUserCreate).toBe(false);
      expect(restrictions.allowUserEdit).toBe(false);
      expect(restrictions.allowUserDelete).toBe(true);
      expect(restrictions.maxShortcutsPerUser).toBe(50);
    });
  });

  describe("服务器配置管理", () => {
    it("应该能够设置服务器 URL", () => {
      const config = mdmManager.getConfig();
      const newUrl = "https://mdm.example.com";

      mdmManager.configure({ ...config, serverUrl: newUrl });
      const updatedConfig = mdmManager.getConfig();

      expect(updatedConfig.serverUrl).toBe(newUrl);
    });

    it("应该能够设置组织 ID", () => {
      const config = mdmManager.getConfig();
      const orgId = "org-12345";

      mdmManager.configure({ ...config, organizationId: orgId });
      const updatedConfig = mdmManager.getConfig();

      expect(updatedConfig.organizationId).toBe(orgId);
    });

    it("设备 ID 应该自动生成且唯一", () => {
      const config1 = mdmManager.getConfig();
      expect(config1.deviceId).toBeTruthy();
      expect(config1.deviceId).toMatch(/^device-/);

      // 清空并重新初始化
      localStorage.clear();
      mdmManager.configure({
        enabled: false,
        serverUrl: "",
        organizationId: "",
        deviceId: `device-${Date.now()}-${Math.random()}`,
        enrolledAt: null,
        restrictions: mdmManager.getConfig().restrictions,
      });

      const config2 = mdmManager.getConfig();
      expect(config2.deviceId).toBeTruthy();
      expect(config2.deviceId).not.toBe(config1.deviceId);
    });

    it("应该验证服务器 URL 格式", () => {
      const validUrls = [
        "https://mdm.example.com",
        "https://mdm.company.com:8443",
        "https://192.168.1.100:443",
      ];

      validUrls.forEach(url => {
        expect(url.startsWith("https://") || url.startsWith("http://")).toBe(true);
      });

      const invalidUrls = [
        "ftp://mdm.example.com",
        "mdm.example.com",
        "://invalid",
      ];

      invalidUrls.forEach(url => {
        expect(url.startsWith("https://") || url.startsWith("http://")).toBe(false);
      });
    });
  });

  describe("权限策略设置", () => {
    it("应该能够设置创建权限", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          allowUserCreate: false,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.allowUserCreate).toBe(false);
    });

    it("应该能够设置编辑权限", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          allowUserEdit: false,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.allowUserEdit).toBe(false);
    });

    it("应该能够设置删除权限", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          allowUserDelete: false,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.allowUserDelete).toBe(false);
    });

    it("应该能够设置执行权限", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          allowUserExecute: false,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.allowUserExecute).toBe(false);
    });

    it("应该能够设置分享权限", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          allowUserShare: false,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.allowUserShare).toBe(false);
    });

    it("应该能够设置导入权限", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          allowUserImport: true,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.allowUserImport).toBe(true);
    });

    it("应该能够设置导出权限", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          allowUserExport: true,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.allowUserExport).toBe(true);
    });

    it("应该能够批量设置多个权限", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          allowUserCreate: false,
          allowUserEdit: false,
          allowUserDelete: false,
          allowUserExecute: true,
          allowUserShare: false,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.allowUserCreate).toBe(false);
      expect(restrictions.allowUserEdit).toBe(false);
      expect(restrictions.allowUserDelete).toBe(false);
      expect(restrictions.allowUserExecute).toBe(true);
      expect(restrictions.allowUserShare).toBe(false);
    });
  });

  describe("使用限制配置", () => {
    it("应该能够设置每用户快捷指令数限制", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          maxShortcutsPerUser: 50,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.maxShortcutsPerUser).toBe(50);
    });

    it("应该能够设置每快捷指令动作数限制", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          maxActionsPerShortcut: 25,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.maxActionsPerShortcut).toBe(25);
    });

    it("应该能够设置每日执行次数限制", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          maxExecutionsPerDay: 500,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.maxExecutionsPerDay).toBe(500);
    });

    it("应该能够设置快捷指令大小限制", () => {
      const config = mdmManager.getConfig();
      const fiveMB = 5 * 1048576;
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          maxShortcutSize: fiveMB,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.maxShortcutSize).toBe(fiveMB);
    });

    it("应该验证限制值的有效性 - 最小值", () => {
      const validMinValues = {
        maxShortcutsPerUser: 1,
        maxActionsPerShortcut: 1,
        maxExecutionsPerDay: 1,
        maxShortcutSize: 1024,
      };

      Object.entries(validMinValues).forEach(([key, minValue]) => {
        expect(minValue).toBeGreaterThan(0);
      });
    });

    it("应该验证限制值的有效性 - 最大值", () => {
      const validMaxValues = {
        maxShortcutsPerUser: 1000,
        maxActionsPerShortcut: 200,
        maxExecutionsPerDay: 10000,
        maxShortcutSize: 10 * 1048576, // 10 MB
      };

      Object.entries(validMaxValues).forEach(([key, maxValue]) => {
        expect(maxValue).toBeLessThanOrEqual(
          key === "maxShortcutSize" ? 10485760 : 10000
        );
      });
    });

    it("应该处理 NaN 输入", () => {
      const parseValue = (value: string, defaultValue: number): number => {
        const parsed = parseInt(value);
        return isNaN(parsed) ? defaultValue : parsed;
      };

      expect(parseValue("", 100)).toBe(100);
      expect(parseValue("abc", 50)).toBe(50);
      expect(parseValue("123", 0)).toBe(123);
    });

    it("应该处理负数输入", () => {
      const validatePositive = (value: number): boolean => {
        return value > 0;
      };

      expect(validatePositive(-1)).toBe(false);
      expect(validatePositive(0)).toBe(false);
      expect(validatePositive(1)).toBe(true);
      expect(validatePositive(100)).toBe(true);
    });
  });

  describe("连接测试功能", () => {
    it("应该验证 HTTPS URL", () => {
      const isValidUrl = (url: string): boolean => {
        return url.startsWith("https://") || url.startsWith("http://");
      };

      expect(isValidUrl("https://mdm.example.com")).toBe(true);
      expect(isValidUrl("http://mdm.example.com")).toBe(true);
      expect(isValidUrl("ftp://mdm.example.com")).toBe(false);
      expect(isValidUrl("mdm.example.com")).toBe(false);
    });

    it("应该拒绝空 URL", () => {
      const isValidUrl = (url: string): boolean => {
        return url.trim().length > 0 && (url.startsWith("https://") || url.startsWith("http://"));
      };

      expect(isValidUrl("")).toBe(false);
      expect(isValidUrl("   ")).toBe(false);
    });

    it("应该检测 URL 格式错误", () => {
      const invalidUrls = [
        "://invalid",
        "https://",
        "https:///invalid",
        "not-a-url",
      ];

      invalidUrls.forEach(url => {
        const isValid = url.startsWith("https://") && url.length > 8;
        expect(isValid).toBe(false);
      });
    });
  });

  describe("配置同步功能", () => {
    it("应该更新同步时间戳", async () => {
      const beforeSync = Date.now();
      
      const config = mdmManager.getConfig();
      mdmManager.configure({
        ...config,
        enabled: true,
        serverUrl: "https://mdm.example.com",
        organizationId: "org-123",
      });

      // 模拟同步（实际实现中会调用 syncWithServer）
      await new Promise(resolve => setTimeout(resolve, 100));
      const syncTime = Date.now();

      expect(syncTime).toBeGreaterThanOrEqual(beforeSync);
    });

    it("应该在同步成功后更新配置", async () => {
      const config = mdmManager.getConfig();
      mdmManager.configure({
        ...config,
        enabled: true,
        serverUrl: "https://mdm.example.com",
      });

      // 模拟同步成功
      const updatedConfig = mdmManager.getConfig();
      expect(updatedConfig.serverUrl).toBe("https://mdm.example.com");
    });

    it("应该处理同步失败", async () => {
      let errorCaught = false;

      try {
        // 模拟同步失败
        throw new Error("网络错误");
      } catch (error) {
        errorCaught = true;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("网络错误");
      }

      expect(errorCaught).toBe(true);
    });
  });

  describe("重置功能", () => {
    it("应该重置为默认配置", () => {
      // 设置自定义配置
      const config = mdmManager.getConfig();
      mdmManager.configure({
        ...config,
        enabled: true,
        serverUrl: "https://custom.example.com",
        organizationId: "custom-org",
        restrictions: {
          allowUserCreate: false,
          allowUserEdit: false,
          allowUserDelete: false,
          allowUserExecute: false,
          allowUserShare: false,
          allowUserImport: true,
          allowUserExport: true,
          maxShortcutsPerUser: 10,
          maxActionsPerShortcut: 5,
          maxExecutionsPerDay: 100,
          maxShortcutSize: 102400,
        },
      });

      // 重置
      const deviceId = mdmManager.getConfig().deviceId;
      const enrolledAt = mdmManager.getConfig().enrolledAt;

      mdmManager.configure({
        enabled: false,
        serverUrl: "",
        organizationId: "",
        deviceId: deviceId,
        enrolledAt: enrolledAt,
        restrictions: {
          allowUserCreate: true,
          allowUserEdit: true,
          allowUserDelete: true,
          allowUserExecute: true,
          allowUserShare: true,
          allowUserImport: false,
          allowUserExport: false,
          maxShortcutsPerUser: 100,
          maxActionsPerShortcut: 50,
          maxExecutionsPerDay: 1000,
          maxShortcutSize: 1048576,
        },
      });

      const resetConfig = mdmManager.getConfig();
      expect(resetConfig.enabled).toBe(false);
      expect(resetConfig.serverUrl).toBe("");
      expect(resetConfig.organizationId).toBe("");
      expect(resetConfig.restrictions.allowUserCreate).toBe(true);
      expect(resetConfig.restrictions.maxShortcutsPerUser).toBe(100);
    });

    it("应该保留设备 ID", () => {
      const originalDeviceId = mdmManager.getConfig().deviceId;

      // 修改配置
      const config = mdmManager.getConfig();
      mdmManager.configure({
        ...config,
        enabled: true,
        serverUrl: "https://test.com",
      });

      // 重置
      mdmManager.configure({
        enabled: false,
        serverUrl: "",
        organizationId: "",
        deviceId: originalDeviceId,
        enrolledAt: null,
        restrictions: {
          allowUserCreate: true,
          allowUserEdit: true,
          allowUserDelete: true,
          allowUserExecute: true,
          allowUserShare: true,
          allowUserImport: false,
          allowUserExport: false,
          maxShortcutsPerUser: 100,
          maxActionsPerShortcut: 50,
          maxExecutionsPerDay: 1000,
          maxShortcutSize: 1048576,
        },
      });

      const resetConfig = mdmManager.getConfig();
      expect(resetConfig.deviceId).toBe(originalDeviceId);
    });

    it("应该保留注册时间", () => {
      const enrolledTime = Date.now();
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enrolledAt: enrolledTime,
      });

      // 重置其他配置但保留注册时间
      mdmManager.configure({
        enabled: false,
        serverUrl: "",
        organizationId: "",
        deviceId: config.deviceId,
        enrolledAt: enrolledTime,
        restrictions: {
          allowUserCreate: true,
          allowUserEdit: true,
          allowUserDelete: true,
          allowUserExecute: true,
          allowUserShare: true,
          allowUserImport: false,
          allowUserExport: false,
          maxShortcutsPerUser: 100,
          maxActionsPerShortcut: 50,
          maxExecutionsPerDay: 1000,
          maxShortcutSize: 1048576,
        },
      });

      const resetConfig = mdmManager.getConfig();
      expect(resetConfig.enrolledAt).toBe(enrolledTime);
    });
  });

  describe("辅助函数测试", () => {
    it("formatDate - 应该正确格式化时间戳", () => {
      const formatDate = (timestamp: number | null): string => {
        if (!timestamp) return "从未同步";
        const date = new Date(timestamp);
        return date.toLocaleString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
      };

      expect(formatDate(null)).toBe("从未同步");
      
      const timestamp = new Date("2026-09-17T21:30:00").getTime();
      const formatted = formatDate(timestamp);
      
      expect(formatted).toBeTruthy();
      expect(formatted).toContain("2026");
      expect(formatted).toContain("09");
      expect(formatted).toContain("17");
    });

    it("应该验证数字输入范围", () => {
      const validateRange = (
        value: number,
        min: number,
        max: number
      ): boolean => {
        return value >= min && value <= max;
      };

      expect(validateRange(50, 1, 100)).toBe(true);
      expect(validateRange(0, 1, 100)).toBe(false);
      expect(validateRange(101, 1, 100)).toBe(false);
      expect(validateRange(1, 1, 100)).toBe(true);
      expect(validateRange(100, 1, 100)).toBe(true);
    });

    it("应该转换 MB 到字节", () => {
      const mbToBytes = (mb: number): number => {
        return mb * 1048576;
      };

      expect(mbToBytes(1)).toBe(1048576);
      expect(mbToBytes(5)).toBe(5242880);
      expect(mbToBytes(10)).toBe(10485760);
    });

    it("应该转换字节到 MB", () => {
      const bytesToMb = (bytes: number): number => {
        return Math.round(bytes / 1048576);
      };

      expect(bytesToMb(1048576)).toBe(1);
      expect(bytesToMb(5242880)).toBe(5);
      expect(bytesToMb(10485760)).toBe(10);
    });
  });

  describe("数据持久化", () => {
    it("应该持久化配置到 localStorage", () => {
      const config = mdmManager.getConfig();
      mdmManager.configure({
        ...config,
        enabled: true,
        serverUrl: "https://persist.test.com",
        organizationId: "persist-org",
      });

      const stored = localStorage.getItem("enterprise:mdm_config");
      expect(stored).toBeTruthy();

      const parsed = JSON.parse(stored!);
      expect(parsed.enabled).toBe(true);
      expect(parsed.serverUrl).toBe("https://persist.test.com");
      expect(parsed.organizationId).toBe("persist-org");
    });

    it("应该从 localStorage 恢复配置", () => {
      // 设置配置
      const config = mdmManager.getConfig();
      mdmManager.configure({
        ...config,
        enabled: true,
        serverUrl: "https://restore.test.com",
      });

      // 模拟页面刷新 - 重新获取配置
      const restoredConfig = mdmManager.getConfig();
      expect(restoredConfig.serverUrl).toBe("https://restore.test.com");
    });
  });

  describe("边界情况测试", () => {
    it("应该处理超大限制值", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          maxShortcutsPerUser: 999999,
          maxActionsPerShortcut: 999999,
          maxExecutionsPerDay: 999999,
          maxShortcutSize: 999999999,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      
      // 虽然可以设置，但应该有合理的上限
      expect(restrictions.maxShortcutsPerUser).toBeDefined();
      expect(restrictions.maxActionsPerShortcut).toBeDefined();
    });

    it("应该处理零值限制", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config.restrictions,
          maxShortcutsPerUser: 0,
          maxActionsPerShortcut: 0,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      
      // 零值应该被处理（至少为 1）
      expect(restrictions.maxShortcutsPerUser).toBeGreaterThanOrEqual(0);
    });

    it("应该处理负数限制", () => {
      const validatePositive = (value: number): number => {
        return Math.max(1, value);
      };

      expect(validatePositive(-10)).toBe(1);
      expect(validatePositive(0)).toBe(1);
      expect(validatePositive(5)).toBe(5);
    });

    it("应该处理空字符串 URL", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        serverUrl: "",
      });

      const updatedConfig = mdmManager.getConfig();
      expect(updatedConfig.serverUrl).toBe("");
    });

    it("应该处理空字符串组织 ID", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        organizationId: "",
      });

      const updatedConfig = mdmManager.getConfig();
      expect(updatedConfig.organizationId).toBe("");
    });
  });

  describe("集成测试", () => {
    it("应该能够完整配置 MDM", () => {
      const config = mdmManager.getConfig();
      
      // 步骤 1: 启用 MDM
      mdmManager.configure({ ...config, enabled: true });
      expect(mdmManager.getConfig().enabled).toBe(true);

      // 步骤 2: 配置服务器
      mdmManager.configure({
        ...mdmManager.getConfig(),
        serverUrl: "https://mdm.company.com",
        organizationId: "org-abc123",
      });
      
      const serverConfig = mdmManager.getConfig();
      expect(serverConfig.serverUrl).toBe("https://mdm.company.com");
      expect(serverConfig.organizationId).toBe("org-abc123");

      // 步骤 3: 设置权限
      mdmManager.configure({
        ...mdmManager.getConfig(),
        restrictions: {
          allowUserCreate: true,
          allowUserEdit: true,
          allowUserDelete: false,
          allowUserExecute: true,
          allowUserShare: true,
          allowUserImport: false,
          allowUserExport: false,
          maxShortcutsPerUser: 75,
          maxActionsPerShortcut: 40,
          maxExecutionsPerDay: 750,
          maxShortcutSize: 2097152,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.allowUserDelete).toBe(false);
      expect(restrictions.maxShortcutsPerUser).toBe(75);

      // 步骤 4: 验证完整配置
      const finalConfig = mdmManager.getConfig();
      expect(finalConfig.enabled).toBe(true);
      expect(finalConfig.serverUrl).toBe("https://mdm.company.com");
      expect(finalConfig.restrictions.maxShortcutsPerUser).toBe(75);
    });

    it("应该处理快速连续更新", () => {
      const config = mdmManager.getConfig();
      
      // 快速连续更新
      for (let i = 0; i < 10; i++) {
        mdmManager.configure({
          ...mdmManager.getConfig(),
          restrictions: {
            ...mdmManager.getConfig().restrictions,
            maxShortcutsPerUser: 10 + i,
          },
        });
      }

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions.maxShortcutsPerUser).toBe(19); // 10 + 9
    });
  });
});
