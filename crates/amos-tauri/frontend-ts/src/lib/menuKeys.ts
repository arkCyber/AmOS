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
 *
 * The **second axis** is the bar's: with a menu open, ←/→ walk the top-level menus. That axis is
 * not a menu's own, because the top bar's menus are owned by **two** components 🍎
 * (`TopbarAppleMenu`) and File…Help (`TopbarMainMenu`) — see [`installTopBarMenuAxis`], which is
 * the one owner spanning both. The decision there is pure too ([`nextMenuBarIndex`]), the rows-vs-
 * bar key split is explicit (Home/End stay with the rows), and the trigger list is read back out of
 * the DOM ([`menuBarTriggers`]) so a menu added later joins the ring with no second list.
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
 * **Escape must not strand the keyboard.** Closing a menu unmounts the panel, and the browser
 * parks focus on `<body>` when the focused element is removed — so the place the keyboard user was
 * standing is gone, and everything that focus was carrying stops answering. For the top bar that is
 * not cosmetic: its ←/→ ring listens on the bar, and a key event dispatched at `<body>` never
 * bubbles *through* the bar, so one press of Escape killed the ring until the user tabbed all the
 * way back. macOS returns the focus to the menu title; [`restoreFocusTo`] is how a caller says
 * where its menu came from. It is called **on the Escape path only** — a menu dismissed by a
 * pointer (an outside click) is followed by a click that owns the focus, and stealing it back would
 * be the bug, not the fix.
 *
 * Returns a cleanup function (Svelte: use it as a `use:` action's `destroy`).
 */
export function installMenuKeyboard(
  root: HTMLElement,
  opts: {
    onClose?: () => void;
    /**
     * The element to return the focus to when **Escape** dismisses this menu — normally the
     * trigger that opened it. Called after `onClose`, and only when the caller claimed Escape.
     */
    restoreFocusTo?: () => HTMLElement | null;
  } = {},
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (!opts.onClose) return; // nobody claimed Escape: let the caller's own handler run
      e.preventDefault();
      // Claimed here so the Dock's document-level listener does not ALSO try to close (it
      // would close a different menu — the one the shell thinks is open).
      e.stopPropagation();
      opts.onClose();
      // After the close, while the panel is still mounted: moving focus out *first* means the
      // panel's removal takes an unfocused element away, so the browser never falls back to
      // `<body>`. Doing it the other way round is exactly the stranding this option exists for.
      opts.restoreFocusTo?.()?.focus();
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

/**
 * The chord that **opens** a context menu: Shift+F10, or the dedicated ContextMenu key.
 *
 * [`installMenuKeyboard`] answers "which row does this key move to" *once a menu is open*; this
 * answers the question in front of it — "does this key open one". Both halves are needed, and the
 * first half alone is a trap: a menu whose rows are walkable but which no key opens is exactly as
 * unreachable to a keyboard user as one whose rows do nothing. (F-DEV-026 recorded the harm as
 * 「打不开也用不了」 and its fix implemented only 「用不了」.)
 *
 * The two chords are the APG context-menu pattern's, and they are the two macOS also answers.
 * Shift is required for F10 because **bare F10 is a different command** in this shell (it is the
 * menu-bar focus key on Windows/Linux, and the chrome keys are live here), so claiming it would
 * steal a press meant for something else. `ctrl`/`meta`/`alt` disqualify the chord for the same
 * reason — `⌘⇧F10` is not "open the context menu", it is a modifier shortcut nobody defined, and
 * eating it would break whatever does.
 *
 * The key is compared case-insensitively so a caller cannot be right on one layout and wrong on
 * another, and `ContextMenu` is matched literally — that name is what the UI Events spec gives the
 * dedicated key, and no layout translates it.
 */
export function isContextMenuKey(e: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (e.key === "ContextMenu") return true;
  return (
    e.key.toLowerCase() === "f10" &&
    Boolean(e.shiftKey) &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey
  );
}

/**
 * Where a **menu bar** key moves the *open menu*: ArrowLeft / ArrowRight step to the neighbouring
 * top-level menu and wrap at the ends, which is what macOS's menu bar does (from the File menu,
 * ArrowLeft opens Help).
 *
 * A second function, not a flag on [`nextMenuIndex`], because it answers a different question:
 * the row axis asks "which row of *this* menu", the bar axis asks "which menu". Two questions,
 * two answers — and the module header's rule is that one answer lives in one place.
 *
 * **Home / End are deliberately NOT owned here.** They are already the row axis's (`first`/`last
 * row of the open menu`), and that is the correct reading of the APG patterns: focus is *inside*
 * an open menu, so the menu's Home/End apply, not the menubar's. Letting this function claim them
 * would make two layers decide one keypress — exactly the fight the row axis's `stopPropagation`
 * exists to prevent. The `null` for every other key is the same contract as its sibling: the
 * caller touches nothing it does not own.
 *
 * `index` is the open menu's index; a caller with no menu open must not install this at all
 * (there is no "current menu" to step from).
 */
export function nextMenuBarIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const current = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    default:
      return null;
  }
}

/**
 * Wire a **menu bar** (the row of top-level menu titles) so ←/→ switch which menu is open, and
 * return the cleanup (a Svelte `$effect` return value).
 *
 * `root` is the bar element. The listener lives there rather than on the open panel because the
 * panel comes and goes while the bar stays, and because a row that is focused *inside* the panel
 * bubbles its unclaimed keys up through it — [`installMenuKeyboard`] claims only the row keys, so
 * ←/→ arrive here untouched.
 *
 * The bar does not decide *what opening a menu means*: `onMove` is the caller's (it owns the
 * `openId` state, and the panel that mounts then focuses its own first row). This function only
 * answers "the key means the next menu" and hands over the index.
 */
export function installMenuBarKeyboard(
  root: HTMLElement,
  opts: {
    /** The index of the currently open menu; the caller uninstalls this when none is open. */
    currentIndex: () => number;
    /** How many top-level menus the bar has. */
    count: () => number;
    /** Open the menu at `index` (the caller closes the previous one). */
    onMove: (index: number) => void;
  },
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // **The axis exists only while a menu is open.** A `currentIndex` of −1 means the bar has no
    // current menu, and `nextMenuBarIndex` clamps that to 0 — so without this guard the first
    // press of ←/→ on a bar with *nothing* open would reach in and open a menu (macOS does
    // nothing). Callers used to guarantee this by installing only while open; the whole-bar owner
    // below installs once and relies on this instead.
    const from = opts.currentIndex();
    if (from < 0) return;
    const next = nextMenuBarIndex(e.key, from, opts.count());
    if (next === null) return;
    e.preventDefault();
    // Claimed for the same reason as the row axis: a surface behind the bar must not ALSO move
    // on the same keypress.
    e.stopPropagation();
    opts.onMove(next);
  };
  root.addEventListener("keydown", onKeyDown);
  return () => root.removeEventListener("keydown", onKeyDown);
}

/**
 * The bar's top-level menus, in DOM order: the triggers that open a `role="menu"` panel.
 *
 * Derived from the DOM rather than handed over by a component, because this is the one bar whose
 * menus are owned by **two** components (`TopbarAppleMenu` and `TopbarMainMenu`). A list passed in
 * by either one is exactly how 🍎 came to sit outside the ring: the main menu owned the axis over
 * its own `<nav>`, and the Apple menu's trigger is a *sibling* of that `<nav>` — so ←/→ never saw
 * it, and ← from the first app menu wrapped past 🍎 to the last menu instead of reaching it.
 * Reading the triggers back out of the shared ancestor is what makes the ring whole, and it keeps
 * a menu added later (another registry row) inside the ring with no second list to update.
 */
export function menuBarTriggers(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]')];
}

/**
 * Give a whole menu bar its ←/→ axis over `root`: one owner, and **at most one menu open**.
 *
 * The two components keep their own open flags, so this does not lift their state — it expresses
 * the bar's rule through each trigger's own toggle, which is the same toggle the pointer path
 * uses (a click on an already-open trigger is a *close* in both components). That is why moving
 * off 🍎 closes it instead of leaving two panels on screen, and why the rule holds for a component
 * that stores "open" some other way.
 *
 * Safe to install once and leave installed: while nothing is open there is no current index, and
 * `installMenuBarKeyboard` refuses to move (see its guard). That is what lets the owner live at
 * the bar itself rather than being re-installed by whichever menu happens to be open.
 */
export function installTopBarMenuAxis(root: HTMLElement): () => void {
  const triggers = () => menuBarTriggers(root);
  return installMenuBarKeyboard(root, {
    currentIndex: () => triggers().findIndex((t) => t.getAttribute("aria-expanded") === "true"),
    count: () => triggers().length,
    onMove: (i) => {
      const list = triggers();
      const target = list[i];
      if (!target) return;
      for (const t of list) {
        if (t !== target && t.getAttribute("aria-expanded") === "true") t.click();
      }
      if (target.getAttribute("aria-expanded") !== "true") target.click();
    },
  });
}

