/**
 * Dynamic home-screen apps from the app store.
 *
 * Built-in apps are a compile-time const (`APPS` in apps.tsx). Store-installed
 * apps are runtime data, so this module gives them a stable tile identity and
 * lets the shell resolve name/icon + merge them into the persisted home layout.
 *
 * Installed store apps get an id `store:<manifest.id>` so they can never collide
 * with a built-in app id. `HomeDock`/`AppComponent`/the shell read tiles through
 * the small cache here (populated by `loadStoreTiles`), and the Store page pokes
 * `notifyStoreTilesChanged()` after install/uninstall/upgrade so the home screen
 * refreshes live.
 */
import { storeInstalled, type InstalledApp } from "./backend";

/** Prefix that marks a home-screen id as a store-installed (third-party) app. */
export const EXT_PREFIX = "store:";

/** Whether `id` refers to a store-installed (third-party) tile. */
export function isExtId(id: string): boolean {
  return id.startsWith(EXT_PREFIX);
}

/** Tile id for a store manifest id. */
export function extIdOf(manifestId: string): string {
  return EXT_PREFIX + manifestId;
}

/** Underlying store manifest id for an ext tile id. */
export function midOf(id: string): string {
  return isExtId(id) ? id.slice(EXT_PREFIX.length) : id;
}

/** A home-screen tile rendered for a store-installed app. */
export interface StoreTile {
  /** Tile id (`store:<manifest.id>`). */
  id: string;
  /** The store's manifest id (e.g. `org.amos.pomodoro`). */
  mid: string;
  /** Display name (from the manifest — not localized). */
  name: string;
  /** Tile glyph (no real icon yet → first character / fallback). */
  icon: string;
}

function glyphFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "🧩";
  const first = Array.from(trimmed)[0];
  return first && first.trim() ? first.toUpperCase() : "🧩";
}

/** Map the store's installed-app list to home-screen tiles (pure). */
export function installedToTiles(installed: InstalledApp[]): StoreTile[] {
  return installed.map((a) => ({
    id: extIdOf(a.manifest.id),
    mid: a.manifest.id,
    name: a.manifest.name,
    icon: glyphFor(a.manifest.name),
  }));
}

// ---------------------------------------------------------------------------
// Module-level tile cache + change notification (kept out of React so the pure
// parts stay trivially testable; the shell + HomeDock re-render from it).
// ---------------------------------------------------------------------------
let cache: StoreTile[] = [];

/** Replace the cached tiles (called by the loader / tests). */
export function setStoreTiles(tiles: StoreTile[]): void {
  cache = tiles;
}

/** Current cached tiles. */
export function getStoreTiles(): StoreTile[] {
  return cache;
}

/** Look up one tile by its ext id, if known. */
export function tileById(id: string): StoreTile | undefined {
  return cache.find((t) => t.id === id);
}

const listeners = new Set<() => void>();

/** Subscribe to tile-change notifications; returns an unsubscribe. */
export function subscribeStoreTiles(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tell subscribers the installed store apps changed (Store page calls this). */
export function notifyStoreTilesChanged(): void {
  for (const fn of listeners) fn();
}

/** Refresh the cache from the bridge. Returns [] (and clears) when not bridged. */
export async function loadStoreTiles(): Promise<StoreTile[]> {
  const installed = await storeInstalled();
  const tiles = installed ? installedToTiles(installed) : [];
  setStoreTiles(tiles);
  return tiles;
}
