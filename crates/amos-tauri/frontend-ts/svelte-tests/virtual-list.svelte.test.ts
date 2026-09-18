/**
 * virtual-list.svelte.test.ts — `VirtualList.svelte` 的组件契约
 * （`src/svelte/components/VirtualList.svelte`，被 `AuditLogViewer` 使用）。
 *
 * 组件把每一项交给 `renderItem` snippet 渲染，只把**可见窗口的切片**交出去，所以这里用
 * `createRawSnippet` 造一个会把"我是第几项"写进 `data-idx` 的 snippet，据此断言：
 *   • 容器高度来自 `containerHeight`，空列表不渲染任何项；
 *   • spacer 高度 = 所有项高度之和（固定值与函数式两种）；
 *   • 只有窗口内的项被渲染，`data-index` 是**真实下标**，内容确实来自 snippet；
 *   • 滚动会移动窗口：被跳过的项高度变成顶部填充（`translateY`）。
 *
 * 为什么重写：原文件渲染的是 `VirtualList<TestItem>` 且**不传 `renderItem`** —— 那是组件
 * 还在用默认插槽时的写法。组件后来改成 snippet 属性，于是那批用例即便跑起来也会在
 * `{@render renderItem(...)}` 上抛错；而它当时并不在任何一个 runner 的扫描目录里
 * （`src/svelte/components/__tests__/`），所以没有任何门会红。现按仓库约定落在 `svelte-tests/`。
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import VirtualList from "../src/svelte/components/VirtualList.svelte";

interface Item {
  id: number;
  content: string;
}

const makeItems = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, content: `Item ${i}` }));

/** 每一项渲染成 `<span class="vrow" data-idx="…">内容</span>`，便于断言窗口位置。 */
const renderItem = createRawSnippet<[Item, number]>((item, index) => ({
  render: () => `<span class="vrow" data-idx="${index()}" data-id="${item().id}">${item().content}</span>`,
}));

const rows = (el: HTMLElement): Element[] => Array.from(el.querySelectorAll(".virtual-list-item"));

afterEach(() => cleanup());

describe("VirtualList — 渲染与虚拟化", () => {
  test("空列表：容器高度来自 containerHeight，且不渲染任何项", () => {
    const { container } = render(VirtualList, {
      props: { items: [], itemHeight: 50, containerHeight: 300, renderItem },
    });
    const box = container.querySelector(".virtual-list-container") as HTMLElement;
    expect(box.style.height).toBe("300px");
    expect(rows(container).length).toBe(0);
  });

  test("spacer 高度等于固定高度的总和", () => {
    const { container } = render(VirtualList, {
      props: { items: makeItems(10), itemHeight: 50, containerHeight: 300, renderItem },
    });
    const spacer = container.querySelector(".virtual-list-spacer") as HTMLElement;
    expect(spacer.style.height).toBe("500px"); // 10 × 50
  });

  test("函数式高度参与总和", () => {
    const { container } = render(VirtualList, {
      props: {
        items: makeItems(10),
        itemHeight: (it: Item) => (it.id % 2 === 0 ? 60 : 40),
        containerHeight: 300,
        renderItem,
      },
    });
    const spacer = container.querySelector(".virtual-list-spacer") as HTMLElement;
    expect(spacer.style.height).toBe("500px"); // 5 × 60 + 5 × 40
  });

  test("只渲染窗口内的项：数量小于总数，首项 data-index 为 0，内容来自 renderItem", () => {
    const { container } = render(VirtualList, {
      props: { items: makeItems(100), itemHeight: 50, containerHeight: 300, buffer: 2, renderItem },
    });
    const rendered = rows(container);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
    expect(rendered[0]!.getAttribute("data-index")).toBe("0");
    expect(rendered[0]!.querySelector(".vrow")!.textContent).toBe("Item 0");
  });

  test("滚动后窗口前移，被跳过的项高度成为顶部填充", async () => {
    const { container } = render(VirtualList, {
      props: { items: makeItems(100), itemHeight: 50, containerHeight: 300, buffer: 2, renderItem },
    });
    const box = container.querySelector(".virtual-list-container") as HTMLElement;
    box.scrollTop = 1000;
    await fireEvent.scroll(box);

    // scrollTop=1000, h=50 ⇒ 第一个可见项是 20，减 buffer 2 ⇒ startIndex=18 ⇒ 18×50=900
    const content = container.querySelector(".virtual-list-content") as HTMLElement;
    expect(content.style.transform).toBe("translateY(900px)");
    const firstIndex = Number(rows(container)[0]!.getAttribute("data-index"));
    expect(firstIndex).toBe(18);
  });

  test("窗口内的每一项都带着它自己的真实下标", () => {
    const { container } = render(VirtualList, {
      props: { items: makeItems(30), itemHeight: 40, containerHeight: 200, buffer: 1, renderItem },
    });
    const indices = rows(container).map((el) => Number(el.getAttribute("data-index")));
    expect(indices.length).toBeGreaterThan(0);
    // 连续、从 0 开始、且严格递增 —— 任何重复/错位都会在这里露出来
    expect(indices).toEqual(indices.map((_, i) => i));
  });
});
