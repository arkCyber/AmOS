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

export type DesktopView = {
  showWallpaper: boolean;
  showIcons: boolean;
  showStageWidgets: boolean;
};

export const DESKTOP_VIEW_KEY = "amos.settings.view";

export const DEFAULT_DESKTOP_VIEW: DesktopView = {
  showWallpaper: true,
  showIcons: true,
  showStageWidgets: true,
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

/** Convenience: flip + persist. The caller subscribes to changes via the
 * shared store; we don't try to publish events here (writeJson already emits
 * `store-updated` through the existing channel). */
export function toggleDesktopView(what: ViewToggle): DesktopView {
  const cur = readDesktopView();
  const next = toggleInView(cur, what);
  writeDesktopView(next);
  return next;
}
