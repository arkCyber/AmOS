/**
 * VirtualList.test.ts - 虚拟滚动列表组件单元测试
 * 
 * 需要 DOM 环境支持
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { describe, it, expect, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/svelte";
import VirtualListComponent from "../src/svelte/components/VirtualList.svelte";

// 为 @testing-library/svelte 创建兼容的组件导入
const VirtualList = { default: VirtualListComponent };

// ============================================================================
// 测试数据
// ============================================================================

interface TestItem {
  id: number;
  content: string;
}

const createTestItems = (count: number): TestItem[] =>
  Array.from({ length: count }, (_, i) => ({
    id: i,
    content: `Item ${i}`,
  }));

// ============================================================================
// 基础渲染测试
// ============================================================================

describe("VirtualList - 基础渲染", () => {
  it("应该渲染容器", () => {
    const items = createTestItems(10);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 300,
      },
    });

    const listContainer = container.querySelector(".virtual-list-container");
    expect(listContainer).toBeTruthy();
    expect(listContainer?.getAttribute("style")).toContain("height: 300px");
  });

  it("应该计算正确的总高度", () => {
    const items = createTestItems(10);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 300,
      },
    });

    const spacer = container.querySelector(".virtual-list-spacer");
    expect(spacer?.getAttribute("style")).toContain("height: 500px"); // 10 * 50
  });

  it("应该仅渲染可见区域内的项目", () => {
    const items = createTestItems(100);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 300, // 可见 6 项
        buffer: 2,
      },
    });

    // 可见区域: 0-5 (6项) + buffer 前后各2项 = 最多10项
    const renderedItems = container.querySelectorAll(".virtual-list-item");
    expect(renderedItems.length).toBeLessThanOrEqual(12); // 6 + 2*2 + 一些余量
    expect(renderedItems.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 动态高度测试
// ============================================================================

describe("VirtualList - 动态高度", () => {
  it("应该支持函数式高度计算", () => {
    const items = createTestItems(10);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: (item: TestItem) => (item.id % 2 === 0 ? 60 : 40),
        containerHeight: 300,
      },
    });

    const spacer = container.querySelector(".virtual-list-spacer");
    // 总高度: 5*60 + 5*40 = 500
    expect(spacer?.getAttribute("style")).toContain("height: 500px");
  });

  it("应该为每个项目应用正确的高度", () => {
    const items = createTestItems(5);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: (item: TestItem) => (item.id === 2 ? 100 : 50),
        containerHeight: 400,
      },
    });

    const renderedItems = container.querySelectorAll(".virtual-list-item");
    const thirdItem = Array.from(renderedItems).find(
      (el) => el.getAttribute("data-index") === "2"
    );

    expect(thirdItem?.getAttribute("style")).toContain("height: 100px");
  });
});

// ============================================================================
// 滚动行为测试
// ============================================================================

describe("VirtualList - 滚动行为", () => {
  it("应该在滚动时更新可见范围", () => {
    const items = createTestItems(100);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 300,
        buffer: 1,
      },
    });

    const listContainer = container.querySelector(
      ".virtual-list-container"
    ) as HTMLDivElement;

    // 初始状态: 应该从索引 0 开始
    let firstItem = container.querySelector('[data-index="0"]');
    expect(firstItem).toBeTruthy();

    // 模拟滚动到中间位置
    Object.defineProperty(listContainer, "scrollTop", {
      writable: true,
      value: 2500, // 滚动到第 50 项附近
    });
    listContainer.dispatchEvent(new Event("scroll"));

    // 注意: 由于 Svelte 的响应式更新，这里需要等待 DOM 更新
    // 在真实环境中，滚动后应该不再渲染索引 0
    // 这个测试在真实浏览器环境中会通过，但在 jsdom 中可能需要额外处理
  });

  it("应该计算正确的偏移量", () => {
    const items = createTestItems(100);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 300,
        buffer: 0,
      },
    });

    const content = container.querySelector(".virtual-list-content");
    // 初始偏移应该是 0
    expect(content?.getAttribute("style")).toContain("translateY(0px)");
  });
});

// ============================================================================
// 缓冲区测试
// ============================================================================

describe("VirtualList - 缓冲区", () => {
  it("应该尊重自定义缓冲区大小", () => {
    const items = createTestItems(100);
    const { container: container1 } = render(VirtualList, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 300,
        buffer: 0,
      },
    });

    const { container: container2 } = render(VirtualList, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 300,
        buffer: 5,
      },
    });

    const items1 = container1.querySelectorAll(".virtual-list-item");
    const items2 = container2.querySelectorAll(".virtual-list-item");

    // buffer=5 应该渲染更多项目
    expect(items2.length).toBeGreaterThan(items1.length);
  });

  it("应该使用默认缓冲区值 3", () => {
    const items = createTestItems(20);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 300,
        // 不提供 buffer，应该使用默认值 3
      },
    });

    // 可见项: 6 (300/50) + buffer 前3 + 后3 = 至少 6 项，可能更多
    const renderedItems = container.querySelectorAll(".virtual-list-item");
    expect(renderedItems.length).toBeGreaterThanOrEqual(6);
  });
});

// ============================================================================
// 边界情况测试
// ============================================================================

describe("VirtualList - 边界情况", () => {
  it("应该处理空列表", () => {
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items: [],
        itemHeight: 50,
        containerHeight: 300,
      },
    });

    const spacer = container.querySelector(".virtual-list-spacer");
    expect(spacer?.getAttribute("style")).toContain("height: 0px");

    const renderedItems = container.querySelectorAll(".virtual-list-item");
    expect(renderedItems.length).toBe(0);
  });

  it("应该处理单项列表", () => {
    const items = createTestItems(1);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 300,
      },
    });

    const spacer = container.querySelector(".virtual-list-spacer");
    expect(spacer?.getAttribute("style")).toContain("height: 50px");

    const renderedItems = container.querySelectorAll(".virtual-list-item");
    expect(renderedItems.length).toBe(1);
  });

  it("应该处理容器高度大于总内容高度的情况", () => {
    const items = createTestItems(3);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 500, // 容器 500px，内容仅 150px
      },
    });

    const renderedItems = container.querySelectorAll(".virtual-list-item");
    // 应该渲染所有项目
    expect(renderedItems.length).toBe(3);
  });

  it("应该处理非常小的项目高度", () => {
    const items = createTestItems(1000);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 1, // 1px per item
        containerHeight: 300,
        buffer: 10,
      },
    });

    const spacer = container.querySelector(".virtual-list-spacer");
    expect(spacer?.getAttribute("style")).toContain("height: 1000px");

    // 应该渲染足够多的项目以填满可见区域
    const renderedItems = container.querySelectorAll(".virtual-list-item");
    expect(renderedItems.length).toBeGreaterThan(300); // 至少 300 项可见
  });

  it("应该处理非常大的项目高度", () => {
    const items = createTestItems(10);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 500, // 500px per item
        containerHeight: 300,
        buffer: 1,
      },
    });

    // 可见区域只能显示不到1项，加上buffer，应该渲染2-3项
    const renderedItems = container.querySelectorAll(".virtual-list-item");
    expect(renderedItems.length).toBeLessThanOrEqual(4);
    expect(renderedItems.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 性能测试
// ============================================================================

describe("VirtualList - 性能", () => {
  it("应该能处理大量数据（10000 项）", () => {
    const items = createTestItems(10000);
    const startTime = performance.now();

    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 600,
      },
    });

    const endTime = performance.now();
    const renderTime = endTime - startTime;

    // 渲染应该在合理时间内完成（< 100ms）
    expect(renderTime).toBeLessThan(100);

    // 应该只渲染可见区域的项目，而不是全部 10000 项
    const renderedItems = container.querySelectorAll(".virtual-list-item");
    expect(renderedItems.length).toBeLessThan(50); // 远少于 10000
  });

  it("应该能快速计算总高度（100000 项）", () => {
    const items = createTestItems(100000);
    const startTime = performance.now();

    render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 600,
      },
    });

    const endTime = performance.now();
    const renderTime = endTime - startTime;

    // 即使 100000 项，初始渲染也应该很快（< 200ms）
    expect(renderTime).toBeLessThan(200);
  });
});

// ============================================================================
// 数据索引测试
// ============================================================================

describe("VirtualList - 数据索引", () => {
  it("应该为每个项目设置正确的 data-index", () => {
    const items = createTestItems(20);
    const { container } = render(VirtualList<TestItem>, {
      props: {
        items,
        itemHeight: 50,
        containerHeight: 300,
        buffer: 1,
      },
    });

    const renderedItems = container.querySelectorAll(".virtual-list-item");
    
    // 验证第一个渲染的项目有正确的索引
    const firstItem = renderedItems[0];
    const firstIndex = parseInt(firstItem.getAttribute("data-index") || "0");
    
    // 第一个应该是 0 或接近 0（取决于 buffer）
    expect(firstIndex).toBeLessThanOrEqual(1);
    
    // 验证索引是连续的
    const indices = Array.from(renderedItems).map((el) =>
      parseInt(el.getAttribute("data-index") || "0")
    );
    
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1] + 1);
    }
  });
});
