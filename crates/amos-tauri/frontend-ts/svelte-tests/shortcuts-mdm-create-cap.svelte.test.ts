/**
 * shortcuts-mdm-create-cap.svelte.test.ts — MDM 的「每用户快捷指令数」真的读到用户身上了吗（REQ-A842）
 *
 * 为什么这个文件存在：`maxShortcutsPerUser` 被声明、有默认值 100、服务端能下发、
 * `MDMPanel.svelte` 上有一个**诚实的**数字框（`readBoundedInt` 有界、超界会挂读数、
 * `min=1 / max=1000`）、`getPolicy("maxShortcutsPerUser")` 能取回 —— 而全仓**没有一处读它**。
 * 唯一的关卡是本应用自己的常量 `LIMITS.MAX_SHORTCUTS`（1000）。管理员把上限设成 1，
 * 用户照样能建到 1000。这条策略是**装饰**。
 *
 * 修法的两个要点：
 *   ① `checkCanCreate(currentCount)` 的计数参数是**必填**的。可选参数等于给下一个调用点
 *      留一条「忘了传就静默不设限」的路，而这条限制的整个缺陷就是"没人读" ——
 *      必填 ⇒ 漏传是编译错误（实测：改完之后 4 个测试调用点当场 tsc 报错），不是安全洞。
 *   ② 拒绝要**说出来**，而且是**管理员那句话**。`createShortcut()` 失败只返回 `null`，
 *      于是三种不同的失败（禁止创建 / 上限已满 / 名字不合法）在屏幕上本来是同一句
 *      「创建失败」—— 与上一轮 REQ-A837 同一个形状，只是换了一条路径。
 *
 * 判据不看 `mdmManager` 内部状态，看**屏幕上出现了哪一句话**，同时问一句
 * 「那条指令是不是真的没被建出来」。两条都要成立。
 *
 * 诚实边界：新建走的是**模态**，它盖住内容区 —— 所以这里用 `alert`（与"请输入名称"
 * 同一条路），而不是 `mutationNote` 那条横幅：横幅在模态后面，用户看不见。
 * 这是上一轮（REQ-A837）踩过的坑，这里按同一个判据选渲染点。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShortcutsApp from "../src/svelte/ShortcutsApp.svelte";
import { loadShortcuts, saveShortcuts, type Shortcut } from "../src/lib/shortcuts";
import { GALLERY_TEMPLATES } from "../src/lib/shortcutGallery";
import { mdmManager, type MDMConfig } from "../src/lib/enterprise/mdm";
import { zh } from "../src/i18n/locales/zh";

const seed = (n: number): Shortcut[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `sc-${i}`,
    name: `第 ${i} 条`,
    icon: "⚡",
    color: "#007AFF",
    description: "",
    actions: [],
    quickActions: [],
    triggers: [],
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    runOnLockScreen: false,
    requiresConfirmation: false,
    tags: [],
  }));

function mdmConfig(
  restrictions: Partial<MDMConfig["restrictions"]> = {},
  enabled = true,
): MDMConfig {
  return {
    enabled,
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
      ...restrictions,
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

let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mdmManager.clearConfigForTest();
  mdmManager.stopAutoSync();
  mdmManager.shutdown();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 打开新建模态：工具栏上那枚按钮。 */
async function openCreateModal(host: { getByRole: (r: string, o: object) => HTMLElement }) {
  await fireEvent.click(host.getByRole("button", { name: zh["shortcuts.newButton"] }));
  await settle();
}

/** 在模态里填名字并点「创建」。 */
async function submitCreate(container: HTMLElement, name: string) {
  const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
  const input = dialog.querySelector<HTMLInputElement>("input[type=text]")!;
  input.value = name;
  await fireEvent.input(input);
  const create = [...dialog.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === zh["shortcuts.create"],
  ) as HTMLButtonElement;
  expect(create).toBeTruthy();
  await fireEvent.click(create);
  await settle();
}

async function openGallery(host: { container: HTMLElement }) {
  const btn = [...host.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(zh["shortcuts.gallery"]),
  ) as HTMLButtonElement;
  expect(btn).toBeTruthy();
  await fireEvent.click(btn);
  await settle();
}

describe("REQ-A842: MDM 的每用户快捷指令上限必须被真的读到", () => {
  test("上限已满 ⇒ 屏幕报的是**管理员那句话**（带上限数字），而不是「创建失败」", async () => {
    saveShortcuts(seed(2));
    mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: 2 }));
    const host = render(ShortcutsApp);
    await settle();

    await openCreateModal(host);
    await submitCreate(host.container, "第三条");

    expect(alertSpy).toHaveBeenCalledWith("每用户快捷指令数已达上限（2）");
    expect(alertSpy).not.toHaveBeenCalledWith(zh["shortcuts.createFailed"]);
    // 而且真的没被建出来。
    expect(loadShortcuts()).toHaveLength(2);
  });

  test("还没到上限 ⇒ 建得成，且没有拒绝读数（补集：别把限制拦得过紧）", async () => {
    saveShortcuts(seed(1));
    mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: 2 }));
    const host = render(ShortcutsApp);
    await settle();

    await openCreateModal(host);
    await submitCreate(host.container, "第二条");

    expect(alertSpy).not.toHaveBeenCalled();
    expect(loadShortcuts()).toHaveLength(2);
    expect(loadShortcuts().some((s) => s.name === "第二条")).toBe(true);
  });

  test("MDM 关闭 ⇒ 上限不生效，照常建得成（补集）", async () => {
    saveShortcuts(seed(3));
    mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: 1 }, false));
    const host = render(ShortcutsApp);
    await settle();

    await openCreateModal(host);
    await submitCreate(host.container, "没有 MDM");

    expect(alertSpy).not.toHaveBeenCalled();
    expect(loadShortcuts()).toHaveLength(4);
  });

  /**
   * 判别用例：**同一句话必须来自同一批判判**。被「禁止创建」拦下时，
   * 屏幕要报禁止创建那句，而不是把上限那句硬编码上去 —— 否则修法只是换了
   * 一句更具体的假话。
   */
  test("被「禁止创建」拦下 ⇒ 报的是禁止那句，不是上限那句（判词来自同一批判判）", async () => {
    saveShortcuts(seed(0));
    mdmManager.setConfigForTest(
      mdmConfig({ allowUserCreate: false, maxShortcutsPerUser: 100 }),
    );
    const host = render(ShortcutsApp);
    await settle();

    await openCreateModal(host);
    await submitCreate(host.container, "不准建");

    expect(alertSpy).toHaveBeenCalledWith("管理员已禁止创建快捷指令");
    expect(loadShortcuts()).toHaveLength(0);
  });

  test("库视图安装模板被上限拦下 ⇒ 库里那句话是管理员的理由（同一条路，同一个判据）", async () => {
    saveShortcuts(seed(2));
    mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: 2 }));
    const host = render(ShortcutsApp);
    await settle();
    await openGallery(host);

    const add = host.container.querySelector<HTMLButtonElement>(
      `[data-testid="gallery-add-${GALLERY_TEMPLATES[0]!.id}"]`,
    );
    expect(add).toBeTruthy();
    await fireEvent.click(add!);
    await settle();

    const note = host.container.querySelector<HTMLElement>('[data-testid="gallery-note"]');
    expect(note?.textContent?.trim()).toBe("每用户快捷指令数已达上限（2）");
    expect(loadShortcuts()).toHaveLength(2);
  });
});
