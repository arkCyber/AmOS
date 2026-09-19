/**
 * menuKeys.test.ts — keyboard navigation for the shell's pop-up menus (REQ-A436).
 *
 * Why it exists: the dock's menus were pointer-only. They rendered `role="menu"` rows and
 * Escape closed them, but **no key moved the focus between the rows**, so a keyboard user
 * could not use them at all — while macOS menus are fully keyboard driven.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  focusMenuItem,
  installMenuKeyboard,
  menuItems,
  nextMenuIndex,
} from "../lib/menuKeys";

/** A menu with `rows` entries; `disabled` lists the ones that must not be reachable. */
function buildMenu(rows: string[], disabled: string[] = []): HTMLElement {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  for (const id of rows) {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.setAttribute("data-testid", id);
    if (disabled.includes(id)) {
      b.disabled = true;
      b.setAttribute("aria-disabled", "true");
    }
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  return menu;
}

function press(target: EventTarget, key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
  target.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    /* already registered */
  }
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("nextMenuIndex — where a nav key goes (pure)", () => {
  test("ArrowDown / ArrowUp walk the rows and wrap like macOS", () => {
    expect(nextMenuIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextMenuIndex("ArrowDown", 2, 3)).toBe(0); // wraps
    expect(nextMenuIndex("ArrowUp", 0, 3)).toBe(2); // wraps
    expect(nextMenuIndex("ArrowUp", 1, 3)).toBe(0);
  });

  test("Home / End jump to the ends", () => {
    expect(nextMenuIndex("Home", 2, 4)).toBe(0);
    expect(nextMenuIndex("End", 0, 4)).toBe(3);
  });

  test("keys this module does not own, and empty menus, are left alone", () => {
    for (const key of ["Tab", "Escape", "Enter", "a", "ArrowLeft"]) {
      expect(nextMenuIndex(key, 0, 3), key).toBeNull();
    }
    expect(nextMenuIndex("ArrowDown", 0, 0)).toBeNull();
  });

  test("an out-of-range current index is clamped instead of throwing", () => {
    expect(nextMenuIndex("ArrowDown", 99, 3)).toBe(0); // clamped to the last row, then wraps
    expect(nextMenuIndex("ArrowUp", -5, 3)).toBe(2); // clamped to the first row, then wraps back
  });
});

describe("menuItems / focusMenuItem — the rows a menu offers", () => {
  test("disabled rows are skipped, in DOM order", () => {
    const menu = buildMenu(["show", "hide", "quit"], ["hide"]);
    expect(menuItems(menu).map((b) => b.dataset.testid)).toEqual(["show", "quit"]);
  });

  test("focusMenuItem clamps and reports what it focused", () => {
    const menu = buildMenu(["a", "b"]);
    expect(focusMenuItem(menu, 5)?.getAttribute("data-testid")).toBe("b");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("b");
    expect(focusMenuItem(buildMenu([]), 0)).toBeNull();
  });
});

describe("installMenuKeyboard — the behaviour a user gets", () => {
  test("opening a menu focuses its first row (macOS), skipping a greyed one", () => {
    const menu = buildMenu(["disabled-first", "real"], ["disabled-first"]);
    const off = installMenuKeyboard(menu, {});
    expect(document.activeElement?.getAttribute("data-testid")).toBe("real");
    off();
  });

  test("ArrowDown / ArrowUp / Home / End move the focus and consume the key", () => {
    const menu = buildMenu(["one", "two", "three"]);
    const off = installMenuKeyboard(menu, {});
    expect(document.activeElement?.getAttribute("data-testid")).toBe("one");

    expect(press(menu, "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("two");
    press(menu, "End");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("three");
    press(menu, "ArrowDown"); // wraps
    expect(document.activeElement?.getAttribute("data-testid")).toBe("one");
    press(menu, "ArrowUp"); // wraps back
    expect(document.activeElement?.getAttribute("data-testid")).toBe("three");
    press(menu, "Home");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("one");
    off();
  });

  test("Escape is handed to the menu's own closer and claimed (no double close)", () => {
    const menu = buildMenu(["only"]);
    let closed = 0;
    const off = installMenuKeyboard(menu, { onClose: () => closed++ });
    const ev = press(menu, "Escape");
    expect(closed).toBe(1);
    expect(ev.defaultPrevented).toBe(true);
    off();
  });

  test("without an onClose, Escape is left to the caller (no claim)", () => {
    const menu = buildMenu(["only"]);
    const off = installMenuKeyboard(menu, {});
    const ev = press(menu, "Escape");
    expect(ev.defaultPrevented).toBe(false);
    off();
  });

  test("a key the module does not own is untouched, and cleanup removes the listener", () => {
    const menu = buildMenu(["one", "two"]);
    const off = installMenuKeyboard(menu, {});
    expect(press(menu, "Tab").defaultPrevented).toBe(false);
    off();
    // After cleanup the arrows do nothing (the menu was unmounted anyway).
    focusMenuItem(menu, 0);
    expect(press(menu, "ArrowDown").defaultPrevented).toBe(false);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("one");
  });
});
