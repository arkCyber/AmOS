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
  installMenuBarKeyboard,
  installMenuKeyboard,
  installTopBarMenuAxis,
  isContextMenuKey,
  menuBarTriggers,
  menuItems,
  nextMenuBarIndex,
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

/**
 * `installMenuKeyboard` answers "which row does this key move to" **once a menu is open**;
 * `isContextMenuKey` answers the question in front of it — "does this key open one". The pair is
 * the unit: a menu whose rows are walkable but which no key opens is exactly as unreachable as one
 * whose rows do nothing, and F-DEV-026 booked the harm as 「打不开也用不了」 while implementing
 * only 「用不了」. So the boundary of the chord is what these cases pin — bare F10 is *not* it.
 */
describe("isContextMenuKey — the chord that opens a context menu", () => {
  test("the ContextMenu key opens it, whatever the modifiers (that key means this and nothing else)", () => {
    expect(isContextMenuKey({ key: "ContextMenu" })).toBe(true);
    expect(isContextMenuKey({ key: "ContextMenu", ctrlKey: true })).toBe(true);
  });

  test("Shift+F10 is the other chord, and the key's case does not matter", () => {
    expect(isContextMenuKey({ key: "F10", shiftKey: true })).toBe(true);
    expect(isContextMenuKey({ key: "f10", shiftKey: true })).toBe(true);
  });

  test("bare F10 is NOT it — it is a different command, and claiming it would steal that press", () => {
    expect(isContextMenuKey({ key: "F10" })).toBe(false);
    expect(isContextMenuKey({ key: "F10", shiftKey: false })).toBe(false);
  });

  test("⌘ / Ctrl / ⌥ disqualify the chord: nobody defined those, so they are not ours to eat", () => {
    expect(isContextMenuKey({ key: "F10", shiftKey: true, metaKey: true })).toBe(false);
    expect(isContextMenuKey({ key: "F10", shiftKey: true, ctrlKey: true })).toBe(false);
    expect(isContextMenuKey({ key: "F10", shiftKey: true, altKey: true })).toBe(false);
  });

  test("every other key is left alone", () => {
    for (const key of ["F10 ", "Enter", "Escape", "Context", "F1", " "]) {
      expect(isContextMenuKey({ key, shiftKey: true })).toBe(false);
    }
  });
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

/**
 * Escape must not *strand* the keyboard (REQ-A1057). The panel unmounts on close, and the browser
 * parks focus on `<body>` when the focused element is removed — so the caller's `restoreFocusTo`
 * puts it back where the menu came from. The primitive owns the *when* (the Escape path, after
 * `onClose`); the caller owns the *where*.
 */
describe("installMenuKeyboard — Escape restores the focus (REQ-A1057)", () => {
  /** A trigger that stands in for whatever opened the menu. */
  function buildTrigger(): HTMLButtonElement {
    const t = document.createElement("button");
    t.setAttribute("data-testid", "opener");
    document.body.appendChild(t);
    return t;
  }

  test("Escape hands the focus to the caller's opener, after closing", () => {
    const trigger = buildTrigger();
    const menu = buildMenu(["only"]);
    const order: string[] = [];
    const off = installMenuKeyboard(menu, {
      onClose: () => order.push("close"),
      restoreFocusTo: () => {
        order.push("restore");
        return trigger;
      },
    });
    expect(document.activeElement?.getAttribute("data-testid"), "the first row").toBe("only");

    press(menu, "Escape");

    expect(order, "closed first, restored after").toEqual(["close", "restore"]);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("opener");
    off();
  });

  test("no opener asked for ⇒ the focus is not moved by us", () => {
    const menu = buildMenu(["only"]);
    const off = installMenuKeyboard(menu, { onClose: () => {} });
    press(menu, "Escape");
    // Nothing was restored, so the row is still the active element (the caller unmounts it).
    expect(document.activeElement?.getAttribute("data-testid")).toBe("only");
    off();
  });

  test("an opener that answers `null` is not an error (the element is gone)", () => {
    const menu = buildMenu(["only"]);
    const off = installMenuKeyboard(menu, { onClose: () => {}, restoreFocusTo: () => null });
    expect(() => press(menu, "Escape")).not.toThrow();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("only");
    off();
  });

  test("an Escape nobody claimed is not a restore either (no onClose ⇒ no claim)", () => {
    const trigger = buildTrigger();
    const menu = buildMenu(["only"]);
    const off = installMenuKeyboard(menu, { restoreFocusTo: () => trigger });
    const ev = press(menu, "Escape");
    expect(ev.defaultPrevented, "the key was left to the caller").toBe(false);
    expect(document.activeElement?.getAttribute("data-testid"), "and the focus was not taken").toBe(
      "only",
    );
    off();
  });
});

describe("nextMenuBarIndex — the bar's own axis (pure)", () => {
  test("ArrowRight / ArrowLeft step between the menus and wrap like macOS", () => {
    expect(nextMenuBarIndex("ArrowRight", 0, 5)).toBe(1);
    expect(nextMenuBarIndex("ArrowRight", 4, 5)).toBe(0); // the File→…→Help ring
    expect(nextMenuBarIndex("ArrowLeft", 0, 5)).toBe(4); // ← from File opens the last menu
    expect(nextMenuBarIndex("ArrowLeft", 3, 5)).toBe(2);
  });

  test("the row axis's keys are NOT owned here — Home / End are the menu's, not the bar's", () => {
    // The two-sided half of the split: `nextMenuIndex` owns these, so the bar must answer `null`
    // rather than let two layers decide one keypress.
    for (const key of ["Home", "End", "ArrowDown", "ArrowUp", "Tab", "Escape", "Enter", " "]) {
      expect(nextMenuBarIndex(key, 1, 5)).toBeNull();
    }
  });

  test("a bar with no menus, and an out-of-range index, are handled instead of throwing", () => {
    expect(nextMenuBarIndex("ArrowRight", 0, 0)).toBeNull();
    // A single-menu bar steps to itself in both directions (there is no neighbour to reach).
    expect(nextMenuBarIndex("ArrowRight", 0, 1)).toBe(0);
    expect(nextMenuBarIndex("ArrowLeft", 0, 1)).toBe(0);
    // An index past the end is clamped, like `nextMenuIndex` clamps its own.
    expect(nextMenuBarIndex("ArrowRight", 99, 3)).toBe(0);
    expect(nextMenuBarIndex("ArrowRight", -5, 3)).toBe(1);
  });
});

describe("installMenuBarKeyboard — the behaviour a bar gets", () => {
  /** A bar of `n` titles; the installer only needs the root to listen on. */
  function buildBar(n: number): HTMLElement {
    const bar = document.createElement("nav");
    for (let i = 0; i < n; i++) {
      const b = document.createElement("button");
      b.setAttribute("data-testid", `title-${i}`);
      bar.appendChild(b);
    }
    document.body.appendChild(bar);
    return bar;
  }

  test("a sidebar-left/right key reports the neighbour and claims the event", () => {
    const bar = buildBar(5);
    const moves: number[] = [];
    const off = installMenuBarKeyboard(bar, {
      currentIndex: () => 2,
      count: () => 5,
      onMove: (i) => moves.push(i),
    });
    const ev = press(bar, "ArrowRight");
    expect(moves).toEqual([3]);
    expect(ev.defaultPrevented, "claimed, so a surface behind cannot also move").toBe(true);
    off();
  });

  test("with NO menu open the axis does not exist — the first arrow must not open one", () => {
    // `nextMenuBarIndex` clamps an out-of-range index to 0, so a bar that is simply "not open"
    // (index −1) would otherwise have `→` reach in and open menu #1. macOS does nothing until a
    // menu is open, and the whole-bar owner installs once and relies on this guard.
    const bar = buildBar(5);
    const moves: number[] = [];
    const off = installMenuBarKeyboard(bar, {
      currentIndex: () => -1,
      count: () => 5,
      onMove: (i) => moves.push(i),
    });
    const ev = press(bar, "ArrowRight");
    expect(moves, "nothing opened").toEqual([]);
    expect(ev.defaultPrevented, "and the key was not claimed").toBe(false);
    off();
  });

  test("a key it does not own is left alone, and cleanup removes the listener", () => {
    const bar = buildBar(5);
    const moves: number[] = [];
    const off = installMenuBarKeyboard(bar, {
      currentIndex: () => 2,
      count: () => 5,
      onMove: (i) => moves.push(i),
    });
    expect(press(bar, "Home").defaultPrevented).toBe(false);
    expect(press(bar, "ArrowDown").defaultPrevented).toBe(false);
    expect(moves).toEqual([]);
    off();
    expect(press(bar, "ArrowRight").defaultPrevented).toBe(false);
    expect(moves).toEqual([]);
  });
});

describe("menuBarTriggers — the bar's menus, read back out of the DOM", () => {
  test("it finds every trigger that opens a role=menu, in DOM order, wherever it is owned", () => {
    const slot = document.createElement("div");
    slot.innerHTML = `
      <div data-testid="menu-apple"><button aria-haspopup="menu" aria-expanded="false">🍎</button></div>
      <span>not a trigger</span>
      <nav><button aria-haspopup="menu" aria-expanded="true">文件</button>
           <button aria-haspopup="menu" aria-expanded="false">编辑</button></nav>`;
    document.body.appendChild(slot);
    // The Apple trigger is a **sibling** of the <nav>, which is exactly the shape a per-component
    // list could not span — this is the pin that the ring is whole.
    expect(menuBarTriggers(slot).map((t) => t.textContent)).toEqual(["🍎", "文件", "编辑"]);
    slot.remove();
  });
});

describe("installTopBarMenuAxis — one owner, at most one menu open", () => {
  /** A bar with `titles` triggers that really toggle `aria-expanded` on click, like the widgets. */
  function buildRealBar(titles: string[]): HTMLElement {
    const slot = document.createElement("div");
    for (const title of titles) {
      const t = document.createElement("button");
      t.textContent = title;
      t.setAttribute("aria-haspopup", "menu");
      t.setAttribute("aria-expanded", "false");
      t.addEventListener("click", () => {
        const open = t.getAttribute("aria-expanded") === "true";
        t.setAttribute("aria-expanded", open ? "false" : "true");
      });
      slot.appendChild(t);
    }
    document.body.appendChild(slot);
    return slot;
  }

  test("→ from the first menu opens the second, and the first closes behind it", () => {
    const bar = buildRealBar(["🍎", "文件", "编辑"]);
    const off = installTopBarMenuAxis(bar);
    const [apple, file] = menuBarTriggers(bar);
    apple!.click(); // open 🍎, the way its own click handler does
    expect(apple!.getAttribute("aria-expanded")).toBe("true");

    const ev = press(apple!, "ArrowRight");
    expect(file!.getAttribute("aria-expanded"), "the neighbour opened").toBe("true");
    expect(apple!.getAttribute("aria-expanded"), "and 🍎 closed — one bar, one menu").toBe("false");
    expect(ev.defaultPrevented).toBe(true);
    off();
    bar.remove();
  });

  test("← from the first menu wraps to the last", () => {
    const bar = buildRealBar(["🍎", "文件", "编辑"]);
    const off = installTopBarMenuAxis(bar);
    const [apple, , edit] = menuBarTriggers(bar);
    apple!.click();
    press(apple!, "ArrowLeft");
    expect(edit!.getAttribute("aria-expanded")).toBe("true");
    expect(apple!.getAttribute("aria-expanded")).toBe("false");
    off();
    bar.remove();
  });

  test("nothing open: the axis does nothing", () => {
    const bar = buildRealBar(["🍎", "文件"]);
    const off = installTopBarMenuAxis(bar);
    const ev = press(bar, "ArrowRight");
    expect(menuBarTriggers(bar).every((t) => t.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(ev.defaultPrevented).toBe(false);
    off();
    bar.remove();
  });
});
