/**
 * template-library-catalogue.svelte.test.ts — 模板库「目录从哪来、装了几次」的门（REQ-A1320）。
 *
 * 为什么是这两条：
 *
 * ① **目录从哪来**。`TemplateManager` 是四件套里最后一个没有 `ensureInitialized()` 的成员：
 *    `mdm.ts` 有（REQ-A945）、`webhooks.ts` 有（REQ-A980）、`audit.ts` 与 `api.ts` 有
 *    （REQ-A982 / FMEA F-SH-309 —— **那一行把 `templates.ts` 写进了自己的 `files`，
 *    却没有真的改它**）。它唯一的引导入口 `initialize()` 只被
 *    `enterprise/index.ts::initializeEnterprise()` 调用 —— 那个函数在生产里**零调用者**
 *    （`SettingsApp.svelte:576` 渲染的 `EnterprisePage` 是真正的入口）。于是 `loadTemplates()`
 *    从来没有在设备上跑过，`this.templates` 恒空 ⇒ 面板永远画空态，用户落盘的模板一条都看不到。
 *
 * ② **装了几次**。面板唯一那条统计（`templates.installCount`）来自 `getInstallCount()`，
 *    一个 `return 0` 的桩；而真正维护着的 `template.installedCount` 就挂在同一个被渲染的
 *    对象上。①修好之后这条就从"看不见"变成"看得见的谎"。
 *
 * 所以这里**故意不调用 `initialize()`** —— 生产调用链里没人调它，测试也不许调；
 * 播种落盘、直接挂载面板，若面板读得出目录，那只可能是管理器的读写路径自己起来了。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import TemplateLibrary from "../src/svelte/modules/TemplateLibrary.svelte";
import {
  templateManager,
  TEMPLATES_KEY,
  TEMPLATE_INSTALLATIONS_KEY,
  type EnterpriseTemplate,
} from "../src/lib/enterprise/templates";
import { SHORTCUTS_KEY } from "../src/lib/shortcuts";
import { mdmManager, type MDMConfig } from "../src/lib/enterprise/mdm";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

/**
 * 按模块自己的读法播种：`saveTemplates()` 写 `JSON.stringify(payload)`，而
 * `writeStoreValueChecked` 的 `writeJson` 再 stringify 一次 ⇒ localStorage 里是
 * 「一个 JSON 字符串字面量，内容是 JSON」。`loadTemplates()` 先 `JSON.parse` 出字符串、
 * 再 `JSON.parse` 一次，所以要复刻这层双层编码。
 */
function seedTemplates(templates: EnterpriseTemplate[]): void {
  window.localStorage.setItem(TEMPLATES_KEY, JSON.stringify(JSON.stringify(templates)));
}

function template(overrides: Partial<EnterpriseTemplate> = {}): EnterpriseTemplate {
  return {
    id: "tpl-seed",
    name: "周报助手",
    description: "一键生成本周周报",
    category: "生产力",
    department: "全员",
    icon: "📝",
    color: "#3366ff",
    version: "1.0.0",
    shortcutData: {
      id: "sc-seed",
      name: "周报助手",
      icon: "star",
      color: "#111111",
      description: "seed shortcut",
      actions: [],
      quickActions: [],
      triggers: [],
      createdAt: 0,
      updatedAt: 0,
      runCount: 0,
    },
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
    organizationId: "org-seed",
    createdBy: "admin",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** `t("templates.installCount", { count })` 的期望值，从当前词典取。 */
function installCountText(count: number): string {
  return zh["templates.installCount"].replace("{count}", String(count));
}

/** 按模块自己的读法播一条安装记录（`saveInstallations` 的双层编码）。 */
function seedInstallation(templateId: string, status: string, shortcutId = `sc-${templateId}`): void {
  window.localStorage.setItem(
    TEMPLATE_INSTALLATIONS_KEY,
    JSON.stringify(
      JSON.stringify([
        {
          templateId,
          templateVersion: "1.0.0",
          shortcutId,
          installedAt: 1,
          installedBy: "unattributed",
          parameterValues: {},
          status,
          lastUpdateCheck: 1,
        },
      ]),
    ),
  );
}

/** 直接往 `amos.shortcuts` 里播一条快捷指令（`saveShortcuts` 的双层编码）。 */
function seedShortcut(id: string): void {
  window.localStorage.setItem(
    SHORTCUTS_KEY,
    JSON.stringify(JSON.stringify([{ id, name: "已装指令", actions: [], quickActions: [], triggers: [], tags: [] }])),
  );
}

let alertCalls: string[] = [];

beforeEach(() => {
  templateManager.resetForTest();
  alertCalls = [];
  vi.stubGlobal("alert", (msg: string) => {
    alertCalls.push(String(msg));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  setLocale("zh");
  window.localStorage.clear();
  templateManager.resetForTest();
  // 本文件里只有 REQ-A1528 那组会注入 MDM 配置；不在这里清掉就会漏给后面的用例
  // （`checkCanDelete` 会在别的安装用例里开始拒绝）。
  mdmManager.clearConfigForTest();
});

describe("模板库：目录靠自己起来（REQ-A1320）", () => {
  test("没人调 initialize()，落盘的已发布模板也要出现在网格里", () => {
    seedTemplates([template({ id: "tpl-a", name: "周报助手" })]);

    const { container } = render(TemplateLibrary);

    const text = container.textContent ?? "";
    expect(text).not.toContain(zh["templates.emptyTitle"]);
    expect(container.querySelectorAll(".template-card")).toHaveLength(1);
    expect(text).toContain("周报助手");
  });

  test("安装记录也一起读回来 —— 面板挂载就是那条触发路径", () => {
    seedTemplates([template({ id: "tpl-b", name: "差旅报销" })]);
    window.localStorage.setItem(
      TEMPLATE_INSTALLATIONS_KEY,
      JSON.stringify(
        JSON.stringify([
          {
            templateId: "tpl-b",
            templateVersion: "1.0.0",
            shortcutId: "sc-b",
            installedAt: 1,
            installedBy: "unattributed",
            parameterValues: {},
            status: "active",
            lastUpdateCheck: 1,
          },
        ]),
      ),
    );

    render(TemplateLibrary);

    expect(templateManager.getInstalledTemplates()).toHaveLength(1);
    expect(templateManager.getInstalledTemplates()[0]?.templateId).toBe("tpl-b");
  });
});

describe("模板库：卡片与详情打印的是真安装数（REQ-A1320）", () => {
  test("卡片上的安装次数等于模板自己维护的 installedCount", () => {
    seedTemplates([template({ id: "tpl-c", name: "客户跟进", installedCount: 7 })]);

    const { container } = render(TemplateLibrary);

    const text = container.textContent ?? "";
    expect(text).toContain(installCountText(7));
    expect(text).not.toContain(installCountText(0));
  });

  test("详情里打印的也是真值，不是 0", async () => {
    seedTemplates([template({ id: "tpl-d", name: "入职引导", installedCount: 3 })]);

    const { container } = render(TemplateLibrary);

    const card = container.querySelector(".template-card") as HTMLButtonElement;
    card.click();
    await tick();

    const modal = container.querySelector(".modal-content");
    expect(modal).not.toBeNull();
    // 详情那一行是「标签 + 裸数字」，与卡片那句 `{count} 次安装` 不是同一条文案。
    const countRow = Array.from(modal!.querySelectorAll(".info-row")).find(r =>
      (r.querySelector(".info-label")?.textContent ?? "").includes(zh["templates.installCountLabel"]),
    );
    expect(countRow?.querySelector(".info-value")?.textContent?.trim()).toBe("3");
  });

  test("装一次之后，卡片上的次数跟着 +1", async () => {
    seedTemplates([template({ id: "tpl-e", name: "会议室预定", installedCount: 2 })]);

    const { container } = render(TemplateLibrary);
    expect(container.textContent ?? "").toContain(installCountText(2));

    const card = container.querySelector(".template-card") as HTMLButtonElement;
    card.click();
    await tick();

    const installBtn = container.querySelector(".modal-footer .btn-primary") as HTMLButtonElement;
    expect(installBtn).not.toBeNull();
    installBtn.click();

    // 装成功了才算数：库里真的多了一条安装记录，计数也落盘了。
    await vi.waitFor(() => {
      expect(templateManager.getInstalledTemplates()).toHaveLength(1);
      expect(templateManager.getTemplate("tpl-e")?.installedCount).toBe(3);
    });
    expect(alertCalls).toHaveLength(1);

    // 面板上那行次数跟着动 —— 「刷新列表以更新安装数量」这句注释说的是这件事。
    await vi.waitFor(() => {
      const text = container.textContent ?? "";
      expect(text).toContain(installCountText(3));
      expect(text).not.toContain(installCountText(2));
    });
  });
});

describe("模板库：「已安装」由安装记录说了算，且装得上就卸得掉（REQ-A1326）", () => {
  test("有 active 的安装记录 ⇒ 卡片上有「已安装」徽标", () => {
    seedTemplates([template({ id: "tpl-inst" })]);
    seedInstallation("tpl-inst", "active");

    const { container } = render(TemplateLibrary);

    const badge = container.querySelector(".badge-installed");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe(zh["templates.badgeInstalled"]);
  });

  test("记录已被卸载（status: uninstalled）⇒ 徽标不亮：判的是状态，不是「有没有这一行」", () => {
    seedTemplates([template({ id: "tpl-gone" })]);
    seedInstallation("tpl-gone", "uninstalled");

    const { container } = render(TemplateLibrary);

    expect(container.querySelector(".badge-installed")).toBeNull();
  });

  test("卸得掉：详情里的「卸载模板」把记录标成 uninstalled，并把那条快捷指令删掉", async () => {
    seedTemplates([template({ id: "tpl-both" })]);
    seedInstallation("tpl-both", "active", "sc-both");
    seedShortcut("sc-both");

    const { container } = render(TemplateLibrary);
    (container.querySelector(".template-card") as HTMLButtonElement).click();
    await tick();

    const uninstall = container.querySelector(".modal-footer .btn-uninstall") as HTMLButtonElement;
    expect(uninstall).not.toBeNull();
    expect(uninstall.textContent).toBe(zh["templates.uninstall"]);

    uninstall.click();
    await vi.waitFor(() => {
      expect(templateManager.getInstalledTemplates()).toHaveLength(0);
    });
    // 真的删了：快捷指令库里那条不见了（不是只把安装记录改了个状态）。
    const raw = window.localStorage.getItem(SHORTCUTS_KEY);
    expect(raw === null || !raw.includes("sc-both")).toBe(true);
  });
});

/**
 * REQ-A1528 ∕ F-SH-771 —— 重装收不掉旧指令时，那句回执必须说出库里多了一条。
 *
 * 这一条是**渲染侧**的一半：`templates.ts::installTemplate` 现在把没能收掉的那条
 * (`leftoverShortcutId`) 带回来，但只带回来而不画出来，就是一枚"没人读的字段" ——
 * 用户看到的仍是一句干净的「模板安装成功」。所以这里驱动的是面板自己的按钮，
 * 断言的是那句 `alert` 的内容：策略禁止删除、允许创建时，重装出来的两条同名指令
 * 必须在提示里被点出来。
 */
describe("模板库：重装收不掉旧指令时那句回执要说实话（REQ-A1528 ∕ F-SH-771）", () => {
  /** 一份启用的 MDM 配置：`allowUserCreate: true` + `allowUserDelete: false`（只禁一半）。 */
  function mdmConfig(): MDMConfig {
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
        allowUserDelete: false,
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
    };
  }

  test("策略禁止删除时重装：提示点出库里多了一条，而不是干干净净的「安装成功」", async () => {
    seedTemplates([template({ id: "tpl-dup", name: "重复项" })]);
    seedInstallation("tpl-dup", "active", "sc-old");
    seedShortcut("sc-old");
    mdmManager.setConfigForTest(mdmConfig());

    const { container } = render(TemplateLibrary);
    (container.querySelector(".template-card") as HTMLButtonElement).click();
    await tick();

    (container.querySelector(".modal-footer .btn-primary") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(alertCalls).toHaveLength(1);
    });

    // 旧的被策略挡住、删不掉 ⇒ 库里两条同名指令都还在（这条本身就是缺陷的现场）。
    expect(templateManager.getInstalledTemplates()).toHaveLength(1);
    const raw = window.localStorage.getItem(SHORTCUTS_KEY) ?? "";
    expect(raw).toContain("sc-old");

    // 回执说的必须是那一句，不是「模板安装成功」。旧的那条收不掉，就谈不上一次干净的安装。
    expect(alertCalls[0]).toBe(zh["templates.installSuccessLeftover"]);
  });

  test("对照组：策略放行时重装照样一句「安装成功」——那句提示不是恒定输出", async () => {
    seedTemplates([template({ id: "tpl-one", name: "单项" })]);
    seedInstallation("tpl-one", "active", "sc-prev");
    seedShortcut("sc-prev");

    const { container } = render(TemplateLibrary);
    (container.querySelector(".template-card") as HTMLButtonElement).click();
    await tick();

    (container.querySelector(".modal-footer .btn-primary") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(alertCalls).toHaveLength(1);
    });

    // 旧的那条真的收掉了，库里只剩新的那条。
    const raw = window.localStorage.getItem(SHORTCUTS_KEY) ?? "";
    expect(raw).not.toContain("sc-prev");
    expect(alertCalls[0]).toContain("模板安装成功");
  });
});
