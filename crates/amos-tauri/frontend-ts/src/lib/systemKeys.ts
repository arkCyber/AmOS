/**
 * systemKeys.ts — which **physical keys the touch shell admits**, decided from the chrome
 * registry instead of from a second list (REQ-A335).
 *
 * Phase 3: 支持从键盘设置页面读取用户自定义配置。
 *
 * The problem this closes: `svelte/shellModules.ts` *is* the shell's shortcut table — its
 * overlay rows carry `shortcuts: [{ key: "F4" }]`, `[{ key: "Space", meta: true }]`,
 * `[{ key: "F3" }, { key: "Tab", meta: true }]`, and Control Center deliberately has none at
 * all ("macOS has no default key for Control Center, and inventing one would be a binding
 * nobody asked for"). `DesktopShell.svelte` and the **touch** shell now both match the
 * event against the **merged** bindings (`mergeOverlayBindings`: this table's defaults plus
 * the user's keyboard settings); before REQ-A394 the desktop side read the registry defaults
 * only, and the touch shell hard-coded Escape — so the same iPad that shows Spotlight /
 * Recents / App Library to a finger could not open a single one of them from an attached
 * keyboard, and Escape did
 * *less* than the platform back gesture (it closed overlays only, never left an app or edit
 * mode). Two paths for one intent, one of them silently empty — the same defect class as
 * REQ-A318's missing tablet DOM assertion and REQ-A319's unreachable `wm_open`.
 *
 * Two deliberate choices about *where* the truth lives:
 *   1. The registry arrives **as an argument** (`modules`), never as an import: `lib/` must
 *      not depend on `svelte/` (that would drag every widget component into a pure unit
 *      test), and the caller — `Shell.svelte` — already holds `SHELL_MODULES`.
 *   2. The id→intent mapping is **explicit and tiny**. The two shells do not share surface
 *      ids (`spotlight` is literally the same component, but the desktop's `launchpad` is the
 *      touch shell's App Library and `mission-control` is its Recents). Anything the registry
 *      may add later maps to `null` and is therefore *inert* here rather than mis-wired —
 *      the failure mode we prefer: a key that does nothing beats a key that does the wrong
 *      thing. `shell.svelte.test.ts` pins the mapping against the **real** registry, so a new
 *      overlay row cannot silently become dead on touch.
 */
import {
  formatShortcut,
  modulesFor,
  shortcutMatches,
  type ShellModule,
  type ShellShortcut,
  type ShortcutEvent,
} from "./shellModule";
import { mergeOverlayBindings, readKeyboardConfig } from "./keyboardConfig";

/** A surface the touch shell can open by key. */
export type TouchOverlay = "spot" | "recents" | "library";

/** What a keystroke asks the shell to do. */
export type ShellKeyIntent =
  /**
   * Go up one level: close the top overlay, else leave the app/library/edit surface.
   * `via` says **which spelling** asked, because the caller treats them differently: Escape is
   * the platform's own dismissal (kept available on every form, and on the lock screen it is
   * already a no-op), while ⌘[ is macOS's *application back* and therefore only admitted where
   * the touch shell is the navigation authority (REQ-A336).
   */
  | { kind: "dismiss"; via: "escape" | "cmd-bracket" }
  /** Open the target surface if it is closed, close it if it is open (registry semantics). */
  | { kind: "toggle"; target: TouchOverlay }
  /** Open the Settings app (⌘, — the desktop's "preferences" key, which *does* have a touch
   *  counterpart: Settings is a real app on every form factor). */
  | { kind: "settings" }
  /** Not ours — leave the keystroke alone. */
  | { kind: "none" };

/**
 * The touch shell's counterpart of a chrome-registry overlay id, or `null` when that row has
 * no touch-side equivalent (Control Center and Spaces are desktop-only surfaces).
 */
export function touchTargetForOverlay(id: string): TouchOverlay | null {
  // `spotlight` is the same component on both shells.
  if (id === "spotlight") return "spot";
  // The desktop's Mission Control (⌘Tab / F3) is the touch shell's app switcher.
  if (id === "mission-control") return "recents";
  // The desktop's Launchpad (F4) is the touch shell's App Library.
  if (id === "launchpad") return "library";
  return null;
}

/** One row of the shortcut panel: what to draw, and which i18n key names the surface. */
export interface TouchShortcutHint {
  /** Rendered keycaps — `formatShortcut` output, e.g. `"⌘Space"` or `"F3 / ⌘Tab"`. */
  keys: string;
  /** The **i18n key** of the surface this reaches. Never text: the panel is translated. */
  labelKey: string;
}

/** The label each touch surface already has (no new strings: the panel reuses the app's own). */
const TOUCH_LABEL_KEYS: Record<TouchOverlay, string> = {
  spot: "shell.search", // the Spotlight sheet's own name (`shell.searchPh` is its placeholder)
  recents: "shell.recents",
  library: "appLibrary.title",
};

/**
 * Get merged overlay bindings (user config + defaults).
 *
 * The merge rules live in `mergeOverlayBindings` so this admission (touch
 * shell) and the chrome keyboard shortcut panel (keyboardConfigHook) cannot
 * drift — one rule book, two callers.
 */
function getMergedOverlayBindings(modules: readonly ShellModule[]): Map<string, ShellShortcut[]> {
  return mergeOverlayBindings(modules, readKeyboardConfig());
}

/**
 * The shortcut panel's content, **generated** from the same two sources the engine reads
 * (REQ-A338).
 *
 * §16.4's boundary ⑤ was "the admission is undiscoverable", and iPadOS answers that with a panel
 * you get by holding ⌘. Building that panel from a hand-written list would have re-created the
 * exact defect REQ-A335 removed (a second place that knows the keys, free to drift) — so the
 * catalog walks the registry rows and `TOUCH_SYSTEM_SHORTCUTS` instead, and
 * `systemKeys.test.ts` pins the result. Adding a key anywhere therefore fails a test until the
 * panel is told about it.
 *
 * Phase 3: 现在从合并后的绑定中读取快捷键。
 *
 * Rows are: the platform's own navigation keys first (⌘[ / ⌘,), then the registry's overlay rows
 * in **registry order** (the same order the desktop chrome documents). A row with two bindings
 * shows both (`"F3 / ⌘Tab"`) — the desktop's tooltip shows only the first because it sits in a
 * tight menu; a panel whose whole job is teaching keys should not hide one that works.
 */
export function touchShortcutCatalog(modules: readonly ShellModule[]): TouchShortcutHint[] {
  const system = TOUCH_SYSTEM_SHORTCUTS.map(({ labelKey, shortcut }) => ({
    keys: formatShortcut(shortcut),
    labelKey,
  }));

  // Phase 3: 使用合并后的绑定
  const mergedBindings = getMergedOverlayBindings(modules);
  const overlays = modulesFor("overlay", modules)
    .map((m) => {
      const target = touchTargetForOverlay(m.id);
      const labelKey = target ? TOUCH_LABEL_KEYS[target] : null;
      if (!target || !labelKey) return null;

      // 从合并后的绑定中获取快捷键
      const shortcuts = mergedBindings.get(m.id);
      if (!shortcuts?.length) return null;

      return {
        keys: shortcuts.map((s) => formatShortcut(s)).join(" / "),
        labelKey,
      };
    })
    .filter((r): r is TouchShortcutHint => r !== null);

  return [...system, ...overlays];
}

/**
 * The **system spellings** the touch shell admits (REQ-A336).
 *
 * These are deliberately *not* in the chrome registry: the registry's overlay rows are about
 * "which key opens which surface", while these are the platform's own navigation keys. Their
 * modifier semantics are still not re-implemented — they go through the same
 * `shortcutMatches`, so Ctrl-as-⌘ and the exactness rule (Shift/Alt must match) hold here too.
 *
 * What is here, and why:
 *   * ⌘[ — macOS's spelling of **Back**. Same intent as Escape, one level up. It is gated by
 *     the caller to the non-desktop forms: on macOS the desktop shell has real windows, so its
 *     "back" is the window chrome, not this shell's stack.
 *   * ⌘, — **Preferences**. Of the four desktop system keys (`DesktopShell.handleSystemShortcut`:
 *     ⌘W / ⌘M / ⌘H / ⌘,) this is the only one with a real touch counterpart, because Settings
 *     is a real app on every form factor.
 *
 * What is **not** here, each for a reason (an audit, not an omission):
 *   * ⌘W "close window" — the touch shell has no windows. The only meaning left would be "close
 *     the app" (= go home), which `⌘[` / Escape already do. A key labelled "close window" that
 *     leaves the app would be a lie.
 *   * ⌘M "minimise" / ⌘H "hide app" — no windows, and iPadOS **owns ⌘H itself** (it is the
 *     system's Home shortcut); inventing a second meaning for a key the platform already claims
 *     is the kind of collision that only shows up on device.
 *   * ⌘] "Forward" — the shell's history has **no forward model**: rewinding pops our own
 *     entries and the next `pushState` truncates the browser's forward stack, so ⌘] would
 *     usually do nothing and occasionally lie about it. Not wired is the honest state; wiring
 *     it needs a real forward stack first.
 */
const TOUCH_SYSTEM_SHORTCUTS: ReadonlyArray<{
  intent: ShellKeyIntent;
  shortcut: ShellShortcut;
  /** The i18n key of what this key does, for the ⌘-hold panel (`touchShortcutCatalog`). */
  labelKey: string;
}> = [
  {
    intent: { kind: "dismiss", via: "cmd-bracket" },
    shortcut: { key: "[", meta: true },
    labelKey: "a11y.back",
  },
  {
    intent: { kind: "settings" },
    shortcut: { key: ",", meta: true },
    labelKey: "app.settings",
  },
];

/**
 * Turn a keystroke into an intent. Pure: no DOM, no shell state — the caller decides what
 * "dismiss" means at its own position (`lib/backNav.ts`) and whether the shell is in a state
 * where a surface may be opened at all (the lock screen is the caller's call, not this
 * function's).
 *
 * Phase 3: 现在使用合并后的绑定（用户自定义 + 系统默认）。
 */
export function shellKeyIntent(
  e: ShortcutEvent,
  modules: readonly ShellModule[],
): ShellKeyIntent {
  // 1. Stand-downs, in the order that keeps the rule honest: if the event was already
  //    handled, or is not a completed keystroke, it is not ours.
  if (e.defaultPrevented) return NONE;
  if (e.isComposing || e.key === "Process") return NONE;
  if (e.repeat) return NONE;

  // 2. Escape = "up one level" — the keyboard's spelling of the platform back gesture.
  //    Whether that does anything is the caller's decision (at home/lock it does nothing at
  //    all, and the caller must also let the event through then).
  if (e.key === "Escape") return { kind: "dismiss", via: "escape" };

  // 3. Phase 3: 使用合并后的绑定
  const mergedBindings = getMergedOverlayBindings(modules);

  // Walk the merged bindings and route a match to the touch target. We use the
  // shared `shortcutMatches` (case-insensitive letter folding included — see
  // `shellModule.normalizeKey`) instead of re-implementing the matcher here:
  // the same code that powers desktop chrome and the ⌘-hold panel catalog also
  // powers this admission, so the truth lives in one place.
  for (const [id, shortcuts] of mergedBindings) {
    for (const s of shortcuts) {
      if (!shortcutMatches(e, s)) continue;
      const target = touchTargetForOverlay(id);
      if (target) return { kind: "toggle", target };
    }
  }

  // 4. The platform's navigation keys (⌘[ / ⌘,), matched with the same rules.
  for (const { intent, shortcut } of TOUCH_SYSTEM_SHORTCUTS) {
    if (shortcutMatches(e, shortcut)) return intent;
  }
  return NONE;
}

const NONE: ShellKeyIntent = { kind: "none" };
