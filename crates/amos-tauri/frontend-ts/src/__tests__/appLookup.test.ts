/**
 * appLookup.test.ts — the one owner of "how does this app id draw?" (REQ-A1179).
 *
 * Before this module every chrome surface asked `appTitleKey(id) !== null` itself, and the
 * desktop chrome answered the store case three different ways (Dock/Launchpad dropped it,
 * the stage named it by its raw id, Spotlight skipped it). These tests pin the three
 * questions once, for both sources, including the case that made the raw-id fallback
 * visible: an id that is neither.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { iconForId, isDrawableApp, nameForId, storeTileFor } from "../lib/appLookup";
import { setStoreTiles, type StoreTile } from "../lib/storeApps";

const DEMO: StoreTile = {
  id: "store:org.amos.demo",
  mid: "org.amos.demo",
  name: "Demo",
  icon: "D",
};

/** A stand-in for the caller's `t()` — the real one is `locale.svelte`'s reactive `t`. */
const translate = (key: string) => `t:${key}`;

afterEach(() => setStoreTiles([]));

describe("appLookup — built-in and installed apps answer the same three questions", () => {
  test("a built-in id is drawable, keeps its glyph, and names through the caller's `t`", () => {
    expect(isDrawableApp("clock", [])).toBe(true);
    expect(iconForId("clock", [])).toBe("🕐");
    expect(nameForId("clock", [], translate)).toBe("t:app.clock");
    expect(storeTileFor("clock", [])).toBeUndefined();
  });

  test("an installed store app is drawable, uses its OWN glyph, and names from the manifest", () => {
    expect(isDrawableApp(DEMO.id, [DEMO])).toBe(true);
    expect(iconForId(DEMO.id, [DEMO])).toBe("D"); // not `appIcon`'s fallback glyph
    // The manifest name is not a translation key — `t` must not be consulted for it.
    expect(nameForId(DEMO.id, [DEMO], translate)).toBe("Demo");
    expect(storeTileFor(DEMO.id, [DEMO])).toBe(DEMO);
  });

  test("an id that is neither is NOT drawable, and falls back to the raw id (no invented name)", () => {
    expect(isDrawableApp("store:org.gone", [DEMO])).toBe(false);
    expect(nameForId("store:org.gone", [DEMO], translate)).toBe("store:org.gone");
  });

  test("the tile list is the answer's input: the same id flips with the list", () => {
    // The house rule this module exists for — a caller that holds an empty list must get the
    // empty answer, so the answer cannot go stale behind a module-level cache read.
    expect(isDrawableApp(DEMO.id, [])).toBe(false);
    expect(isDrawableApp(DEMO.id, [DEMO])).toBe(true);
  });
});
