/**
 * app-registry.svelte.test.ts — React-free Svelte app registry (Phase-3 foundation).
 *
 * **Two tables, one truth.** The home grid's tiles come from the live table
 * `lib/appMeta.ts` (`APP_META`); the screens come from `svelte/appRegistry.ts`
 * (`ALL_APP_LOADERS`). Both directions are asserted here, against **those tables** — not
 * against a hand-copied id list:
 *
 *   * tile → loader: every `APP_META` id resolves to a component (the direction the device
 *     hit in F-SH-025: a tile that opens "no screen in this build");
 *   * loader → tile: every loader id is a real tile, so a screen cannot be unreachable.
 *
 * REQ-A382: this file used to iterate a **hand-written `EXPECTED` list of 29 ids** while
 * `APP_META` already had 33 — the four apps added after the list was written were never
 * checked, and a new tile with no screen would have passed every gate. The assertion below
 * also drives its own comparison on fixtures that *must* fail, so a green run means the
 * check can fail (the repo's negative-control rule).
 *
 * Phone apps (e.g. `phone`) are filtered out on desktop form factor — see `svelteAppLoader`.
 * The desktop shape is asserted separately: `PHONE_APP_IDS` must be hidden, everything else
 * must remain available.
 */
import { afterEach, describe, expect, test } from "vitest";
import { ALL_APP_LOADERS, svelteAppLoader } from "../src/svelte/appRegistry";
import { APP_META } from "../src/lib/appMeta";
import { setFormFactor } from "../src/lib/desktopApps";
import { PHONE_APP_IDS } from "../src/lib/phoneApps";

/** Ids present in `tiles` but with no `loaders` entry — the defect this file exists for. */
function missingLoaders(tiles: readonly string[], loaders: Record<string, unknown>): string[] {
  return tiles.filter((id) => !(id in loaders));
}

/** Ids present in `loaders` but not in `tiles` — a screen the grid can never open. */
function unreachableScreens(tiles: readonly string[], loaders: Record<string, unknown>): string[] {
  return Object.keys(loaders).filter((id) => !tiles.includes(id));
}

const TILE_IDS = APP_META.map((a) => a.id);
const LOADER_IDS = Object.keys(ALL_APP_LOADERS);

afterEach(() => {
  // Don't leak the form factor between tests.
  setFormFactor(null);
});

describe("svelte/appRegistry.ts", () => {
  // Negative control first: the two helpers above must report a mismatch when there is one,
  // otherwise every assertion below could pass vacuously (a gate that cannot fail).
  test("the comparison itself can fail (negative control)", () => {
    expect(missingLoaders(["ghost"], {})).toEqual(["ghost"]);
    expect(missingLoaders(["ghost"], { ghost: () => {} })).toEqual([]);
    expect(unreachableScreens(["clock"], { clock: () => {}, orphan: () => {} })).toEqual(["orphan"]);
    expect(unreachableScreens(["clock"], { clock: () => {} })).toEqual([]);
  });

  test("every tile in the live grid table has a screen (tile → loader)", () => {
    expect(TILE_IDS.length).toBeGreaterThan(0);
    expect(missingLoaders(TILE_IDS, ALL_APP_LOADERS)).toEqual([]);
  });

  test("every screen is a tile in the live grid table (loader → tile)", () => {
    expect(unreachableScreens(TILE_IDS, ALL_APP_LOADERS)).toEqual([]);
  });

  test("every id resolves to a Svelte component module (non-desktop form factor)", async () => {
    // Default: not desktop, so every app in the live table must resolve.
    setFormFactor("phone");
    for (const id of TILE_IDS) {
      const load = svelteAppLoader(id);
      expect(load, `missing loader for ${id}`).toBeTruthy();
      const mod = await load!();
      expect(mod.default, `${id} resolved without a default component`).toBeTruthy();
    }
  });

  test("phone-only apps are hidden on desktop (REQ-A251: desktop cannot dial)", () => {
    setFormFactor("desktop");
    for (const id of PHONE_APP_IDS) {
      expect(svelteAppLoader(id), `${id} must be hidden on desktop`).toBeUndefined();
    }
  });

  test("non-phone apps remain available on desktop", () => {
    setFormFactor("desktop");
    for (const id of LOADER_IDS.filter((x) => !(PHONE_APP_IDS as readonly string[]).includes(x))) {
      expect(svelteAppLoader(id), `${id} must remain available on desktop`).toBeTruthy();
    }
  });
});
