/**
 * overviewKeys.test.ts — keyboard navigation for the window-overview panels.
 *
 * Why it exists: `MissionControl` and `AppExpose` each trapped Tab and closed on Escape, but
 * **no key moved the focus between the window tiles** — so the arrow keys a macOS user
 * reaches for in Mission Control did nothing, in both panels. That is the gap this module
 * closes, and the reason it is one module rather than two copies.
 *
 * Launchpad has the same gap in a different shape: its tiles are not grouped in row elements
 * (they simply `flex-wrap`), so its row lengths have to be derived from the column count. The
 * second half of this file (`uniformRowLengths` / `nextGridIndex` / `installGridKeyboard`)
 * covers that shape — and it delegates the actual decision to `nextOverviewCell`, so the two
 * shapes cannot disagree about where ArrowRight goes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  installGridKeyboard,
  installOverviewKeyboard,
  nextGridIndex,
  nextListIndex,
  nextOverviewCell,
  overviewCellAt,
  overviewTiles,
  uniformRowLengths,
} from "../lib/overviewKeys";

/** A tile row; `disabled` lists ids that must be skipped by the keyboard. */
function row(ids: string[], disabled: string[] = []): HTMLElement {
  const el = document.createElement("div");
  for (const id of ids) {
    const b = document.createElement("button");
    b.setAttribute("data-testid", id);
    if (disabled.includes(id)) b.disabled = true;
    el.appendChild(b);
  }
  document.body.appendChild(el);
  return el;
}

/** A flat wrapping grid of `n` tiles (`t0`…`t{n-1}`) — Launchpad's shape: no row elements. */
function grid(n: number): HTMLElement {
  const el = document.createElement("div");
  for (let i = 0; i < n; i++) {
    const b = document.createElement("button");
    b.setAttribute("data-testid", `t${i}`);
    el.appendChild(b);
  }
  document.body.appendChild(el);
  return el;
}

function press(key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
  document.body.dispatchEvent(ev);
  return ev;
}

const focused = () => (document.activeElement as HTMLElement | null)?.dataset.testid;

/** Teardowns registered by the tests below. */
const cleanups: Array<() => void> = [];

/**
 * Register a keyboard layer's teardown and hand it back.
 *
 * A test that fails part-way never reaches its own `off()`, and the leaked `document`
 * listener then reddens the NEXT test as well — a second red that is an artifact, not a
 * second defect. Registering here means a red stays one red, which is what makes these
 * cases usable as negative controls.
 */
function track(off: () => void): () => void {
  cleanups.push(off);
  return off;
}

beforeEach(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    /* already registered */
  }
  document.body.innerHTML = "";
});
afterEach(() => {
  for (const off of cleanups.splice(0)) off();
  document.body.innerHTML = "";
});

describe("nextOverviewCell — where a nav key goes (pure)", () => {
  test("Left / Right walk within the row and wrap like macOS", () => {
    expect(nextOverviewCell("ArrowRight", 0, 0, [3])).toEqual({ row: 0, col: 1 });
    expect(nextOverviewCell("ArrowRight", 0, 2, [3])).toEqual({ row: 0, col: 0 }); // wraps
    expect(nextOverviewCell("ArrowLeft", 0, 0, [3])).toEqual({ row: 0, col: 2 }); // wraps
    expect(nextOverviewCell("ArrowLeft", 0, 1, [3])).toEqual({ row: 0, col: 0 });
  });

  test("Home / End jump to the ends of the focused row", () => {
    expect(nextOverviewCell("Home", 0, 2, [4])).toEqual({ row: 0, col: 0 });
    expect(nextOverviewCell("End", 0, 0, [4])).toEqual({ row: 0, col: 3 });
  });

  test("Up / Down change rows and keep the column (clamped to the new row's length)", () => {
    // Two rows: the Spaces strip (3) above the windows (4).
    expect(nextOverviewCell("ArrowDown", 0, 1, [3, 4])).toEqual({ row: 1, col: 1 });
    expect(nextOverviewCell("ArrowUp", 1, 2, [3, 4])).toEqual({ row: 0, col: 2 });
    // Column 3 exists in the windows row but not in the 2-tile row above: clamp, don't vanish.
    expect(nextOverviewCell("ArrowUp", 1, 3, [2, 4])).toEqual({ row: 0, col: 1 });
    // Rows wrap.
    expect(nextOverviewCell("ArrowDown", 1, 0, [3, 4])).toEqual({ row: 0, col: 0 });
    expect(nextOverviewCell("ArrowUp", 0, 0, [3, 4])).toEqual({ row: 1, col: 0 });
  });

  test("in a one-row panel Up / Down walk that row (two arrows must not be dead keys)", () => {
    expect(nextOverviewCell("ArrowDown", 0, 0, [3])).toEqual({ row: 0, col: 1 });
    expect(nextOverviewCell("ArrowUp", 0, 0, [3])).toEqual({ row: 0, col: 2 });
  });

  test("an empty neighbouring row is left alone rather than jumped over", () => {
    // The Spaces strip rendered with no Spaces: there is no honest tile below from row 0.
    expect(nextOverviewCell("ArrowDown", 0, 0, [2, 0])).toBeNull();
  });

  test("keys this module does not own, and grids with nowhere to go, are left alone", () => {
    for (const key of ["Tab", "Escape", "Enter", " ", "a", "PageDown"]) {
      expect(nextOverviewCell(key, 0, 0, [3]), key).toBeNull();
    }
    expect(nextOverviewCell("ArrowRight", 0, 0, [])).toBeNull();
    expect(nextOverviewCell("ArrowRight", 0, 0, [0])).toBeNull(); // focused row is empty
  });

  test("an out-of-range current cell is clamped instead of throwing", () => {
    expect(nextOverviewCell("ArrowRight", 99, 99, [3])).toEqual({ row: 0, col: 0 });
    expect(nextOverviewCell("ArrowRight", -5, -5, [3])).toEqual({ row: 0, col: 1 });
    expect(nextOverviewCell("ArrowDown", 99, 99, [3, 4])).toEqual({ row: 0, col: 2 });
  });
});

describe("overviewTiles / overviewCellAt — the tiles a row offers", () => {
  test("disabled tiles are skipped, in DOM order", () => {
    const r = row(["a", "b", "c"], ["b"]);
    expect(overviewTiles(r).map((b) => b.dataset.testid)).toEqual(["a", "c"]);
  });

  test("overviewCellAt addresses by row/col and reports a missing tile as null", () => {
    const r0 = row(["r0c0", "r0c1"]);
    const r1 = row(["r1c0"]);
    expect(overviewCellAt([r0, r1], { row: 1, col: 0 })?.dataset.testid).toBe("r1c0");
    expect(overviewCellAt([r0, r1], { row: 0, col: 9 })).toBeNull();
    expect(overviewCellAt([r0], { row: 5, col: 0 })).toBeNull();
  });
});

describe("installOverviewKeyboard — the behaviour a user gets", () => {
  test("the first nav key makes the first tile reachable when nothing is focused", () => {
    const r0 = row(["s0", "s1"]);
    const r1 = row(["w0", "w1"]);
    const off = track(installOverviewKeyboard([r0, r1]));
    expect(focused()).not.toBe("s0");
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect(focused()).toBe("s0");
    off();
  });

  test("Left / Right walk the focused row and wrap; the key is consumed", () => {
    const r0 = row(["s0", "s1"]);
    const r1 = row(["w0", "w1", "w2"]);
    const off = track(installOverviewKeyboard([r0, r1]));
    press("ArrowRight"); // focus s0
    press("ArrowRight");
    expect(focused()).toBe("s1");
    press("ArrowRight"); // wraps
    expect(focused()).toBe("s0");
    press("ArrowLeft"); // wraps back
    expect(focused()).toBe("s1");
    off();
  });

  test("Down moves to the window row and keeps the column", () => {
    const r0 = row(["s0", "s1", "s2"]);
    const r1 = row(["w0", "w1", "w2"]);
    const off = track(installOverviewKeyboard([r0, r1]));
    press("ArrowRight"); // focus s0
    press("ArrowRight");
    expect(focused()).toBe("s1");
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(focused()).toBe("w1");
    expect(press("ArrowUp").defaultPrevented).toBe(true);
    expect(focused()).toBe("s1");
    off();
  });

  test("a single row (App Exposé) walks with Up / Down too", () => {
    const w = row(["w0", "w1", "w2"]);
    const off = track(installOverviewKeyboard([w]));
    press("ArrowRight"); // focus w0
    press("ArrowDown");
    expect(focused()).toBe("w1");
    press("ArrowUp");
    expect(focused()).toBe("w0");
    off();
  });

  test("a null row is accepted (a Spaces strip that is not rendered)", () => {
    const w = row(["w0", "w1"]);
    const off = track(installOverviewKeyboard([null, w]));
    press("ArrowRight");
    expect(focused()).toBe("w0");
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect(focused()).toBe("w1");
    off();
  });

  test("a key the module does not own is untouched, and cleanup removes the listener", () => {
    const w = row(["w0", "w1"]);
    const off = track(installOverviewKeyboard([w]));
    expect(press("Tab").defaultPrevented).toBe(false);
    expect(press("Escape").defaultPrevented).toBe(false);
    press("ArrowRight"); // focus w0
    expect(focused()).toBe("w0");
    off();
    expect(press("ArrowRight").defaultPrevented).toBe(false);
    expect(focused()).toBe("w0"); // focus did not move: the listener is gone
  });
});

describe("uniformRowLengths / nextGridIndex — a wrapped grid (Launchpad's shape)", () => {
  test("rows are the wrap of `total` at `cols`, and the last row may be short", () => {
    expect(uniformRowLengths(10, 4)).toEqual([4, 4, 2]);
    expect(uniformRowLengths(8, 4)).toEqual([4, 4]);
    expect(uniformRowLengths(3, 8)).toEqual([3]);
    expect(uniformRowLengths(0, 4)).toEqual([]);
    expect(uniformRowLengths(4, 0)).toEqual([]); // no columns ⇒ no grid to walk
  });

  test("Left / Right walk the row and wrap at its ends", () => {
    // 10 tiles in 4 columns: index 3 is the end of row 0 ⇒ Right wraps back to index 0.
    expect(nextGridIndex("ArrowRight", 2, 10, 4)).toBe(3);
    expect(nextGridIndex("ArrowRight", 3, 10, 4)).toBe(0);
    expect(nextGridIndex("ArrowLeft", 0, 10, 4)).toBe(3);
    expect(nextGridIndex("ArrowLeft", 4, 10, 4)).toBe(7);
    // The short last row (2 tiles) wraps within itself, never into a tile that is not there.
    expect(nextGridIndex("ArrowRight", 9, 10, 4)).toBe(8);
    expect(nextGridIndex("ArrowLeft", 8, 10, 4)).toBe(9);
  });

  test("Up / Down change rows, keep the column, and wrap", () => {
    expect(nextGridIndex("ArrowDown", 1, 10, 4)).toBe(5);
    expect(nextGridIndex("ArrowUp", 5, 10, 4)).toBe(1);
    // Down from row 1 col 3 lands in the 2-tile last row: the column is clamped, not lost.
    expect(nextGridIndex("ArrowDown", 7, 10, 4)).toBe(9);
    // Down from the last row wraps to the first.
    expect(nextGridIndex("ArrowDown", 9, 10, 4)).toBe(1);
  });

  test("Home / End are the ends of the focused row; a single row walks with Up/Down", () => {
    expect(nextGridIndex("Home", 6, 10, 4)).toBe(4);
    expect(nextGridIndex("End", 4, 10, 4)).toBe(7);
    // One row: Up/Down must not be dead keys (the same rule the overview panels follow).
    expect(nextGridIndex("ArrowDown", 0, 3, 8)).toBe(1);
    expect(nextGridIndex("ArrowUp", 0, 3, 8)).toBe(2);
  });

  test("keys it does not own, and grids with nowhere to go, are left alone", () => {
    for (const key of ["Tab", "Escape", "Enter", " "]) {
      expect(nextGridIndex(key, 0, 8, 4), key).toBeNull();
    }
    expect(nextGridIndex("ArrowRight", 0, 0, 4)).toBeNull();
    expect(nextGridIndex("ArrowRight", 0, 8, 0)).toBeNull();
  });

  test("an out-of-range index is clamped instead of throwing", () => {
    expect(nextGridIndex("ArrowRight", 99, 10, 4)).toBe(8); // clamped into the last row, then moved
    expect(nextGridIndex("ArrowRight", -5, 10, 4)).toBe(1); // clamped to index 0, then moved
  });
});

describe("installGridKeyboard — the behaviour a user gets on a wrapped grid", () => {
  test("the first nav key focuses the first tile when nothing is focused", () => {
    const g = grid(6);
    const off = track(installGridKeyboard(g, 3));
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect(focused()).toBe("t0");
    off();
  });

  test("Right walks the row and wraps; the key is consumed", () => {
    const g = grid(6);
    const off = track(installGridKeyboard(g, 3));
    overviewTiles(g)[1]!.focus();
    const ev = press("ArrowRight");
    expect(ev.defaultPrevented).toBe(true);
    expect(focused()).toBe("t2");
    press("ArrowRight");
    expect(focused()).toBe("t0"); // wrapped within row 0, not into row 1
    off();
  });

  test("Down moves a whole row and keeps the column", () => {
    const g = grid(6);
    const off = track(installGridKeyboard(g, 3));
    overviewTiles(g)[1]!.focus();
    press("ArrowDown");
    expect(focused()).toBe("t4");
    off();
  });

  test("an editable target keeps the arrow keys — the search field is not hijacked", () => {
    const g = grid(6);
    const off = track(installGridKeyboard(g, 3));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const ev = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      cancelable: true,
      bubbles: true,
    });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input); // the caret moves, the grid does not
    off();
  });

  test("a key it does not own is untouched, and cleanup removes the listener", () => {
    const g = grid(6);
    const off = track(installGridKeyboard(g, 3));
    overviewTiles(g)[1]!.focus();
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(focused()).toBe("t1");
    off();
    expect(press("ArrowRight").defaultPrevented).toBe(false);
    expect(focused()).toBe("t1"); // focus did not move: the listener is gone
  });
});

/**
 * The `wrap: false` mode — the desktop icon grid's rule.
 *
 * The desktop's grid is a `display: grid` with `repeat(DESKTOP_GRID_COLS, …)` and row-major
 * flow, and it keeps its own focus (`focusedId` + `aria-activedescendant`) instead of moving
 * DOM focus. Its arrows used to be `±1` for **both** axes — `ArrowDown` was a synonym of
 * `ArrowRight` — so on a 4-column desktop pressing Down slid the selection sideways. These
 * cases pin the clamped geometry, and in particular the contrast with the default mode, so a
 * later "simplification" cannot quietly fold the two rules back into one.
 */
describe("nextGridIndex — the clamped mode (the desktop's icon grid)", () => {
  const clamped = (key: string, index: number, total: number, cols: number) =>
    nextGridIndex(key, index, total, cols, { wrap: false });

  test("Down / Up move a whole row and keep the column; they are not synonyms of Right / Left", () => {
    // 6 tiles in 4 columns ⇒ rows [4, 2].
    expect(clamped("ArrowDown", 0, 6, 4)).toBe(4); // row 1, column 0
    expect(clamped("ArrowDown", 1, 6, 4)).toBe(5); // row 1, column 1
    expect(clamped("ArrowUp", 4, 6, 4)).toBe(0);
    expect(clamped("ArrowUp", 5, 6, 4)).toBe(1);
    // The defect this mode exists to prevent: on a 4-column grid Down must not equal Right.
    for (const i of [0, 1, 2]) {
      expect(clamped("ArrowDown", i, 6, 4)).not.toBe(clamped("ArrowRight", i, 6, 4));
    }
  });

  test("Left / Right walk the reading order and clamp at the ends", () => {
    expect(clamped("ArrowRight", 0, 6, 4)).toBe(1);
    expect(clamped("ArrowRight", 3, 6, 4)).toBe(4); // continues into the next row
    expect(clamped("ArrowRight", 5, 6, 4)).toBe(5); // clamps, never wraps to the first tile
    expect(clamped("ArrowLeft", 4, 6, 4)).toBe(3);
    expect(clamped("ArrowLeft", 0, 6, 4)).toBe(0); // clamps at the first tile
  });

  test("a short last row clamps to the nearest tile in it, and the ends clamp too", () => {
    // Row 1 holds columns 0–1, so there is no tile under column 3: stop at the last one.
    expect(clamped("ArrowDown", 3, 6, 4)).toBe(5);
    expect(clamped("ArrowDown", 5, 6, 4)).toBe(5); // last tile: nowhere to go, stays put
    expect(clamped("ArrowUp", 0, 6, 4)).toBe(0); // first row: nothing above
  });

  test("a full grid's edges stay put — Up on row 0 and Down on the last row never slide sideways", () => {
    // The desktop's own shape: 16 icons in 4 columns, **every row full** ⇒ rows [4,4,4,4]. The
    // 6-tile grid above cannot reach this: its last row is short, so `i ± cols` happened to land
    // somewhere real. With no tile above (row 0) or below (row 3) the raw arithmetic clamped the
    // index into a horizontal move — Up from 1 answered 0, Down from 14 answered 15 — i.e. exact
    // synonyms of ArrowLeft / ArrowRight, the defect this mode exists to prevent.
    for (const i of [1, 2, 3]) {
      expect(clamped("ArrowUp", i, 16, 4), `Up from ${i}`).toBe(i);
      expect(clamped("ArrowUp", i, 16, 4)).not.toBe(clamped("ArrowLeft", i, 16, 4));
    }
    for (const i of [12, 13, 14]) {
      expect(clamped("ArrowDown", i, 16, 4), `Down from ${i}`).toBe(i);
      expect(clamped("ArrowDown", i, 16, 4)).not.toBe(clamped("ArrowRight", i, 16, 4));
    }
    // The interior rows are unaffected: a whole row, keeping the column.
    expect(clamped("ArrowDown", 1, 16, 4)).toBe(5);
    expect(clamped("ArrowUp", 14, 16, 4)).toBe(10);
  });

  test("Home / End are the ends of the LIST here (not of the focused row)", () => {
    // The wrapping mode scopes Home/End to the row; this mode must not — the desktop has no
    // row elements to scope to, and the list ends are what Finder's Home/End reach.
    expect(clamped("Home", 5, 6, 4)).toBe(0);
    expect(clamped("End", 0, 6, 4)).toBe(5);
    expect(clamped("Home", 4, 10, 4)).toBe(0);
    expect(clamped("End", 4, 10, 4)).toBe(9);
  });

  test("the two modes really differ at the edges (the default keeps wrapping)", () => {
    // Same grid, same key, same start — opposite answers. This is the contrast that keeps the
    // mode explicit at every call site.
    expect(nextGridIndex("ArrowDown", 9, 10, 4)).toBe(1); // wrapping: around to the top
    expect(clamped("ArrowDown", 9, 10, 4)).toBe(9); // clamping: stays put
    expect(nextGridIndex("ArrowRight", 3, 10, 4)).toBe(0); // wraps within the row
    expect(clamped("ArrowRight", 3, 10, 4)).toBe(4); // continues into the next row
  });

  test("keys it does not own, and grids with nowhere to go, are left alone", () => {
    for (const key of ["Tab", "Escape", "Enter", " ", "a", "PageDown"]) {
      expect(clamped(key, 0, 6, 4), key).toBeNull();
    }
    expect(clamped("ArrowDown", 0, 0, 4)).toBeNull();
    expect(clamped("ArrowDown", 0, 6, 0)).toBeNull();
  });

  test("an out-of-range index is clamped instead of throwing", () => {
    expect(clamped("ArrowLeft", 99, 6, 4)).toBe(4); // clamped to the last tile, then moved
    expect(clamped("ArrowRight", -5, 6, 4)).toBe(1); // clamped to the first tile, then moved
    expect(clamped("ArrowDown", 99, 6, 4)).toBe(5);
  });
});

describe("nextListIndex — the flat vertical list (both Spotlights' result rows)", () => {
  test("↓ / ↑ step one row and clamp at the ends", () => {
    expect(nextListIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextListIndex("ArrowUp", 1, 3)).toBe(0);
    // Last row: ↓ stays; first row: ↑ stays. macOS Spotlight does not wrap.
    expect(nextListIndex("ArrowDown", 2, 3)).toBe(2);
    expect(nextListIndex("ArrowUp", 0, 3)).toBe(0);
  });

  test("↑ from the top hit reaches the suggestions drawn ABOVE it", () => {
    // The panel draws its suggestions first, then the hits — so walking up out of the hits is
    // how a suggestion is reached at all. Nothing here may special-case "the first row".
    expect(nextListIndex("ArrowUp", 2, 5)).toBe(1);
  });

  test("the horizontal axis and Home/End are NOT owned (the caret keeps them)", () => {
    // ←/→ are not the list's: this is a vertical list, and the caller's focus is in a text
    // field where Home/End belong to the caret.
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " ", "Tab", "Escape"]) {
      expect(nextListIndex(key, 1, 3), key).toBeNull();
    }
  });

  test("an empty list has nowhere to go; an out-of-range index is clamped first", () => {
    expect(nextListIndex("ArrowDown", 0, 0)).toBeNull();
    expect(nextListIndex("ArrowDown", 99, 3)).toBe(2); // clamped to the last row, stays
    expect(nextListIndex("ArrowUp", -5, 3)).toBe(0);
  });

  test("it is NOT a one-column grid — that shape would make ↓ a synonym of →", () => {
    // The whole reason this function exists next to `nextGridIndex`: at one column, the grid's
    // ArrowDown and ArrowRight branches both evaluate to `i + 1`, so ↓ would be a synonym of →
    // and ←/→ would step the list vertically — F-SH-351's defect, one axis over.
    const gridOneCol = nextGridIndex("ArrowDown", 1, 5, 1, { wrap: false });
    expect(gridOneCol).toBe(nextGridIndex("ArrowRight", 1, 5, 1, { wrap: false }));
    expect(nextListIndex("ArrowRight", 1, 5)).toBeNull(); // …while the list leaves → alone
  });
});
