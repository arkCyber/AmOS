/**
 * webman-history-list-length.svelte.test.ts — 「历史记录」列的是**整段历史**吗（REQ-A1292 / FMEA F-SH-562）。
 *
 * 历史面板逐字用 `searchHistory(query)` 当它的列表源：
 *
 * ```js
 * filteredHistory = searchHistory(query);
 * ```
 *
 * 而 `searchHistory` 两支都以 `.slice(0, 20)` 收尾（`lib/webman.ts:899` / `:905`）—— 于是面板
 * 最多画 20 行，**屏幕上没有任何一处说"还有别的"**，而紧挨着列表上方那颗「清除历史」清的是
 * **全部**（`clearHistory()`，上限 `HISTORY_MAX_COUNT = 500`）。用户数到 20 行就以为那是全部历史，
 * 然后按下了清空。
 *
 * 那个 20 曾经不是没理由的：侧栏此前**不会滚**（`ul.overflow-y-auto` 之类一个都没有，
 * 外层还是 `overflow-hidden`），所以列表必须自己截短。REQ-A1291 已经把面板体做成滚动容器
 * （`min-h-0 flex-1 overflow-y-auto`）—— 布局那半个理由没有了，剩下的就只是把用户的历史藏起来。
 * 与 REQ-A1290（站点数据那口 jar）同形：**列表长度由数据源自己决定**。
 *
 * 搜索那一支一样：用户在**找**东西，而"命中 20 条"与"共 200 条命中"在屏幕上一模一样。
 *
 * 用回环地址的标签页：happy-dom 会真去取 iframe 的 src，指向公网等于让测试触网。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { HISTORY_KEY, TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

/** 25 条 —— 比那个上限多 5 条，足够让"截断"与"没截断"分得开。 */
const HISTORY_SIZE = 25;

const historyRows = () =>
  Array.from({ length: HISTORY_SIZE }, (_, i) => ({
    url: `http://127.0.0.1:1/h${String(i).padStart(2, "0")}`,
    title: `History ${i}`,
    visitedAt: 10_000 - i,
  }));

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        {
          id: "tab-1",
          url: "http://127.0.0.1:1/",
          title: "Alpha",
          favicon: "",
          loading: false,
          scrollY: 0,
          pinned: false,
        },
      ],
    }),
  );
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, data: historyRows() }));
  setFormFactor("desktop");
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setFormFactor(null);
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

type Host = { container: HTMLElement };

const buttons = (h: Host) => [...h.container.querySelectorAll("button")] as HTMLButtonElement[];

/** 打开 ⋮ 菜单 → 点「历史记录」。 */
async function openHistoryPanel(h: Host) {
  await fireEvent.click(buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.a11y.menu"])!);
  await settle();
  await fireEvent.click(buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.history"]))!);
  await settle();
}

/** 历史行 —— 面板体里带 `flex` 的那些 button（清空那颗没有 `flex`，于是分得开）。 */
const rows = (h: Host) =>
  [...h.container.querySelectorAll("div.w-72 > div.p-2 button.flex")] as HTMLButtonElement[];

const searchBox = (h: Host) =>
  h.container.querySelector<HTMLInputElement>(`input[placeholder="${zh["webman.searchHistory"]}"]`)!;

describe("REQ-A1292: 历史面板列的是整段历史，不是一个悄悄截断的窗口", () => {
  test("存了 25 条 ⇒ 列表里就该有 25 行（面板本来就会滚，没有理由藏）", async () => {
    const host = render(WebManApp);
    await settle();
    await openHistoryPanel(host);

    // 列表由 `debounce(…, 300)` 填 —— 打开后要等它一次（这不是被测的行为，是它的节奏）。
    await new Promise<void>((r) => setTimeout(r, 400));
    await settle();

    expect(rows(host).length, `历史有 ${HISTORY_SIZE} 条，列表却只画了 ${rows(host).length} 行`).toBe(
      HISTORY_SIZE,
    );
    // 第一条与最后一条都要在 —— 只数行数可能被"换了 20 条"蒙混过去。
    const text = rows(host).map((b) => b.textContent ?? "").join("|");
    expect(text).toContain("History 0");
    expect(text).toContain(`History ${HISTORY_SIZE - 1}`);
  });

  test("搜索命中的每一条都要在 —— 「共 25 条命中」不能显示成 20 条", async () => {
    const host = render(WebManApp);
    await settle();
    await openHistoryPanel(host);

    // 每条历史的标题都含 "History"，于是这一问命中全部 25 条。
    await fireEvent.input(searchBox(host), { target: { value: "History" } });
    await new Promise<void>((r) => setTimeout(r, 400)); // 防抖 300ms
    await settle();

    expect(rows(host).length, `25 条命中，列表却只画了 ${rows(host).length} 行`).toBe(HISTORY_SIZE);
  });
});
