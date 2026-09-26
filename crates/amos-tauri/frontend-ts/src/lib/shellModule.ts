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
import type { DesktopSystemIntent } from "../svelte/desktopSystemKeys";
// Type-only, so this edge is erased and does not close a runtime cycle with `snapZones.ts`
// (which imports this module's `ShellShortcut` / `shortcutMatches`): the zone type has **one**
// definition, in the table that owns the zones.
import type { SnapZone } from "./snapZones";
import type { StoreTile } from "./storeApps";

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
  defaultPrevented?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
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
  //   │ s.meta=true / s.ctrl=true       → matches metaKey AND ctrlKey        │
  //   │   (explicit "Ctrl AND ⌘" — both physical modifiers)                 │
  //   │ s.meta=undefined / s.ctrl=true  → matches ctrlKey only (Meta absent) │
  //   │   (Ctrl-only binding; matches our dormant `ctrl: true` branch)      │
  //   │ all other shapes                                                   → undef│
  //   └─────────────────────────────────────────────────────────────────────┘
  // The shell-chrome registry declares none after REQ-A297 phase-2 §2, so
  // only row 1 is live today; the other rows exist as the explicit "I really
  // mean Ctrl, not ⌘" escape hatch for future rows that need it.
  //
  // Row 2 used to *name* itself "Ctrl AND ⌘" while matching `metaKey` alone (REQ-A1568):
  // the name was the intent and the body was not it, so a `{ctrl, meta}` binding — the only
  // shape that can reach a chord the ⌘ family does not already own — fired on the bare ⌘
  // chord too. `lib/stageKeys.ts`'s ⌃⌘S is the first row to depend on it, and on the old body
  // it would also have swallowed every app's ⌘S.
  if (s.meta && s.ctrl) {
    if (!e.metaKey || !e.ctrlKey) return false;
  } else if (s.meta) {
    // Meta required, with Ctrl accepted in its place (non-Apple keyboards).
    if (!(e.metaKey || e.ctrlKey)) return false;
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
  /**
   * The **installed store apps**, as the shell loaded them (REQ-A1179).
   *
   * Not a capability like the rest of this handle, but the same single-owner rule: only the
   * shell starts `loadStoreTiles()` (it is the one component alive in every form factor), and
   * the desktop chrome — Dock, Launchpad, stage, Spotlight — draws the *same* layout the
   * touch shell draws. Reading the module cache directly would freeze each surface at
   * whatever the cache held when it mounted, and the load is async — so the list is pushed
   * down here the way the shell already pushes it to `HomeDock` / `RecentsPanel`.
   */
  storeTiles: readonly StoreTile[];
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
  /**
   * Act on the **focused app window**, the way the OS menu's window items do (REQ-A457).
   *
   * A **request, not a label**: the shell owns "which window is focused" (it polls
   * `wm_windows`), so a widget that resolved the label itself would be a second
   * implementation of the focus model (F-SH-005) — and the two would disagree the moment one
   * of them stopped polling. The shell then runs the *same* code path the native macOS menu's
   * `menu.zoom` / `menu.enter-fullscreen` items run (`DesktopShell::applyWindowAction`), so
   * the two menu surfaces cannot drift.
   *
   * "No app window is focused" (the launcher, or none open) means **nothing is sent**: the
   * launcher *is* the desktop, and zooming or full-screening it is not what the user asked for
   * (F-SH-008).
   */
  windowAction: (action: ShellWindowAction) => void;
  /**
   * Run a **focused-window** intent (close / hide) for the menu rows that act on "the
   * window you are looking at" — File ▸ Close Window and Window ▸ Minimize.
   *
   * Same contract as [`ShellChromeApi.windowAction`]: the widget sends the **intent**, not a
   * label, because the shell owns "which window is focused". These two rows used to send an
   * empty label (`wm_close` / `wm_hide` with `""`) on the belief that `""` was the macOS
   * "the front window" idiom — the host has no such idiom (`wm.rs::close_core` / `hide` look
   * the label up in `by_label`), so the command was refused and the row did nothing while the
   * matching ⌘W / ⌘M chord worked. Routing through the shell puts the rows on the chord's
   * own path (REQ-A424's stale-poll fallback and REQ-A430's refusal report included).
   */
  focusedWindowIntent: (intent: DesktopSystemIntent) => void;
  /**
   * Ask the shell for **one more window of the focused application** (File ▸ New Window,
   * and ⌘N — REQ-A473).
   *
   * A *request*, not a target: "which window is focused" is owned by the shell's single
   * `wm_windows` poll, and a widget that resolved it itself would be a second focus model
   * (the F-SH-005 shape). The shell resolves the app and reports a refusal, exactly as
   * [`ShellChromeApi.windowAction`] does for Zoom / Enter Full Screen.
   */
  newWindow: () => void;
  /**
   * Snap the **focused app window** to a named screen region (REQ-A816 — the `Window` menu's
   * zone rows).
   *
   * Same contract as [`ShellChromeApi.windowAction`]: a request, not a label, because the
   * shell owns "which window is focused". The shell routes it to the *same* `snapFocused` the
   * ⌃⌥ chords call, so the mouse path and the keyboard path are one implementation — including
   * the stale-poll retry (REQ-A424), the launcher-is-never-a-target rule (F-SH-008) and the
   * refusal report naming the zone (`snapRefusal`). It is deliberately **not** gated by
   * `AMOS_DESKTOP_SHORTCUTS`, which switches off the shell *taking over keys*; a menu row is a
   * click the user made on purpose, and the neighbouring Zoom / Minimize rows are not gated
   * either.
   *
   * `zone` is `amos_wm::snap::SnapZone`'s wire key, taken from `lib/snapZones.ts`'s table by
   * the caller — never a literal — so a menu row cannot name a region the host refuses.
   */
  snapWindow: (zone: SnapZone) => void;
  /**
   * Print the **focused app window** (REQ-A869 — File ▸ Print… / ⌘P).
   *
   * A request, not a target, for the reason every handle here states: the shell owns "which
   * window is focused", and only the **host** can act on that answer for printing. `window.print()`
   * is a call on the document that makes it, and the shell's only `menu-event` subscriber mounts
   * in the **launcher** window — so a DOM-level print from either menu surface would print the
   * desktop, not the app the user is looking at. The handle therefore routes to
   * `print_document` (`lib/print.ts`), which is zero-argument for exactly this reason (D2).
   *
   * The refusal is reported through [`printRefusalMessage`] (`lib/print.ts`), which names the
   * three `amos.print.*` codes rather than giving all of them one sentence.
   */
  printDocument: () => void;
  /**
   * Toggle **Stage Manager** (REQ-A1568 — the Window menu's row and the ⌃⌘S chord).
   *
   * A request with no argument, because the mode is the **host's** state: the shell reads it
   * (`stage_snapshot`), flips it and reports a refusal. A widget that passed `enabled` would
   * have to keep its own copy of the bit, and that copy goes stale the moment the rail's own
   * toggle changes it (the second-ledger shape this feature was built without).
   */
  toggleStage: () => void;
  /**
   * Lay every on-stage window out in a grid (REQ-A1568 — Window ▸ Tidy).
   *
   * Also argument-free, and for a stronger reason than [`toggleStage`]: the **on-stage set**
   * is derived by the host from the window model (`views_of`, the same rule the rail draws),
   * so the shell has no list to send — one it computed itself could only disagree with the
   * rail about which windows "Tidy" is about.
   */
  tidyStage: () => void;
}

/** The focused-window actions the in-app menu can request (see [`ShellChromeApi.windowAction`]). */
export type ShellWindowAction = "zoom" | "full-screen";

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
 * The overlay id `Escape` should close: the **last registered** layer in the stack.
 *
 * `openOverlays` is a list of ids the shell was asked to open — nothing more. A layer
 * whose id no registry row declares renders **nothing** (the renderer skips it), so
 * closing `openOverlays[openOverlays.length - 1]` blindly consumes one `Escape` press per
 * such entry and leaves the visible top layer open — exactly the "the panel is sticky"
 * symptom REQ-A414's hot-corner defect produced (`toggleOverlay("spaces")`, an id that
 * does not exist). Filtering by the registry makes the key act on something the user can
 * see, whatever ends up in the stack. Pure; the stack is not modified.
 */
export function topOverlay(stack: readonly string[], knownIds: readonly string[]): string | null {
  const known = new Set(knownIds);
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const id = stack[i];
    if (id !== undefined && known.has(id)) return id;
  }
  return null;
}

/**
 * The hint for the **first** binding of an already-merged row.
 *
 * 为什么是"一行绑定 → label/aria"而不是"注册表 + overlay id"：桌面壳**接受**的那些键
 * 是注册表默认 **+** 用户在键盘设置里的覆盖 **+** `null` 禁用合并后的结果
 * （`mergeOverlayBindings`，触摸壳的准入与 ⌘-hold 面板读的也是它）。提示如果只看得见
 * 注册表，就会出现"按钮说 ⌘Space、按下去什么都不开"（或反过来）—— 两者必须同源。
 * 这里只负责把一行绑定折成显示用的形状，行从哪里来由调用方决定。
 */
export function bindingHint(shortcuts: readonly ShellShortcut[] | undefined): ShortcutHint | null {
  const first = shortcuts?.[0];
  return first ? { label: formatShortcut(first), aria: shortcutAria(first) } : null;
}
