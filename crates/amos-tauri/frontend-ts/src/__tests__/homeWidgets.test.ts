/**
 * homeWidgets.test.ts — the pure widget-stack model (see `lib/homeWidgets.ts`).
 *
 * The properties pinned here are the ones a screen reader / a store cannot catch:
 * a missing key must decode to **today's** stack (not to nothing), a stored string must not
 * be able to become a widget by typing, and every catalog entry must name a REAL app (a
 * widget whose tap goes nowhere is a dead tile — REQ-A673 / FMEA F-SH-138).
 */
import { describe, expect, test } from "bun:test";
import {
  addWidget,
  canAddWidget,
  canMoveWidget,
  DEFAULT_WIDGET_KINDS,
  HOME_WIDGETS_KEY,
  MAX_WIDGETS,
  moveWidget,
  normalizeWidgets,
  removeWidget,
  WIDGET_CATALOG,
  WIDGET_KINDS,
  WIDGETS_PER_ROW,
  widgetAppId,
  widgetRows,
  widgetSpec,
  type WidgetKind,
} from "../lib/homeWidgets";
import { appTitleKey } from "../lib/appMeta";
import { zh } from "../i18n/locales/zh";

describe("homeWidgets — the catalog", () => {
  test("every widget opens a real app and has a dictionary name", () => {
    for (const spec of WIDGET_CATALOG) {
      // The tap destination must be an app this build actually has.
      expect(appTitleKey(spec.appId)).not.toBeNull();
      // …and the gallery row must have a name users can read (no raw keys on screen).
      expect(typeof zh[spec.labelKey as keyof typeof zh]).toBe("string");
    }
  });

  test("widgetAppId answers with the catalog's own appId for every kind", () => {
    // The tap destination has ONE owner: `widgetAppId` delegates to the catalog, so the
    // value `homeWidgets.test.ts` checks above is the value `HomeWidgets.svelte` opens.
    // Two copies (a literal beside the field) is how a tile opens a dead app while the
    // check stays green.
    for (const spec of WIDGET_CATALOG) {
      expect(widgetAppId(spec.kind)).toBe(spec.appId);
      expect(appTitleKey(widgetAppId(spec.kind))).not.toBeNull();
    }
  });

  test("the catalog and the kind union agree, one entry each", () => {
    expect(WIDGET_CATALOG.map((w) => w.kind).sort()).toEqual([...WIDGET_KINDS].sort());
    expect(new Set(WIDGET_CATALOG.map((w) => w.kind)).size).toBe(WIDGET_CATALOG.length);
  });

  test("the store key is namespaced like its neighbours", () => {
    expect(HOME_WIDGETS_KEY).toBe("amos.home.widgets");
  });

  test("widgetSpec answers only for kinds this build knows", () => {
    expect(widgetSpec("clock")?.kind).toBe("clock");
    expect(widgetSpec("nope")).toBeNull();
    expect(widgetSpec(null)).toBeNull();
    expect(widgetSpec(42)).toBeNull();
    // A prototype key must not read as a widget.
    expect(widgetSpec("constructor")).toBeNull();
    expect(widgetSpec("toString")).toBeNull();
  });

  test("the default stack is the clock + weather header this screen always drew", () => {
    expect([...DEFAULT_WIDGET_KINDS]).toEqual(["clock", "weather"]);
    expect(widgetRows(DEFAULT_WIDGET_KINDS)).toEqual([["clock", "weather"]]);
  });
});

describe("homeWidgets — decoding stored state", () => {
  test("a missing or unusable value decodes to the default stack", () => {
    for (const raw of [null, undefined, {}, "clock", 5, true, { 0: "clock" }]) {
      expect(normalizeWidgets(raw)).toEqual([...DEFAULT_WIDGET_KINDS]);
    }
  });

  test("a well-formed array is taken at face value — including empty", () => {
    expect(normalizeWidgets([])).toEqual([]); // "I removed them all" is a real intent
    expect(normalizeWidgets(["battery"])).toEqual(["battery"]);
  });

  test("unknown kinds are dropped, order preserved", () => {
    expect(normalizeWidgets(["weather", "spinner", "clock"])).toEqual(["weather", "clock"]);
    expect(normalizeWidgets(["spinner"])).toEqual([]); // all-unknown ⇒ empty, not default
  });

  test("duplicates collapse to their first position", () => {
    expect(normalizeWidgets(["weather", "clock", "weather"])).toEqual(["weather", "clock"]);
  });

  test("the list is capped at the catalog size", () => {
    const many = [...Array(50).fill("clock"), ...WIDGET_KINDS];
    const out = normalizeWidgets(many);
    expect(out.length).toBeLessThanOrEqual(MAX_WIDGETS);
    expect(out[0]).toBe("clock");
  });
});

describe("homeWidgets — editing is total", () => {
  const base: WidgetKind[] = ["clock"];

  test("add refuses unknown, duplicate and over-capacity kinds", () => {
    expect(canAddWidget(base, "battery")).toBe(true);
    expect(canAddWidget(base, "clock")).toBe(false); // already placed
    expect(canAddWidget(base, "spinner")).toBe(false); // not in this build
    expect(canAddWidget([...WIDGET_KINDS], "clock")).toBe(false); // full
    expect(addWidget(base, "spinner")).toEqual(base);
    expect(addWidget(base, "clock")).toEqual(base);
    expect(addWidget(base, "battery")).toEqual(["clock", "battery"]);
  });

  test("the full stack refuses a new kind rather than dropping an existing one", () => {
    const full = [...WIDGET_KINDS];
    expect(full.length).toBe(MAX_WIDGETS);
    expect(addWidget(full, "clock")).toEqual(full);
  });

  test("remove is a no-op for an absent or unknown kind", () => {
    expect(removeWidget(base, "battery")).toEqual(base);
    expect(removeWidget(base, "spinner")).toEqual(base);
    expect(removeWidget(["clock", "weather"], "clock")).toEqual(["weather"]);
  });

  test("move swaps with the neighbour and refuses to leave the ends", () => {
    const list: WidgetKind[] = ["clock", "weather", "battery"];
    expect(moveWidget(list, "weather", -1)).toEqual(["weather", "clock", "battery"]);
    expect(moveWidget(list, "weather", 1)).toEqual(["clock", "battery", "weather"]);
    expect(moveWidget(list, "clock", -1)).toEqual(list); // already first
    expect(moveWidget(list, "battery", 1)).toEqual(list); // already last
    expect(moveWidget(list, "spinner", 1)).toEqual(list);
  });

  test("canMoveWidget mirrors what moveWidget would do", () => {
    const list: WidgetKind[] = ["clock", "weather"];
    expect(canMoveWidget(list, "weather", -1)).toBe(true);
    expect(canMoveWidget(list, "clock", -1)).toBe(false);
    expect(canMoveWidget(list, "clock", 1)).toBe(true);
    expect(canMoveWidget(list, "weather", 1)).toBe(false);
    expect(canMoveWidget(list, "spinner", 1)).toBe(false);
    for (const kind of list) {
      for (const d of [-1, 1]) {
        expect(canMoveWidget(list, kind, d)).toBe(moveWidget(list, kind, d).join() !== list.join());
      }
    }
  });

  test("edits never mutate the list they were given", () => {
    const list: WidgetKind[] = ["clock", "weather"];
    addWidget(list, "battery");
    removeWidget(list, "clock");
    moveWidget(list, "weather", -1);
    expect(list).toEqual(["clock", "weather"]);
  });
});

describe("homeWidgets — row arrangement", () => {
  test("small widgets pair two per row; the default row is [1fr, auto]", () => {
    expect(widgetRows(["clock", "weather"])).toEqual([["clock", "weather"]]);
    expect(widgetRows(["clock", "weather", "battery"])).toEqual([
      ["clock", "weather"],
      ["battery"],
    ]);
  });

  test("a large widget owns its row", () => {
    expect(widgetRows(["clock", "calendar", "weather"])).toEqual([
      ["clock"],
      ["calendar"],
      ["weather"],
    ]);
  });

  test("unknown kinds never produce a blank cell", () => {
    expect(widgetRows(["clock", "spinner" as WidgetKind])).toEqual([["clock"]]);
    expect(widgetRows([])).toEqual([]);
  });

  test("a row never exceeds the per-row limit", () => {
    for (const row of widgetRows([...WIDGET_KINDS])) {
      expect(row.length).toBeLessThanOrEqual(WIDGETS_PER_ROW);
      expect(row.length).toBeGreaterThan(0);
    }
  });
});
