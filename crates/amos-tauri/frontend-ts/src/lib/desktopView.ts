/**
 * desktopView.ts — desktop view toggles (REQ-A275).
 *
 * Three boolean toggles wired through `amos.settings.view` so the View menu and the
 * desktop stage agree on what is currently shown:
 *   • `showWallpaper` — the Backdrop is rendered when true.
 *   • `showIcons`     — the desktop icon grid is rendered when true.
 *   • `showStageWidgets` — registered stage widgets (clock) render when true.
 *
 * Why a single object in one store key (not three separate keys):
 *   the menu writes them atomically; readers (Backdrop, DesktopStage) get one
 *   subscription per logical setting and the JSON shape cannot drift between
 *   callers (a future "Reset to defaults" can `writeView({ ...defaults })`).
 *
 * Defaults are `true` for every toggle — the desktop is meant to *show* things,
 * and a menu that defaults to "hidden wallpaper" would be a UI that surprises a
 * user who never asked for it. A missing/corrupt JSON falls back to all-true.
 *
 * Pure data + a thin bridge wrapper — no Svelte runes here. The desktop shell
 * components subscribe through `createStoreValue` in their own context, so this
 * module stays framework-agnostic and unit-testable.
 */
import { readStoreValue, writeStoreValueChecked } from "./amosStore";
import { amosWarn } from "./debugLog";

export type DesktopView = {
  showWallpaper: boolean;
  showIcons: boolean;
  showStageWidgets: boolean;
};

export const DESKTOP_VIEW_KEY = "amos.settings.view";

export const DEFAULT_DESKTOP_VIEW: DesktopView = {
  showWallpaper: true,
  showIcons: true,
  showStageWidgets: false, // macOS桌面不在右上角显示时钟，时间显示在顶栏
};

/** What a single View-menu row toggles. */
export type ViewToggle = "wallpaper" | "icons" | "stageWidgets";

/** Read the current view (or the documented defaults). Pure: no I/O on parse. */
export function readDesktopView(): DesktopView {
  const v = readStoreValue<Partial<DesktopView>>(DESKTOP_VIEW_KEY, {});
  return {
    showWallpaper: v.showWallpaper ?? DEFAULT_DESKTOP_VIEW.showWallpaper,
    showIcons: v.showIcons ?? DEFAULT_DESKTOP_VIEW.showIcons,
    showStageWidgets:
      v.showStageWidgets ?? DEFAULT_DESKTOP_VIEW.showStageWidgets,
  };
}

/** Write the full view object. Returns whether the write landed (matches
 * `writeStoreValueChecked`'s contract). */
export function writeDesktopView(next: DesktopView): boolean {
  return writeStoreValueChecked(DESKTOP_VIEW_KEY, next);
}

/** Flip one toggle, persist, and return the new full view.
 *
 * Pure on the input side: callers pass the current view (so tests don't have to
 * spin up localStorage to drive it). The persistence step uses `writeDesktopView`.
 *
 * The boolean is **flipped** — the menu reads "currently visible ⇒ next click
 * hides it", which is what users see on macOS Finder's "Hide Toolbar". */
export function toggleInView(view: DesktopView, what: ViewToggle): DesktopView {
  switch (what) {
    case "wallpaper":
      return { ...view, showWallpaper: !view.showWallpaper };
    case "icons":
      return { ...view, showIcons: !view.showIcons };
    case "stageWidgets":
      return { ...view, showStageWidgets: !view.showStageWidgets };
  }
}

/**
 * Convenience: flip + persist. The caller subscribes to changes via the shared store; we don't try
 * to publish events here (`writeJson` already emits `store-updated` through the existing channel).
 *
 * **The return value is what the store holds**, not what we intended (REQ-A492): a refused write
 * (storage full/unavailable) used to be discarded while this function still handed back the toggled
 * view, so the caller rendered a state that would be gone on reload. Publishing `next` on that path
 * was the same lie the keyboard page told with its 「已保存」 toast; re-reading costs one lookup and
 * makes the caller's state equal the store's, whatever happened.
 */
export function toggleDesktopView(what: ViewToggle): DesktopView {
  const cur = readDesktopView();
  const next = toggleInView(cur, what);
  if (!writeDesktopView(next)) {
    // The store refused it: report it (the ledger is the surface for "why is my setting back after a
    // reload") and hand back what is actually stored.
    amosWarn("desktop", "desktop view toggle was not persisted", { what });
    return readDesktopView();
  }
  return next;
}
