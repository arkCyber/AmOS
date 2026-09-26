/**
 * shortcuts-app-picker.svelte.test.ts — 快捷指令编辑器里的「应用」选择器 (REQ-A1190 / F-SH-482).
 *
 * 先证后修：加一条「打开 App」操作后，`open_app` 的 `app` 参数是 **required**、类型
 * `app`，而参数渲染分支只处理 text/number/select —— 界面上一个控件都没有
 * （`parameters` 恒为 `{}`），该步骤执行时必然抛「打开 App 需要应用标识」。
 * 同时在**唯一**存在的应用选择器（应用触发器的下拉）里只列 `APP_META`，于是
 * 「当某个已安装商店应用打开时」这条自动化编不出来 —— 而运行时 `triggerMatches`
 * 的 `app` 分支只是字符串相等，对 `store:<manifest.id>` 一视同仁（门比屋窄）。
 *
 * 修法：补上 `param.type === "app"` 分支，并让两处选择器都走同一份来源
 * （`APP_META` + 壳推送/缓存里的商店瓷砖）。本文件钉住三件事：
 *   1. 必填的 app 参数**真的有控件**，且能选中一个已安装的商店应用并落盘；
 *   2. 应用触发器的下拉含已安装商店应用，选中后 `config.appId` 落盘、
 *      行摘要显示它的**名字**而不是裸 wire id；
 *   3. 选择器对「装完应用」是**活**的：挂载后再 poke 一次即出现新选项。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShortcutsApp from "../src/svelte/ShortcutsApp.svelte";
import { loadShortcuts, saveShortcuts, type Shortcut } from "../src/lib/shortcuts";
import {
  notifyStoreTilesChanged,
  setStoreTiles,
  type StoreTile,
} from "../src/lib/storeApps";
import { zh } from "../src/i18n/locales/zh";

const seedShortcut = (): Shortcut => ({
  id: "sc-seed",
  name: "每天早上",
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
});

const DEMO: StoreTile = { id: "store:org.amos.demo", mid: "org.amos.demo", name: "Demo", icon: "D" };
const POMO: StoreTile = { id: "store:org.amos.pomodoro", mid: "org.amos.pomodoro", name: "Pomodoro", icon: "P" };

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  saveShortcuts([seedShortcut()]);
  setStoreTiles([DEMO]);
});
afterEach(() => {
  cleanup();
  setStoreTiles([]);
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const byText = (host: { container: HTMLElement }, sel: string, text: string) =>
  [...host.container.querySelectorAll(sel)].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;

/** 打开种子指令的编辑器（列表行的 ✏️ 按钮）。 */
async function openEditor(host: { container: HTMLElement }) {
  const edit = [...host.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === zh["shortcuts.edit"],
  ) as HTMLButtonElement | undefined;
  expect(edit, "编辑器入口必须存在").toBeTruthy();
  await fireEvent.click(edit!);
  await settle();
}

/** 加一条内置操作（按操作名文本）。 */
async function addAction(host: { container: HTMLElement }, name: string) {
  await fireEvent.click(byText(host, "button", zh["shortcuts.addActionButton"])!);
  await settle();
  await fireEvent.click(byText(host, "button", name)!);
  await settle();
}

/** 加一个触发器类型（按目录里的类型按钮）。 */
async function addTrigger(host: { container: HTMLElement }, type: string) {
  await fireEvent.click(host.container.querySelector('[data-testid="trigger-add"]') as HTMLButtonElement);
  await settle();
  await fireEvent.click(
    host.container.querySelector(`[data-testid="trigger-option-${type}"]`) as HTMLButtonElement,
  );
  await settle();
}

describe("REQ-A1190: 快捷指令编辑器的应用选择器", () => {
  test("「打开 App」的必填 app 参数真的有控件，且能选中已安装的商店应用", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);
    await addAction(host, "打开 App");

    const made = loadShortcuts()[0]!;
    expect(made.actions.length, "操作必须真的加上了").toBe(1);
    const actionId = made.actions[0]!.id;

    const sel = host.container.querySelector(
      `[data-testid="action-param-app-${actionId}"]`,
    ) as HTMLSelectElement | null;
    expect(sel, "必填的 app 参数不能没有控件").not.toBeNull();
    expect(sel!.tagName).toBe("SELECT");

    const values = [...sel!.options].map((o) => o.value);
    expect(values, "控件里要有内置应用").toContain("clock");
    expect(values, "控件里要有已安装的商店应用").toContain(DEMO.id);

    await fireEvent.change(sel!, { target: { value: DEMO.id } });
    await settle();
    expect(loadShortcuts()[0]!.actions[0]!.parameters.app).toBe(DEMO.id);
  });

  test("应用触发器的下拉含已安装商店应用；选中后落盘，行摘要显示其名字而非裸 id", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);
    await addTrigger(host, "app");

    const trg = loadShortcuts()[0]!.triggers[0]!;
    const sel = host.container.querySelector(
      `[data-testid="trigger-app-${trg.id}"]`,
    ) as HTMLSelectElement;
    const values = [...sel.options].map((o) => o.value);
    expect(values, "触发器下拉要含已安装的商店应用").toContain(DEMO.id);

    await fireEvent.change(sel, { target: { value: DEMO.id } });
    await settle();
    expect(loadShortcuts()[0]!.triggers[0]!.config.appId).toBe(DEMO.id);

    const row = host.container.querySelector(`[data-testid="trigger-row-${trg.id}"]`)!;
    expect(row.textContent, "行摘要要显示商店应用的名字").toContain("Demo");
    expect(row.textContent, "行摘要不能把裸 wire id 给用户看").not.toContain(DEMO.id);
  });

  test("选择器对「装完应用」是活的：挂载后再 poke 一次即出现新选项", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);
    await addTrigger(host, "app");

    const trg = loadShortcuts()[0]!.triggers[0]!;
    const optionsNow = () =>
      [...(host.container.querySelector(`[data-testid="trigger-app-${trg.id}"]`) as HTMLSelectElement).options].map(
        (o) => o.value,
      );
    expect(optionsNow(), "挂载时只有一个商店应用").not.toContain(POMO.id);

    // 模拟商店装完一个应用：写缓存 + poke（`StoreApp` 的做法）。
    setStoreTiles([DEMO, POMO]);
    notifyStoreTilesChanged();
    await settle();

    expect(optionsNow(), "装完后下拉必须自己更新，无需重挂载").toContain(POMO.id);
  });
});
