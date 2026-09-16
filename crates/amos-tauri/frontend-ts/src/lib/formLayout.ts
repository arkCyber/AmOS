/**
 * formLayout.ts — how the shell lays its **content** out for this form factor.
 *
 * `amos-wm::form` decides *which class we are* and what the **window** may do
 * (multi-window, free resize, divider gap, content columns). That authority reaches
 * the UI on the `LayoutSnapshot` wire; this module is the single place the UI turns
 * it into concrete **content decisions** — the "a tablet is not a stretched phone"
 * half of `docs/multi-window.md` §1.5, and (since REQ-A249) the same question for a
 * **desktop**: is this window on a Mac, and if so what does a Mac's screen actually
 * have?
 *
 * Two families of answers, both **pure functions of the host's `form`** (plus the
 * host's *measured* screen for geometry):
 *
 *   1. `homeGrid` / `homeTile` / `pageCapacity` — the launcher's geometry: how many
 *      tiles per page, and how big one tile is.
 *   2. `deviceChrome` — which **device-specific** chrome the shell may draw. This is
 *      not decoration: a Dynamic Island is an *iPhone cutout* and a home indicator is
 *      an *iOS gesture bar*. Drawing either inside a macOS window states hardware and
 *      gestures that are not there (macOS owns the clock/Wi-Fi/battery in its menu bar,
 *      and its windows have no gesture bar).
 *
 * Rules this module exists to keep:
 *
 *   1. **The class comes from the host, never from the viewport.** A phone and a
 *      tablet are one `aarch64-linux-android` build, so deciding here from
 *      `window.innerWidth` would be exactly the mistake §1.5 warns about. The plan
 *      is a pure function of the host's `form` plus the host's **measured** screen.
 *   2. **Phone (and robot, and an absent host) keep today's numbers.** The phone
 *      grid is 4×3 = 12 per page, which the home-screen tests pin. A tablet gets
 *      iPadOS's own densities: portrait 4×6, landscape 6×4 (24 per page either way).
 *      A desktop gets a **Launchpad-class** launcher laid out from the window it
 *      actually has (`DESKTOP_*` below).
 *
 * Honest boundaries (kept explicit so nobody reads more into this than it says):
 *   * **The desktop class's content is no longer rendered from here.** A separate
 *     desktop shell (`svelte/DesktopShell.svelte` + `lib/desktopLayout.ts`: TopBar /
 *     Launchpad / Dock / Spotlight / Mission Control) was added concurrently and
 *     `Shell.svelte` now routes `form === "desktop"` to it *before* the launcher
 *     branches, so this module's desktop geometry (the `homeGrid` desktop case and
 *     `homeTile`'s `large`) is **policy, not production**: it is exercised by the unit
 *     tests and would be reached again if the launcher rendered on desktop. Two
 *     sources of truth for one class is itself a defect and is registered in
 *     `CHANGELOG.md` (REQ-A250) — the numbers do not agree: 8 columns / 5 rows / 80 px
 *     grid icon / 56 px dock icon there, versus 8×4 at 1496×882 with an 80 px grid
 *     icon and a 76 px dock icon here.
 *   * The `DESKTOP_*` constants are **this repository's design constants**, not
 *     measurements of Apple's Launchpad. What the tests pin is the *shape* of the
 *     rule (derived from the measured window, clamped, never below the phone's grid)
 *     plus the number it produces for the desktop this work was measured on.
 *   * An **unmeasured** screen (`0×0`, the `FALLBACK_SCREEN` window nobody measured
 *     yet) never invents a desktop or tablet density — it degrades to the phone grid,
 *     mirroring `LayoutPolicy::columns_for(0) == 1`'s "an unmeasured screen gets the
 *     most conservative answer" rule.
 *   * This module decides **launcher geometry + device chrome only**. It does not
 *     (yet) render an iPad-style side rail, nor a macOS menu-bar mirror: the shell has
 *     no per-app navigation model to put in either, and inventing one would be worse
 *     than not having it.
 */

import type { FormFactor } from "./wm";

/** A home-screen icon grid: how many tiles per row and per page-row. */
export interface HomeGrid {
  /** Icon columns per page. */
  readonly cols: number;
  /** Icon rows per page. */
  readonly rows: number;
}

/**
 * The handset grid — **unchanged** from the hard-coded `grid-cols-4` / `per = 12`
 * this module replaced, so the phone path (and every existing home-screen test)
 * keeps its exact geometry.
 */
export const PHONE_GRID: HomeGrid = { cols: 4, rows: 3 };

/** iPadOS portrait home screen: 4 columns × 6 rows = 24 tiles per page. */
const TABLET_PORTRAIT_GRID: HomeGrid = { cols: 4, rows: 6 };

/** iPadOS landscape home screen: 6 columns × 4 rows = 24 tiles per page. */
const TABLET_LANDSCAPE_GRID: HomeGrid = { cols: 6, rows: 4 };

/**
 * Horizontal pitch of one desktop home tile (px).
 *
 * Basis (a *design* constant — see the module doc): the Mac this work was measured on
 * gives a maximized shell window 1496 px of width (REQ-A233), and 1496 ≈ 8 × 170.
 * Apple's Launchpad shows 7 columns on a 1440-wide display; with the tile size this
 * crate draws, 170 lands in the same region.
 */
export const DESKTOP_COL_PITCH_PX = 170;

/** Vertical pitch of one desktop tile (px): an 80 px tile + its label + gutter. */
export const DESKTOP_ROW_PITCH_PX = 140;

/** Horizontal chrome the grid never occupies: the home column's `px-4` on both sides. */
export const DESKTOP_PAD_PX = 32;

/**
 * Vertical chrome the grid never occupies: the status row (~44), the fixed widget
 * header (~120), the dots / App-Library row (~30) and the bottom dock (~90) — i.e. the
 * component's own fixed rows, read off rather than guessed, and deliberately
 * **over**-estimated: a grid that claims more room than it has is how icons get cut
 * off, while one that claims less only leaves a gap.
 */
export const DESKTOP_CHROME_PX = 284;

/** Never wider than this many columns: past it the tiles are lost in their cells. */
export const DESKTOP_MAX_COLS = 8;

/** Never taller than this many rows (same reason, vertically). */
export const DESKTOP_MAX_ROWS = 6;

/**
 * The **App Library** column count for this class.
 *
 * The App Library is the search / browse surface that mirrors the home screen's icon
 * grid; it lives on the `library` surface (full screen on phone/tablet, modal-launchpad
 * on desktop). iOS keeps it at 4 columns; iPadOS widens to 6 so the screen real
 * estate is actually used; macOS / desktop widens further (`DESKTOP_MAX_COLS`). A
 * robot has no UI ⇒ the most conservative answer (the phone default).
 *
 * Why this lives next to `homeGrid`: it is the *same* decision family (class →
 * layout), driven by the *same* authority (the host's `form`), and tested the *same*
 * way (pure function of inputs, no DOM, no `window`). Keeping the rule here means
 * `AppLibrary.svelte` does not have to repeat the `form === "tablet"` branch itself
 * — that branch is what the audit found missing (REQ-A234 wired the *home* grid for
 * tablet, not the App Library surface).
 */
export function appLibraryColumns(form: FormFactor): number {
  if (form === "tablet") return 6;
  if (form === "desktop") return DESKTOP_MAX_COLS;
  return 4;
}

/**
 * The **Photos** grid column count for this class.
 *
 * iOS Photos uses 3 columns regardless of device size — a deliberate choice on a
 * phone-shaped canvas; iPadOS Photos widens to 5 columns (its My Photos tab). The
 * desktop class gets `DESKTOP_MAX_COLS` (matching the launcher) so a Mac window
 * shows a desktop-class gallery rather than the iPad's 5. Robot has no UI ⇒ the
 * most conservative answer (the phone default).
 *
 * Why `App.svelte` components consume a *number* from this module instead of
 * branching on `form === "tablet"` themselves: one source of truth, one
 * decision family, one set of tests. Each consumer only picks the function
 * (`appLibraryColumns` / `photosCols` / …) — they never ask "what *is* a tablet?".
 */
export function photosCols(form: FormFactor): number {
  if (form === "tablet") return 5;
  if (form === "desktop") return DESKTOP_MAX_COLS;
  return 3;
}

/**
 * The **PWA picker** (system PWA index) column count for this class.
 *
 * iOS uses 4 columns for the system-installed web-app picker; iPadOS widens to 6
 * columns (its picker density); the desktop class widens further to
 * `DESKTOP_MAX_COLS` so a Mac window shows a desktop-class picker. Robot has no UI
 * ⇒ the phone default. Same family as `appLibraryColumns` / `photosCols` — the
 * function name is per-surface because the column counts differ.
 */
export function pwaHubCols(form: FormFactor): number {
  if (form === "tablet") return 6;
  if (form === "desktop") return DESKTOP_MAX_COLS;
  return 4;
}

/**
 * The home-screen grid for this class at this measured screen size.
 *
 * `width`/`height` are the host's measured screen (logical px; see
 * `WmState::sync_from_pixels`). A square screen counts as portrait, matching
 * `amos_wm::form::split_axis`'s "square is vertical" rule.
 *
 * Desktop (REQ-A249): the launcher is laid out from the **window it actually has** —
 * the same pitch reasoning as the phone, given a Mac-sized area — then clamped so a
 * small desktop window never gets *fewer* icons per page than a phone, and a huge one
 * never gets tiles lost in their cells.
 */
export function homeGrid(form: FormFactor, width: number, height: number): HomeGrid {
  const measured =
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  if (!measured) return PHONE_GRID;
  if (form === "desktop") {
    return {
      cols: clamp(
        Math.floor((width - DESKTOP_PAD_PX) / DESKTOP_COL_PITCH_PX),
        PHONE_GRID.cols,
        DESKTOP_MAX_COLS,
      ),
      rows: clamp(
        Math.floor((height - DESKTOP_CHROME_PX) / DESKTOP_ROW_PITCH_PX),
        PHONE_GRID.rows,
        DESKTOP_MAX_ROWS,
      ),
    };
  }
  if (form !== "tablet") return PHONE_GRID;
  return height >= width ? TABLET_PORTRAIT_GRID : TABLET_LANDSCAPE_GRID;
}

/** How many tiles one page of `grid` holds — the single answer to "per page". */
export function pageCapacity(grid: HomeGrid): number {
  return grid.cols * grid.rows;
}

/** Integer clamp: `min` when the value is below it, `max` above it (never NaN). */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * How big one home tile is on this class.
 *
 * `regular` is the phone/iPad tile the shell has always drawn; `large` is the
 * Launchpad-class tile a desktop window's Launcher wants (a 56 px tile in a 183 px cell
 * reads as a phone screenshot pasted onto a Mac). The component maps each value to
 * **literal** Tailwind classes — a constructed class name is one Tailwind purges.
 */
export type HomeTile = "regular" | "large";

/** The tile size for this class (desktop `large`, everything else today's `regular`). */
export function homeTile(form: FormFactor): HomeTile {
  return form === "desktop" ? "large" : "regular";
}

/**
 * The **device-specific** chrome the shell may draw for this class.
 *
 * Both fields exist because both used to be drawn unconditionally: a maximized macOS
 * window showed an iPhone's Dynamic Island and an iOS home-indicator bar. Neither is a
 * styling preference — the island asserts a screen cutout the Mac does not have, and the
 * gesture bar asserts a touch gesture a Mac window does not implement (macOS owns
 * clock/Wi-Fi/battery in its menu bar, and a window's way back is its toolbar control).
 */
export interface DeviceChrome {
  /** Draw the iPhone's Dynamic-Island pill? Only the **iPhone** has that hardware. */
  readonly dynamicIsland: boolean;
  /** Draw the iOS home-indicator (gesture) bar? Touch classes have it, macOS does not. */
  readonly homeIndicator: boolean;
  /**
   * Is there an **OS title bar** to put a name in? A macOS window has one (and the
   * convention is that it names what you are looking at); a phone/tablet app is
   * fullscreen and a robot has no UI.
   */
  readonly titleBar: boolean;
}

/** What this class's device actually has (see [`DeviceChrome`]). */
export function deviceChrome(form: FormFactor): DeviceChrome {
  return {
    dynamicIsland: form === "phone",
    homeIndicator: form === "phone" || form === "tablet",
    titleBar: form === "desktop",
  };
}
