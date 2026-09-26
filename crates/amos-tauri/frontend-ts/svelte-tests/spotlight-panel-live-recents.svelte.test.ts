/**
 * spotlight-panel-live-recents.svelte.test.ts — Spotlight 的应用列表按「这台设备**实际**怎么用」
 * 排序（`amos.recents`），但那份 recents 是**按一次读**的：`hits` 把 `getRecents()`（一次
 * `readJson`）放进一个只依赖 `needle` 的 `$derived`，于是排序冻结在「这个常驻 sheet 第一次被
 * 打开」的那一刻 —— 之后你打开的 app 再也不会排到前面，而文件上方那段注释逐字写着
 * 「an app you just opened comes first」（REQ-A1417 / FMEA F-SH-675）。
 *
 * 与上一轮同一个文件、同一个家族（`project_derived_with_no_dependency_freezes_on_first_read`）：
 * 上一轮修的是同一段表达式**下面**的 `fileList` / `contactList`，这一处是同一段里剩下的那次
 * 一次性读 —— 一次按「形状」扫过的审计，漏掉的正是**同一屏里剩下的那个兄弟**。
 *
 * 修法：与 file / contact 两个来源同形 —— `createStoreValue<string[]>(RECENTS_KEY, [])` +
 * `$state` + `$effect(subscribe)`，`hits` 读订阅来的那份。
 *
 * 如实边界 (what this does NOT cover)：`AppLibrary` 也读 `getRecents()`，但它逐字渲染在
 * `Shell.svelte` 的 `{:else if s.kind === "library"}` 分支里 —— 每次进入「App 资源库」都重新
 * 挂载、重新读盘，所以它不受这个缺陷影响，本轮**未**动它。未做真机复核。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import SpotlightPanel from "../src/svelte/SpotlightPanel.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState } from "../src/svelte/shellState.svelte";
import { pushRecent } from "../src/lib/amosStore";

const bus = () => propsChannel<{ open: boolean }>("spotlight");

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

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

/** 打开 sheet（空查询 = 默认那组按使用排序的应用行）。 */
async function mountOpen() {
  bus().set({ open: true });
  const h = render(SpotlightPanel);
  await settle();
  return h;
}

/** 当前画出来的应用行 id（按屏幕顺序，正是 `orderByRecency` 的结论）。 */
const appRows = (c: HTMLElement): string[] =>
  [...c.querySelectorAll('[data-testid^="spot-app-"]')].map(
    (e) => e.getAttribute("data-testid")!.replace("spot-app-", ""),
  );

describe("SpotlightPanel —— 应用列表按 recents 排序，且这份 recents 是活的（REQ-A1417）", () => {
  test("sheet 开着的时候刚用过的 app 排到最前", async () => {
    const h = await mountOpen();
    expect(appRows(h.container)[0], "先确认它一开始不在最前，否则这条断言是空的").not.toBe(
      "calculator",
    );

    pushRecent("calculator");
    await settle();

    expect(appRows(h.container)[0]).toBe("calculator");
  });

  test("连续用过两个 app —— 后用的那个在前（排的是先后，不只是「在不在表里」）", async () => {
    const h = await mountOpen();
    pushRecent("calculator");
    await settle();
    pushRecent("settings");
    await settle();

    expect(appRows(h.container).slice(0, 2)).toEqual(["settings", "calculator"]);
  });

  test("对照：挂载**之前**就记下的 recents 在第一次打开时就生效", async () => {
    pushRecent("calculator");
    pushRecent("settings");

    const h = await mountOpen();

    expect(appRows(h.container).slice(0, 2)).toEqual(["settings", "calculator"]);
  });
});
