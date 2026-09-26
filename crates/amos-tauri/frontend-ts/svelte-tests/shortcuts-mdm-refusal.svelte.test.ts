/**
 * shortcuts-mdm-refusal.svelte.test.ts — MDM 说「不行」的时候，用户在屏幕上看得见吗（REQ-A837）
 *
 * 为什么这个文件存在：`updateShortcut()` / `deleteShortcut()` 被 MDM 拦下时只返回 `false`
 * —— 理由留在它们自己的 `logger.error` 里。而 `ShortcutsApp.svelte` 里**每一处**调用点
 * 原先都是 `if (updateShortcut(...)) { … }`：**没有 else，没有任何提示**（对 HEAD 实测：
 * 9 处调用、0 处 else）。于是管理员勾上「禁止修改」之后，用户改名字、换图标、描述、
 * 加触发器、切分享开关 —— 点下去屏幕毫无反应，指令也没变，用户分不清是「没保存上」
 * 还是「不让改」。同一个限制面里**创建**那条路却说了话（`alert(t("shortcuts.createFailed"))`）：
 * 三条同类路径，两条不说。
 *
 * 同一个缺陷面还有第二半：面板上的「允许分享」与「分享需审批」两个开关**只**被
 * `mdmManager.checkPermission("share")` 读，而那个分支**没有任何调用者** —— 开关是装饰。
 * 本轮把它的生产调用点落在编辑器的分享开关上。
 *
 * 判据是这个家族一贯的那个：**不看内部状态，看屏幕上出现了什么**，同时问一句
 * 「模型里的东西是不是真的没被改」。两条都要成立 —— 只说不改是"说了但没拦"，
 * 只改不说就是本条要修的那个静默。
 *
 * 负控（实测四条，逐字节还原 + `shasum -a 256` =
 * `a67b93f3e2d3a6663ea40bf164290f751a1dc1127f880e5f3124c98b0e139b93`）：
 * ①渲染守卫 `{#if mutationNote}` 改 `{#if false}` ⇒ 6 条红；②删掉 modify 调用点的赋值
 * ⇒ 3 条红；③删掉 delete `else` 里的赋值 ⇒ 1 条红；④删掉 share 的拒绝块 ⇒ 2 条红。
 * 每条控制**只打到自己的断言**，而「模型没被改」那几条**两侧都绿** ——
 * 它们历来就绿：静默失败在模型侧是对的，错的只是没人说。
 *
 * 诚实边界：①面板上的「允许导出」「允许导入」两个开关**没有可修之处** —— HEAD 上这个
 * 应用根本没有导出／导入功能，那两条分支没有可挂的生产路径（登记为边界，非漏修）；
 * ②`shortcuts.mutationBlocked` / `updateFailed` / `deleteFailed` 三句兜底文案
 * **本文件走不到**（MDM 拒绝时 `verdict.reason` 总有值），它们是诚实兜底而非被验证的路径。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShortcutsApp from "../src/svelte/ShortcutsApp.svelte";
import { loadShortcuts, saveShortcuts, type Shortcut } from "../src/lib/shortcuts";
import { mdmManager, type MDMConfig } from "../src/lib/enterprise/mdm";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const seedShortcut = (quickActions: string[] = []): Shortcut => ({
  id: "sc-seed",
  name: "收藏文章",
  icon: "⚡",
  color: "#007AFF",
  description: "",
  actions: [],
  quickActions,
  triggers: [],
  createdAt: 0,
  updatedAt: 0,
  runCount: 0,
  runOnLockScreen: false,
  requiresConfirmation: false,
  tags: [],
});

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

beforeEach(() => {
  setLocale("zh");
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  saveShortcuts([seedShortcut()]);
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

const stored = () => loadShortcuts()[0]!;

/** 屏幕上的那句话（没有就是空串）。 */
const refusal = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="shortcut-mutation-note"]')?.textContent?.trim() ??
  "";

async function openEditor(host: { container: HTMLElement }) {
  const edit = [...host.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === zh["shortcuts.edit"],
  ) as HTMLButtonElement | undefined;
  expect(edit).toBeTruthy();
  await fireEvent.click(edit!);
  await settle();
}

/** 编辑器里的名字框（按 `label[for]` 找，不用位置猜）。 */
const nameInput = (container: HTMLElement): HTMLInputElement => {
  const label = [...container.querySelectorAll("label")].find(
    (l) => l.textContent?.trim() === zh["shortcuts.name"],
  );
  expect(label).toBeTruthy();
  return container.querySelector<HTMLInputElement>(`#${label!.getAttribute("for")}`)!;
};

const toggle = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[data-testid="shortcut-share-sheet-toggle"]')!;

describe("REQ-A837: MDM 拒绝写操作时，屏幕上必须有一句话", () => {
  test("禁止修改 ⇒ 改名字被拒：说出管理员的理由，且**名字真的没改**", async () => {
    mdmManager.setConfigForTest(mdmConfig({ allowUserModify: false }));
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);
    expect(refusal(host.container)).toBe(""); // 还没操作过，屏幕是干净的

    const input = nameInput(host.container);
    input.value = "改个名字";
    await fireEvent.input(input);
    await settle();

    // ① 屏幕说了话，而且用的是 MDM 自己的理由（不是另写一句文案）。
    expect(refusal(host.container)).toBe("管理员已禁止修改快捷指令");
    // ② 模型侧真的没被改 —— 只说不拦、或只拦不说，都过不了这一条。
    expect(stored().name).toBe("收藏文章");
  });

  test("禁止修改 ⇒ 改描述同样被拒并说出来（不是只有名字那一格）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ allowUserModify: false }));
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);

    const label = [...host.container.querySelectorAll("label")].find(
      (l) => l.textContent?.trim() === zh["shortcuts.description"],
    );
    expect(label).toBeTruthy();
    const input = host.container.querySelector<HTMLInputElement>(
      `#${label!.getAttribute("for")}`,
    )!;
    input.value = "新描述";
    await fireEvent.input(input);
    await settle();

    expect(refusal(host.container)).toBe("管理员已禁止修改快捷指令");
    expect(stored().description).toBe("");
  });

  /**
   * 删除**不**走 `openEditor`：`handleDelete` 的唯一调用点是列表卡片上的那个按钮，
   * 编辑器里（`shortcut.actions` 每一项的 ×）用的是另一个处理函数 `handleRemoveAction`。
   * 这条正是前一次实现漏掉的那一格 —— 读数只渲染在编辑器内部时，删除被拒的那句话
   * **没有渲染点**，测试连按钮都找不到。
   */
  test("禁止删除 ⇒ 在列表里确认之后指令还在，且屏幕说出理由（原先什么都不发生）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ allowUserDelete: false }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const host = render(ShortcutsApp);
    await settle();

    const del = [...host.container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === zh["shortcuts.delete"],
    ) as HTMLButtonElement | undefined;
    expect(del).toBeTruthy();
    await fireEvent.click(del!);
    await settle();

    expect(refusal(host.container)).toBe("管理员已禁止删除快捷指令");
    expect(loadShortcuts()).toHaveLength(1); // 还在
    expect(loadShortcuts()[0]!.id).toBe("sc-seed");
  });

  test("禁止分享 ⇒ 打开分享开关被拒：说出理由，quickActions 不变", async () => {
    mdmManager.setConfigForTest(mdmConfig({ allowSharing: false }));
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);

    await fireEvent.click(toggle(host.container));
    await settle();

    expect(refusal(host.container)).toBe("管理员已禁止分享快捷指令");
    expect(stored().quickActions).toEqual([]);
    expect(toggle(host.container).getAttribute("aria-checked")).toBe("false");
  });

  test("分享需审批 ⇒ 同一句话里说清是「审批」而不是「禁止」", async () => {
    mdmManager.setConfigForTest(mdmConfig({ requireApprovalForSharing: true }));
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);

    await fireEvent.click(toggle(host.container));
    await settle();

    expect(refusal(host.container)).toBe("分享快捷指令需要管理员审批");
    expect(stored().quickActions).toEqual([]);
  });

  /**
   * 极性：同一个开关的两个方向**不由开关自己决定**。禁止分享之后再拦「取消分享」，
   * 等于把已经分享出去的指令永久钉在那里 —— 限制的方向是收紧可见性，而撤回分享
   * 本身就是收紧。拦它是在朝危险的一侧失败。
   */
  test("禁止分享 ⇒ 但**撤回**分享不被拦（限制只朝收紧的一侧）", async () => {
    saveShortcuts([seedShortcut(["shareSheet"])]);
    mdmManager.setConfigForTest(mdmConfig({ allowSharing: false }));
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);
    expect(toggle(host.container).getAttribute("aria-checked")).toBe("true");

    await fireEvent.click(toggle(host.container));
    await settle();

    expect(refusal(host.container)).toBe(""); // 没有拒绝
    expect(stored().quickActions).toEqual([]); // 而且真的撤下了
  });

  test("改成功了 ⇒ 上一次的拒绝读数消失（不是一条只会亮不会灭的灯）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ allowUserModify: false }));
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);

    const input = nameInput(host.container);
    input.value = "改不动";
    await fireEvent.input(input);
    await settle();
    expect(refusal(host.container)).not.toBe("");

    // 管理员放开了修改权限，再改一次 ⇒ 提示必须消失。
    mdmManager.setConfigForTest(mdmConfig());
    input.value = "这回可以";
    await fireEvent.input(input);
    await settle();

    expect(refusal(host.container)).toBe("");
    expect(stored().name).toBe("这回可以");
  });

  test("MDM 关闭 ⇒ 没有任何拒绝读数，改名字照常生效（补集）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ allowUserModify: false }, false));
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);

    const input = nameInput(host.container);
    input.value = "没有 MDM";
    await fireEvent.input(input);
    await settle();

    expect(refusal(host.container)).toBe("");
    expect(stored().name).toBe("没有 MDM");
  });
});
