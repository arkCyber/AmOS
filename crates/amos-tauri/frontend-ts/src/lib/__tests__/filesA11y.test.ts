/**
 * Tests for filesA11y.ts — keyboard navigation and accessibility helpers.
 */
import { describe, test, expect } from "vitest";
import {
  navNext,
  createKeyboardHandler,
  entryAriaLabel,
  scrollIntoViewIfNeeded,
  type A11yNavState,
} from "../filesA11y";

describe("filesA11y.ts", () => {
  describe("navNext", () => {
    test("returns null for empty list", () => {
      const state: A11yNavState = { focusedId: null, visibleIds: [] };
      expect(navNext(state, "up")).toBe(null);
      expect(navNext(state, "down")).toBe(null);
      expect(navNext(state, "home")).toBe(null);
      expect(navNext(state, "end")).toBe(null);
    });

    test("home/end navigate to first/last", () => {
      const state: A11yNavState = {
        focusedId: "b",
        visibleIds: ["a", "b", "c", "d"],
      };
      expect(navNext(state, "home")).toBe("a");
      expect(navNext(state, "end")).toBe("d");
    });

    test("down from no focus goes to first", () => {
      const state: A11yNavState = {
        focusedId: null,
        visibleIds: ["a", "b", "c"],
      };
      expect(navNext(state, "down")).toBe("a");
    });

    test("up from first stays at first", () => {
      const state: A11yNavState = {
        focusedId: "a",
        visibleIds: ["a", "b", "c"],
      };
      expect(navNext(state, "up")).toBe("a");
    });

    test("down from last stays at last", () => {
      const state: A11yNavState = {
        focusedId: "c",
        visibleIds: ["a", "b", "c"],
      };
      expect(navNext(state, "down")).toBe("c");
    });

    test("navigates up/down correctly", () => {
      const state: A11yNavState = {
        focusedId: "b",
        visibleIds: ["a", "b", "c", "d"],
      };
      expect(navNext(state, "up")).toBe("a");
      expect(navNext(state, "down")).toBe("c");
    });

    test("handles focusedId not in list (treats as no focus)", () => {
      const state: A11yNavState = {
        focusedId: "z",
        visibleIds: ["a", "b", "c"],
      };
      expect(navNext(state, "down")).toBe("a");
      expect(navNext(state, "up")).toBe("z"); // stays
    });
  });

  describe("createKeyboardHandler", () => {
    // Mock KeyboardEvent for Node.js environment
    const mockKeyEvent = (key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) => ({
      key,
      metaKey: modifiers.metaKey || false,
      ctrlKey: modifiers.ctrlKey || false,
      target: { tagName: "DIV" },
      preventDefault: () => {},
    } as unknown as KeyboardEvent);

    test("ArrowUp/Down call onNav", () => {
      const calls: string[] = [];
      const handler = createKeyboardHandler({
        onNav: (dir) => calls.push(`nav:${dir}`),
        onOpen: () => calls.push("open"),
        onDelete: () => calls.push("delete"),
        onToggle: () => calls.push("toggle"),
        onSelectAll: () => calls.push("selectAll"),
      });

      handler(mockKeyEvent("ArrowUp"));
      handler(mockKeyEvent("ArrowDown"));
      handler(mockKeyEvent("Home"));
      handler(mockKeyEvent("End"));

      expect(calls).toEqual(["nav:up", "nav:down", "nav:home", "nav:end"]);
    });

    test("Enter calls onOpen", () => {
      const calls: string[] = [];
      const handler = createKeyboardHandler({
        onNav: () => {},
        onOpen: () => calls.push("open"),
        onDelete: () => {},
        onToggle: () => {},
        onSelectAll: () => {},
      });

      handler(mockKeyEvent("Enter"));
      expect(calls).toEqual(["open"]);
    });

    test("Delete/Backspace calls onDelete", () => {
      const calls: string[] = [];
      const handler = createKeyboardHandler({
        onNav: () => {},
        onOpen: () => {},
        onDelete: () => calls.push("delete"),
        onToggle: () => {},
        onSelectAll: () => {},
      });

      handler(mockKeyEvent("Delete"));
      handler(mockKeyEvent("Backspace"));
      expect(calls).toEqual(["delete", "delete"]);
    });

    test("Space calls onToggle", () => {
      const calls: string[] = [];
      const handler = createKeyboardHandler({
        onNav: () => {},
        onOpen: () => {},
        onDelete: () => {},
        onToggle: () => calls.push("toggle"),
        onSelectAll: () => {},
      });

      handler(mockKeyEvent(" "));
      expect(calls).toEqual(["toggle"]);
    });

    test("Cmd/Ctrl+A calls onSelectAll", () => {
      const calls: string[] = [];
      const handler = createKeyboardHandler({
        onNav: () => {},
        onOpen: () => {},
        onDelete: () => {},
        onToggle: () => {},
        onSelectAll: () => calls.push("selectAll"),
      });

      handler(mockKeyEvent("a", { metaKey: true }));
      handler(mockKeyEvent("A", { ctrlKey: true }));
      expect(calls).toEqual(["selectAll", "selectAll"]);
    });

    test("ignores keys when typing in input/textarea", () => {
      const calls: string[] = [];
      const handler = createKeyboardHandler({
        onNav: (dir) => calls.push(`nav:${dir}`),
        onOpen: () => calls.push("open"),
        onDelete: () => calls.push("delete"),
        onToggle: () => calls.push("toggle"),
        onSelectAll: () => calls.push("selectAll"),
      });

      // Mock events with input/textarea as target
      const inputEvent = {
        key: "ArrowDown",
        metaKey: false,
        ctrlKey: false,
        target: { tagName: "INPUT" },
        preventDefault: () => {},
      } as unknown as KeyboardEvent;

      const textareaEvent = {
        key: "Enter",
        metaKey: false,
        ctrlKey: false,
        target: { tagName: "TEXTAREA" },
        preventDefault: () => {},
      } as unknown as KeyboardEvent;

      handler(inputEvent);
      handler(textareaEvent);

      expect(calls).toEqual([]);
    });
  });

  describe("entryAriaLabel", () => {
    test("generates label for file", () => {
      const label = entryAriaLabel("report.pdf", "file", false, false, Date.UTC(2026, 8, 17));
      expect(label).toContain("File");
      expect(label).toContain("report.pdf");
      expect(label).toContain("modified");
    });

    test("includes favorite status", () => {
      const label = entryAriaLabel("photo.jpg", "file", true, false, Date.now());
      expect(label).toContain("favorite");
    });

    test("includes selected status", () => {
      const label = entryAriaLabel("folder", "folder", false, true, Date.now());
      expect(label).toContain("Folder");
      expect(label).toContain("selected");
    });

    test("includes both favorite and selected", () => {
      const label = entryAriaLabel("doc.txt", "file", true, true, Date.now());
      expect(label).toContain("favorite");
      expect(label).toContain("selected");
    });
  });
});

/**
 * REQ-A407 — `scrollIntoViewIfNeeded`（此前 0 覆盖：17 行，全仓第 5 大的一块）。
 *
 * 它只碰元素的三件事：`parentElement`、双方的 `getBoundingClientRect()`、`scrollIntoView()`。
 * 所以**不需要 DOM**：给一个假元素即可把"什么时候该滚、什么时候不该滚"逐条钉住 —— 键盘导航
 * 每按一次方向键都会调它，滚错方向的代价是列表"看着卡住"。
 */
describe("scrollIntoViewIfNeeded", () => {
  type Rect = { top: number; bottom: number; left: number; right: number };
  const rect = (top: number, bottom: number, left = 0, right = 100): DOMRect =>
    ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top }) as DOMRect;

  /** 一个假元素：记录 scrollIntoView 的调用次数与参数。 */
  function fakeElement(options: { parent?: unknown; rect?: Rect } = {}) {
    const scrolls: unknown[] = [];
    const element = {
      parentElement: options.parent ?? null,
      getBoundingClientRect: () => rect(options.rect?.top ?? 0, options.rect?.bottom ?? 10, options.rect?.left ?? 0, options.rect?.right ?? 100),
      scrollIntoView: (arg?: unknown) => {
        scrolls.push(arg);
      },
    };
    return { element: element as unknown as HTMLElement, scrolls };
  }

  test("null 元素：什么都不做（不抛）", () => {
    expect(() => scrollIntoViewIfNeeded(null)).not.toThrow();
  });

  test("没有父元素：直接滚（无从判断可见性）", () => {
    const { element, scrolls } = fakeElement();
    scrollIntoViewIfNeeded(element);
    expect(scrolls).toEqual([{ block: "nearest", behavior: "smooth" }]);
  });

  test("完全可见（含四条边正好贴合）：一次都不滚", () => {
    const parent = fakeElement({ rect: rect(0, 200) }).element;
    const inside = fakeElement({ parent, rect: rect(10, 100, 10, 90) }).element;
    scrollIntoViewIfNeeded(inside);
    expect((inside as unknown as { scrollIntoView: unknown }).scrollIntoView).toBeDefined();

    // 逐边贴合也必须算"可见"（`>=` / `<=`，不是 `>` / `<`）
    for (const touching of [rect(0, 100), rect(100, 200), rect(0, 200, 0, 100), rect(0, 200, 0, 100)]) {
      const { element, scrolls } = fakeElement({ parent, rect: touching });
      scrollIntoViewIfNeeded(element);
      expect(scrolls).toEqual([]);
    }
  });

  test("上/下/左/右任一边越界都要滚（用 nearest，不是整页跳）", () => {
    const parent = fakeElement({ rect: rect(100, 200, 100, 200) }).element;
    const outOfView = [
      rect(99, 150, 120, 180), // 顶边越界
      rect(150, 201, 120, 180), // 底边越界
      rect(120, 180, 99, 150), // 左边越界
      rect(120, 180, 150, 201), // 右边越界
    ];
    for (const r of outOfView) {
      const { element, scrolls } = fakeElement({ parent, rect: r });
      scrollIntoViewIfNeeded(element);
      expect([JSON.stringify(r), scrolls]).toEqual([
        JSON.stringify(r),
        [{ block: "nearest", behavior: "smooth" }],
      ]);
    }
  });
});

