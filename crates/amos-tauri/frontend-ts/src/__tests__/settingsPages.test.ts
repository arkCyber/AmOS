/**
 * Unit tests for `lib/settingsPages.ts` — the page vocabulary and the cross-window page intent
 * (REQ-A790), the Settings counterpart of `normalizeViewIntent` (REQ-A783).
 *
 * What is actually at stake here, and why it is not just a parser test: this is the **only** gate
 * between a value in the shared store — which outlives this build, and which a newer build or a
 * hand-edited localStorage can write anything into — and a `page` variable that the Settings
 * template switches on. `page` is a `Sub`, and `Sub` is derived from `SETTINGS_PAGES`, so a name
 * that gets through this function is a name some branch of the template renders. A name that got
 * through and was *not* in the list would put `page` in a state the template has no branch for —
 * the detail pane would render nothing at all.
 */
import { describe, expect, test } from "vitest";
import {
  SETTINGS_PAGES,
  SETTINGS_PAGE_KEY,
  normalizePageIntent,
  type SettingsPageId,
} from "../lib/settingsPages";

describe("normalizePageIntent (the cross-window page intent, REQ-A790)", () => {
  test("keeps a real request and drops the nonce it cannot trust", () => {
    expect(normalizePageIntent({ page: "dock", nonce: 7 })).toEqual({ page: "dock", nonce: 7 });
    // A missing/foreign/NaN nonce is *no clock*, not a reason to refuse the request: the screen
    // still has to land on the page (the nonce is only the re-fire marker). Same rule as the
    // Files view intent — freshness is never inferred from the size of a number.
    expect(normalizePageIntent({ page: "dock" })).toEqual({ page: "dock", nonce: 0 });
    expect(normalizePageIntent({ page: "dock", nonce: "now" })).toEqual({ page: "dock", nonce: 0 });
    expect(normalizePageIntent({ page: "dock", nonce: Infinity })).toEqual({
      page: "dock",
      nonce: 0,
    });
    expect(normalizePageIntent({ page: "dock", nonce: NaN })).toEqual({ page: "dock", nonce: 0 });
  });

  test("'nothing pending' is null, not a default page", () => {
    // The key is a command, not state: `null` (and everything that is not a request) must leave
    // the screen where it is. A default here would mean every Settings window opened *later*
    // jumped to some page on its own — a navigation nobody asked for.
    expect(normalizePageIntent(null)).toBeNull();
    expect(normalizePageIntent(undefined)).toBeNull();
    expect(normalizePageIntent("dock")).toBeNull();
    expect(normalizePageIntent(42)).toBeNull();
    expect(normalizePageIntent([])).toBeNull();
    expect(normalizePageIntent({})).toBeNull();
    expect(normalizePageIntent({ page: "" })).toBeNull();
    expect(normalizePageIntent({ page: 3 })).toBeNull();
  });

  test("a page this build does not have is ignored, not switched to", () => {
    // Forward-compat, and the reason the check is a runtime list and not the type: an older
    // reader meeting a newer writer's page name must stay where it is. If this returned the
    // value, `page` would hold a string no branch of the template renders — an empty detail pane
    // with no way to tell it apart from a page that legitimately has no content.
    expect(normalizePageIntent({ page: "vpn", nonce: 1 })).toBeNull();
    expect(normalizePageIntent({ page: "DOCK", nonce: 1 })).toBeNull();
    expect(normalizePageIntent({ page: " dock", nonce: 1 })).toBeNull();
    // …and the list is the whole set, so every page the screen *does* render survives.
    for (const p of SETTINGS_PAGES) {
      expect(normalizePageIntent({ page: p, nonce: 1 })).toEqual({ page: p, nonce: 1 });
    }
  });

  test("the vocabulary still contains every page, and `index` is not one of them", () => {
    // A pin, not a tautology: `Sub` is `SettingsPageId`, so a page dropped from this array stops
    // being nameable by the sidebar, the search index and every `{#if page === …}` branch that
    // references it — svelte-check would not necessarily flag the branch, only the writers.
    expect(SETTINGS_PAGES.length).toBe(28);
    expect(new Set(SETTINGS_PAGES).size).toBe(SETTINGS_PAGES.length); // no duplicate id
    // `index` is the *absence* of a page: it is the state the screen starts in, not a destination
    // a caller should aim at, and a cross-window intent naming it would be a request to go
    // nowhere. It is deliberately not in the list, so `normalizePageIntent` refuses it.
    expect(SETTINGS_PAGES as readonly string[]).not.toContain("index");
    expect(normalizePageIntent({ page: "index", nonce: 1 })).toBeNull();
    // The one the Dock actually asks for, spelled the way the Dock spells it.
    const dock: SettingsPageId = "dock";
    expect(SETTINGS_PAGES as readonly string[]).toContain(dock);
  });

  test("the key is the one the store allow-list and both writers name", () => {
    // Three places hold this string: this constant, `settingsPages`' readers, and
    // `scripts/store-allowlist.json` (which the store scan matches by literal). A silent drift in
    // any of them would make the intent unnoticeable rather than loud — the write and the read
    // would each succeed, on different keys.
    expect(SETTINGS_PAGE_KEY).toBe("amos.settings.page");
  });
});
