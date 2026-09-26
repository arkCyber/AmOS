/**
 * 一条「不可用」菜单行的**可访问名**，不该在每个语言里都拼上一个英文单词
 * （REQ-A1548 ∕ F-SH-788）。
 *
 * `TopbarMainMenu.svelte` 修前逐字：
 *
 *   function unavailableName(row: MenuRow): string {
 *     if (row.run) return t(row.labelKey!);
 *     return t(row.labelKey!) + " — unavailable";
 *   }
 *
 * 于是没有 `run` 的那两行（编辑 ▸ 撤销、窗口 ▸ 全部置于顶层）的 `aria-label` 变成
 * 「撤销 — unavailable」—— 一句**中文标签 + 一个硬编码的英文词**。两处同类证据说明它不是
 * 有意为之：
 *
 *  1. **它读的那份词典自己写下了规则**：`src/i18n/locales/zh.ts` 里这两行的键
 *     （`…UndoUnavailable` ∕ `…BringAllToFrontUnavailable`）旁逐字写着「`*Unavailable` 行用
 *     **纯 macOS 文案**：不可用由行状态表达，不在文字里重复说一遍」——值就是「撤销」／
 *     「全部置于顶层」，没有任何 unavailable 的字样。
 *  2. **同一块的兄弟菜单把这件事做对了**：`TopbarAppleMenu.svelte` 的灰行是
 *     `aria-label={t(entry.labelKey)}`（不加后缀），`DockContextMenu.svelte` 的灰占位行用的是
 *     **一句被翻译过的**话（`desktop.dockCtxOptionsUnavailable`）。可访问名要额外说明「不可用」
 *     时，本仓库用的是**一个 i18n 键**，从不是硬编码的英文词。
 *
 * 而 `disabled` + `aria-disabled="true"` 本来就把「不可用」告诉了辅助技术 —— 后缀既冗余又
 * 只对英文读者成立。判据是**两个字段读同一行**：可见文本 `{t(row.labelKey!)}` 与
 * `aria-label` 本就该一致，修前却相差一个英文词。
 */
import { describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import TopbarMainMenu from "../src/svelte/modules/TopbarMainMenu.svelte";
import { zh } from "../src/i18n/locales/zh";

async function openGroup(container: HTMLElement, group: string): Promise<void> {
  await fireEvent.click(container.querySelector<HTMLElement>(`[data-testid="menu-${group}-trigger"]`)!);
  await tick();
}

const rowOf = (container: HTMLElement, group: string, id: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-testid="menu-${group}-${id}"]`)!;

describe("REQ-A1548 — 不可用行的可访问名不拼英文单词（F-SH-788）", () => {
  test("编辑 ▸ 撤销：`aria-label` 就是本地化标签，不含 'unavailable'", async () => {
    const { container } = render(TopbarMainMenu);
    await tick();
    await openGroup(container, "edit");

    const undo = rowOf(container, "edit", "edit.undo");
    expect(undo.getAttribute("aria-label")).toBe(zh["desktop.menu.edit.undoUnavailable"]);
    expect(undo.getAttribute("aria-label")).not.toContain("unavailable");
  });

  test("窗口 ▸ 全部置于顶层：同上", async () => {
    const { container } = render(TopbarMainMenu);
    await tick();
    await openGroup(container, "window");

    const bringAll = rowOf(container, "window", "window.bring-all");
    expect(bringAll.getAttribute("aria-label")).toBe(
      zh["desktop.menu.window.bringAllToFrontUnavailable"],
    );
    expect(bringAll.getAttribute("aria-label")).not.toContain("unavailable");
  });

  test("正控 · 去掉后缀没有拿掉「不可用」这个事实（行仍是 disabled）", async () => {
    const { container } = render(TopbarMainMenu);
    await tick();
    await openGroup(container, "edit");

    const undo = rowOf(container, "edit", "edit.undo");
    expect(undo.hasAttribute("disabled")).toBe(true);
    expect(undo.getAttribute("aria-disabled")).toBe("true");
  });

  test("正控 · 可用的行不受影响：`aria-label` 仍是它自己的标签", async () => {
    const { container } = render(TopbarMainMenu);
    await tick();
    await openGroup(container, "edit");

    const copy = rowOf(container, "edit", "edit.copy");
    expect(copy.getAttribute("aria-disabled")).toBeNull();
    expect(copy.getAttribute("aria-label")).toBe(zh["desktop.menu.edit.copy"]);
  });

  test("正控 · 可见文本与可访问名读的是同一个标签（没有后缀时二者必然一致）", async () => {
    const { container } = render(TopbarMainMenu);
    await tick();
    await openGroup(container, "edit");

    const undo = rowOf(container, "edit", "edit.undo");
    const text = (undo.textContent ?? "").trim();
    expect(text).toBe(zh["desktop.menu.edit.undoUnavailable"]);
    expect(undo.getAttribute("aria-label")).toBe(text);
  });
});
