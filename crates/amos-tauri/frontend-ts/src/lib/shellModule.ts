/**
 * shellModule.ts — the contract a **desktop shell chrome widget** implements.
 *
 * Why this exists: `appRegistry.ts` already made *app screens* modular (id →
 * dynamic import, one entry per screen), but the chrome **around** them was not.
 * `DesktopShell.svelte` statically imported the whole shell and `TopBar.svelte`
 * hard-coded its five right-hand widgets — so "which widgets exist, and in what
 * order" lived in a Svelte template instead of in data. That is the part of a
 * complex desktop UI that rots: every new indicator is an edit inside the bar,
 * every widget's test has to mount the whole bar, and two people cannot touch two
 * widgets at once.
 *
 * The split borrowed from the COSMIC desktop (`pop-os/cosmic-panel` +
 * `cosmic-applets`) is the **panel ↔ applet** one: a *container* owns layout,
 * ordering and config; each *widget* owns its own data, rendering and tests, and
 * gets a small handle to ask the container for things. What is deliberately **not**
 * borrowed is their process model — there an applet is a separate process drawing
 * a Wayland layer-shell surface, which buys crash isolation and a stable
 * third-party ABI; here every widget is a component inside the one already
 * sandboxed WebView per window, so a process per widget would cost memory and IPC
 * for a property we do not need. See `docs/PC_DESKTOP_ARCHITECTURE.md` §4.11.
 *
 * Pure data + pure functions: no Svelte, no IPC — the registry and its ordering
 * are unit-testable without rendering anything.
 *
 * Round 2 (REQ-A262) finished the story the first round only started: **all five
 * slots are now rendered by a container from this table** (top bar left/right, the
 * stage, the dock, the overlays) and the **overlay list is also the shortcut list** —
 * F4 / ⌘Space / F3 / ⌘Tab are matched out of the same entries the shell renders,
 * instead of a `switch` in the key handler next to a comment claiming the bindings
 * exist (`lib/shellChrome.ts` said "⌘Space/F4 are bound" while F4 was bound nowhere).
 */
import type { Component } from "svelte";

/**
 * Where a widget can live. Exactly one container renders each slot:
 * `topbar-left` + `topbar-right` → `TopBar.svelte`, `stage` → `DesktopStage.svelte`,
 * `dock` → `Dock.svelte`, `overlay` → `DesktopShell.svelte`.
 */
export type ShellSlot = "topbar-left" | "topbar-right" | "stage" | "dock" | "overlay";

/**
 * A key binding, as **data**: one entry serves both the matcher (below) and the
 * label a user reads (⌘Space), so the two can never disagree — which is exactly how
 * the "F4 is bound" claim in the docs drifted away from the code.
 *
 * No i18n key: a shortcut label is Apple's glyph vocabulary (⌘ ⇧ ⌥ ⌃ ⇥), the same
 * string in every language, and it is *derived* from the fields here rather than
 * spelled a second time.
 */
export interface ShellShortcut {
  /** `KeyboardEvent.key`, normalised — `"Space"`, not `" "` (see `normalizeKey`). */
  key: string;
  /** ⌘ on an Apple keyboard (`ctrlKey` counts too — the shell already treated it so). */
  meta?: boolean;
  /** Control key (⌃), distinct from meta for Spaces navigation. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** The structural slice of a `KeyboardEvent` the matcher needs (no DOM in this file). */
export interface ShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * What a shortcut label shows for a key. Only the keys the chrome binds need an
 * entry; anything else renders as-is (`F4`), which is already how a user writes it.
 */
const KEY_GLYPHS: Record<string, string> = {
  Space: "Space",
  Tab: "⇥",
  Enter: "↩",
  Escape: "⎋",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
};

/** `" "` (what a browser reports for the space bar) → `"Space"`; everything else untouched. */
export function normalizeKey(key: string): string {
  const k = key === " " || key === "Spacebar" ? "Space" : key;
  // FMEA finding: `KeyboardEvent.key` for letter keys is lowercase ("w"), but
  // human-written shortcuts are uppercase ("W"). Normalise to upper so a ⌘W typed
  // by a real user matches a `closeWindow: { key: "W", meta: true }` binding.
  // Function keys ("F1"…F24), arrows, named keys ("Tab"/"Enter"/"Escape") are
  // already case-stable, so this only widens letter matching without shifting them.
  return k.length === 1 ? k.toUpperCase() : k;
}

/**
 * Does this event trigger this shortcut? **Strict**: an unmodified `F4` must not fire
 * on ⌘F4, so every modifier the binding does not list must be absent.
 */
export function shortcutMatches(e: ShortcutEvent, s: ShellShortcut): boolean {
  // Both sides are run through `normalizeKey` so a single-letter binding declared
  // either case ("W" or "w") matches a typed event whose `key` is always the
  // browser's lowercased form. `normalizeKey` is also responsible for " "→"Space".
  if (normalizeKey(e.key) !== normalizeKey(s.key)) return false;
  // **REQ-A297 phase-2 §2 (compat policy)**. The shell chrome has always
  // counted an external keyboard's `Ctrl` as equivalent to ⌘ for the four
  // documented overlay launches (Spotlight / Mission Control / Launchpad) so
  // users without an Apple keyboard still get the registry to fire. This is
  // load-bearing: `shellModule.test.ts` pins the matcher against the binding
  // set `["F3", "F4", "Meta+Space", "Meta+Tab"]`, and breaking ctrlKey→⌘
  // equivalence would silently expand the set.
  //
  // Two modifier checks, one truth-table:
  //   ┌─────────────────────────────────────────────────────────────────────┐
  //   │ s.meta=true / s.ctrl=undefined  → matches metaKey OR ctrlKey        │
  //   │   (legacy Apple-binding: ctrlKey is treated as ⌘)                    │
  //   │ s.meta=true / s.ctrl=true       → matches metaKey only               │
  //   │   (explicit "Ctrl AND ⌘", reserved for future use)                  │
  //   │ s.meta=undefined / s.ctrl=true  → matches ctrlKey only (Meta absent) │
  //   │   (Ctrl-only binding; matches our dormant `ctrl: true` branch)      │
  //   │ all other shapes                                                   → undef│
  //   └─────────────────────────────────────────────────────────────────────┘
  // The shell-chrome registry declares none after REQ-A297 phase-2 §2, so
  // only row 1 is live today; the other rows exist as the explicit "I really
  // mean Ctrl, not ⌘" escape hatch for future rows that need it.
  if (s.meta) {
    // Meta required. Implicit-Ctrl-as-Meta is on unless the binding opted
    // out by also setting `ctrl: true`.
    const ctrlAsMeta = !s.ctrl;
    const metaHits = Boolean(e.metaKey || (ctrlAsMeta && e.ctrlKey));
    if (!metaHits) return false;
  } else if (s.ctrl) {
    // Pure Ctrl binding: requires ctrlKey, forbids metaKey.
    if (!e.ctrlKey || e.metaKey) return false;
  } else {
    // Binding declares no modifier at all — the user must not have hit Meta
    // or Ctrl either, or it would be hijacked by a more specific row.
    if (e.metaKey || e.ctrlKey) return false;
  }
  if (Boolean(s.shift) !== Boolean(e.shiftKey)) return false;
  if (Boolean(s.alt) !== Boolean(e.altKey)) return false;
  return true;
}

/** The human label for a binding: `"⌘Space"`, `"⇥"`, `"F4"`. Modifier order is Apple's. */
export function formatShortcut(s: ShellShortcut): string {
  let out = "";
  if (s.ctrl) out += "⌃";
  if (s.alt) out += "⌥";
  if (s.shift) out += "⇧";
  if (s.meta) out += "⌘";
  return out + (KEY_GLYPHS[s.key] ?? s.key);
}

/**
 * The same binding for `aria-keyshortcuts` (WAI-ARIA spelling: `"Meta+Space"`), so a
 * screen reader can announce it — a tooltip alone is invisible to one.
 */
export function shortcutAria(s: ShellShortcut): string {
  const parts: string[] = [];
  if (s.ctrl) parts.push("Control");
  if (s.alt) parts.push("Alt");
  if (s.shift) parts.push("Shift");
  if (s.meta) parts.push("Meta");
  parts.push(s.key);
  return parts.join("+");
}

/** What a widget shows for its own shortcut: a tooltip label plus the ARIA form. */
export interface ShortcutHint {
  label: string;
  aria: string;
}

/**
 * What a chrome widget may ask the shell to do.
 *
 * A **handle, not the shell**: a widget cannot reach `shellState`, the layout
 * snapshot or another widget through it. Every capability here is an intent the
 * shell translates into what it already does, and the handle is provided **once, by
 * the shell** (`DesktopShell.svelte`) — not by each container. That correction to
 * round 1 matters: `lockScreen` is something only the shell can do (it owns
 * `shellState`), so a handle per container would have meant two implementations of
 * the same capability set and a widget whose behaviour depended on which slot it was
 * placed in.
 */
export interface ShellChromeApi {
  /** Ask for the Launchpad overlay. */
  openLaunchpad: () => void;
  /** Ask for the Spotlight overlay. */
  openSpotlight: () => void;
  /** Ask the shell for the lock screen (the Apple menu's 锁定屏幕). */
  lockScreen: () => void;
  /**
   * The shortcut of an overlay, for a tooltip / `aria-keyshortcuts`
   * (`overlayId` is the registry id, e.g. `"spotlight"`). `null` when that overlay
   * has no binding — a widget must render no hint rather than invent one.
   */
  overlayShortcut: (overlayId: string) => ShortcutHint | null;
  /**
   * Show an overlay, or hide it if it is already up.
   *
   * This is what a **panel** trigger needs (macOS's Control Center item toggles its own
   * popover; a trigger that can only open leaves a panel the user cannot dismiss with the
   * same click). `overlayId` is a registry id.
   */
  toggleOverlay: (overlayId: string) => void;
  /**
   * Is that overlay currently up?
   *
   * Read-only, and deliberately part of the handle: a trigger must be able to say so
   * (`aria-expanded`) instead of showing a state that may be wrong — an icon that never
   * looks pressed while its panel is open is the same family as an inert control
   * (`docs/FMEA.md` F-SH-001).
   */
  isOverlayOpen: (overlayId: string) => boolean;
}

/**
 * The context key the shell provides and widgets read (`getContext`).
 *
 * Deliberately **not** named `amos.*`: that namespace is reserved for SharedStore
 * keys, and `scripts/store-scan.mjs` (rightly) treats every `"amos.*"` literal in
 * production as a store key that must be classified. A Svelte context is not store
 * state — nothing persists, nothing syncs across windows — so it must not borrow the
 * namespace and force an exemption.
 */
export const SHELL_CHROME_API = Symbol("shellChromeApi");

/** One chrome widget in the registry. */
export interface ShellModule {
  /** Stable id — what a test, a scan and (later) a config refer to. */
  id: string;
  slot: ShellSlot;
  /** Ascending within the slot; equal orders keep registry order (stable sort). */
  order: number;
  /** i18n key for the widget's human-readable name (never a literal — `i18n-scan`). */
  titleKey: string;
  /** `data-testid` on the widget's root, so tests address widgets, not glyphs. */
  testId: string;
  /**
   * The component to render — **eager, on purpose**. Chrome is always on screen:
   * a code-split chunk would fetch on first paint and shift the bar (the
   * `appRegistry` laziness is right for app screens, which are opened per app and
   * may never be opened at all).
   */
  component: Component;
  /**
   * Keys that toggle this widget's surface. **Overlay slot only** in practice: the
   * shell matches these *and* lists them, and the first entry is the one a trigger
   * shows. Two entries exist for one overlay where macOS has two bindings for the
   * same thing (F3 and ⌘Tab both open Mission Control on a Mac).
   */
  shortcuts?: readonly ShellShortcut[];
  /**
   * **Dock slot only.** Draw the dock's separator *before* this widget. macOS puts
   * one separator between the apps and the Trash; keeping it in the table (instead of
   * an `{#if}` in the template) is what lets the item order and the grouping be read
   * off one screen.
   */
  separatorBefore?: boolean;
  /**
   * **Dock slot only.** The window label whose `wm_windows` state draws this item's
   * running dot. Absent ⇒ this dock item never shows one: Launchpad is not a window,
   * and the Trash has nothing to run. (Without this the container would have to guess
   * from the module id, which is a layout id — `dock-finder` is not a window label.)
   */
  windowLabel?: string;
}


/**
 * The modules of one slot, in render order. Pure; ties keep registry order, so
 * the bar does not reshuffle when two widgets declare the same `order`.
 */
export function modulesFor<T extends ShellModule>(slot: ShellSlot, modules: readonly T[]): T[] {
  return modules
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.slot === slot)
    .sort((a, b) => a.m.order - b.m.order || a.index - b.index)
    .map(({ m }) => m);
}

/**
 * The module in `slot` whose binding this event triggers, or `undefined`.
 *
 * This is the whole shortcut layer: the shell's key handler calls it and does whatever
 * the returned module says (`toggle` its overlay), so **adding a binding is a row in
 * the registry** and cannot disagree with the list the UI shows. It searches in render
 * order, so the first match wins deterministically when two modules claim one key.
 */
export function moduleForShortcut<T extends ShellModule>(
  slot: ShellSlot,
  modules: readonly T[],
  e: ShortcutEvent,
): T | undefined {
  return modulesFor(slot, modules).find((m) => m.shortcuts?.some((s) => shortcutMatches(e, s)));
}

/**
 * The shortcut hint for an overlay id (`"spotlight"` → `{ label: "⌘Space", aria:
 * "Meta+Space" }`), or `null` when that overlay exists with no binding **or** does not
 * exist at all.
 *
 * One implementation for every trigger that shows a hint (the top bar's Launchpad /
 * Spotlight widgets and the Dock's Launchpad item), because "which key opens what" is
 * exactly the fact that used to live in a comment.
 */
export function overlayShortcutHint<T extends ShellModule>(
  modules: readonly T[],
  overlayId: string,
): ShortcutHint | null {
  const overlay = modulesFor("overlay", modules).find((m) => m.id === overlayId);
  const first = overlay?.shortcuts?.[0];
  return first ? { label: formatShortcut(first), aria: shortcutAria(first) } : null;
}
