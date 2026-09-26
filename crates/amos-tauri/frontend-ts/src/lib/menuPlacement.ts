/**
 * menuPlacement.ts — where a **cursor-anchored** menu goes (REQ-A481).
 *
 * Why this module exists, from a real-device measurement rather than from taste: every menu in this
 * shell that is anchored at the pointer was placed with `left: x; top: y` and nothing else. The
 * Dock lives at the *bottom* of the shell window, so a right-click on a tile happens a few dozen
 * points above the window's bottom edge while `DockContextMenu`'s panel is ~223 pt tall: the panel
 * was drawn straight down, the window clipped it, and every row below the first
 * (新建窗口 / 显示 / 隐藏 / 选项… / 退出) was **invisible and unclickable**. Measured: panel rows
 * 868→1091 pt against a window whose bottom edge is 909 pt on a 967 pt screen — the pixels showed
 * wallpaper and the macOS Dock where the menu should have been.
 *
 * The accessibility tree could not have caught it either: AX reported all six rows with honest
 * frames. An accessibility frame is *DOM layout*; it says nothing about what the window can show.
 *
 * Rules, each with a reason:
 *
 *  * **Flip before clamping.** When there is no room below the pointer but there is above it, the
 *    menu is drawn *above* the pointer (macOS does the same). Sliding it up instead would detach
 *    the menu from the item the user clicked.
 *  * **Clamp as the fallback.** When neither side fits — a menu taller than the viewport — the top
 *    edge wins: a menu that must lose something loses its *last* rows, and the first rows are the
 *    ones a user needs first (the last row is usually the destructive one). So the panel is pinned
 *    to `margin` and allowed to overhang the bottom.
 *  * **`margin` on both axes.** A panel flush against an edge reads as cut off, and the pointer
 *    needs a couple of points of separation from the panel's own border.
 *  * **An unmeasured menu is not moved.** With `width`/`height` of 0 (jsdom, a component that has
 *    not painted yet) the anchor is returned unchanged: placing by guesswork is how this defect
 *    would come back. The component measures, the rule decides.
 */

/** The pointer position the menu is anchored to, in CSS pixels inside its viewport. */
export interface MenuAnchor {
  x: number;
  y: number;
}

/** The measured size of the panel that is about to be shown. */
export interface MenuSize {
  width: number;
  height: number;
}

/** The area the menu must stay inside — `window.innerWidth/innerHeight` for the shell. */
export interface MenuViewport {
  width: number;
  height: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  /** True when the menu is drawn above the pointer because there was no room below it. */
  flipped: boolean;
}

/** Distance kept from the viewport edges, in CSS pixels. */
export const MENU_MARGIN = 8;

/**
 * Clamp one axis into `[margin, limit - margin]`, where `limit` is the largest coordinate that
 * still keeps the panel inside the viewport (`viewport − panel size`).
 *
 * A **margin can never push a panel out of the viewport**: when the panel is wider than the room
 * the margin would demand, the margin loses (the panel ends up flush, `limit`), and when the panel
 * is wider than the viewport itself, `limit` is negative and that is the answer — the panel's right
 * edge is aligned with the viewport's right edge, deterministically, rather than by accident.
 * (Caught by this module's own test: a 2000 pt margin must not place a menu at x=2000.)
 */
function clampAxis(value: number, limit: number, margin: number): number {
  if (!Number.isFinite(limit)) return value;
  const low = Math.min(margin, limit);
  const high = Math.max(low, limit - margin);
  return Math.min(Math.max(value, low), high);
}

/**
 * Place a cursor-anchored menu inside `viewport`.
 *
 * Pure: the same anchor, size and viewport always give the same answer, which is what makes the
 * clipping defect testable without a browser (`src/__tests__/menuPlacement.test.ts`).
 */
export function placeMenu(
  anchor: MenuAnchor,
  menu: MenuSize,
  viewport: MenuViewport,
  margin: number = MENU_MARGIN,
): MenuPlacement {
  if (menu.width <= 0 || menu.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { left: anchor.x, top: anchor.y, flipped: false };
  }
  const left = clampAxis(anchor.x, viewport.width - menu.width, margin);
  const bottomLimit = viewport.height - menu.height;
  const fitsBelow = anchor.y + menu.height + margin <= viewport.height;
  if (fitsBelow) return { left, top: anchor.y, flipped: false };
  const above = anchor.y - menu.height - margin;
  if (above >= 0) return { left, top: above, flipped: true };
  // Neither side fits. The panel keeps its *first* rows on screen (the last row is usually the
  // destructive one) and overhangs the bottom: slide it up as far as it fits, but never past the
  // top margin — and if it is taller than the viewport, the top margin is all it gets.
  return { left, top: Math.max(margin, Math.min(anchor.y, bottomLimit - margin)), flipped: false };
}

/**
 * Measure `el` and place it at `(x, y)` inside the current window.
 *
 * The component-facing half of the rule: it reads the panel's *rendered* size (which depends on how
 * many rows the menu has — the Dock's menu is a different height when the app is running) and the
 * window it must stay inside, then hands both to {@link placeMenu}.
 */
export function placeMenuAt(
  el: HTMLElement,
  x: number,
  y: number,
  win: { innerWidth: number; innerHeight: number } = window,
): MenuPlacement {
  return placeMenu(
    { x, y },
    { width: el.offsetWidth, height: el.offsetHeight },
    { width: win.innerWidth, height: win.innerHeight },
  );
}
