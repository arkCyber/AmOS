/**
 * webman-closed-tabs.test.ts — 「最近关闭的标签页」与浏览器快捷键的**行为**测试（REQ-A496）。
 *
 * 为什么单开一个文件：这两个契约都是**纯逻辑**，而它们此前分别住在
 *   • `WebManApp.svelte` 的 `handleGlobalKeydown`（键映射），与
 *   • 组件里一个 `logger.info('… not implemented yet')`（撤销栈根本不存在），
 * 二者都**无法被无头测试触达** —— 这正是缺陷活下来的原因：`⌘⇧T` 那一支比较的是
 * `e.key === 't'`，而物理键盘上 `Shift+T` 产生的是 `"T"`，于是那一支在真实设备上
 * 从未成立（下面的"按键形状"一节把真实的 `KeyboardEvent` 形状钉住）。
 *
 * 本文件**不注册 happy-dom**（与 `webman-persistence.test.ts` 同一理由）：这里考的是
 * 不碰 DOM 的价值导出，`createTab` / `localId` 也不需要 `window`。
 */
import { describe, test, expect } from "bun:test";
import {
  BROWSER_SHORTCUT_HINTS,
  LIMITS,
  browserIntent,
  closedTabFrom,
  createTab,
  cycleTabIndex,
  pushClosedTab,
  reopenClosedTab,
  setTabPinned,
  tabIndexForOrdinal,
  type BrowserIntent,
  type ClosedTab,
  type Tab,
} from "../webman";

/**
 * 全部意图 —— **手写**的清单，不是 `Object.keys(BROWSER_SHORTCUT_HINTS)` 反推出来的。
 *
 * 反推会让"新增了意图却忘了给键帽"这条断言永远为真（被检查的那一集就是它自己；
 * 本仓记过这一类循环枚举）。手写之后，加一个意图必须同时改三处：类型、`browserIntent`、
 * 这张表 —— 少改一处这条测试就红。
 */
const ALL_INTENTS: readonly BrowserIntent[] = [
  "new-tab",
  "close-tab",
  "restore-tab",
  "focus-address",
  "reload",
  "next-tab",
  "prev-tab",
  "tab-1",
  "tab-2",
  "tab-3",
  "tab-4",
  "tab-5",
  "tab-6",
  "tab-7",
  "tab-8",
  "tab-9",
];

const URL_A = "https://example.com/a";
const URL_B = "https://example.org/b";

const tab = (url: string, over: Partial<Tab> = {}): Tab => ({
  id: `t-${url}-${over.pinned ? "p" : "n"}`,
  url,
  title: url,
  favicon: "",
  loading: false,
  scrollY: 0,
  pinned: false,
  ...over,
});

const closed = (url: string, over: Partial<ClosedTab> = {}): ClosedTab => ({
  url,
  title: url,
  pinned: false,
  scrollY: 0,
  index: 0,
  ...over,
});

// ── 1. 按键形状：真实的 ⌘⇧T 是 `{ key: "T", metaKey: true, shiftKey: true }` ───────

describe("browserIntent —— 真实 KeyboardEvent 形状", () => {
  test("⌘⇧T：`key` 是**大写** `\"T\"`（Shift 之后的字符），仍必须识别为 restore-tab", () => {
    expect(browserIntent({ key: "T", metaKey: true, shiftKey: true })).toBe("restore-tab");
  });

  test("负控：旧判据 `e.key === 't'` 对真实的 ⌘⇧T **为假** —— 它就是这一支从来没跑过的原因", () => {
    const realShiftT = { key: "T", metaKey: true, shiftKey: true };
    expect(realShiftT.key === "t").toBe(false); // 旧表达式
    expect(browserIntent(realShiftT)).toBe("restore-tab"); // 新表达式
  });

  test("Ctrl 与 ⌘ 等价（非 Apple 键盘）；Shift 版本同样成立", () => {
    expect(browserIntent({ key: "t", ctrlKey: true })).toBe("new-tab");
    expect(browserIntent({ key: "T", ctrlKey: true, shiftKey: true })).toBe("restore-tab");
  });

  test("无修饰键、或带 ⌥ 时一律不是浏览器意图", () => {
    expect(browserIntent({ key: "t" })).toBeNull();
    expect(browserIntent({ key: "T", shiftKey: true })).toBeNull();
    expect(browserIntent({ key: "t", metaKey: true, altKey: true })).toBeNull();
    expect(browserIntent({ key: "T", metaKey: true, shiftKey: true, altKey: true })).toBeNull();
  });

  test("每一个意图逐一可达，且别处的键不会被误吞", () => {
    const seen: BrowserIntent[] = [];
    for (const key of ["t", "w", "l", "r"]) {
      const intent = browserIntent({ key, metaKey: true });
      expect(intent).not.toBeNull();
      seen.push(intent!);
    }
    seen.push(browserIntent({ key: "T", metaKey: true, shiftKey: true })!);
    for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      seen.push(browserIntent({ key, metaKey: true })!);
    }
    seen.push(browserIntent({ key: "}", metaKey: true, shiftKey: true })!);
    seen.push(browserIntent({ key: "{", metaKey: true, shiftKey: true })!);

    expect([...seen].sort()).toEqual([...ALL_INTENTS].sort());
    // 未登记的键 / 只有 Shift 的其它字母 / Escape（本屏自己处理）/ 缺 key 字段
    expect(browserIntent({ key: "q", metaKey: true })).toBeNull();
    expect(browserIntent({ key: "W", metaKey: true, shiftKey: true })).toBeNull();
    expect(browserIntent({ key: "Escape", metaKey: true })).toBeNull();
    expect(browserIntent({ metaKey: true })).toBeNull();
    // `0` 不是标签页序号（⌘0 在浏览器里没有语义）
    expect(browserIntent({ key: "0", metaKey: true })).toBeNull();
  });

  test("每个意图都有菜单键帽（新增意图而不给提示 ⇒ 这条红）", () => {
    for (const intent of ALL_INTENTS) {
      expect(BROWSER_SHORTCUT_HINTS[intent]).toBeTruthy();
    }
    expect(Object.keys(BROWSER_SHORTCUT_HINTS).sort()).toEqual([...ALL_INTENTS].sort());
  });

  // ── REQ-A1316：标签条此前没有任何键盘模型 ────────────────────────────────────

  test("⌘⇧[ / ⌘⇧]：真实的键盘上 Shift 产出 `{` / `}`，两个字形都要认", () => {
    // 与 REQ-A496 的 `"T"` 同一课：判据若只写 `[` / `]`，真实键盘上这一支永不成立。
    expect(browserIntent({ key: "}", metaKey: true, shiftKey: true })).toBe("next-tab");
    expect(browserIntent({ key: "]", metaKey: true, shiftKey: true })).toBe("next-tab");
    expect(browserIntent({ key: "{", metaKey: true, shiftKey: true })).toBe("prev-tab");
    expect(browserIntent({ key: "[", metaKey: true, shiftKey: true })).toBe("prev-tab");
    // 不带 Shift 的 `[` / `]` 不是浏览器意图（那是别的层的键）
    expect(browserIntent({ key: "[", metaKey: true })).toBeNull();
    expect(browserIntent({ key: "]", metaKey: true })).toBeNull();
  });

  test("⌘1…⌘9 映射到 `tab-N`；Shift 之后是符号（`!`…）⇒ 不再是序号", () => {
    const ordinals: readonly BrowserIntent[] = [
      "tab-1",
      "tab-2",
      "tab-3",
      "tab-4",
      "tab-5",
      "tab-6",
      "tab-7",
      "tab-8",
      "tab-9",
    ];
    for (let n = 1; n <= 9; n++) {
      expect(browserIntent({ key: String(n), metaKey: true })).toBe(ordinals[n - 1]!);
    }
    expect(browserIntent({ key: "!", metaKey: true, shiftKey: true })).toBeNull();
  });
});

// ── REQ-A1316：标签页序号的落点（⌘N / ⇧⌘[ / ⇧⌘]） ──────────────────────────────

describe("tabIndexForOrdinal / cycleTabIndex", () => {
  test("前 8 个序号指向第 N 个标签（0 基下标）", () => {
    expect(tabIndexForOrdinal(1, 5)).toBe(0);
    expect(tabIndexForOrdinal(3, 5)).toBe(2);
    expect(tabIndexForOrdinal(8, 9)).toBe(7);
  });

  test("第 9 个永远是**最后一个**，无论标签有多少", () => {
    expect(tabIndexForOrdinal(9, 3)).toBe(2);
    expect(tabIndexForOrdinal(9, 9)).toBe(8);
    expect(tabIndexForOrdinal(9, 50)).toBe(49);
  });

  test("标签不够时**夹到最后一个**（不是「什么都不做」）—— 与第 9 个语义一致", () => {
    expect(tabIndexForOrdinal(5, 3)).toBe(2);
    expect(tabIndexForOrdinal(2, 1)).toBe(0);
  });

  test("越界序号 / 空标签条 → null（调用方据此不施加任何变化）", () => {
    expect(tabIndexForOrdinal(0, 5)).toBeNull();
    expect(tabIndexForOrdinal(10, 5)).toBeNull();
    expect(tabIndexForOrdinal(1.5, 5)).toBeNull();
    expect(tabIndexForOrdinal(1, 0)).toBeNull();
    expect(tabIndexForOrdinal(1, -3)).toBeNull();
    expect(tabIndexForOrdinal(1, Number.NaN)).toBeNull();
  });

  test("环绕：最右边再 +1 回到第一个，最左边再 -1 去最后一个", () => {
    expect(cycleTabIndex(2, 3, 1)).toBe(0);
    expect(cycleTabIndex(0, 3, -1)).toBe(2);
    expect(cycleTabIndex(1, 3, 1)).toBe(2);
    expect(cycleTabIndex(1, 3, -1)).toBe(0);
  });

  test("多步环绕也正确（`-4` 在 3 个标签上等价于 `-1`）", () => {
    expect(cycleTabIndex(0, 3, -4)).toBe(2);
    expect(cycleTabIndex(0, 3, 7)).toBe(1);
  });

  test("当前下标不可信时按 0 处理；count ≤ 0 / delta 为 0 → null", () => {
    expect(cycleTabIndex(-1, 3, 1)).toBe(1); // 当作 0
    expect(cycleTabIndex(99, 3, 1)).toBe(1); // 当作 0
    expect(cycleTabIndex(0, 0, 1)).toBeNull();
    expect(cycleTabIndex(0, 3, 0)).toBeNull();
    expect(cycleTabIndex(0, Number.NaN, 1)).toBeNull();
  });
});

// ── REQ-A1315：固定标签的单向门 ────────────────────────────────────────────────

describe("setTabPinned", () => {
  test("固定与取消固定都能做到（修前 `pinned` 只在 createTab 时被写一次）", () => {
    const tabs = [tab(URL_A), tab(URL_B)];
    const pinned = setTabPinned(tabs, tabs[0]!.id, true);
    expect(pinned.map((t) => t.pinned)).toEqual([true, false]);

    const unpinned = setTabPinned(pinned, tabs[0]!.id, false);
    expect(unpinned.map((t) => t.pinned)).toEqual([false, false]);
  });

  test("只碰目标那一张，其余对象**引用不变**（标签条上别的行不该换身份）", () => {
    const tabs = [tab(URL_A), tab(URL_B)];
    const next = setTabPinned(tabs, tabs[1]!.id, true);
    expect(next).not.toBe(tabs);
    expect(next[0]).toBe(tabs[0]); // 未动的那一张是同一个对象
    expect(next[1]).not.toBe(tabs[1]);
    expect(tabs[1]!.pinned).toBe(false); // 输入不被就地改写
  });

  test("找不到 id、或状态本来就是那个值 → 原样返回**同一个数组引用**（调用方据此知道没变化）", () => {
    const tabs = [tab(URL_A)];
    expect(setTabPinned(tabs, "nope", true)).toBe(tabs);
    expect(setTabPinned(tabs, tabs[0]!.id, false)).toBe(tabs);
  });

  test("固定态不影响其它字段", () => {
    const tabs = [tab(URL_A, { title: "A", scrollY: 120 })];
    const next = setTabPinned(tabs, tabs[0]!.id, true);
    expect(next[0]).toEqual({ ...tabs[0]!, pinned: true });
  });
});

// ── 3. 恢复 ────────────────────────────────────────────────────────────────────

describe("reopenClosedTab", () => {
  test("栈空：不恢复、不消费历史（tabs / stack 原样返回同一个数组）", () => {
    const tabs = [tab(URL_A)];
    const stack: ClosedTab[] = [];
    const r = reopenClosedTab(tabs, stack);
    expect(r.outcome).toBe("empty");
    expect(r.tab).toBeNull();
    expect(r.tabs).toBe(tabs);
    expect(r.stack).toBe(stack);
  });

  test("LIFO：先恢复最后关掉的那条，且这条从栈里消掉", () => {
    const r = reopenClosedTab([tab(URL_A)], [closed(URL_A), closed(URL_B, { index: 1 })]); // B 后关
    expect(r.tab?.url).toBe(URL_B);
    expect(r.stack.map((c) => c.url)).toEqual([URL_A]);
    expect(r.tabs.map((t) => t.url)).toEqual([URL_A, URL_B]);
  });

  test("放回**原处**：关掉中间的标签再恢复，它回到中间", () => {
    const tabs = [tab("https://a.example.com/"), tab("https://c.example.com/")];
    const r = reopenClosedTab(tabs, [closed("https://b.example.com/", { index: 1 })]);
    expect(r.tabs.map((t) => t.url)).toEqual([
      "https://a.example.com/",
      "https://b.example.com/",
      "https://c.example.com/",
    ]);
  });

  test("位置越界 → 夹到末尾（标签条比关闭时短了）", () => {
    const r = reopenClosedTab([tab(URL_A)], [closed(URL_B, { index: 99 })]);
    expect(r.tabs.map((t) => t.url)).toEqual([URL_A, URL_B]);
  });

  test("空白占位页被**顶掉**（关掉最后一个标签再 ⌘⇧T 是最常用的路径）", () => {
    const placeholder = createTab(); // url === ""，就是 closeTab 补出来的那一张
    const r = reopenClosedTab([placeholder], [closed(URL_A, { index: 0 })]);
    expect(r.outcome).toBe("restored");
    expect(r.tabs.length).toBe(1); // 不产生第二张多余空页
    expect(r.tabs[0]!.url).toBe(URL_A);
    expect(r.tabs[0]!.id).not.toBe(placeholder.id);
  });

  test("固定标签不当作占位页（单张固定页旁边追加，而不是顶掉它）", () => {
    const pinned = tab("https://pinned.example.com/", { pinned: true });
    const r = reopenClosedTab([pinned], [closed(URL_A, { index: 1 })]);
    expect(r.tabs.length).toBe(2);
    expect(r.tabs.some((x) => x.id === pinned.id)).toBe(true);
    expect(r.tabs.map((t) => t.pinned)).toEqual([true, false]);
  });

  test("有内容的单标签页同样不被顶掉", () => {
    const r = reopenClosedTab([tab(URL_A)], [closed(URL_B, { index: 1 })]);
    expect(r.tabs.map((t) => t.url)).toEqual([URL_A, URL_B]);
  });

  test("标签数到顶：恢复被拒、**历史不被消耗**（关掉一个再按即可）", () => {
    const tabs = Array.from({ length: LIMITS.TAB_MAX_COUNT }, (_, i) =>
      tab(`https://full${i}.example.com`),
    );
    const stack = [closed(URL_A)];
    const r = reopenClosedTab(tabs, stack);
    expect(r.outcome).toBe("at-capacity");
    expect(r.tab).toBeNull();
    expect(r.tabs).toBe(tabs);
    expect(r.stack).toBe(stack);
    expect(r.stack.length).toBe(1);
  });

  test("恢复出来的是**新**身份（新 id、不处于加载态），并带回标题 / 固定位 / 滚动位置", () => {
    const r = reopenClosedTab(
      [tab(URL_A)],
      [closed(URL_B, { title: "B 的标题", pinned: true, scrollY: 640 })],
    );
    const t = r.tab!;
    expect(t.id.length).toBeGreaterThan(0);
    expect(r.tabs.some((x) => x.id === t.id)).toBe(true);
    expect(t.loading).toBe(false);
    expect(t.title).toBe("B 的标题");
    expect(t.pinned).toBe(true);
    expect(t.scrollY).toBe(640);
    expect(t.favicon).toContain("example.org");
  });

  test("标题缺失 → 从 URL 派生；滚动位置非法 → 0", () => {
    const r = reopenClosedTab([tab(URL_A)], [closed(URL_B, { title: "", scrollY: Number.NaN })]);
    expect(r.tab!.title.length).toBeGreaterThan(0);
    expect(r.tab!.scrollY).toBe(0);
    const neg = reopenClosedTab([tab(URL_A)], [closed(URL_B, { scrollY: -5 })]);
    expect(neg.tab!.scrollY).toBe(0);
  });

  test("恢复的标题重新过一遍清洗（记录跨了一次组件状态往返）", () => {
    const r = reopenClosedTab(
      [tab(URL_A)],
      [closed(URL_B, { title: "<script>alert(1)</script>标题" })],
    );
    expect(r.tab!.title).not.toContain("<");
    expect(r.tab!.title).not.toContain(">");
  });

  test("URL 重新过一遍清洗：被改坏的记录不会变成一条能点的野链接", () => {
    const r = reopenClosedTab([tab(URL_A)], [closed("javascript:alert(1)")]);
    expect(r.tab!.url).toBe(""); // createTab 的清洗拒绝 ⇒ 空白页，而不是留下那条协议
    expect(r.outcome).toBe("restored");
  });

  test("连续恢复按相反顺序返回；每次都以**当时**的标签条为基准", () => {
    let tabs = [tab(URL_A)];
    let stack = [
      closed("https://one.example.com", { index: 1 }),
      closed("https://two.example.com", { index: 2 }),
    ];
    const first = reopenClosedTab(tabs, stack);
    tabs = first.tabs;
    stack = first.stack;
    const second = reopenClosedTab(tabs, stack);
    expect([first.tab?.url, second.tab?.url]).toEqual([
      "https://two.example.com/",
      "https://one.example.com/",
    ]);
    expect(second.stack).toEqual([]);
    expect(reopenClosedTab(second.tabs, second.stack).outcome).toBe("empty");
  });

  test("恢复经过 `createTab` ⇒ URL 是**规范化**后的形式（恢复的页不会与新建的页长得不一样）", () => {
    const r = reopenClosedTab([tab(URL_A)], [closed("https://example.net", { index: 1 })]);
    expect(r.tab!.url).toBe("https://example.net/"); // sanitizeUrl 的规范化，不是原样复制
  });
});

// ── 2. 记录一次关闭 ────────────────────────────────────────────────────────────

describe("closedTabFrom / pushClosedTab", () => {
  test("记录保留恢复所需的字段，并把关闭前的位置带上", () => {
    const entry = closedTabFrom(tab(URL_A, { title: "A", pinned: true, scrollY: 420 }), 3);
    expect(entry).toEqual({ url: URL_A, title: "A", pinned: true, scrollY: 420, index: 3 });
  });

  test("位置被归一：负数 → 0、小数 → 向下取整（恢复时要能直接 splice）", () => {
    expect(closedTabFrom(tab(URL_A), -4).index).toBe(0);
    expect(closedTabFrom(tab(URL_A), 2.9).index).toBe(2);
  });

  test("LIFO：最后关掉的那条在栈顶；输入数组不被就地改写", () => {
    const stack = [closed(URL_A)];
    const next = pushClosedTab(stack, closed(URL_B));
    expect(stack.length).toBe(1);
    expect(next.map((c) => c.url)).toEqual([URL_A, URL_B]);
  });

  test("有界：从**最旧的一端**丢，最近关掉的永远在栈顶", () => {
    let stack: ClosedTab[] = [];
    for (let i = 0; i < 5; i++) stack = pushClosedTab(stack, closed(`https://s${i}.example.com`), 3);
    expect(stack.map((c) => c.url)).toEqual([
      "https://s2.example.com",
      "https://s3.example.com",
      "https://s4.example.com",
    ]);
  });

  test("上限参数非法时退回 LIMITS.CLOSED_TAB_MAX_COUNT（既不是无界也不是 0 条）", () => {
    let stack = [closed(URL_A)];
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      stack = pushClosedTab(stack, closed(URL_B), bad);
      expect(stack.length).toBeLessThanOrEqual(LIMITS.CLOSED_TAB_MAX_COUNT);
      expect(stack.length).toBeGreaterThan(0);
    }
  });
});
