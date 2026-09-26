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
 *   * This module decides **launcher geometry + device chrome** and, since the tablet
 *     completion work (2026-09-20), two *content* families that consume the host's
 *     measured `columns`: `masterDetail` (an iPad-style side rail, adopted by the
 *     Settings app — the shell still has no per-app navigation model, so no other app
 *     gets one) and `dockRecentSlots` / `dockRecents` (the iPad Dock's recently-used
 *     section). No macOS menu-bar mirror exists; the desktop shell owns its own TopBar.
 */

import type { FormFactor } from "./wm";
import { orientationOf } from "./rotation";

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
 * Whether the **browser** (`WebManApp`) hosts a live remote page **inline** — the
 * sandboxed `iframe` — rather than showing the "open in browser" punt card.
 *
 * The defect this replaces (REQ-A554): the app decided this from
 * `window.innerWidth >= 768`, i.e. "the class from the viewport", which rule 1 above
 * forbids. The two disagree on a tablet in portrait (768 px wide — the threshold was
 * an *approximation* of "tablet and up"), and a Mac app window narrowed below 768 px
 * lost its page. A large-screen class hosts inline (an iPad renders a page in place,
 * as does a Mac window whatever its width); the phone class keeps the punt card it has
 * always shown (that path awaits a native browser WebView — this does not grant it
 * one), and so does robot. An unmeasured class reaches here as `"phone"` (the honest
 * "no host yet" state), keeping today's behavior.
 *
 * Same family as `photosCols` / `pwaHubCols`: one source of truth, one set of tests.
 */
export function webManInline(form: FormFactor): boolean {
  return form === "desktop" || form === "tablet";
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
  // One orientation read for the whole shell (REQ-A677): `orientationOf` is the TS
  // mirror of the Rust kernel `amos_display::orientation::orientation_of` (landscape
  // iff strictly wider than tall; a square counts as portrait). Keeping the home grid
  // and the rotation policy on the *same* rule is what the Rust doc-comment claims.
  return orientationOf(width, height) === "landscape"
    ? TABLET_LANDSCAPE_GRID
    : TABLET_PORTRAIT_GRID;
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

/**
 * The narrowest a **tablet** may be and still split a surface into
 * sidebar + detail.
 *
 * Basis (the same 600 px band `columns_for` widens at, plus room to be useful): the
 * host's `columns >= 2` already proves the screen is tablet-wide, but a 600 px window
 * with a 260 px sidebar leaves a 340 px detail — narrower than the phone's own
 * `min_pane` (360), i.e. a "sidebar" that makes the content *worse* than not having
 * one. iPadOS collapses the sidebar in a narrow Split View for the same reason. 700
 * clears that with margin, and every measured tablet (portrait 900 / landscape 1200)
 * is above it.
 */
export const TABLET_SIDEBAR_MIN_WIDTH = 700;

/** Widest the sidebar column ever grows (px) — a fixed column, like iPadOS's. */
export const TABLET_SIDEBAR_MAX_PX = 360;

/** Narrowest the sidebar column ever shrinks to (px), when the surface has one. */
export const TABLET_SIDEBAR_MIN_PX = 260;

/** The sidebar fraction of the measured width (32 % ≈ iPadOS's 320/1000). */
const TABLET_SIDEBAR_FRACTION = 0.32;

/**
 * The master-detail decision for one surface: does this device class lay the surface
 * out as a **sidebar + detail**, and how wide is the sidebar?
 *
 * This is the "a tablet is not a stretched phone" half of the layout work applied to
 * *list → detail* surfaces (iOS Settings / Mail / Notes push a sub-page; iPadOS shows
 * the list beside it). It is the **second behavioral consumer** of the host's measured
 * `columns` signal (`docs/multi-window.md:79` boundary ④ — until now `columns` only
 * gated the split surface), and it deliberately consumes **both** the class and the
 * measurement, from one authority (`LayoutSnapshot.form` / `.columns`):
 *
 *   * a class that is not `tablet` ⇒ never (desktop owns its own shell; phone/robot are
 *     single-column — the sidebar is not this module's call to make for them);
 *   * `columns < 2` ⇒ never: the host has measured a screen too narrow for two panes,
 *     so a sidebar would be a column this device cannot afford (the same rule
 *     `canSplit` follows);
 *   * an unmeasured width (0 / NaN / ∞) ⇒ never — mirroring
 *     `LayoutPolicy::columns_for(0) == 1` and `homeGrid`'s "unmeasured ⇒ the most
 *     conservative answer", so a preview build or a boot race never invents a sidebar;
 *   * otherwise the sidebar appears once the measured width reaches
 *     [`TABLET_SIDEBAR_MIN_WIDTH`].
 *
 * The width is a bounded fraction of the measured surface, clamped to
 * `[TABLET_SIDEBAR_MIN_PX, TABLET_SIDEBAR_MAX_PX]` — a fixed column, never a second
 * layout engine. `sidebarWidth` is 0 exactly when `sidebar` is false, so a caller that
 * ignores the boolean still cannot reserve a phantom column.
 */
export interface MasterDetail {
  /** Show the sidebar column at all? */
  readonly sidebar: boolean;
  /** The sidebar column's width (px) — `0` when `sidebar` is false. */
  readonly sidebarWidth: number;
}

/** Decide the master-detail layout for this class at this measured size
 * (see [`MasterDetail`] for the rule). */
export function masterDetail(
  form: FormFactor,
  columns: number,
  width: number,
): MasterDetail {
  const measured = Number.isFinite(width) && width > 0;
  const fits = form === "tablet" && columns >= 2 && measured && width >= TABLET_SIDEBAR_MIN_WIDTH;
  if (!fits) return { sidebar: false, sidebarWidth: 0 };
  const raw = Math.round(width * TABLET_SIDEBAR_FRACTION);
  return { sidebar: true, sidebarWidth: clamp(raw, TABLET_SIDEBAR_MIN_PX, TABLET_SIDEBAR_MAX_PX) };
}

/* ---- Dock recents (the iPad's "recently used" apps) ------------------------- */

/** How many recently-used apps an iPad's Dock offers beside the pinned ones. */
export const DOCK_RECENT_SLOTS = 3;

/**
 * Does this class's Dock carry a **recently-used** section, and how many apps may it
 * hold?
 *
 * iPadOS puts up to three recently-opened apps at the right of the Dock, after a
 * divider — the Dock is also the shell's quick app switcher, so an app you just left
 * is one tap away instead of a hunt through the App Library. An iPhone's Dock has no
 * such section: it is pinned apps only, and reaching a recent app there means the
 * Recents surface (bottom-edge swipe) rather than a Dock slot. So: tablet ⇒ 3,
 * everything else ⇒ 0.
 *
 * The desktop is **deliberately 0 here even though macOS's Dock does show recent
 * apps**: the desktop class renders from its own shell (`DesktopShell.svelte` +
 * `lib/desktopLayout.ts`) and never mounts this launcher, so answering 3 for it would
 * be policy no production path renders — the same two-sources-of-truth boundary the
 * module header registers (REQ-A250). When that Dock adopts this family, it is one
 * case to add, with its own measurement.
 *
 * `0` is also the conservative answer for a payload with no class (see
 * `HomeDock`'s "a missing payload never gains a capability" rule): phone behaviour
 * is today's behaviour, and a Dock section appearing from absent data would be a new
 * thing, not a preserved one.
 */
export function dockRecentSlots(form: FormFactor): number {
  return form === "tablet" ? DOCK_RECENT_SLOTS : 0;
}

/**
 * The recent apps a Dock section should show, in most-recent-first order.
 *
 * Pure, and narrow on purpose:
 *   * `pinned` ids are dropped — an app already in the Dock must not appear twice,
 *     and the pinned tile is the one the user placed (its position is theirs);
 *   * duplicates in `recents` collapse to their first (most recent) occurrence;
 *   * the answer is capped at `slots`, so a caller cannot widen the Dock's density
 *     by passing a longer history.
 *
 * It does **not** filter unknown/uninstalled ids: the recents store already holds
 * built-in ids only (`shellState.open` records a recent only for `appTitleKey` hits),
 * and a caller rendering external tiles filters against its own tile map. Inventing a
 * second availability check here would be the third place that decision lives.
 */
export function dockRecents(
  recents: readonly string[],
  pinned: readonly string[],
  slots: number,
): string[] {
  if (!Number.isFinite(slots) || slots <= 0) return [];
  const out: string[] = [];
  for (const id of recents) {
    if (out.length >= slots) break;
    if (pinned.includes(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}
