/**
 * __tests__/enterprise-ui-mdm.test.ts
 * 
 * MDMPanel UI 组件测试
 * 
 * 测试范围:
 * - MDM 配置的 UI 交互逻辑
 * - 限制配置的正确性验证
 * - 数据格式化函数
 * - 输入验证逻辑
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MDMManager, mdmManager } from "../lib/enterprise/mdm";
import type { MDMRestrictions } from "../lib/enterprise/mdm";

// 注册 happy-dom 全局对象（包括 localStorage）
beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("MDMPanel UI 逻辑测试", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("配置管理", () => {
    test("应该能够启用和禁用 MDM", async () => {
      // `configure` 是异步的（写盘之后才算配好），所以这里 await；
      // 也不能假设初始 config 一定是 null —— 它是模块级单例，前面的用例会留下状态。
      await mdmManager.configure({ enabled: true });
      expect(mdmManager.getConfig()?.enabled).toBe(true);

      await mdmManager.configure({ enabled: false });
      expect(mdmManager.getConfig()?.enabled).toBe(false);
    });

    test("应该能够配置服务器 URL", () => {
      const config = mdmManager.getConfig();
      const testUrl = "https://mdm.company.com";

      mdmManager.configure({ ...config, serverUrl: testUrl });
      expect(mdmManager.getConfig()?.serverUrl).toBe(testUrl);
    });

    test("应该能够配置组织 ID", () => {
      const config = mdmManager.getConfig();
      const testOrgId = "org-12345";

      mdmManager.configure({ ...config, organizationId: testOrgId });
      expect(mdmManager.getConfig()?.organizationId).toBe(testOrgId);
    });
  });

  describe("限制配置", () => {
    test("应该正确配置用户权限", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config?.restrictions,
          allowUserCreate: false,
          allowUserModify: false,
          allowUserDelete: true,
        } as MDMRestrictions,
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions?.allowUserCreate).toBe(false);
      expect(restrictions?.allowUserModify).toBe(false);
      expect(restrictions?.allowUserDelete).toBe(true);
    });

    test("应该正确配置数量限制", () => {
      const config = mdmManager.getConfig();
      
      mdmManager.configure({
        ...config,
        enabled: true,
        restrictions: {
          ...config?.restrictions,
          maxShortcutsPerUser: 50,
          maxActionsPerShortcut: 25,
          maxExecutionsPerDay: 500,
        } as MDMRestrictions,
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions?.maxShortcutsPerUser).toBe(50);
      expect(restrictions?.maxActionsPerShortcut).toBe(25);
      expect(restrictions?.maxExecutionsPerDay).toBe(500);
    });

    test("禁用 MDM 时限制不再生效（由 enabled 门控，而不是丢弃配置）", async () => {
      // 真实语义：`getRestrictions()` 返回**配置里写的值**（管理员的设定），
      // 禁用后生效与否由 `checkPermission` 的 `!enabled ⇒ allowed: true` 决定。
      // 原来的断言要求"禁用时返回宽松默认值"——代码里没有这个行为，而且不该有：
      // 丢掉配置等于用户重新启用后要再配一遍。
      // 先"启用 + 收紧"，确认限制真的在起作用
      await mdmManager.configure({
        enabled: true,
        restrictions: {
          ...mdmManager.getRestrictions(),
          allowUserCreate: false,
          allowUserModify: false,
        },
      });
      expect(mdmManager.checkCanCreate().allowed).toBe(false);

      // 再禁用：限制不再生效
      await mdmManager.configure({ enabled: false });

      const stored = mdmManager.getRestrictions();
      // 配置值仍在（管理员的设定没有被丢掉）……
      expect(stored.allowUserCreate).toBe(false);
      expect(stored.allowUserModify).toBe(false);
      // ……但**执行**被门控放行：禁用即不限制。
      expect(mdmManager.isEnabled()).toBe(false);
      expect(mdmManager.checkCanCreate().allowed).toBe(true);
    });
  });

  describe("URL 验证辅助函数", () => {
    test("应该验证有效的 HTTPS URL", () => {
      const isValidUrl = (url: string): boolean => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === "https:" || parsed.protocol === "http:";
        } catch {
          return false;
        }
      };

      expect(isValidUrl("https://mdm.example.com")).toBe(true);
      expect(isValidUrl("http://mdm.example.com")).toBe(true);
      expect(isValidUrl("https://192.168.1.100:8443")).toBe(true);
    });

    test("应该拒绝无效的 URL", () => {
      const isValidUrl = (url: string): boolean => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === "https:" || parsed.protocol === "http:";
        } catch {
          return false;
        }
      };

      expect(isValidUrl("ftp://mdm.example.com")).toBe(false);
      expect(isValidUrl("not-a-url")).toBe(false);
      expect(isValidUrl("")).toBe(false);
      expect(isValidUrl("://invalid")).toBe(false);
    });
  });

  describe("数字输入验证辅助函数", () => {
    test("应该正确解析数字输入", () => {
      const parsePositiveInt = (value: string, defaultValue: number): number => {
        const parsed = parseInt(value, 10);
        return isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
      };

      expect(parsePositiveInt("100", 50)).toBe(100);
      expect(parsePositiveInt("", 50)).toBe(50);
      expect(parsePositiveInt("abc", 50)).toBe(50);
      expect(parsePositiveInt("-10", 50)).toBe(50);
      expect(parsePositiveInt("0", 50)).toBe(0);
    });

    test("应该验证数字范围", () => {
      const validateRange = (value: number, min: number, max: number): boolean => {
        return value >= min && value <= max;
      };

      expect(validateRange(50, 1, 100)).toBe(true);
      expect(validateRange(1, 1, 100)).toBe(true);
      expect(validateRange(100, 1, 100)).toBe(true);
      expect(validateRange(0, 1, 100)).toBe(false);
      expect(validateRange(101, 1, 100)).toBe(false);
    });
  });

  describe("时间格式化辅助函数", () => {
    test("应该格式化时间戳为本地时间", () => {
      const formatTimestamp = (timestamp: number | undefined): string => {
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

      expect(formatTimestamp(undefined)).toBe("从未同步");
      expect(formatTimestamp(0)).toBe("从未同步");
      
      const timestamp = new Date("2026-09-17T21:30:00").getTime();
      const formatted = formatTimestamp(timestamp);
      expect(formatted).toContain("2026");
      expect(formatted).toContain("09");
      expect(formatted).toContain("17");
    });
  });

  describe("设备 ID 生成", () => {
    test("设备 ID 应该包含 device- 前缀", () => {
      const config = mdmManager.getConfig();
      expect(config?.deviceId).toBeTruthy();
      expect(config?.deviceId).toMatch(/^device-/);
    });

    test("每次初始化应该生成不同的设备 ID", () => {
      const config1 = mdmManager.getConfig();
      const deviceId1 = config1?.deviceId;

      localStorage.clear();
      
      // 模拟新的初始化
      mdmManager.configure({
        enabled: false,
        serverUrl: "",
        organizationId: "",
        deviceId: `device-${Date.now()}-${Math.random()}`,
        enrolledAt: undefined,
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
          allowExport: false,
          allowImport: false,
          requireApprovalForCreate: false,
          requireApprovalForModify: false,
          requireApprovalForSharing: false,
        },
      });

      const config2 = mdmManager.getConfig();
      const deviceId2 = config2?.deviceId;

      expect(deviceId1).not.toBe(deviceId2);
    });
  });

  describe("MB 转换辅助函数", () => {
    test("应该正确转换 MB 到字节", () => {
      const mbToBytes = (mb: number): number => {
        return mb * 1048576;
      };

      expect(mbToBytes(1)).toBe(1048576);
      expect(mbToBytes(5)).toBe(5242880);
      expect(mbToBytes(10)).toBe(10485760);
    });

    test("应该正确转换字节到 MB", () => {
      const bytesToMb = (bytes: number): number => {
        return Math.round(bytes / 1048576);
      };

      expect(bytesToMb(1048576)).toBe(1);
      expect(bytesToMb(5242880)).toBe(5);
      expect(bytesToMb(10485760)).toBe(10);
      expect(bytesToMb(1500000)).toBe(1); // 向下取整
    });
  });

  describe("数据持久化", () => {
    test("配置应该自动保存（真实键名 amos.shortcuts.mdm.config，且能被重新读回）", async () => {
      await mdmManager.configure({
        enabled: true,
        serverUrl: "https://persist.test.com",
        organizationId: "persist-org-123",
      });

      // 真实键名来自 `mdm.ts` 的 `STORE_KEYS.MDM_CONFIG`；原来断言的是
      // `enterprise:mdm_config` —— 代码从不写这个键。
      const stored = localStorage.getItem("amos.shortcuts.mdm.config");
      expect(stored).toBeTruthy();

      // 存储里可能是**密文**（Web Crypto 可用时），所以断言的是"重新读回来
      // 是同一份配置"，而不是"存储里是明文 JSON"——后者会把加密实现钉死。
      const reloaded = new MDMManager();
      await reloaded.initialize();
      expect(reloaded.getConfig()?.enabled).toBe(true);
      expect(reloaded.getConfig()?.serverUrl).toBe("https://persist.test.com");
      expect(reloaded.getConfig()?.organizationId).toBe("persist-org-123");
    });
  });

  describe("集成场景", () => {
    test("完整的 MDM 配置流程", () => {
      // 步骤 1: 启用 MDM
      const config = mdmManager.getConfig();
      mdmManager.configure({ ...config, enabled: true });
      expect(mdmManager.getConfig()?.enabled).toBe(true);

      // 步骤 2: 配置服务器
      mdmManager.configure({
        ...mdmManager.getConfig(),
        serverUrl: "https://mdm.company.com",
        organizationId: "org-abc123",
      });
      
      const serverConfig = mdmManager.getConfig();
      expect(serverConfig?.serverUrl).toBe("https://mdm.company.com");
      expect(serverConfig?.organizationId).toBe("org-abc123");

      // 步骤 3: 配置限制
      mdmManager.configure({
        ...mdmManager.getConfig(),
        restrictions: {
          disabledCategories: [],
          disabledActions: [],
          maxExecutionTime: 300,
          maxExecutionsPerDay: 750,
          maxActionsPerShortcut: 40,
          maxShortcutsPerUser: 75,
          allowUserCreate: true,
          allowUserModify: true,
          allowUserDelete: false,
          allowSharing: true,
          allowExport: false,
          allowImport: false,
          requireApprovalForCreate: false,
          requireApprovalForModify: false,
          requireApprovalForSharing: false,
        },
      });

      const restrictions = mdmManager.getRestrictions();
      expect(restrictions?.allowUserDelete).toBe(false);
      expect(restrictions?.maxShortcutsPerUser).toBe(75);

      // 步骤 4: 验证完整配置
      const finalConfig = mdmManager.getConfig();
      expect(finalConfig?.enabled).toBe(true);
      expect(finalConfig?.serverUrl).toBe("https://mdm.company.com");
      expect(finalConfig?.restrictions?.maxShortcutsPerUser).toBe(75);
    });
  });
});
