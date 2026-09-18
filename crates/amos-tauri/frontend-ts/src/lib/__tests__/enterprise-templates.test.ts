/**
 * __tests__/enterprise-templates.test.ts — `enterprise/templates.ts` 的行为测试（P2-1 覆盖）
 *
 * 为什么单独一个文件：`make cov` 缺口最大的几个文件里，`templates.ts` 有 217 行未覆盖，
 * 而它的每个方法都是**能在无头环境里验的真契约**：模板/安装记录/分类落到哪三个 store 键、
 * 参数校验的六类拒绝（必填 / 数字 / 布尔 / select / 范围 / 正则）、安装时占位符怎么替换、
 * 卸载时要拒绝强制模板、版本比较怎么判"有更新"、以及同步时的自动安装。没有一条断言依赖真机。
 *
 * 这个文件**故意不注册 happy-dom**（同 `enterprise-webhooks.test.ts`）：导入 happy-dom 会被
 * `scripts/bun-iso-test.mjs` 判为 DOM 文件、只为"正确性"跑，**不计入 P2-1 覆盖率**。
 * `amosStore` 只用到一个 DOM 面（`window.localStorage`），给一个内存桩就够。
 * `pure` 批次是"一个进程跑所有文件"，所以桩只在**本文件**生命周期内存在：`beforeAll` 装、
 * `afterAll` 还原（顶层安装会泄漏给同批次后面的文件，REQ-A390 踩过）。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  TemplateManager,
  TEMPLATES_KEY,
  TEMPLATE_INSTALLATIONS_KEY,
  TEMPLATE_CATEGORIES_KEY,
  type EnterpriseTemplate,
  type TemplateInstallation,
} from "../enterprise/templates";
import { mdmManager, type MDMConfig } from "../enterprise/mdm";
import { readStoreValue } from "../amosStore";
import type { Shortcut } from "../shortcuts";

const memory = new Map<string, string>();
const stub = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  },
};
const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;

beforeAll(() => {
  globals.window = stub;
});

afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
});

const realFetch = globalThis.fetch;
const realGetItem = stub.localStorage.getItem;

beforeEach(() => {
  memory.clear();
  mdmManager.clearConfigForTest();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  stub.localStorage.getItem = realGetItem;
  mdmManager.clearConfigForTest();
});

/**
 * 按**模块自己的读法**播种：`saveX` 写的是 `JSON.stringify(payload)`，而
 * `writeJson` 再 stringify 一次 ⇒ localStorage 里是"一个 JSON 字符串字面量，内容是 JSON"。
 * 直接播种要复刻这层双层编码，`initialize()` 才读得出来。
 */
function seed(key: string, value: unknown): void {
  memory.set(key, JSON.stringify(JSON.stringify(value)));
}

/** 按模块自己的读法取回落盘内容。 */
function stored<T>(key: string): T[] {
  const raw = readStoreValue<string>(key, "");
  return raw ? (JSON.parse(raw) as T[]) : [];
}

function shortcut(overrides: Partial<Shortcut> = {}): Shortcut {
  return {
    id: "s-base",
    name: "Base",
    icon: "star",
    color: "#111111",
    description: "base shortcut",
    actions: [],
    quickActions: [],
    triggers: [],
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    runOnLockScreen: false,
    requiresConfirmation: false,
    tags: [],
    ...overrides,
  };
}

function makeTemplate(over: Partial<EnterpriseTemplate> = {}): EnterpriseTemplate {
  return {
    id: "tpl-1",
    name: "Template",
    description: "describes the template",
    category: "productivity",
    department: "engineering",
    icon: "⚡",
    color: "#000000",
    version: "1.0.0",
    shortcutData: shortcut(),
    parameters: [],
    targetRoles: [],
    targetDepartments: [],
    isForced: false,
    allowCustomization: true,
    autoUpdate: false,
    publishStatus: "published",
    installedCount: 0,
    successCount: 0,
    failureCount: 0,
    organizationId: "org-1",
    createdBy: "admin",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** `createTemplate` 要的入参：Omit 掉由管理器生成的四个字段。 */
function templateInput(over: Partial<EnterpriseTemplate> = {}) {
  const full = makeTemplate(over);
  const { id: _id, version: _v, createdAt: _c, updatedAt: _u, ...rest } = full;
  return rest;
}

/** 一份启用的 MDM 配置（`syncTemplates` 需要 `getConfig()` 非空）。 */
function mdmConfig(over: Partial<MDMConfig> = {}): MDMConfig {
  return {
    enabled: true,
    organizationId: "org-1",
    organizationName: "Acme",
    deviceId: "device-test",
    deviceName: "Test Mac",
    serverUrl: "https://mdm.example.test",
    apiKey: "key-1",
    policies: [],
    restrictions: {
      disabledCategories: [],
      disabledActions: [],
      maxExecutionTime: 300,
      maxExecutionsPerDay: 1000,
      maxActionsPerShortcut: 100,
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
    syncInterval: 3600,
    lastSyncAt: 0,
    lastSyncStatus: "success",
    deviceStatus: "active",
    enrolledAt: 0,
    enrolledBy: "admin",
    version: "1.0.0",
    ...over,
  };
}

async function freshManager(seedFn?: () => void): Promise<TemplateManager> {
  if (seedFn) seedFn();
  const manager = new TemplateManager();
  await manager.initialize();
  return manager;
}

describe("TemplateManager 初始化与载入", () => {
  test("空存储：无模板，内置 8 个分类按 order 排序并落盘", async () => {
    const manager = await freshManager();

    expect(manager.getTemplates()).toEqual([]);
    expect(manager.getInstalledTemplates()).toEqual([]);

    const categories = manager.getCategories();
    expect(categories).toHaveLength(8);
    expect(categories.map((c) => c.id)).toEqual([
      "productivity",
      "communication",
      "automation",
      "reporting",
      "customer_service",
      "sales",
      "it_ops",
      "hr",
    ]);
    // 内置分类是**播种**的：第一次初始化要把它写进 store，否则下次又回落内置
    const persisted = stored<{ id: string }>(TEMPLATE_CATEGORIES_KEY);
    expect(persisted.map((c) => c.id)).toEqual(categories.map((c) => c.id));
  });

  test("已落盘的模板 / 安装记录 / 分类在 initialize 后可见", async () => {
    const t = makeTemplate({ id: "tpl-kept", name: "Kept" });
    const install: TemplateInstallation = {
      templateId: "tpl-kept",
      templateVersion: "1.0.0",
      shortcutId: "shortcut-x",
      installedAt: 5,
      installedBy: "user-1",
      parameterValues: {},
      status: "active",
      lastUpdateCheck: 5,
    };
    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [t]);
      seed(TEMPLATE_INSTALLATIONS_KEY, [install]);
      seed(TEMPLATE_CATEGORIES_KEY, [{ id: "custom", name: "自定义", description: "", icon: "?", order: 1 }]);
    });

    expect(manager.getTemplate("tpl-kept")?.name).toBe("Kept");
    expect(manager.getInstalledTemplates().map((i) => i.templateId)).toEqual(["tpl-kept"]);
    expect(manager.getCategories().map((c) => c.id)).toEqual(["custom"]);
  });

  test("损坏的载荷（不是合法 JSON）不抛，模板/安装记录回落为空、分类回落内置", async () => {
    const manager = await freshManager(() => {
      // readStoreValue 先解一层；内容仍是**不合法**的 JSON ⇒ 走模块自己的 catch
      memory.set(TEMPLATES_KEY, JSON.stringify("{ not json"));
      memory.set(TEMPLATE_INSTALLATIONS_KEY, JSON.stringify("{ not json"));
      memory.set(TEMPLATE_CATEGORIES_KEY, JSON.stringify("{ not json"));
    });

    expect(manager.getTemplates()).toEqual([]);
    expect(manager.getInstalledTemplates()).toEqual([]);
    expect(manager.getCategories()).toHaveLength(8);
  });
});


describe("TemplateManager 增删改查", () => {
  test("createTemplate 生成 id/版本/时间戳并落盘；getTemplate 找不到回 null", async () => {
    const manager = await freshManager();
    const created = manager.createTemplate(templateInput({ name: "New Tpl" }));

    expect(created.id.startsWith("tpl-")).toBe(true);
    expect(created.version).toBe("1.0.0");
    expect(created.createdAt).toBeGreaterThan(0);
    expect(manager.getTemplate(created.id)?.name).toBe("New Tpl");
    expect(stored<EnterpriseTemplate>(TEMPLATES_KEY).map((t) => t.id)).toEqual([created.id]);
    expect(manager.getTemplate("nope")).toBeNull();
  });

  test("getTemplates 只回已发布，且支持四个过滤条件与按 updatedAt 倒序", async () => {
    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [
        makeTemplate({ id: "old", name: "Alpha", description: "first", updatedAt: 10 }),
        makeTemplate({ id: "new", name: "Beta", description: "second", updatedAt: 99 }),
        makeTemplate({ id: "draft", name: "Alpha draft", publishStatus: "draft", updatedAt: 100 }),
        makeTemplate({ id: "other-dept", name: "Alpha ops", department: "ops", updatedAt: 50 }),
      ]);
    });

    // 默认只回已发布，按 updatedAt 倒序
    expect(manager.getTemplates().map((t) => t.id)).toEqual(["new", "other-dept", "old"]);
    // status 过滤在"只回已发布"之后 ⇒ 查 draft 是空集（记录这个语义，别让它悄悄变）
    expect(manager.getTemplates({ status: "draft" })).toEqual([]);
    expect(manager.getTemplates({ status: "published" }).map((t) => t.id)).toEqual([
      "new",
      "other-dept",
      "old",
    ]);
    expect(manager.getTemplates({ department: "ops" }).map((t) => t.id)).toEqual(["other-dept"]);
    expect(manager.getTemplates({ category: "productivity" })).toHaveLength(3);
    // search 只看 name/description，且大小写不敏感
    expect(manager.getTemplates({ search: "ALPHA" }).map((t) => t.id)).toEqual(["other-dept", "old"]);
    expect(manager.getTemplates({ search: "second" }).map((t) => t.id)).toEqual(["new"]);
    // 过滤条件可叠加
    expect(manager.getTemplates({ department: "ops", search: "alpha" }).map((t) => t.id)).toEqual([
      "other-dept",
    ]);
  });

  test("updateTemplate 递增 patch 版本、固定 id，并落盘；不存在回 null", async () => {
    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [makeTemplate({ id: "tpl-up", version: "2.3.4", name: "Before" })]);
    });

    const updated = manager.updateTemplate("tpl-up", { name: "After" });
    expect(updated?.id).toBe("tpl-up");
    expect(updated?.version).toBe("2.3.5");
    expect(updated?.name).toBe("After");
    expect(manager.getTemplate("tpl-up")?.version).toBe("2.3.5");
    expect(stored<EnterpriseTemplate>(TEMPLATES_KEY)[0]?.version).toBe("2.3.5");

    expect(manager.updateTemplate("missing", { name: "x" })).toBeNull();
  });

  test("deleteTemplate 存在回 true 并从存储移除；不存在回 false", async () => {
    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [makeTemplate({ id: "tpl-del" })]);
    });

    expect(manager.deleteTemplate("tpl-del")).toBe(true);
    expect(manager.getTemplate("tpl-del")).toBeNull();
    expect(stored<EnterpriseTemplate>(TEMPLATES_KEY)).toEqual([]);
    expect(manager.deleteTemplate("tpl-del")).toBe(false);
  });

  test("publishTemplate 设置 published + publishedAt；不存在回 null", async () => {
    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [makeTemplate({ id: "tpl-pub", publishStatus: "testing" })]);
    });

    const published = manager.publishTemplate("tpl-pub");
    expect(published?.publishStatus).toBe("published");
    expect(published?.publishedAt).toBeGreaterThan(0);
    expect(manager.getTemplates().map((t) => t.id)).toEqual(["tpl-pub"]);
    expect(manager.publishTemplate("missing")).toBeNull();
  });
});


describe("TemplateManager 参数校验（经 installTemplate 的真入口）", () => {
  const params = [
    {
      key: "who",
      name: "对象",
      type: "text" as const,
      defaultValue: "world",
      required: true,
      description: "",
      validation: { pattern: "^[a-z]+$", message: "只能小写字母" },
    },
    {
      key: "count",
      name: "次数",
      type: "number" as const,
      defaultValue: 1,
      required: false,
      description: "",
      validation: { min: 2, max: 5 },
    },
    { key: "loud", name: "响亮", type: "boolean" as const, defaultValue: false, required: false, description: "" },
    {
      key: "mode",
      name: "模式",
      type: "select" as const,
      defaultValue: "a",
      required: false,
      description: "",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    },
  ];

  async function managerWithParams() {
    return freshManager(() => {
      seed(TEMPLATES_KEY, [makeTemplate({ id: "tpl-p", parameters: params })]);
    });
  }

  test("必填缺失 / 空串 / 数字类型不符都会被拒，并指名参数", async () => {
    const manager = await managerWithParams();

    expect(await manager.installTemplate("tpl-p", {})).toEqual({
      success: false,
      message: '参数 "对象" 为必填项',
    });
    expect(await manager.installTemplate("tpl-p", { who: "" })).toEqual({
      success: false,
      message: '参数 "对象" 为必填项',
    });
    expect(await manager.installTemplate("tpl-p", { who: "ok", count: "3" })).toEqual({
      success: false,
      message: '参数 "次数" 必须为数字',
    });
  });

  test("布尔类型不符 / select 越界会被拒", async () => {
    const manager = await managerWithParams();

    expect(await manager.installTemplate("tpl-p", { who: "ok", loud: "yes" })).toEqual({
      success: false,
      message: '参数 "响亮" 必须为布尔值',
    });
    expect(await manager.installTemplate("tpl-p", { who: "ok", mode: "c" })).toEqual({
      success: false,
      message: '参数 "模式" 的值不在允许范围内',
    });
  });

  test("数值上下界与文本正则：越界/不匹配回自定义消息", async () => {
    const manager = await managerWithParams();

    expect(await manager.installTemplate("tpl-p", { who: "ok", count: 1 })).toEqual({
      success: false,
      message: '参数 "次数" 不能小于 2',
    });
    expect(await manager.installTemplate("tpl-p", { who: "ok", count: 6 })).toEqual({
      success: false,
      message: '参数 "次数" 不能大于 5',
    });
    expect(await manager.installTemplate("tpl-p", { who: "ABC" })).toEqual({
      success: false,
      message: "只能小写字母",
    });
    // 边界值通过
    const ok = await manager.installTemplate("tpl-p", { who: "ok", count: 5, loud: true, mode: "b" });
    expect(ok.success).toBe(true);
  });

  test("未定义的可选参数跳过校验（不会被当成类型错误）", async () => {
    const manager = await managerWithParams();
    const result = await manager.installTemplate("tpl-p", { who: "ok" });
    expect(result.success).toBe(true);
  });

  test("模板不存在：安装回失败，且不写安装记录", async () => {
    const manager = await freshManager();
    expect(await manager.installTemplate("ghost", {})).toEqual({
      success: false,
      message: "模板不存在",
    });
    expect(manager.getInstalledTemplates()).toEqual([]);
  });
});


describe("TemplateManager 安装 / 卸载 / 更新", () => {
  test("安装成功：写安装记录（active）+ 统计 +1 + 快捷键 id 是新生成的", async () => {
    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [makeTemplate({ id: "tpl-i" })]);
    });

    const result = await manager.installTemplate("tpl-i", {});
    expect(result.success).toBe(true);
    expect(result.shortcutId?.startsWith("shortcut-")).toBe(true);

    const installs = stored<TemplateInstallation>(TEMPLATE_INSTALLATIONS_KEY);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.templateId).toBe("tpl-i");
    expect(installs[0]?.status).toBe("active");
    expect(installs[0]?.installedBy).toBe("user-default");
    expect(manager.getTemplate("tpl-i")?.installedCount).toBe(1);
    expect(manager.getTemplate("tpl-i")?.successCount).toBe(1);
  });

  test("安装记录里的 installedBy 取 store 里的用户 id", async () => {
    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [makeTemplate({ id: "tpl-u" })]);
      // `amos.user.id` 是**普通字符串**：`writeJson` 只编码一层，所以这里也只播一层
      memory.set("amos.user.id", JSON.stringify("user-42"));
    });

    await manager.installTemplate("tpl-u", {});
    expect(stored<TemplateInstallation>(TEMPLATE_INSTALLATIONS_KEY)[0]?.installedBy).toBe("user-42");
  });

  test("uninstallTemplate：未安装 / 强制模板 / 正常卸载三条路径", async () => {
    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [
        makeTemplate({ id: "tpl-free" }),
        makeTemplate({ id: "tpl-forced", isForced: true }),
      ]);
    });

    expect(await manager.uninstallTemplate("tpl-free")).toEqual({
      success: false,
      message: "未安装此模板",
    });

    await manager.installTemplate("tpl-free", {});
    await manager.installTemplate("tpl-forced", {});

    expect(await manager.uninstallTemplate("tpl-forced")).toEqual({
      success: false,
      message: "强制模板不可卸载",
    });

    expect(await manager.uninstallTemplate("tpl-free")).toEqual({ success: true });
    // 只卸掉 tpl-free；强制模板仍在册
    expect(manager.getInstalledTemplates().map((i) => i.templateId)).toEqual(["tpl-forced"]);
    expect(
      stored<TemplateInstallation>(TEMPLATE_INSTALLATIONS_KEY).find((i) => i.templateId === "tpl-free")
        ?.status,
    ).toBe("uninstalled");
  });

  test("checkForUpdates：版本不同才标 outdated 并返回 id；相同/非 active 不动", async () => {
    const install = (
      templateId: string,
      templateVersion: string,
      status: TemplateInstallation["status"],
    ): TemplateInstallation => ({
      templateId,
      templateVersion,
      shortcutId: `shortcut-${templateId}`,
      installedAt: 1,
      installedBy: "u",
      parameterValues: {},
      status,
      lastUpdateCheck: 1,
    });

    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [
        makeTemplate({ id: "tpl-behind", version: "1.0.0" }),
        makeTemplate({ id: "tpl-current", version: "1.0.0" }),
        makeTemplate({ id: "tpl-uninstalled", version: "2.0.0" }),
      ]);
      seed(TEMPLATE_INSTALLATIONS_KEY, [
        install("tpl-behind", "0.9.0", "active"),
        install("tpl-current", "1.0.0", "active"),
        install("tpl-uninstalled", "1.0.0", "uninstalled"),
      ]);
    });

    expect(await manager.checkForUpdates()).toEqual(["tpl-behind"]);
    const records = stored<TemplateInstallation>(TEMPLATE_INSTALLATIONS_KEY);
    expect(records.find((i) => i.templateId === "tpl-behind")?.status).toBe("outdated");
    expect(records.find((i) => i.templateId === "tpl-current")?.status).toBe("active");
    expect(records.find((i) => i.templateId === "tpl-uninstalled")?.status).toBe("uninstalled");
  });

  test("updateInstalledTemplate：未安装 / 成功重装（统计累加）", async () => {
    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [makeTemplate({ id: "tpl-upd" })]);
    });

    expect(await manager.updateInstalledTemplate("tpl-upd")).toEqual({
      success: false,
      message: "未安装此模板",
    });

    await manager.installTemplate("tpl-upd", {});
    const again = await manager.updateInstalledTemplate("tpl-upd");
    expect(again.success).toBe(true);
    expect(manager.getTemplate("tpl-upd")?.installedCount).toBe(2);
  });
});


describe("TemplateManager 服务器同步", () => {
  test("MDM 未启用（无配置）时同步回失败，且不碰网络", async () => {
    const manager = await freshManager();
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof fetch;

    expect(await manager.syncTemplates()).toEqual({ success: false, count: 0, message: "MDM 未启用" });
    expect(called).toBe(false);
  });

  test("服务器 success=false：把服务器的 message 原样带回", async () => {
    const manager = await freshManager();
    mdmManager.setConfigForTest(mdmConfig());
    globalThis.fetch = (async () => ({
      json: async () => ({ success: false, message: "组织未授权" }),
    })) as unknown as typeof fetch;

    expect(await manager.syncTemplates()).toEqual({
      success: false,
      count: 0,
      message: "组织未授权",
    });
  });

  test("网络抛错：回失败并带上原因，不写任何模板", async () => {
    const manager = await freshManager();
    mdmManager.setConfigForTest(mdmConfig());
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(await manager.syncTemplates()).toEqual({
      success: false,
      count: 0,
      message: "network down",
    });
    expect(manager.getTemplates()).toEqual([]);
  });

  test("同步成功：写入模板并自动安装强制模板（用默认参数）", async () => {
    const manager = await freshManager();
    mdmManager.setConfigForTest(mdmConfig());
    const remote = makeTemplate({
      id: "tpl-remote",
      name: "Remote",
      isForced: true,
      parameters: [
        { key: "who", name: "对象", type: "text", defaultValue: "world", required: true, description: "" },
      ],
    });
    globalThis.fetch = (async () => ({
      json: async () => ({ success: true, templates: [remote] }),
    })) as unknown as typeof fetch;

    expect(await manager.syncTemplates()).toEqual({ success: true, count: 1 });
    expect(manager.getTemplate("tpl-remote")?.name).toBe("Remote");
    expect(manager.getInstalledTemplates().map((i) => i.templateId)).toEqual(["tpl-remote"]);
  });

  test("强制模板已 active 时不重复安装", async () => {
    const manager = await freshManager(() => {
      seed(TEMPLATES_KEY, [makeTemplate({ id: "tpl-remote", isForced: true })]);
      seed(TEMPLATE_INSTALLATIONS_KEY, [
        {
          templateId: "tpl-remote",
          templateVersion: "1.0.0",
          shortcutId: "shortcut-1",
          installedAt: 1,
          installedBy: "u",
          parameterValues: {},
          status: "active",
          lastUpdateCheck: 1,
        },
      ]);
    });
    mdmManager.setConfigForTest(mdmConfig());
    globalThis.fetch = (async () => ({
      json: async () => ({ success: true, templates: [] }),
    })) as unknown as typeof fetch;

    await manager.syncTemplates();
    expect(manager.getTemplate("tpl-remote")?.installedCount).toBe(0);
  });
});

describe("TemplateManager 占位符替换（applyParameters 是纯函数，直接钉）", () => {
  test("替换 {{key}}、保留未知占位符、处理数组与嵌套，且不改动原对象", async () => {
    const manager = await freshManager();
    const priv = manager as unknown as {
      applyParameters(shortcutData: Shortcut, values: Record<string, unknown>): Shortcut;
    };

    const source = shortcut({
      name: "Hello {{who}}",
      tags: ["{{city}}", "static"],
      actions: [
        {
          id: "a1",
          actionTypeId: "web.open",
          parameters: { url: "https://x/{{who}}", nested: { deep: "{{city}}" }, unknown: "{{missing}}" },
          position: 0,
        },
      ],
    });

    const applied = priv.applyParameters(source, { who: "world", city: "paris" });
    expect(applied.name).toBe("Hello world");
    expect(applied.tags).toEqual(["paris", "static"]);
    expect(applied.actions[0]?.parameters.url).toBe("https://x/world");
    expect((applied.actions[0]?.parameters.nested as { deep: string }).deep).toBe("paris");
    // 未知占位符**原样保留**（不是替换成空串，也不是 undefined）
    expect(applied.actions[0]?.parameters.unknown).toBe("{{missing}}");
    // 深拷贝：原对象一个字都没变
    expect(source.name).toBe("Hello {{who}}");
    expect(source.tags).toEqual(["{{city}}", "static"]);
  });
});

