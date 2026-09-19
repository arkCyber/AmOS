/**
 * menuKeys.ts — keyboard navigation for the shell's pop-up menus (REQ-A436).
 *
 * The dock's menus (`DockContextMenu`, `DockGlobalContextMenu`, `DockOverflowMenu`) were
 * pointer-only: they render `role="menu"` + `role="menuitem"` buttons, Escape closed them (the
 * Dock's own document listener), and **nothing moved the focus between the rows**. macOS menus
 * are fully keyboard driven — the arrow keys walk the rows, Home/End jump to the ends, and the
 * menu opens with its first row focused — so a keyboard user (or anyone who right-clicks and
 * then reaches for the arrows) had no way through them.
 *
 * One implementation for every menu, for the usual reason: three copies of "where does
 * ArrowDown go" is how the three menus start disagreeing. The *decision* is pure
 * ([`nextMenuIndex`]); the DOM part only asks the menu which rows it offers
 * ([`menuItems`] — enabled `role="menuitem"` buttons, in DOM order, so a greyed row is skipped
 * rather than focused-and-dead) and moves focus.
 *
 * Not a focus trap: Tab leaves the menu on purpose (a pop-up is not a dialog), and the caller
 * keeps owning "what does Escape mean" (`onClose`), so a menu cannot close a different menu.
 */

/**
 * Where a nav key moves the focus inside a menu of `count` rows currently at `index`.
 *
 * `null` for a key this module does not own, and for an empty menu (there is nowhere to go).
 * Wrapping matches macOS: ArrowDown on the last row goes back to the first.
 */
export function nextMenuIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const current = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * The rows a menu offers to the keyboard: its **enabled** `menuItem*` buttons, in DOM order.
 *
 * The selector is a **prefix** match on purpose: a menu's rows are not all `role="menuitem"` —
 * the Dock's preferences panel uses `menuitemradio` for its position/magnification choices
 * (that is the correct ARIA role for them), and a selector that only knew `menuitem` would
 * hand the keyboard an empty list for exactly those menus. Disabled rows are skipped rather
 * than focused-and-dead (the same rule `lib/shellChrome.ts` states for the visual state,
 * applied to the keyboard).
 */
export function menuItems(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].filter(
    (el) => !el.disabled && el.getAttribute("aria-disabled") !== "true",
  );
}

/** Focus the row at `index` (clamped). Returns the element it focused, or `null`. */
export function focusMenuItem(root: ParentNode, index: number): HTMLElement | null {
  const items = menuItems(root);
  const target = items[Math.min(Math.max(index, 0), items.length - 1)];
  if (!target) return null; // an empty menu (or only disabled rows): nothing to focus
  target.focus();
  return target;
}

/**
 * Wire a menu element for keyboard use: focus its first row, then walk the rows with the arrow
 * keys / Home / End, and hand Escape to `onClose`.
 *
 * Returns a cleanup function (Svelte: use it as a `use:` action's `destroy`).
 */
export function installMenuKeyboard(
  root: HTMLElement,
  opts: { onClose?: () => void } = {},
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (!opts.onClose) return; // nobody claimed Escape: let the caller's own handler run
      e.preventDefault();
      // Claimed here so the Dock's document-level listener does not ALSO try to close (it
      // would close a different menu — the one the shell thinks is open).
      e.stopPropagation();
      opts.onClose();
      return;
    }
    const items = menuItems(root);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextMenuIndex(e.key, index, items.length);
    if (next === null) return;
    const target = items[next];
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    target.focus();
  };
  root.addEventListener("keydown", onKeyDown);
  // macOS opens a menu with its first row focused; the right-click already moved the user's
  // attention here, so this is where the focus belongs.
  focusMenuItem(root, 0);
  return () => root.removeEventListener("keydown", onKeyDown);
}

/** Svelte action form, so a component can write `use:menuKeyboard={{ onClose }}`. */
