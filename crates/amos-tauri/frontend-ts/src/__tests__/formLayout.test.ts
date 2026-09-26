import { describe, expect, test } from "bun:test";
import {
  appLibraryColumns,
  DESKTOP_MAX_COLS,
  DESKTOP_MAX_ROWS,
  deviceChrome,
  DOCK_RECENT_SLOTS,
  dockRecents,
  dockRecentSlots,
  homeGrid,
  homeTile,
  masterDetail,
  pageCapacity,
  photosCols,
  PHONE_GRID,
  pwaHubCols,
  TABLET_SIDEBAR_MAX_PX,
  TABLET_SIDEBAR_MIN_PX,
  TABLET_SIDEBAR_MIN_WIDTH,
  webManInline,
  type HomeGrid,
} from "../lib/formLayout";
import type { FormFactor } from "../lib/wm";

const FORMS: FormFactor[] = ["phone", "tablet", "desktop", "robot"];

/** A few real-ish measured screens, including the unmeasured 0×0 fallback. */
const SCREENS: Array<[number, number]> = [
  [0, 0],
  [480, 820],
  [820, 480],
  [900, 1200],
  [1200, 900],
  [900, 900],
  [1496, 881],
];

describe("homeGrid — the phone path is byte-identical", () => {
  test("phone keeps the hard-coded 4×3 = 12 the component used before", () => {
    for (const [w, h] of SCREENS) {
      expect(homeGrid("phone", w, h)).toEqual({ cols: 4, rows: 3 });
    }
    expect(pageCapacity(PHONE_GRID)).toBe(12);
  });

  test("robot has no UI, so its inert grid is the phone's (never a zero grid)", () => {
    for (const [w, h] of SCREENS) {
      expect(homeGrid("robot", w, h)).toEqual(PHONE_GRID);
    }
  });

  test("desktop gets a Launchpad-class grid derived from the window it has", () => {
    // The Mac this work was measured on: a maximized shell window is 1496×881
    // (REQ-A233). 1496 ⇒ 8 columns at the 170 px pitch, (881−284) ⇒ 4 rows at 140.
    // Pinned as a *number*, not just a property: this is the geometry an operator
    // sees on that desktop, and a silent change to it should fail a test.
    expect(homeGrid("desktop", 1496, 881)).toEqual({ cols: 8, rows: 4 });
    expect(pageCapacity(homeGrid("desktop", 1496, 881))).toBe(32);
    // …and it really is denser than the phone grid it used to borrow.
    expect(pageCapacity(homeGrid("desktop", 1496, 881))).toBeGreaterThan(
      pageCapacity(PHONE_GRID),
    );
  });

  test("a desktop window never gets FEWER icons per page than a phone", () => {
    // A small desktop window is a real case (a Mac window can be resized down): the
    // answer must never be worse than the phone's, and never a zero/negative grid.
    for (const [w, h] of [
      [800, 600],
      [480, 820],
      [640, 400],
      [300, 200],
      [200, 1200],
    ] as Array<[number, number]>) {
      const g = homeGrid("desktop", w, h);
      expect(g.cols).toBeGreaterThanOrEqual(PHONE_GRID.cols);
      expect(g.rows).toBeGreaterThanOrEqual(PHONE_GRID.rows);
    }
    expect(homeGrid("desktop", 800, 600)).toEqual(PHONE_GRID);
  });

  test("the desktop grid is bounded and monotonic in the window size", () => {
    expect(homeGrid("desktop", 100_000, 100_000)).toEqual({
      cols: DESKTOP_MAX_COLS,
      rows: DESKTOP_MAX_ROWS,
    });
    // Wider is never fewer columns; taller is never fewer rows.
    let last = 0;
    for (const w of [600, 900, 1200, 1496, 1920, 2560]) {
      const cols = homeGrid("desktop", w, 1000).cols;
      expect(cols).toBeGreaterThanOrEqual(last);
      last = cols;
    }
  });

  test("an unmeasured desktop screen degrades to the phone grid, never a guess", () => {
    for (const [w, h] of [
      [0, 0],
      [0, 881],
      [1496, 0],
      [-1, -1],
      [Number.NaN, 881],
      [1496, Number.POSITIVE_INFINITY],
    ]) {
      expect(homeGrid("desktop", w as number, h as number)).toEqual(PHONE_GRID);
    }
  });
});

describe("homeGrid — the tablet gets iPadOS densities", () => {
  test("portrait is 4×6 (24 per page), landscape 6×4 (24 per page)", () => {
    expect(homeGrid("tablet", 900, 1200)).toEqual({ cols: 4, rows: 6 });
    expect(homeGrid("tablet", 1200, 900)).toEqual({ cols: 6, rows: 4 });
    expect(pageCapacity(homeGrid("tablet", 900, 1200))).toBe(24);
    expect(pageCapacity(homeGrid("tablet", 1200, 900))).toBe(24);
  });

  test("a square screen counts as portrait (same rule as split_axis)", () => {
    expect(homeGrid("tablet", 900, 900)).toEqual({ cols: 4, rows: 6 });
  });

  test("an unmeasured table screen degrades to the phone grid, never a guess", () => {
    // Mirrors `LayoutPolicy::columns_for(0) == 1`: an unmeasured screen gets the
    // most conservative answer rather than an invented tablet density.
    for (const [w, h] of [
      [0, 0],
      [0, 1200],
      [900, 0],
      [-1, -1],
      [Number.NaN, 1200],
      [900, Number.POSITIVE_INFINITY],
    ]) {
      expect(homeGrid("tablet", w as number, h as number)).toEqual(PHONE_GRID);
    }
  });
});

describe("homeGrid / pageCapacity — invariants over every class and screen", () => {
  test("pages are always non-empty and bounded by iPad/phone densities", () => {
    for (const form of FORMS) {
      for (const [w, h] of SCREENS) {
        const g: HomeGrid = homeGrid(form, w, h);
        expect(Number.isInteger(g.cols) && g.cols >= 1).toBe(true);
        expect(Number.isInteger(g.rows) && g.rows >= 1).toBe(true);
        // Class-aware ceiling: the desktop may go up to its own caps, every other
        // class stays within the iPad/phone densities.
        expect(g.cols).toBeLessThanOrEqual(form === "desktop" ? DESKTOP_MAX_COLS : 6);
        expect(g.rows).toBeLessThanOrEqual(DESKTOP_MAX_ROWS);
        expect(pageCapacity(g)).toBe(g.cols * g.rows);
        // No class ever pages *less* densely than the phone, whatever it is told.
        expect(g.cols).toBeGreaterThanOrEqual(PHONE_GRID.cols);
        expect(g.rows).toBeGreaterThanOrEqual(PHONE_GRID.rows);
      }
    }
  });

  test("the plan is a pure function of its inputs", () => {
    for (const form of FORMS) {
      for (const [w, h] of SCREENS) {
        expect(homeGrid(form, w, h)).toEqual(homeGrid(form, w, h));
      }
    }
  });
});

describe("homeTile — a desktop Launcher draws Launchpad-class tiles", () => {
  test("only the desktop is `large`; every other class keeps today's tiles", () => {
    expect(homeTile("desktop")).toBe("large");
    for (const form of ["phone", "tablet", "robot"] as FormFactor[]) {
      expect(homeTile(form)).toBe("regular");
    }
  });
});

describe("deviceChrome — do not draw another device's hardware", () => {
  test("the Dynamic Island is iPhone hardware: only the phone gets it", () => {
    // It was drawn unconditionally, so a maximized macOS window showed a black pill
    // that stands for an iPhone 14 Pro screen cutout — hardware that is not there.
    // An iPad has none either (iPadOS has no Dynamic Island).
    expect(deviceChrome("phone").dynamicIsland).toBe(true);
    for (const form of ["tablet", "desktop", "robot"] as FormFactor[]) {
      expect(deviceChrome(form).dynamicIsland).toBe(false);
    }
  });

  test("the home indicator is a touch gesture bar: touch classes only", () => {
    expect(deviceChrome("phone").homeIndicator).toBe(true);
    expect(deviceChrome("tablet").homeIndicator).toBe(true);
    // A macOS window has no gesture bar; its way back is the toolbar control.
    expect(deviceChrome("desktop").homeIndicator).toBe(false);
    // The robot class has no UI at all (`FormFactor::has_ui()`), so it gets neither.
    expect(deviceChrome("robot")).toEqual({
      dynamicIsland: false,
      homeIndicator: false,
      titleBar: false,
    });
  });

  test("only a desktop window has an OS title bar to put a name in (REQ-A250)", () => {
    expect(deviceChrome("desktop").titleBar).toBe(true);
    for (const form of ["phone", "tablet", "robot"] as FormFactor[]) {
      expect(deviceChrome(form).titleBar).toBe(false);
    }
  });

  test("every class gets an answer (no field left to a caller's guess)", () => {
    for (const form of FORMS) {
      const chrome = deviceChrome(form);
      expect(typeof chrome.dynamicIsland).toBe("boolean");
      expect(typeof chrome.homeIndicator).toBe("boolean");
      expect(typeof chrome.titleBar).toBe("boolean");
    }
  });
});

describe("appLibraryColumns — the library surface scales with the class (REQ-A289)", () => {
  test("phone keeps today's 4 columns (no UI drift on existing devices)", () => {
    expect(appLibraryColumns("phone")).toBe(4);
  });

  test("tablet widens to 6 columns (iPadOS App-Library density)", () => {
    // The audit (REQ-A289) found the App Library surface rendering on a tablet was
    // still 4 columns wide — REQ-A234 wired the *home* grid for tablet but not the
    // library. iPadOS uses 6; the screen real estate on a 900x1200 tablet is otherwise
    // wasted as a half-empty 4-col grid.
    expect(appLibraryColumns("tablet")).toBe(6);
  });

  test("desktop widens further (matches Launchpad-class capacity, capped by the desktop cap)", () => {
    // Pinned to DESKTOP_MAX_COLS rather than a magic number: this is the same cap
    // `homeGrid` honors, so the library and the launcher stay in step.
    expect(appLibraryColumns("desktop")).toBe(DESKTOP_MAX_COLS);
  });

  test("robot has no UI, so its library column count is the phone's (never zero)", () => {
    expect(appLibraryColumns("robot")).toBe(4);
  });

  test("the column count is a positive integer for every class", () => {
    for (const form of FORMS) {
      const n = appLibraryColumns(form);
      expect(Number.isInteger(n) && n >= 1).toBe(true);
    }
  });
});

describe("photosCols — the Photos grid scales with the class (REQ-A292)", () => {
  test("phone keeps today's 3 columns (iOS Photos phone density)", () => {
    expect(photosCols("phone")).toBe(3);
  });

  test("tablet widens to 5 columns (iPadOS My-Photos density)", () => {
    // iPadOS Photos is 5 columns wide in My Photos — the same density that ships on
    // a 12.9" iPad Pro and the same the user expects. A 3-column grid on a 900px-wide
    // tablet window wastes half the width.
    expect(photosCols("tablet")).toBe(5);
  });

  test("desktop widens further (matches the launcher cap)", () => {
    // Pinned to DESKTOP_MAX_COLS (not a hand-picked number): the launcher already
    // honors this cap, so the gallery stays in step with it.
    expect(photosCols("desktop")).toBe(DESKTOP_MAX_COLS);
  });

  test("robot has no UI, so its gallery column count is the phone's (never zero)", () => {
    expect(photosCols("robot")).toBe(3);
  });

  test("the column count is a positive integer for every class", () => {
    for (const form of FORMS) {
      const n = photosCols(form);
      expect(Number.isInteger(n) && n >= 1).toBe(true);
    }
  });
});

describe("pwaHubCols — system PWA index grid column count", () => {
  // The PWA picker is a *3rd* member of the form-aware grid family, joining the
  // App Library (REQ-A290) and Photos (REQ-A292). The numbers do NOT equal any of
  // the siblings — 4/6/DESKTOP_MAX_COLS is iOS-style picker density, not Photos
  // density — so each surface owns its own function name.
  const FORMS: FormFactor[] = ["phone", "tablet", "desktop", "robot"];

  test("phone uses the iOS-picker 4-column density", () => {
    expect(pwaHubCols("phone")).toBe(4);
  });

  test("tablet widens to 6 columns (iPadOS picker density)", () => {
    expect(pwaHubCols("tablet")).toBe(6);
  });

  test("desktop uses the launcher cap (DESKTOP_MAX_COLS), not a hand-picked number", () => {
    expect(pwaHubCols("desktop")).toBe(DESKTOP_MAX_COLS);
  });

  test("robot has no UI, so its picker column count is the phone's (never zero)", () => {
    expect(pwaHubCols("robot")).toBe(4);
  });

  test("the column count is a positive integer for every class", () => {
    for (const form of FORMS) {
      const n = pwaHubCols(form);
      expect(Number.isInteger(n) && n >= 1).toBe(true);
    }
  });
});

describe("masterDetail — the tablet's list→detail layout (REQ-A512 sibling)", () => {
  // The decision family's *second* behavioral consumer of the host's measured
  // `columns` (the split gate is the first): a list→detail surface may put its list
  // beside the detail, but only on a tablet whose screen the host has measured wide
  // enough for two panes. Every other class keeps the push-page it has always had.

  test("only the tablet ever shows a sidebar", () => {
    for (const form of ["phone", "desktop", "robot"] as FormFactor[]) {
      expect(masterDetail(form, 4, 2000)).toEqual({ sidebar: false, sidebarWidth: 0 });
    }
  });

  test("a tablet whose columns the host measured < 2 gets no sidebar", () => {
    // The host's column signal is the same gate `canSplit` uses — a screen it says
    // cannot fit two panes must not get a sidebar column either.
    expect(masterDetail("tablet", 1, 1200)).toEqual({ sidebar: false, sidebarWidth: 0 });
    expect(masterDetail("tablet", 0, 1200)).toEqual({ sidebar: false, sidebarWidth: 0 });
  });

  test("a tablet narrower than the sidebar threshold stays a push page", () => {
    // 600 px passes `columns_for`'s band but a 260 px sidebar would leave a 340 px
    // detail — narrower than the phone's own min_pane. The threshold clears that.
    expect(masterDetail("tablet", 2, 600).sidebar).toBe(false);
    expect(masterDetail("tablet", 2, TABLET_SIDEBAR_MIN_WIDTH - 1).sidebar).toBe(false);
    expect(masterDetail("tablet", 2, TABLET_SIDEBAR_MIN_WIDTH).sidebar).toBe(true);
  });

  test("an unmeasured width never invents a sidebar (the conservative rule)", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(masterDetail("tablet", 2, bad)).toEqual({ sidebar: false, sidebarWidth: 0 });
    }
  });

  test("the sidebar width is a bounded fraction of the measured screen", () => {
    // 900 portrait → 288 ; 1200 landscape → 384 clamped to the 360 cap.
    expect(masterDetail("tablet", 2, 900)).toEqual({ sidebar: true, sidebarWidth: 288 });
    expect(masterDetail("tablet", 2, 1200)).toEqual({
      sidebar: true,
      sidebarWidth: TABLET_SIDEBAR_MAX_PX,
    });
    // At the threshold the 32 % floor is raised to the minimum column.
    expect(masterDetail("tablet", 2, 700)).toEqual({
      sidebar: true,
      sidebarWidth: TABLET_SIDEBAR_MIN_PX,
    });
  });

  test("a shown sidebar always leaves a detail column wider than the phone min_pane", () => {
    for (const w of [700, 768, 900, 1024, 1200, 2048]) {
      const md = masterDetail("tablet", 2, w);
      expect(md.sidebar).toBe(true);
      expect(md.sidebarWidth).toBeGreaterThanOrEqual(TABLET_SIDEBAR_MIN_PX);
      expect(md.sidebarWidth).toBeLessThanOrEqual(TABLET_SIDEBAR_MAX_PX);
      // 360 = the shell's phone `min_pane`; a detail narrower than that would be a
      // sidebar that made the content worse than not having one.
      expect(w - md.sidebarWidth).toBeGreaterThanOrEqual(360);
    }
  });

  test("sidebarWidth is 0 exactly when the sidebar is hidden", () => {
    for (const form of FORMS) {
      for (const [cols, w] of [
        [0, 0],
        [2, 600],
        [2, 900],
        [4, 1600],
      ] as Array<[number, number]>) {
        const md = masterDetail(form, cols, w);
        expect(md.sidebarWidth === 0).toBe(!md.sidebar);
      }
    }
  });

  test("the rule is pure — same inputs, same answer (and never NaN)", () => {
    for (const w of [0, 700, 900, 1200, 2048]) {
      const a = masterDetail("tablet", 2, w);
      expect(a).toEqual(masterDetail("tablet", 2, w));
      expect(Number.isInteger(a.sidebarWidth)).toBe(true);
      expect(a.sidebarWidth).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("dockRecentSlots — the iPad Dock's recently-used section", () => {
  test("only the tablet's Dock carries one (iPad, not iPhone)", () => {
    expect(dockRecentSlots("tablet")).toBe(DOCK_RECENT_SLOTS);
    for (const form of ["phone", "robot"] as FormFactor[]) {
      expect(dockRecentSlots(form)).toBe(0);
    }
  });

  test("the desktop answers 0 even though macOS has such a section (its shell is elsewhere)", () => {
    // `DesktopShell` + `lib/desktopLayout.ts` own the desktop Dock and never mount this
    // launcher, so a non-zero answer would be policy no production path renders.
    expect(dockRecentSlots("desktop")).toBe(0);
  });

  test("every class gets a non-negative integer answer", () => {
    for (const form of FORMS) {
      const n = dockRecentSlots(form);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("dockRecents — the apps the Dock section may show", () => {
  test("most-recent-first order is preserved, capped at the slot count", () => {
    expect(dockRecents(["notes", "photos", "files", "mail"], [], 3)).toEqual(["notes", "photos", "files"]);
  });

  test("a pinned app is never repeated in the section (and the cap is on the kept ones)", () => {
    // Dropping a pinned id must let the next recent in, not shrink the section.
    expect(dockRecents(["notes", "photos", "files"], ["notes"], 2)).toEqual(["photos", "files"]);
  });

  test("duplicates collapse to their most-recent occurrence", () => {
    expect(dockRecents(["notes", "photos", "notes", "files"], [], 3)).toEqual(["notes", "photos", "files"]);
  });

  test("a non-positive or non-finite slot count shows nothing (never a whole history)", () => {
    for (const slots of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(dockRecents(["notes", "photos"], [], slots)).toEqual([]);
    }
  });

  test("it filters nothing else — an empty history is an empty section, not a default", () => {
    expect(dockRecents([], ["notes"], 3)).toEqual([]);
  });

  test("the rule is pure", () => {
    const recents = ["notes", "photos", "files"];
    expect(dockRecents(recents, ["notes"], 2)).toEqual(dockRecents(recents, ["notes"], 2));
  });
});

describe("webManInline — whether the browser hosts a page inline (REQ-A554)", () => {
  test("large-screen classes host inline; phone and robot keep the punt card", () => {
    // The whole point: the answer is a function of the **class**, nothing else.
    const expected: Record<FormFactor, boolean> = {
      phone: false,
      tablet: true,
      desktop: true,
      robot: false,
    };
    for (const form of FORMS) {
      expect(webManInline(form)).toBe(expected[form]);
    }
  });

  test("it takes no width — there is no viewport input to disagree with the class", () => {
    // A regression guard on the call shape: the old defect *was* a width argument.
    expect(webManInline("tablet")).toBe(true);
    expect(webManInline("phone")).toBe(false);
  });
});
