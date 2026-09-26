/**
 * app-library-custom-group-cold-tiles.svelte.test.ts — 打开一个自建分组**不是**一次写入。
 *
 * REQ-A1393 ∕ FMEA F-SH-652。核实如下（对工作树，逐字）：
 *
 *   • `AppLibrary.svelte:71` 逐字 `const knownIds = $derived(new Set([...appIds(), ...ext.map((e) => e.id)]))`
 *     —— `knownIds` 里"存在"的那一半来自**宿主推下来的** `ext`（store 安装的三方瓦片），
 *     而 `AppLibrary` 拿到它的唯一途径是 propsChannel `appLibrary`（`Shell.svelte:256` /
 *     `DesktopShell.svelte:115` 的 `let { ext = [] } = $props()`）。
 *   • 那张瓦片列表是**异步**加载的：`lib/storeApps.ts:101 loadStoreTiles` 是模块缓存的**唯一**
 *     写点，`Shell.refreshStoreTiles`（`Shell.svelte:214`）在 mount 之后才 `await` 它；启动那一刻
 *     缓存是冷的，`ext` 是 `[]`。
 *   • 修前 `openCustomGroup`（`:234-237`）逐字
 *     `const apps = g.apps.filter((a) => knownIds.has(a)); if (apps.length !== g.apps.length) { customGroups = setGroupApps(customGroups, g.id, apps); }`
 *     —— 于是冷缓存下**每一个 `store:*` 成员都读成幽灵**，而这一句把这个结论**写回了盘**。
 *   • `Shell.refreshStoreTiles` 已经把"冷缓存的另一半"逐面列了出来：`reseatHomeLayout()`（主屏摆位）、
 *     `restoreSplit()`（分屏窗格）、`restoreSlideOver()`（悬浮面板）—— 三者都在瓦片到达后被**重新推导**。
 *     **自建分组的成员没有这一手**：`customGroups` 的唯一使用方就是 `AppLibrary.svelte`（全仓 grep），
 *     没有任何 re-seat，所以被写掉的成员**永远回不来**。
 *   • 后果：装过 store 应用并把它们放进自建分组的用户，重启后在瓦片加载完成前打开该分组，
 *     成员被**静默、永久地**抹掉。卡片预览（`:660 gKnown`）本来就只是过滤显示，`available`（`:78`）
 *     也把 store 应用列为可选成员（`:367`），所以"分组里有 store 成员"是这条 UI 支持的正常状态。
 *
 * 修法：把**读**和**写**分开 —— `openCustomGroup` 保留**整份**存储成员（`openGroup.apps`），
 * 只有**渲染**走 `visibleMembers = memberApps.filter((a) => knownIds.has(a))`；成员编辑照旧持久化整份，
 * 所以一次编辑再也不会顺手丢掉它看不见的成员。幽灵依然不会被画出来（同样的结果），
 * 只是不再以**删数据**为代价；重装（或只是瓦片迟到）的应用会自动回到分组里。
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

/** A store-installed tile as the host pushes it (`lib/storeApps.installedToTiles`). */
const tile = (id: string): StoreTile => ({
  id,
  mid: id.replace(/^store:/, ""),
  name: id,
  icon: "🧩",
});

const STORE_MEMBER = "store:org.amos.pomodoro";

/** Seed one custom group holding a built-in + a store-installed member. */
function seedGroup(apps: string[]): string {
  const { created, groups } = addCustomGroup([], "工作");
  setGroupApps(groups, created.id, apps);
  return created.id;
}

/** Mount the library as the host feeds it — with `ext` exactly as cold/warm as we say. */
async function renderLibrary(ext: StoreTile[]) {
  propsChannel<{ layout: typeof EMPTY_LAYOUT; ext: StoreTile[] }>("appLibrary").set({
    layout: EMPTY_LAYOUT,
    ext,
  });
  const utils = render(AppLibrary);
  await tick();
  return utils;
}

/** Click the custom-group card, landing on the group's open view. */
async function openGroupCard(container: HTMLElement): Promise<void> {
  const card = container.querySelector(
    '[data-testid="app-library-custom-group"]',
  ) as HTMLButtonElement | null;
  expect(card).toBeTruthy();
  await fireEvent.click(card!);
  await tick();
}

/** The member tiles actually drawn in the open view (the draggable ones). */
function drawnMembers(container: HTMLElement): string[] {
  const view = container.querySelector('[data-testid="app-library-custom-open"]');
  if (!view) return [];
  return [...view.querySelectorAll('button[draggable="true"]')].map(
    (b) => (b.getAttribute("aria-label") ?? "").trim(),
  );
}

describe("冷瓦片缓存下打开自建分组 —— 丢的必须是幽灵的**显示**，不是成员本身（REQ-A1393 ∕ F-SH-652）", () => {
  test("宿主还没推 `ext` 时打开分组：盘上的 store 成员必须**原封不动**", async () => {
    seedGroup(["notes", STORE_MEMBER]);
    const { container } = await renderLibrary([]); // 冷 —— 宿主尚未交付瓦片列表
    await openGroupCard(container);

    // 修前：这一句把 `store:org.amos.pomodoro` 从盘上永久删掉（成员只剩 `notes`）。
    expect(getCustomGroups()[0]!.apps).toEqual(["notes", STORE_MEMBER]);
  });

  test("对照：看不见的成员不得被**画出来**（幽灵仍然是幽灵）", async () => {
    seedGroup(["notes", STORE_MEMBER]);
    const { container } = await renderLibrary([]);
    await openGroupCard(container);

    // 只画得出 `notes`（内置 id 在 `appIds()` 里，冷缓存也认得）。
    expect(drawnMembers(container)).toEqual([zhLabel("app.notes")]);
  });

  test("对照：瓦片到达后同一个分组的 store 成员必须照旧显示出来", async () => {
    seedGroup(["notes", STORE_MEMBER]);
    const { container } = await renderLibrary([tile(STORE_MEMBER)]); // 热 —— 宿主已交付
    await openGroupCard(container);

    expect(drawnMembers(container).length).toBe(2);
    expect(getCustomGroups()[0]!.apps).toEqual(["notes", STORE_MEMBER]);
  });

  test("编辑成员持久化的是**整份**存储清单，冷缓存下也带得走看不见的那一位", async () => {
    seedGroup(["notes", STORE_MEMBER]);
    const { container } = await renderLibrary([]);
    await openGroupCard(container);

    // 进"编辑成员"面板，把一个内置应用加进去（`toggleMember` → `setGroupApps`）。
    const editBtn = container.querySelector(
      '[data-testid="app-library-edit-members"]',
    ) as HTMLButtonElement | null;
    expect(editBtn).toBeTruthy();
    await fireEvent.click(editBtn!);
    await tick();

    const picker = container.querySelector('[data-testid="app-library-custom-edit"]')!;
    const clockRow = [...picker.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "").trim() === zhLabel("app.clock"),
    ) as HTMLButtonElement | undefined;
    expect(clockRow).toBeTruthy();
    await fireEvent.click(clockRow!);
    await tick();

    // 修前：`store:org.amos.pomodoro` 已在打开时被抹掉，这里只剩 notes + clock。
    expect(getCustomGroups()[0]!.apps).toEqual(["notes", STORE_MEMBER, "clock"]);
  });

  test("守卫：打开一个**全员都在**的分组不会平白写盘", async () => {
    seedGroup(["notes", "clock"]);
    const before = window.localStorage.getItem("amos.appLibrary.groups");
    const { container } = await renderLibrary([]);
    await openGroupCard(container);

    // 没有幽灵可丢时，打开分组不产生任何存储写入（读路径无副作用）。
    expect(window.localStorage.getItem("amos.appLibrary.groups")).toBe(before);
    expect(drawnMembers(container).length).toBe(2);
  });
});
