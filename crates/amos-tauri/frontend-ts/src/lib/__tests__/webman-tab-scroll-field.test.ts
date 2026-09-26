/**
 * webman-tab-scroll-field.test.ts — 读侧的必填过滤不得让一个**没人读的**字段承重。
 *
 * REQ-A1384 ∕ FMEA F-SH-647。上一轮的「如实边界②」（F-SH-640 ∕ REQ-A1376）逐字把这一处
 * 留给了单独一轮：「`Tab.scrollY` 是**同一个形状的邻居**（落盘、读侧必填、生产侧既无写者
 * 也无读者），本轮**刻意不碰** —— 它的后果与本条不同（缺字段丢整行 vs. 一个假读数）」。
 * 本轮就是那一轮，核实如下（对工作树，逐字）：
 *
 *   • **接口**：`webman.ts:155` 逐字 `scrollY: number;`，上面一行注释是「滚动位置」。
 *   • **写者**：整条生产链上唯一的写者 `createTab`（`webman.ts:1553`）恒写 `0`；
 *     `grep -rn scrollY src/` 在 `src/svelte/**` 下**一处也没有** —— 没有任何代码去读
 *     `iframeRef.contentWindow.scrollY`，也没有任何 `scrollTo`。所以真实的滚动偏移
 *     **从未被采集过**。
 *   • **读者**：`reopenClosedTab`（`:1685`）把它从 `ClosedTab` 搬回恢复出来的标签，
 *     `closedTabFrom`（`:1630`）把它搬进关闭栈 —— 一条**搬运链**，两端都没有终点：
 *     落盘之后没有任何一处渲染或应用它。`webman-closed-tabs.test.ts:333` 钉着
 *     `expect(t.scrollY).toBe(640)`，可那 640 是**测试自己手搓**出来的（生产里 `entry.scrollY`
 *     恒为 0），所以那条断言描述的是一个到不了的状态。
 *   • **代价**：`loadTabStore`（`:1440`）的读侧过滤逐字要求 `typeof t.scrollY === 'number'`
 *     ⇒ 盘上**少这一位，丢掉的是整行标签页**（URL、标题、固定状态一起没），触发来源与同一个
 *     函数自己那条 REQ-A405 注释点名的三种同形（旧版本 ∕ 导入器 ∕ 手工编辑）；每一行都缺
 *     这一位时，整个会话打开时就只剩一张空白页 —— 正是 REQ-A405 修过的那个「零标签」形状。
 *   • **同一份清单的对照**：真正**被画出来**的 `favicon`（`favicon?: string`）一个字也没查。
 *
 * 一条"必填"清单里唯一的读者是零的那一项，代价却是丢整行 —— 修在读侧：不再把它当准入条件，
 * 并在同一个 `.map()`（那里早就归一化了 `title` 与 `loading`）里把不可信的值归一成 0。
 * 写侧**一个字不动**（`createTab` 继续写这一位：同一个函数里 `loading` 的先例正是
 * 「字段必须在，值只能是 ……」，否则读侧的必填过滤会把整行丢掉）。
 *
 * 这个文件故意不注册 happy-dom（与 `webman-persistence.test.ts` 同一条理由：只需要一个
 * 内存 `localStorage`）；桩只在本文件生命周期内存在，`afterAll` 还原。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { TABS_KEY, loadTabs, saveTabs, createTab, type Tab } from "../webman";

const memory = new Map<string, string>();

const stub = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: (i: number) => [...memory.keys()][i] ?? null,
    get length() {
      return memory.size;
    },
  },
  dispatchEvent: () => true,
};

const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;

beforeAll(() => {
  globals.window = stub;
});
afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
});
beforeEach(() => memory.clear());

/** 播种一份版本化标签存储（`loadTabStore` 读的就是这个形状）。 */
function seedTabs(data: unknown[]): void {
  memory.set(TABS_KEY, JSON.stringify({ version: 0, data }));
}

/** 一行**完整**的标签（每个必填字段都在），滚动位置可覆盖 —— 用来只抽掉一个字段。 */
function fullRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tab-1",
    url: "https://example.com/page",
    title: "示例页",
    loading: false,
    scrollY: 0,
    pinned: false,
    ...over,
  };
}

const OK_URL = "https://example.com/page";

describe("盘上的标签行缺 `scrollY` —— 丢的必须是那个字段，不是整行（REQ-A1384 ∕ F-SH-647）", () => {
  test("只缺 `scrollY` 的一行必须留下，值归一成 0", () => {
    const row = fullRow();
    delete row.scrollY;
    seedTabs([row]);

    const tabs = loadTabs();
    // 修前：这一行整条被读侧过滤丢掉 ⇒ `loadTabStore` 补一张空白占位页，URL 变成空串。
    expect(tabs.map((t) => t.url)).toEqual([OK_URL]);
    expect(tabs[0]).toMatchObject({ id: "tab-1", title: "示例页", pinned: false });
    expect(tabs[0]!.scrollY).toBe(0);
  });

  test("每一行都缺这一位 ⇒ 会话不塌成一张空白页", () => {
    const a = fullRow({ id: "a", url: "https://a.example/" });
    const b = fullRow({ id: "b", url: "https://b.example/" });
    delete a.scrollY;
    delete b.scrollY;
    seedTabs([a, b]);

    const tabs = loadTabs();
    // 修前：两行都丢 ⇒ 只剩 `createTab()` 那一张空页（url === ""）。
    expect(tabs.map((t) => t.url)).toEqual(["https://a.example/", "https://b.example/"]);
    expect(tabs.every((t) => t.scrollY === 0)).toBe(true);
  });

  test("不可信的值（字符串 ∕ NaN ∕ 负数 ∕ 无穷 ∕ null）归一成 0，行照旧留下", () => {
    const values: unknown[] = ["42", Number.NaN, -5, Number.POSITIVE_INFINITY, null];
    seedTabs(values.map((v, i) => fullRow({ id: `t${i}`, url: `https://x${i}.example/`, scrollY: v })));

    const tabs = loadTabs();
    // 修前：五行全丢（`typeof "42" !== 'number'`、NaN 也不是有限数……一条都不通过）。
    expect(tabs.map((t) => t.id)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(tabs.map((t) => t.scrollY)).toEqual([0, 0, 0, 0, 0]);
  });

  test("对照组：一个**真**值必须原样保留（归一化不是「一律归零」）", () => {
    seedTabs([fullRow({ scrollY: 42 })]);
    expect(loadTabs().map((t) => t.scrollY)).toEqual([42]);

    // 与关闭栈那一路的口径逐字相同：写进去 → 读回来，值不变。
    saveTabs(loadTabs().map((t) => ({ ...t, scrollY: 99 })));
    expect(loadTabs().map((t) => t.scrollY)).toEqual([99]);
  });

  test("守卫：其余必填字段照旧承重（放宽的不是整张清单）", () => {
    // 非法 URL 的行照旧被丢 —— 这是安全过滤，与 `scrollY` 那一位无关。
    seedTabs([fullRow({ id: "bad", url: "javascript:alert(1)" })]);
    expect(loadTabs().map((t) => t.url)).toEqual([""]);

    // 缺 `id` ∕ `title` ∕ `loading` ∕ `pinned` 的任何一行照旧被丢。
    const noId = fullRow({ url: "https://a.example/" });
    delete noId.id;
    const noTitle = fullRow({ url: "https://b.example/" });
    delete noTitle.title;
    const noPinned = fullRow({ url: "https://c.example/" });
    delete noPinned.pinned;
    const noLoading = fullRow({ url: "https://d.example/" });
    delete noLoading.loading;
    seedTabs([noId, noTitle, noPinned, noLoading]);
    expect(loadTabs().map((t) => t.url)).toEqual([""]);
  });

  test("落盘那一行仍**带着** `scrollY` 这个数（读侧必填清单曾经看得见它）", () => {
    saveTabs([createTab(OK_URL)]);
    const row = (JSON.parse(memory.get(TABS_KEY)!) as { data: Tab[] }).data[0]!;
    expect(typeof row.scrollY).toBe("number");
    expect(row.scrollY).toBe(0);
  });
});
