/**
 * appLookup.ts — what the chrome draws for **any** app id (REQ-A1179 / F-SH-472).
 *
 * An app id is one of two things: a **built-in** (a compile-time registry row in
 * `lib/appMeta`) or an **installed store app** (`store:<manifest.id>`, runtime data in
 * `lib/storeApps`). Both can be placed on the home screen, put in the dock and given a
 * pane, so every surface that draws an app has to answer the same three questions — can
 * this id be drawn at all, what glyph, what name.
 *
 * Before this module there was no owner of those questions, and the desktop chrome
 * answered them three different ways, each wrong for a store app: the Dock and the
 * Launchpad **dropped** it (`appTitleKey(id) !== null` as a filter), the desktop stage
 * drew it **named by its raw id** with the fallback glyph, and `SpotlightOverlay` skipped
 * it outright (`if (!titleKey) continue`). The touch shell meanwhile answered correctly
 * (`HomeDock` merges the tile list). One fact, four answers — see §61.
 *
 * Deliberately runes-free and *not* reading the tile cache on its own: the caller passes
 * the tile list it holds, so the answer is a function of state the component already
 * tracks and cannot silently go stale behind a non-reactive module read.
 */
import { appIcon, appTitleKey } from "./appMeta";
import type { StoreTile } from "./storeApps";

/** The store tile behind an id, or `undefined` when `id` is a built-in (or nothing). */
export function storeTileFor(id: string, tiles: readonly StoreTile[]): StoreTile | undefined {
  return tiles.find((t) => t.id === id);
}

/** Whether the chrome can draw a tile for this id: a built-in app, or an installed store app. */
export function isDrawableApp(id: string, tiles: readonly StoreTile[]): boolean {
  // A store tile wins over the registry: a manifest id can never collide with a built-in
  // id (`store:` prefix), but asking the tile first keeps the two lookups in one order.
  return storeTileFor(id, tiles) !== undefined || appTitleKey(id) !== null;
}

/** The glyph for an app id — the store tile's own glyph when it is one. */
export function iconForId(id: string, tiles: readonly StoreTile[]): string {
  return storeTileFor(id, tiles)?.icon ?? appIcon(id);
}

/**
 * The display name for an app id. `translate` is the caller's own `t()` — passing it in is
 * what keeps the name reactive, because Svelte tracks `t()` per render and a name resolved
 * behind this module would freeze at the locale that was active when it was computed.
 *
 * An id that is neither a store tile nor a registry row falls back to the raw id, which is
 * the honest answer for something the build does not know.
 */
export function nameForId(
  id: string,
  tiles: readonly StoreTile[],
  translate: (key: string) => string,
): string {
  const tile = storeTileFor(id, tiles);
  if (tile) return tile.name;
  const key = appTitleKey(id);
  return key ? translate(key) : id;
}
