/**
 * spotlightSearch.test.ts — the rule that puts apps, files and a calculation in ONE list
 * (REQ-A458). Pure, so the order and the caps are pinned without a DOM: the overlay renders what
 * this returns, and "why is my file below the apps?" is answered here rather than in a component.
 */
import { describe, expect, test } from "bun:test";
import {
  buildSpotlightResults,
  SPOTLIGHT_MAX_APPS,
  SPOTLIGHT_MAX_FILES,
  type SpotlightInputs,
} from "../lib/spotlightSearch";

const inputs = (over: Partial<SpotlightInputs> = {}): SpotlightInputs => ({
  apps: [],
  files: [],
  calculation: null,
  ...over,
});

const app = (id: string) => ({ id, name: id.toUpperCase(), icon: "🕐" });
const file = (id: string) => ({ id, name: `${id}.txt`, subtitle: "文档" });

describe("buildSpotlightResults", () => {
  test("an empty query shows nothing (the panel shows its hint, not everything)", () => {
    const r = buildSpotlightResults("   ", inputs({ apps: [app("clock")] }));
    expect(r.rows).toEqual([]);
    expect(r.hidden).toEqual({ apps: 0, files: 0 });
  });

  test("order is macOS's: the calculation, then apps, then files", () => {
    const r = buildSpotlightResults(
      "3+4",
      inputs({ apps: [app("clock"), app("notes")], files: [file("f1")], calculation: "7" }),
    );
    expect(r.rows.map((x) => x.kind)).toEqual(["calc", "app", "app", "file"]);
    expect(r.rows[0]).toMatchObject({ kind: "calc", id: "7", title: "7", subtitle: "3+4" });
    // The calculation is the one answer *about the query itself*, so it leads.
    expect(r.rows[3]).toMatchObject({ kind: "file", id: "f1", title: "f1.txt", subtitle: "文档" });
  });

  test("keys are unique per kind (a file may share a name with an app)", () => {
    const r = buildSpotlightResults("cl", inputs({ apps: [app("clock")], files: [file("clock")] }));
    const keys = r.rows.map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the caps are bounds, and what they cut is REPORTED (never silently hidden)", () => {
    const apps = Array.from({ length: SPOTLIGHT_MAX_APPS + 2 }, (_, i) => app(`a${i}`));
    const files = Array.from({ length: SPOTLIGHT_MAX_FILES + 3 }, (_, i) => file(`f${i}`));
    const r = buildSpotlightResults("x", inputs({ apps, files }));
    expect(r.rows.filter((x) => x.kind === "app")).toHaveLength(SPOTLIGHT_MAX_APPS);
    expect(r.rows.filter((x) => x.kind === "file")).toHaveLength(SPOTLIGHT_MAX_FILES);
    expect(r.hidden).toEqual({ apps: 2, files: 3 });
  });

  test("no calculation (null) simply means no calc row — not a placeholder", () => {
    const r = buildSpotlightResults("cl", inputs({ apps: [app("clock")] }));
    expect(r.rows.map((x) => x.kind)).toEqual(["app"]);
  });
});