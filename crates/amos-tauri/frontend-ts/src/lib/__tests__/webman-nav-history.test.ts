/**
 * webman-nav-history.test.ts —— 地址栏 ← / → 的**行为**测试（REQ-A598 / FMEA F-SH-081）。
 *
 * 为什么单开一个文件：`WEBMAN_IMPLEMENTATION_REPORT.md` 把「前进/后退」标成 ✅「导航历史」，
 * 但代码里那两个按钮是 `onclick={() => (canGoBack = !canGoBack)}` —— 点一下只翻转一个布尔量，
 * **没有任何导航发生**，全 crate 也不存在任何导航历史。缺陷能活下来的原因与 F-SH-046 同族：
 * 判据（"哪个 URL 在上一页"）住在组件状态里，无头测试够不着。
 *
 * 现在判据被抽成 `webman.ts` 的纯函数（`pushNavEntry` / `goBackNav` / `goForwardNav` /
 * `canGoBackNav` / `canGoForwardNav`），本文件把真实浏览器语义逐条钉住。
 *
 * 本文件**不注册 happy-dom**（与 `webman-closed-tabs.test.ts` 同一理由）：考的全是不碰 DOM
 * 的纯逻辑。
 */
import { describe, test, expect } from "bun:test";
import {
  LIMITS,
  canGoBackNav,
  canGoForwardNav,
  emptyNavStack,
  goBackNav,
  goForwardNav,
  pushNavEntry,
  type NavStack,
} from "../webman";

const A = "https://a.example.com/";
const B = "https://b.example.com/";
const C = "https://c.example.com/";
const D = "https://d.example.com/";

/** 走一串 URL，返回最终栈（等价于用户在地址栏依次敲这些页）。 */
const visit = (urls: string[]): NavStack =>
  urls.reduce((stack, url) => pushNavEntry(stack, url), emptyNavStack());

describe("导航历史 —— 空栈与单页", () => {
  test("空栈：两个方向都不可去，且返回的是原栈（不是新对象）", () => {
    const empty = emptyNavStack();
    expect(empty).toEqual({ entries: [], index: -1 });
    expect(canGoBackNav(empty)).toBe(false);
    expect(canGoForwardNav(empty)).toBe(false);

    const back = goBackNav(empty);
    expect(back.url).toBeNull();
    expect(back.stack).toBe(empty);

    const fwd = goForwardNav(empty);
    expect(fwd.url).toBeNull();
    expect(fwd.stack).toBe(empty);
  });

  test("只访问过一页：没有任何方向可去（← / → 都该是灰的）", () => {
    const stack = visit([A]);
    expect(stack).toEqual({ entries: [A], index: 0 });
    expect(canGoBackNav(stack)).toBe(false);
    expect(canGoForwardNav(stack)).toBe(false);
  });

  test("空白 URL 不是一条历史（新标签页不该占一格）", () => {
    const stack = visit(["", A, ""]);
    expect(stack.entries).toEqual([A]);
  });
});

describe("导航历史 —— 后退 / 前进真的移动", () => {
  test("A→B：后退回到 A、前进回到 B（缺陷版是「点一下什么都不动」）", () => {
    const ab = visit([A, B]);
    expect([canGoBackNav(ab), canGoForwardNav(ab)]).toEqual([true, false]);

    const back = goBackNav(ab);
    expect(back.url).toBe(A);
    expect(back.stack.index).toBe(0);
    expect(canGoForwardNav(back.stack)).toBe(true);

    const forward = goForwardNav(back.stack);
    expect(forward.url).toBe(B);
    expect(forward.stack.index).toBe(1);
    expect(canGoForwardNav(forward.stack)).toBe(false);
  });

  test("A→B→C：连续后退两次到 A，再连续前进两次回 C", () => {
    let stack = visit([A, B, C]);
    stack = goBackNav(stack).stack;
    const toA = goBackNav(stack);
    expect(toA.url).toBe(A);
    expect(canGoBackNav(toA.stack)).toBe(false); // 已在最旧端

    stack = goForwardNav(toA.stack).stack;
    const toC = goForwardNav(stack);
    expect(toC.url).toBe(C);
    expect(canGoForwardNav(toC.stack)).toBe(false); // 已在最新端
  });

  test("在最旧端继续按 ← ：url 为 null、栈原样（按钮本就是 disabled，这里守第二道）", () => {
    const stack = { entries: [A, B], index: 0 };
    const r = goBackNav(stack);
    expect(r.url).toBeNull();
    expect(r.stack).toBe(stack);
  });

  test("在最新端继续按 → ：url 为 null、栈原样", () => {
    const stack = { entries: [A, B], index: 1 };
    const r = goForwardNav(stack);
    expect(r.url).toBeNull();
    expect(r.stack).toBe(stack);
  });

  test("后退 / 前进不就地改写入参（组件是拿返回值换掉状态）", () => {
    const stack = visit([A, B, C]);
    goBackNav(stack);
    goForwardNav(stack);
    expect(stack).toEqual({ entries: [A, B, C], index: 2 });
  });
});

describe("导航历史 —— 新导航截断前进支路", () => {
  test("A→B→C，回退到 B，再导航到 D ⇒ C 必须消失、→ 变灰", () => {
    let stack = visit([A, B, C]);
    stack = goBackNav(stack).stack; // 现在在 B
    stack = pushNavEntry(stack, D);
    expect(stack.entries).toEqual([A, B, D]);
    expect(stack.index).toBe(2);
    expect(canGoForwardNav(stack)).toBe(false);
  });

  test("回退到 A 后导航到 C ⇒ B 也被截掉", () => {
    let stack = visit([A, B]);
    stack = goBackNav(stack).stack; // 现在在 A
    stack = pushNavEntry(stack, C);
    expect(stack.entries).toEqual([A, C]);
    expect(canGoForwardNav(stack)).toBe(false);
  });

  test("在 A 上重复导航到 A（刷新 / 重按同一链接）⇒ **不动前进支路**", () => {
    let stack = visit([A, B]);
    stack = goBackNav(stack).stack; // 在 A，B 还在前进支路里
    const after = pushNavEntry(stack, A);
    expect(after).toBe(stack); // 完全 no-op，连对象都没换
    expect(canGoForwardNav(after)).toBe(true);
    expect(after.entries).toEqual([A, B]);
  });

  test("连续两次导航到同一页只产生一条历史（否则 ← 要按两次才离开）", () => {
    const stack = visit([A, A, A]);
    expect(stack.entries).toEqual([A]);
    expect(canGoBackNav(stack)).toBe(false);
  });
});

describe("导航历史 —— 有界", () => {
  test("超过上限时从**最旧**一端丢，当前页永远在 index 上", () => {
    const total = LIMITS.NAV_HISTORY_MAX_COUNT + 10;
    const urls = Array.from({ length: total }, (_, i) => `https://n${i}.example.com/`);
    const stack = visit(urls);
    expect(stack.entries.length).toBe(LIMITS.NAV_HISTORY_MAX_COUNT);
    expect(stack.entries[0]).toBe(urls[total - LIMITS.NAV_HISTORY_MAX_COUNT]); // 最旧的 10 条被丢
    expect(stack.entries[stack.entries.length - 1]).toBe(urls[total - 1]);
    expect(stack.index).toBe(LIMITS.NAV_HISTORY_MAX_COUNT - 1);
    expect(canGoForwardNav(stack)).toBe(false);
    expect(canGoBackNav(stack)).toBe(true);
  });

  test("有界不变量：任何长度下 index 都落在 entries 内", () => {
    let stack = emptyNavStack();
    for (let i = 0; i < LIMITS.NAV_HISTORY_MAX_COUNT * 2; i++) {
      stack = pushNavEntry(stack, `https://x${i}.example.com/`);
      expect(stack.index).toBeGreaterThanOrEqual(0);
      expect(stack.index).toBeLessThan(stack.entries.length);
      expect(stack.entries.length).toBeLessThanOrEqual(LIMITS.NAV_HISTORY_MAX_COUNT);
    }
  });
});
