/**
 * __tests__/enterprise-mdm-manager.test.ts — `MDMManager` 的**写入与落盘**（原先名为
 * `enterprise-ui-mdm.test.ts`，见文件末尾的来历说明）
 *
 * 这里只留有真事的用例：全部调用真的 `mdmManager` / 真的 `localStorage`，覆盖的是
 * 「写进去之后读得回来」这一层 —— 与 `src/lib/__tests__/enterprise-mdm.test.ts`
 * （28 例，权限判定与策略）互补，两处都真的碰生产代码。
 *
 * **不渲染任何组件**：这个文件从来不渲染 `MDMPanel.svelte`，组件层的门在
 * `svelte-tests/enterprise-panels.svelte.test.ts`。
 *
 * 用途最紧的一条是「配置应该自动保存」：它断言的是**真实存储键**
 * `amos.shortcuts.mdm.config`（`mdm.ts` 的 `STORE_KEYS.MDM_CONFIG`）—— 原先它断言
 * `enterprise:mdm_config`，那是个代码从不写的键。
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

describe("MDMManager 的写入与落盘", () => {
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
      expect(mdmManager.checkCanCreate(0).allowed).toBe(false);

      // 再禁用：限制不再生效
      await mdmManager.configure({ enabled: false });

      const stored = mdmManager.getRestrictions();
      // 配置值仍在（管理员的设定没有被丢掉）……
      expect(stored.allowUserCreate).toBe(false);
      expect(stored.allowUserModify).toBe(false);
      // ……但**执行**被门控放行：禁用即不限制。
      expect(mdmManager.isEnabled()).toBe(false);
      expect(mdmManager.checkCanCreate(0).allowed).toBe(true);
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

/**
 * 来历（REQ-A821，2026-09-21）
 *
 * 这个文件原先叫 `enterprise-ui-mdm.test.ts`，与 `enterprise-ui-{api,audit,template}.test.ts`
 * 三兄弟一样，头里写着「XXX UI 组件测试」，而**没有一条用例渲染过任何组件**：83 条里有 69 条
 * 断言的是**测试自己写的那份实现** —— 25 条在测试体里定义一个函数（`const formatTimestamp = …`）
 * 再断言它，另 44 条**不碰任何一个生产符号**（自己拼一个数组、`filter` 一下、断言过滤结果）。
 * 其中 21 条测的函数在产品里**根本不存在**（`escapeCsvValue`／`validateRange`／`mbToBytes`…），
 * 4 条测的名字在 `AuditLogViewer.svelte` 里有，但用的是测试里自己那份副本，生产改了不会红。
 *
 * 那种用例的判别力是零：删掉整个面板它们照样全绿。本轮把那 69 条删掉，三个空壳文件整个删除
 * （剩下的 2／1／1 条与 `src/lib/__tests__/enterprise-{api,audit,templates}.test.ts` 重复），
 * 只留下本文件里真的调用 `mdmManager` 的 10 条，并把文件改成如实的名字。
 */
