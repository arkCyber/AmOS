/**
 * Tests for filesA11y.ts — keyboard navigation and accessibility helpers.
 */
import { describe, test, expect } from "vitest";
import { navNext, createKeyboardHandler, entryAriaLabel, type A11yNavState } from "../filesA11y";

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
