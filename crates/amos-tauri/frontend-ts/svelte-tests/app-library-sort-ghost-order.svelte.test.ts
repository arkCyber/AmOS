/**
 * app-library-sort-ghost-order.svelte.test.ts — ▲/▼ 必须走**可见**坐标。
 *
 * REQ-A1572 ∕ FMEA F-SH-798。核实如下（对工作树，逐字）：
 *
 *   • `AppLibrary.svelte:309` 逐字
 *     `const visibleMembers = $derived(memberApps.filter((id) => knownIds.has(id)))`
 *     —— REQ-A1393 ∕ F-SH-652（同一份未提交改动）把**视图**从**存储清单**里分了出来：
 *     `memberApps`（`openGroup.apps`，整份，含幽灵）是写盘的单位，`visibleMembers` 是画出来的单位。
 *   • 同一轮把 `sortable` 也改到了可见坐标：`AppLibrary.svelte:329`
 *     `const sortable = $derived(visibleMembers.length > 1)`。但**排序模式里真正动手的两处没跟着改**：
 *     - `AppLibrary.svelte:535` `{@const index = memberApps.indexOf(id)}` —— 又回到**存储**坐标；
 *     - `AppLibrary.svelte:550/558` `onclick={() => shiftMember(index, ±1)}` —— 于是
 *       `shiftMember`（`:330-343`）交换的是 `g.apps[index]` 与 `g.apps[index+dir]`，
 *       即"存储里相邻的那一格"，**可能是幽灵**；
 *     - 而同一对按钮的禁用态却按**可见**坐标算：`:551 disabled={vi === 0}` /
 *       `:559 disabled={vi === visibleMembers.length - 1}`。
 *     一个控件用自己的坐标**判活**、用另一套坐标**动手**，两者只在"两可见成员在存储里相邻"时碰巧一致。
 *   • 后果（幽灵夹在两个可见成员之间时，最普通的一种是冷缓存下 store 成员落在中间）：
 *     `["notes","store:x","clock"]` 画成 `[笔记, 时钟]`，点"笔记 下移"交换的是 `apps[0]` 与
 *     `apps[1]` —— **笔记和幽灵**。可见顺序仍是 `[笔记, 时钟]`：按钮是启用的、点了也写了盘，
 *     却**什么也没动**（写进去的还是同一份集合的另一排列）。用户看到的是一个按下去毫无反应的按钮。
 *   • 对照：`svelte-tests/custom-groups.svelte.test.ts:389`（"touch reorder via ▲/▼ moves a member
 *     and persists"）用的是 `["phone","clock","weather"]` —— **没有幽灵**，两套坐标恰好重合，
 *     所以那条用例在修前修后都是绿的，正好漏掉这条路径。
 *
 * 修法：让 `shiftMember` 也走可见坐标 —— 传入的已是 `vi`，内部交换的是
 * `visibleMembers[from]` 与 `visibleMembers[to]` 在 `g.apps` 里的那两个**存储下标**。
 * 于是按钮的判活坐标与动手坐标重新统一，幽灵只是"不参与排序"（仍原样留在盘上）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AppLibrary from "../src/svelte/AppLibrary.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState } from "../src/svelte/shellState.svelte";
import { addCustomGroup, getCustomGroups, setGroupApps } from "../src/lib/customGroups";
import type { StoreTile } from "../src/lib/storeApps";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
});
afterEach(() => {
  resetPropsChannels();
});

const zhLabel = (key: string): string => zh[key as keyof typeof zh] ?? key;
const EMPTY_LAYOUT = { page: [] as string[], dock: [] as string[], hidden: [] as string[] };
const STORE_MEMBER = "store:org.amos.pomodoro";

function seedGroup(apps: string[]): void {
  const { created, groups } = addCustomGroup([], "工作");
  setGroupApps(groups, created.id, apps);
}

/** 宿主推下来的 store 瓦片（`lib/storeApps.StoreTile`）。 */
const tile = (id: string): StoreTile => ({
  id,
  mid: id.replace(/^store:/, ""),
  name: id,
  icon: "🧩",
});

/** 冷缓存：`ext = []`，于是 `store:*` 成员都是幽灵、不画出来。 */
async function renderLibraryCold() {
  propsChannel<{ layout: typeof EMPTY_LAYOUT; ext: StoreTile[] }>("appLibrary").set({
    layout: EMPTY_LAYOUT,
    ext: [],
  });
  const utils = render(AppLibrary);
  await tick();
  return utils;
}

async function openGroupInSortMode(container: HTMLElement): Promise<void> {
  const card = container.querySelector(
    '[data-testid="app-library-custom-group"]',
  ) as HTMLButtonElement | null;
  expect(card).toBeTruthy();
  await fireEvent.click(card!);
  await tick();

  const toggle = container.querySelector(
    '[data-testid="app-library-sort-toggle"]',
  ) as HTMLButtonElement | null;
  expect(toggle, "有 >1 个可见成员时必须给出排序开关").toBeTruthy();
  await fireEvent.click(toggle!);
  await tick();
}

/** 画出来的顺序 —— 取自每格 ▲ 按钮的无障碍名（`${label} 上移`），即**可见**坐标。 */
function visibleOrder(container: HTMLElement): string[] {
  const up = zhLabel("appLibrary.moveUp");
  return [...container.querySelectorAll('[data-testid="app-library-member-up"]')].map((b) => {
    const name = b.getAttribute("aria-label") ?? "";
    expect(name.endsWith(` ${up}`), `unexpected member arrow name: ${name}`).toBe(true);
    return name.slice(0, -(up.length + 1));
  });
}

/** 某一位可见成员的那一支箭头。 */
function arrow(
  container: HTMLElement,
  label: string,
  dir: "up" | "down",
): HTMLButtonElement {
  const suffix = dir === "down" ? zhLabel("appLibrary.moveDown") : zhLabel("appLibrary.moveUp");
  const testid = dir === "down" ? "app-library-member-down" : "app-library-member-up";
  const found = ([...container.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLButtonElement[]).find(
    (b) => (b.getAttribute("aria-label") ?? "") === `${label} ${suffix}`,
  );
  expect(found, `missing ${dir} arrow for ${label}`).toBeTruthy();
  return found!;
}

describe("自建分组的 ▲/▼ 走**可见**坐标（REQ-A1572 ∕ F-SH-798）", () => {
  test("幽灵夹在中间：▼ 真的把可见成员换到下一格，整份存储清单带走", async () => {
    // 冷缓存 —— 中间那位 store 成员是幽灵。
    seedGroup(["notes", STORE_MEMBER, "clock"]);
    const { container } = await renderLibraryCold();
    await openGroupInSortMode(container);
    expect(visibleOrder(container)).toEqual([zhLabel("app.notes"), zhLabel("app.clock")]);

    await fireEvent.click(arrow(container, zhLabel("app.notes"), "down"));
    await tick();

    // 修前：交换的是 apps[0] 与 apps[1]（笔记 ↔ 幽灵），可见顺序纹丝不动 —— 按钮是"死"的。
    expect(visibleOrder(container)).toEqual([zhLabel("app.clock"), zhLabel("app.notes")]);
    // 幽灵仍然原样留在盘上（REQ-A1393 的整份持久化不受影响），只是不参与排序。
    expect(getCustomGroups()[0]!.apps).toEqual(["clock", STORE_MEMBER, "notes"]);
  });

  test("幽灵夹在中间：下一位的 ▲ 同样真的上移一格", async () => {
    seedGroup(["notes", STORE_MEMBER, "clock"]);
    const { container } = await renderLibraryCold();
    await openGroupInSortMode(container);

    await fireEvent.click(arrow(container, zhLabel("app.clock"), "up"));
    await tick();

    expect(visibleOrder(container)).toEqual([zhLabel("app.clock"), zhLabel("app.notes")]);
    expect(getCustomGroups()[0]!.apps).toEqual(["clock", STORE_MEMBER, "notes"]);
  });

  test("三位可见成员 + 中间幽灵：中间那位两向都可动，且都真的动", async () => {
    seedGroup(["notes", STORE_MEMBER, "clock", "weather"]);
    const { container } = await renderLibraryCold();
    await openGroupInSortMode(container);
    expect(visibleOrder(container)).toEqual([
      zhLabel("app.notes"),
      zhLabel("app.clock"),
      zhLabel("app.weather"),
    ]);

    // 首位的 ▲ 与末位的 ▼ 在可见坐标下禁用（没有死控件），中间两位不禁用。
    expect(arrow(container, zhLabel("app.notes"), "up").disabled).toBe(true);
    expect(arrow(container, zhLabel("app.weather"), "down").disabled).toBe(true);
    expect(arrow(container, zhLabel("app.clock"), "down").disabled).toBe(false);

    await fireEvent.click(arrow(container, zhLabel("app.notes"), "down"));
    await tick();

    expect(visibleOrder(container)).toEqual([
      zhLabel("app.clock"),
      zhLabel("app.notes"),
      zhLabel("app.weather"),
    ]);
    expect(getCustomGroups()[0]!.apps).toEqual(["clock", STORE_MEMBER, "notes", "weather"]);
  });

  test("对照：没有幽灵时，可见坐标 = 存储坐标，行为一字不变", async () => {
    seedGroup(["phone", "clock", "weather"]);
    const { container } = await renderLibraryCold();
    await openGroupInSortMode(container);

    await fireEvent.click(arrow(container, zhLabel("app.phone"), "down"));
    await tick();

    expect(getCustomGroups()[0]!.apps).toEqual(["clock", "phone", "weather"]);
    expect(arrow(container, zhLabel("app.clock"), "up").disabled).toBe(true);
  });
});
