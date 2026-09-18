/**
 * modal-pattern.svelte.test.ts — 五个模态共用的那条模式（REQ-A386）。
 *
 * 起因：`svelte-check` 报了 8 处「带 click 的 `<div>` 既没有 role 也没有键盘路径」。
 * 它们全是模态遮罩（`onclick={close}` + 内容 `stopPropagation`）。修法不是"给 div 加个
 * role 了事"，而是把遮罩换成**内容后面的一枚真按钮**：
 *   • 它自己可点、可聚焦、有名字（`aria-label`）⇒ 不需要 role/键盘兜底；
 *   • 它与内容**同级**（在内容之下）⇒ 点内容根本到不了它，`stopPropagation` 那一层
 *     补丁连同它的隐患一起消失；
 *   • Escape 与焦点陷阱交给仓库共享的 `attachFocusTrap`，它顺带把焦点交给模态里的
 *     第一个可聚焦元素 —— 这就是原来 `autofocus` 想做的事，而 `autofocus` 会在页面
 *     加载时抢焦点，所以它被删掉了。
 *
 * 两个**可复现**的代表各测一遍（ShortcutsApp 的新建、APISettings 的 Webhook 编辑），
 * 因为其余三个面板的模态需要先有数据才能打开。
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShortcutsApp from "../src/svelte/ShortcutsApp.svelte";
import APISettings from "../src/svelte/modules/APISettings.svelte";
import { zh } from "../src/i18n/locales/zh";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const backdropOf = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>("button.modal-backdrop");

describe("模态：遮罩是可命名的真按钮，Escape 能关（REQ-A386）", () => {
  test("ShortcutsApp 的新建模态：dialog 语义 + 遮罩按钮 + Escape 关闭", async () => {
    const host = render(ShortcutsApp);
    await fireEvent.click(host.getByRole("button", { name: zh["shortcuts.newButton"] }));
    await tick();

    const dialog = host.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // 由可见标题命名（不是靠 aria-label 复述一遍）。
    expect(dialog.getAttribute("aria-labelledby")).toBe("shortcut-new-title");
    expect(host.container.querySelector("#shortcut-new-title")?.textContent).toContain(
      zh["shortcuts.createNew"],
    );

    // 遮罩：一枚**可命名**的按钮，而不是"带 click 的 div"。
    const backdrop = backdropOf(host.container);
    expect(backdrop, "the backdrop must be a real button").toBeTruthy();
    expect(backdrop?.getAttribute("aria-label")).toBe(zh["shortcuts.close"]);

    // 焦点在模态里的**第一个字段**（`autofocus` 的替代：attachFocusTrap 做的）。
    const nameInput = dialog.querySelector<HTMLInputElement>("input[type=text]");
    expect(nameInput).toBeTruthy();
    expect(document.activeElement).toBe(nameInput);

    await fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await tick();
    expect(host.container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("APISettings 的 Webhook 模态：点遮罩关闭（点内容不关）", async () => {
    const host = render(APISettings);
    await fireEvent.click(host.getByRole("button", { name: new RegExp(zh["api.addWebhook"]) }));
    await tick();
    expect(host.container.querySelector('[role="dialog"]')).toBeTruthy();

    // 点内容：模态必须**留着** —— 这正是原来 stopPropagation 在守的那件事，
    // 现在由"遮罩在内容之下"这个结构保证。
    await fireEvent.click(host.container.querySelector('[role="dialog"]') as HTMLElement);
    await tick();
    expect(host.container.querySelector('[role="dialog"]')).toBeTruthy();

    // 点遮罩：关闭。
    await fireEvent.click(backdropOf(host.container) as HTMLButtonElement);
    await tick();
    expect(host.container.querySelector('[role="dialog"]')).toBeNull();
  });
});
