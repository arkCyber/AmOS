/**
 * formLayout.ts — how the shell lays its **content** out for this form factor.
 *
 * `amos-wm::form` decides *which class we are* and what the **window** may do
 * (multi-window, free resize, divider gap, content columns). That authority reaches
 * the UI on the `LayoutSnapshot` wire; this module is the single place the UI turns
 * it into concrete **content geometry** — the "a tablet is not a stretched phone"
 * half of `docs/multi-window.md` §1.5. Before it existed, the tablet class changed
 * the window's *size* and nothing else: the home screen still rendered its
 * hard-coded 4×3 phone grid (`HomeDock.svelte`) inside a 900×1200 window.
 *
 * Two rules this module exists to keep:
 *
 *   1. **The class comes from the host, never from the viewport.** A phone and a
 *      tablet are one `aarch64-linux-android` build, so deciding here from
 *      `window.innerWidth` would be exactly the mistake §1.5 warns about. The plan
 *      is a pure function of the host's `form` plus the host's **measured** screen.
 *   2. **Phone (and robot, and an absent host) keep today's numbers.** The phone
 *      grid is 4×3 = 12 per page, which the home-screen tests pin. A tablet gets
 *      iPadOS's own densities: portrait 4×6, landscape 6×4 (24 per page either way).
 *
 * Honest boundaries (kept explicit so nobody reads more into this than it says):
 *   * `desktop` is **deliberately excluded** — its window is already a real, freely
 *     resizable OS window (REQ-A233 maximizes it against the desktop's usable area),
 *     and changing its launcher density is a separate, visible decision that must not
 *     ride along with the tablet work. It therefore keeps the phone grid.
 *   * An **unmeasured** screen (`0×0`, the `FALLBACK_SCREEN` window nobody measured
 *     yet) never invents a tablet density — it degrades to the phone grid, mirroring
 *     `LayoutPolicy::columns_for(0) == 1`'s "an unmeasured screen gets the most
 *     conservative answer" rule.
 *   * This module decides **icon-grid geometry only**. It does not (yet) render an
 *     iPad-style side rail: the shell has no per-app navigation model to put in one,
 *     and inventing a rail of made-up entries would be worse than not having it.
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
 * The home-screen grid for this class at this measured screen size.
 *
 * `width`/`height` are the host's measured screen (logical px; see
 * `WmState::sync_from_pixels`). A square screen counts as portrait, matching
 * `amos_wm::form::split_axis`'s "square is vertical" rule.
 */
export function homeGrid(form: FormFactor, width: number, height: number): HomeGrid {
  const measured =
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  if (form !== "tablet" || !measured) return PHONE_GRID;
  return height >= width ? TABLET_PORTRAIT_GRID : TABLET_LANDSCAPE_GRID;
}

/** How many tiles one page of `grid` holds — the single answer to "per page". */
export function pageCapacity(grid: HomeGrid): number {
  return grid.cols * grid.rows;
}
