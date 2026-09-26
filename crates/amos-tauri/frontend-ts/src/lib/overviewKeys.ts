/**
 * overviewKeys.ts — keyboard navigation for the shell's keyboard-driven collections: the two
 * window-overview panels, Launchpad, the desktop's icon grid (which keeps its own focus and
 * so uses `nextGridIndex` directly rather than a DOM-focus installer), and the two Spotlight
 * result lists (`nextListIndex` — the flat vertical case, which is **not** a one-column grid:
 * see that function for why).
 *
 * The two overview panels (`MissionControl`, `AppExpose`) each render their windows as a row
 * of tile buttons and each trapped focus for Tab and closed on Escape — but **no key moved
 * the focus between the tiles**. A keyboard user could reach a tile with Tab and activate it
 * with Enter, yet the arrow keys macOS users reach for did nothing, and both panels said so
 * in their own comments ("没有方向键网格导航 … 登记为缺口而不是假装有"). One implementation
 * for both, for the usual reason (`lib/menuKeys.ts` states it for the pop-up menus): two
 * copies of "where does ArrowRight go" is how two panels start disagreeing.
 *
 * The shape is a **grid** (rows of tiles) rather than a single list, because Mission Control
 * draws two rows — the Spaces strip and the windows — while App Exposé draws one:
 *
 *   • ArrowLeft / ArrowRight walk **within the focused row**, wrapping at the ends;
 *   • ArrowUp / ArrowDown move to the **neighbouring row** and stay in the same column
 *     (clamped to that row's length, wrapping at the ends);
 *   • Home / End jump to the ends of the focused row;
 *   • in a **single-row** panel Up/Down walk that row exactly like Left/Right — a grid with
 *     one row must not make two of the four arrows dead keys.
 *
 * Enter / Space are deliberately *not* handled: a tile is a `<button>`, so the browser
 * already activates it. Escape stays with the caller (both panels own "what Escape means"),
 * exactly as in `menuKeys`.
 *
 * Launchpad draws the same grid in a **flat** shape — its tiles `flex-wrap` with no row
 * elements, so the row lengths have to come from the column count. `uniformRowLengths` /
 * `nextGridIndex` / `installGridKeyboard` are that adapter, and they *delegate* the decision
 * to `nextOverviewCell` rather than re-deriving it: one place decides where ArrowRight goes.
 */

export interface OverviewCell {
  row: number;
  col: number;
}

/**
 * The keys this module owns. Anything else (Tab, Escape, Enter) is left untouched.
 *
 * Exported because a surface that owns its focus itself (the desktop's icon listbox) must ask
 * the *same* question, and a hand-written second list of six key names is how the two halves
 * start disagreeing about Escape or Space.
 */
export const NAV_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

/**
 * Where a nav key moves the focus in a grid whose rows hold `rowLengths[i]` tiles, from the
 * tile at (`row`, `col`). `null` for a key this module does not own, and for a grid with
 * nowhere to go (no rows, or the focused row is empty).
 */
export function nextOverviewCell(
  key: string,
  row: number,
  col: number,
  rowLengths: readonly number[],
): OverviewCell | null {
  const rows = rowLengths.length;
  if (rows === 0) return null;
  const r = Math.min(Math.max(row, 0), rows - 1);
  const len = rowLengths[r] ?? 0;
  if (len <= 0) return null;
  const c = Math.min(Math.max(col, 0), len - 1);
  switch (key) {
    case "ArrowRight":
      return { row: r, col: (c + 1) % len };
    case "ArrowLeft":
      return { row: r, col: (c - 1 + len) % len };
    case "Home":
      return { row: r, col: 0 };
    case "End":
      return { row: r, col: len - 1 };
    case "ArrowDown":
    case "ArrowUp": {
      // One row: walk it, so Up/Down are not dead keys in a one-row panel.
      if (rows === 1) {
        const walk = key === "ArrowDown" ? "ArrowRight" : "ArrowLeft";
        return nextOverviewCell(walk, r, c, rowLengths);
      }
      const step = key === "ArrowDown" ? 1 : -1;
      const nr = (r + step + rows) % rows;
      const nlen = rowLengths[nr] ?? 0;
      // The neighbouring row is empty (a Space strip can render with no Spaces): there is
      // no honest tile to move to, so leave the key alone rather than jumping somewhere else.
      if (nlen <= 0) return null;
      return { row: nr, col: Math.min(c, nlen - 1) };
    }
    default:
      return null;
  }
}

/** The tiles a row offers to the keyboard: its enabled buttons, in DOM order. */
export function overviewTiles(row: ParentNode): HTMLButtonElement[] {
  return [...row.querySelectorAll<HTMLButtonElement>("button")].filter(
    (el) => !el.disabled,
  );
}

/** The tile at `cell`, or `null` when that row/tile does not exist. */
export function overviewCellAt(
  rows: readonly HTMLElement[],
  cell: OverviewCell,
): HTMLButtonElement | null {
  const row = rows[cell.row];
  if (!row) return null;
  return overviewTiles(row)[cell.col] ?? null;
}

/** The first tile of the first non-empty row, or `null` when every row is empty. */
function firstCell(rowLengths: readonly number[]): OverviewCell | null {
  for (let row = 0; row < rowLengths.length; row++) {
    if ((rowLengths[row] ?? 0) > 0) return { row, col: 0 };
  }
  return null;
}

/** Which cell holds `active`, or `null` when the focus is not on a tile of these rows. */
function currentCell(
  rows: readonly HTMLElement[],
  active: Element | null,
): OverviewCell | null {
  if (!active) return null;
  for (let row = 0; row < rows.length; row++) {
    const col = overviewTiles(rows[row]!).indexOf(active as HTMLButtonElement);
    if (col >= 0) return { row, col };
  }
  return null;
}

/**
 * The row lengths of a **uniform** grid: `total` tiles wrapped at `cols` columns. The last
 * row may be short — 10 tiles in 4 columns is `[4, 4, 2]`, not `[4, 4, 4]` — because a grid
 * that pretends its last row is full would let ArrowDown land on a tile that is not there.
 *
 * This is the shape Launchpad draws: unlike the overview panels its tiles are not grouped in
 * row elements, they simply wrap — so the row lengths have to be derived from the column count
 * rather than read off the DOM.
 */
export function uniformRowLengths(total: number, cols: number): number[] {
  if (total <= 0 || cols <= 0) return [];
  const out: number[] = [];
  for (let left = total; left > 0; left -= cols) out.push(Math.min(cols, left));
  return out;
}

/**
 * How a grid's **edges** behave, the one thing the surfaces disagree about.
 *
 * `wrap` (the default) is macOS's Launchpad / Mission Control rule: Left / Right wrap within
 * the focused row and Up / Down wrap around the rows. `wrap: false` is the rule an
 * index-based listbox uses (the desktop's icon grid): the reading order is clamped at its
 * ends, and Up / Down still move a whole row keeping the column, so a grid whose tiles are
 * focusable items cannot end up with Down behaving as a synonym of Right.
 */
export interface GridOptions {
  wrap?: boolean;
}

/**
 * Where a nav key moves the focus in a **uniform** `cols`-column grid of `total` tiles, from
 * the tile at `index`. Returns the next index, or `null` for a key this module does not own and
 * for a grid with nowhere to go.
 *
 * In the default (wrapping) mode the decision is `nextOverviewCell`'s — this only translates an
 * index to a (row, col) and back. Keeping one decision is what stops a wrapped grid and a
 * row-grouped grid from disagreeing about where ArrowRight goes.
 *
 * In `wrap: false` mode the geometry is the same but the arithmetic is index-based, because the
 * callers of that mode **own the focus themselves** (the desktop's listbox keeps `focusedId` and
 * an `aria-activedescendant` rather than moving DOM focus): Left / Right step one tile in reading
 * order, Up / Down move to the **same column of the next row** — which is `cols` while the rows
 * are full, and a clamped step into the short last row when they are not — Home / End are the
 * ends of the **list**. Clamping rather than wrapping is the point of the mode: at the last tile
 * Down must stay put instead of teleporting to the first, and on the first row Up must stay put
 * rather than slide along it.
 */
export function nextGridIndex(
  key: string,
  index: number,
  total: number,
  cols: number,
  opts: GridOptions = {},
): number | null {
  const lengths = uniformRowLengths(total, cols);
  if (lengths.length === 0) return null;
  const i = Math.min(Math.max(index, 0), total - 1);
  if (opts.wrap === false) {
    switch (key) {
      case "ArrowRight":
        return Math.min(i + 1, total - 1);
      case "ArrowLeft":
        return Math.max(i - 1, 0);
      case "ArrowDown":
      case "ArrowUp": {
        // Row-aware, not `i ± cols`: at the first row Up and at the last row Down there is no
        // tile in that column at all, and the raw arithmetic answered with a **horizontal**
        // teleport to the row's last/first tile. On the desktop's full 4×4 grid `ArrowDown`
        // from 14 landed on 15 — byte-for-byte where `ArrowRight` goes, the very synonym this
        // mode's doc and test comment promise to prevent. Staying put is the clamped answer.
        const row = Math.floor(i / cols);
        const col = i % cols;
        const nr = key === "ArrowDown" ? row + 1 : row - 1;
        if (nr < 0 || nr >= lengths.length) return i;
        return nr * cols + Math.min(col, (lengths[nr] ?? 1) - 1);
      }
      case "Home":
        return 0;
      case "End":
        return total - 1;
      default:
        return null;
    }
  }
  const from = { row: Math.floor(i / cols), col: i % cols };
  const target = nextOverviewCell(key, from.row, from.col, lengths);
  if (!target) return null;
  return target.row * cols + target.col;
}

/**
 * Where a nav key moves the selection in a flat **vertical list** of `count` rows at `index`.
 * Owns **↑ / ↓ only**; `null` for everything else, and for an empty list.
 *
 * The ends **clamp** rather than wrap — walking past the last result stays on the last result,
 * which is what macOS Spotlight does and what the desktop overlay already does by hand. Two
 * surfaces (`SpotlightOverlay`, `SpotlightPanel`) draw the same kind of list, so the arithmetic
 * lives here for the reason this module exists: a second copy of "where does ↓ go" is how the
 * two Spotlights start disagreeing about the ends.
 *
 * **Why not `nextGridIndex(key, i, total, 1, { wrap: false })`**, which looks like the same
 * shape: with one column that function's `ArrowDown` and `ArrowRight` branches both evaluate to
 * `i + 1`, so ↓ becomes a synonym of → and ←/→ would step the list *vertically*. That is exactly
 * the defect F-SH-351 fixed in the desktop's icon grid, one axis over — a one-column grid is not
 * a list, and a list has no horizontal axis to give away.
 *
 * `Home` / `End` are deliberately **not** owned: both callers' focus starts (and stays) in the
 * search field, where Home/End belong to the caret. Claiming them here would move the user's
 * cursor to the end of their query instead of the end of the list.
 */
export function nextListIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const i = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case "ArrowDown":
      return Math.min(i + 1, count - 1);
    case "ArrowUp":
      return Math.max(i - 1, 0);
    default:
      return null;
  }
}

/**
 * Wire the tiles of a single **flat** container (a wrapping grid, no row elements) for
 * keyboard use, and return the cleanup (a Svelte `$effect` return value).
 *
 * `cols` is read at install time; call this from an `$effect` that reads it, and the grid
 * re-wires whenever the column count changes (a window resize re-flows Launchpad).
 *
 * Two differences from `installOverviewKeyboard`, both forced by the surface:
 *   • the tiles come from one container instead of one element per row;
 *   • an **editable target is never claimed** — Launchpad owns a search field, and hijacking
 *     ArrowLeft/ArrowRight while the user is typing would move the grid instead of the caret.
 *     The overview panels have no text field, so they do not need the guard.
 */
export function installGridKeyboard(
  container: HTMLElement | null | undefined,
  cols: number,
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!NAV_KEYS.has(e.key)) return;
    if (isEditableTarget(e.target)) return;
    if (!container) return;
    const tiles = overviewTiles(container);
    if (tiles.length === 0) return;
    const from = tiles.indexOf(document.activeElement as HTMLButtonElement);
    const target =
      from >= 0 ? nextGridIndex(e.key, from, tiles.length, cols) : 0;
    if (target === null) return;
    const next = tiles[target];
    if (!next) return;
    e.preventDefault();
    // Claimed here for the same reason as `installOverviewKeyboard`: `DesktopStage`'s icon
    // grid listens on `window`, and a window listener runs after this document one.
    e.stopPropagation();
    next.focus();
  };
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}

/** True when the event target is a text field — the keyboard layer must stand down. */
function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return t.isContentEditable;
}

/**
 * Wire the tiles of `rows` for keyboard use, and return the cleanup (a Svelte `$effect`
 * return value).
 *
 * Rows may be `null` — a panel's Spaces strip is conditional — and are read live on every
 * keypress, so a row appearing or disappearing cannot leave a stale list behind.
 *
 * Nothing is focused at install: the panels already trap focus (Tab) and macOS's overview
 * does not steal the focus ring on open. The one case that needs help is "no tile has the
 * focus yet" — then the first nav key focuses the first tile, so the arrows are reachable
 * from a panel whose focus sits on the dialog root.
 */
export function installOverviewKeyboard(
  rows: readonly (HTMLElement | null | undefined)[],
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!NAV_KEYS.has(e.key)) return;
    const live = rows.filter((r): r is HTMLElement => !!r);
    if (live.length === 0) return;
    const lengths = live.map((r) => overviewTiles(r).length);
    const from = currentCell(live, document.activeElement);
    const target = from
      ? nextOverviewCell(e.key, from.row, from.col, lengths)
      : firstCell(lengths);
    if (!target) return;
    const next = overviewCellAt(live, target);
    if (!next) return;
    e.preventDefault();
    // The event is claimed here so a surface behind the panel does not ALSO walk its own
    // grid: `DesktopStage`'s icon grid listens on `window`, and a window listener runs after
    // this document one — which is exactly why the claim has to happen here.
    e.stopPropagation();
    next.focus();
  };
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}
