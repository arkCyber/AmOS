/**
 * spotlight-panel-live-content.svelte.test.ts — Spotlight 的**文件 / 联系人**命中表是
 * 一次快照，第一次用它搜索之后就**再也不会更新**（REQ-A1411 / FMEA F-SH-669）。
 *
 * 逐字：
 *
 *     const fileList    = $derived(normalizeFiles(readStoreValue<unknown>(FILES_KEY, [])));
 *     const contactList = $derived(normalizeContacts(readStoreValue<unknown>(CONTACTS_KEY, [])));
 *
 * `readStoreValue` **不是响应式的**（它只是一次 `JSON.parse`），而一个不读任何响应式值的
 * `$derived` 求值一次就被永远缓存。两者相加 = 第一次求值把盘上的那一刻钉死。这个 sheet 挂在
 * `Shell.svelte` 里是**常驻**的（`<SpotlightPanel />`，不在任何 `{#if}` 内），所以「第一次用
 * Spotlight 搜过一个非空词」之后就冻结，直到整个 app 重启：此后在「文件」里新建的文件、
 * 在「通讯录」里新建的联系人，**永远**搜不到。
 *
 * 同一张表里的第三行是反例：`noteHits` 把读取**放在**依赖 `needle` 的 `$derived.by` 里，每次
 * 输入都重读，所以**笔记**能搜到、文件和联系人搜不到 —— 同一次查询、同一张 sheet 里的这条
 * 不对称，就是「这里漏了一次订阅」的凭据。
 *
 * 桌面那一面（`SpotlightOverlay`）用的是真源订阅（`createStoreValue` + `$state`），从一开始
 * 就没有这个问题 —— 本轮把手机这一面改成同一种订阅，两面回答的都是 store，而不是快照。
 *
 * 如实边界 (what this does NOT cover)：`noteHits` 的读取按**每次输入**刷新（与桌面面同形），
 * 所以在同一查询下由另一个窗口推来的笔记要等下一次输入才会出现；本轮只把文件 / 联系人
 * 从「永不更新」修成「与桌面面一致」。i18n 未改；未做真机复核。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SpotlightPanel from "../src/svelte/SpotlightPanel.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState } from "../src/svelte/shellState.svelte";
import { writeStoreValueChecked } from "../src/lib/amosStore";
import { FILES_KEY, type FEntry } from "../src/lib/files";
import { CONTACTS_KEY, type Contact } from "../src/lib/contacts";
import { t } from "../src/svelte/locale.svelte";

const bus = () => propsChannel<{ open: boolean }>("spotlight");

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const FILE: FEntry = { id: "f1", type: "file", name: "zebrafish", ts: 1, content: "zebrafish" };
const CONTACT: Contact = { id: "c1", name: "Zebra Person", phones: ["5550100"], fav: false, ts: 1 };

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
});
afterEach(() => {
  resetPropsChannels();
  resetShellState();
  window.localStorage.clear();
});

/** 打开 sheet，并**先用它搜一次**（`QQQ` 无命中）—— 这正是冻结发生的那一刻。 */
async function mountUsed() {
  bus().set({ open: true });
  const h = render(SpotlightPanel);
  await settle();
  const input = h.container.querySelector("input") as HTMLInputElement;
  await fireEvent.input(input, { target: { value: "qqq" } });
  await settle();
  return { ...h, input };
}

const shown = (c: HTMLElement, testid: string) => c.querySelector(`[data-testid="${testid}"]`) !== null;
const text = (c: HTMLElement) => (c.textContent ?? "").replace(/\s+/g, " ");

describe("SpotlightPanel —— 文件 / 联系人命中表必须跟着 store 走（REQ-A1411）", () => {
  test("用过一次之后新建的**文件**仍然搜得到", async () => {
    const h = await mountUsed();
    writeStoreValueChecked(FILES_KEY, [FILE]); // 就在 sheet 还开着的时候落盘
    await settle();

    await fireEvent.input(h.input, { target: { value: "zebrafish" } });
    await settle();

    expect(shown(h.container, "spot-file-f1"), "文件就在盘上，Spotlight 不能装作没有").toBe(true);
  });

  test("用过一次之后新建的**联系人**仍然搜得到", async () => {
    const h = await mountUsed();
    writeStoreValueChecked(CONTACTS_KEY, [CONTACT]);
    await settle();

    await fireEvent.input(h.input, { target: { value: "zebra" } });
    await settle();

    expect(shown(h.container, "spot-contact-c1")).toBe(true);
  });

  test("同一张表里文件名命中时，不能说「无匹配」", async () => {
    const h = await mountUsed();
    writeStoreValueChecked(FILES_KEY, [FILE]);
    await settle();

    await fireEvent.input(h.input, { target: { value: "zebrafish" } });
    await settle();

    expect(shown(h.container, "spot-file-f1")).toBe(true);
    expect(text(h.container), "有命中却报「无匹配」，是屏幕在否认盘上的事实").not.toContain(
      t("shell.noMatch"),
    );
  });

  test("对照：用**之前**就在盘上的内容一直搜得到（修法不得回退掉原本就对的那条路）", async () => {
    writeStoreValueChecked(FILES_KEY, [FILE]);
    writeStoreValueChecked(CONTACTS_KEY, [CONTACT]);

    const h = await mountUsed(); // 第一次使用发生在写入之后
    await fireEvent.input(h.input, { target: { value: "zebrafish" } });
    await settle();
    expect(shown(h.container, "spot-file-f1")).toBe(true);

    await fireEvent.input(h.input, { target: { value: "zebra" } });
    await settle();
    expect(shown(h.container, "spot-contact-c1")).toBe(true);
  });
});
