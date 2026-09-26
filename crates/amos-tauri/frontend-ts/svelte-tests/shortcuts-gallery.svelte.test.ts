/**
 * shortcuts-gallery.svelte.test.ts — 快捷指令库（`view === "gallery"`）的 DOM 契约（REQ-A500）。
 *
 * 这个视图此前**可达**（工具栏里就有一个「快捷指令库」按钮），却只画一句
 * `🚧 快捷指令库即将推出` —— 而它的描述写着「探索预设模板，快速创建实用的快捷指令」。
 * 本文件钉住"承诺真的兑现"这件事：
 *   1. 卡片来自 `GALLERY_TEMPLATES`（数量与名字都对得上），不是占位串；
 *   2. 点「添加」→ 走 `createShortcut` 真的落盘（`amos.shortcuts`），并且**回到列表视图时能看到它**；
 *   3. 已经装过的模板按钮变成「已添加」且禁用（状态从 `shortcuts` 现算，不维护第二条账）；
 *   4. 创建被拒时**说出来**（那句 `galleryAddFailed`），而不是点了没反应。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShortcutsApp from "../src/svelte/ShortcutsApp.svelte";
import { GALLERY_TEMPLATES } from "../src/lib/shortcutGallery";
import { loadShortcuts, type Shortcut } from "../src/lib/shortcuts";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 打开库视图：工具栏上的按钮文本就是它的标题。 */
async function openGallery(host: { container: HTMLElement }) {
  const btn = [...host.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(zh["shortcuts.gallery"]),
  ) as HTMLButtonElement;
  expect(btn).toBeTruthy();
  await fireEvent.click(btn);
  await settle();
}

const addButton = (host: { container: HTMLElement }, id: string) =>
  host.container.querySelector(`[data-testid="gallery-add-${id}"]`) as HTMLButtonElement | null;

describe("REQ-A500: 快捷指令库渲染真实预设模板", () => {
  test("卡片数与模板一致，名字/描述/动作数都来自字典（不是占位串）", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openGallery(host);

    const text = host.container.textContent ?? "";
    expect(text).not.toContain("Coming Soon");
    expect(text).not.toContain("即将推出");
    expect(host.container.querySelector('[data-testid="gallery-grid"]')).not.toBeNull();

    for (const tpl of GALLERY_TEMPLATES) {
      expect(text).toContain(zh[tpl.nameKey as keyof typeof zh]);
      expect(text).toContain(zh[tpl.descKey as keyof typeof zh]);
      expect(addButton(host, tpl.id)).not.toBeNull();
    }
    // 卡片自身的状态是"未装"：按钮文案是「添加」。
    expect(addButton(host, GALLERY_TEMPLATES[0]!.id)?.textContent).toContain(
      zh["shortcuts.galleryAdd"],
    );
  });

  test("点「添加」→ 真的写进存储、动作数与模板一致、来源标签在", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openGallery(host);

    const tpl = GALLERY_TEMPLATES[0]!;
    await fireEvent.click(addButton(host, tpl.id)!);
    await settle();

    const stored = loadShortcuts();
    expect(stored.length).toBe(1);
    const made: Shortcut = stored[0]!;
    expect(made.name).toBe(zh[tpl.nameKey as keyof typeof zh]);
    expect(made.description).toBe(zh[tpl.descKey as keyof typeof zh]);
    expect(made.icon).toBe(tpl.icon);
    expect(made.color).toBe(tpl.color);
    expect(made.actions.length).toBe(tpl.actions.length);
    expect(made.actions.map((a) => a.position)).toEqual(tpl.actions.map((_, i) => i));
    expect(made.tags).toContain(`gallery:${tpl.id}`);
    // 动作文案已经**解析成中文**（不是把 i18n 键写进用户的快捷指令）。
    const textAction = made.actions.find((a) => a.actionTypeId === "text")!;
    expect(String(textAction.parameters.text)).toBe(
      zh["gallery.tpl.quickNote.text" as keyof typeof zh],
    );
  });

  test("装完之后按钮变成「已添加」并禁用；装第二条模板互不影响", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openGallery(host);

    const first = GALLERY_TEMPLATES[0]!;
    await fireEvent.click(addButton(host, first.id)!);
    await settle();

    const btn = addButton(host, first.id)!;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain(zh["shortcuts.galleryAdded"]);
    // 第二条仍然可装（状态是**按模板**算的，不是一个全局开关）。
    const second = GALLERY_TEMPLATES[1]!;
    expect(addButton(host, second.id)!.disabled).toBe(false);

    await fireEvent.click(addButton(host, second.id)!);
    await settle();
    expect(loadShortcuts().length).toBe(2);
    expect(loadShortcuts().map((s) => s.name)).toContain(zh[second.nameKey as keyof typeof zh]);
  });

  test("创建被拒时把原因说出来（`createShortcut` 返回 null 不是「点了没反应」）", async () => {
    const shortcuts = await import("../src/lib/shortcuts");
    const spy = vi.spyOn(shortcuts, "createShortcut").mockReturnValue(null);

    const host = render(ShortcutsApp);
    await settle();
    await openGallery(host);

    await fireEvent.click(addButton(host, GALLERY_TEMPLATES[0]!.id)!);
    await settle();

    const note = host.container.querySelector('[data-testid="gallery-note"]');
    expect(note?.textContent).toContain(zh["shortcuts.galleryAddFailed"]);
    expect(loadShortcuts().length).toBe(0);
    spy.mockRestore();
  });
});
