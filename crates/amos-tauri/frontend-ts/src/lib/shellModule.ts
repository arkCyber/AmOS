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
 */
import type { Component } from "svelte";

/** Where a widget can live. Exactly one container renders each slot. */
export type ShellSlot = "topbar-left" | "topbar-right" | "stage" | "dock" | "overlay";

/**
 * What a chrome widget may ask the shell to do.
 *
 * A **handle, not the shell**: a widget cannot reach `shellState`, the layout
 * snapshot or another widget through it. Every capability here is an intent the
 * container translates into what the shell already does (TopBar re-dispatches it),
 * so the widgets stay testable without a shell.
 */
export interface ShellChromeApi {
  /** Ask for the Launchpad overlay. */
  openLaunchpad: () => void;
  /** Ask for the Spotlight overlay. */
  openSpotlight: () => void;
}

/**
 * The context key the container provides and widgets read (`getContext`).
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
