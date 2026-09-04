import { describe, expect, test } from "bun:test";
import type { AppManifest, InstalledApp } from "../lib/backend";
import { extIdOf, installedToTiles, isExtId, midOf, setStoreTiles, getStoreTiles, tileById, subscribeStoreTiles, notifyStoreTilesChanged, loadStoreTiles, type StoreTile } from "../lib/storeApps";

const manifest: AppManifest = {
  id: "org.amos.pomodoro",
  name: "Pomodoro",
  summary: "focus",
  author: "Amos Labs",
  version: { major: 1, minor: 2, patch: 0, pre: null },
  category: "tools",
  package: { format: "tar_gz", url: "https://x/p.tgz", sha256: null, size_bytes: null },
  publisher: null,
};
const installed: InstalledApp[] = [{ manifest, installed_at: 123 }];

describe("store-apps tile registry (dynamic APPS)", () => {
  test("ext id helpers round-trip and never collide with built-ins", () => {
    const id = extIdOf(manifest.id);
    expect(id).toBe("store:org.amos.pomodoro");
    expect(isExtId(id)).toBe(true);
    expect(isExtId(manifest.id)).toBe(false); // bare manifest id is NOT an ext tile id
    expect(midOf(id)).toBe("org.amos.pomodoro");
    expect(midOf("org.amos.pomodoro")).toBe("org.amos.pomodoro"); // passthrough
  });

  test("installedToTiles maps an installed list to home tiles", () => {
    const tiles = installedToTiles(installed);
    expect(tiles).toHaveLength(1);
    const tile = tiles[0]!;
    expect(tile.id).toBe("store:org.amos.pomodoro");
    expect(tile.mid).toBe("org.amos.pomodoro");
    expect(tile.name).toBe("Pomodoro");
    expect(tile.icon).toBe("P");
  });

  test("glyph falls back for blank/whitespace names", () => {
    const tiles = installedToTiles([
      { manifest: { ...manifest, id: "org.amos.x", name: "   " }, installed_at: 0 },
    ]);
    expect(tiles[0]!.icon).toBe("🧩");
  });
});

describe("store-apps tile cache & change notifications", () => {
  const tile: StoreTile = { id: "store:org.amos.pomodoro", mid: "org.amos.pomodoro", name: "Pomodoro", icon: "P" };

  test("setStoreTiles/getStoreTiles/tileById manage the module cache", () => {
    setStoreTiles([tile]);
    expect(getStoreTiles()).toEqual([tile]);
    expect(tileById("store:org.amos.pomodoro")).toEqual(tile);
    expect(tileById("store:nope")).toBeUndefined();
    setStoreTiles([]); // don't leak into other tests
    expect(getStoreTiles()).toEqual([]);
  });

  test("subscribeStoreTiles/notifyStoreTilesChanged fire only subscribers", () => {
    let calls = 0;
    const unsub = subscribeStoreTiles(() => {
      calls += 1;
    });
    notifyStoreTilesChanged();
    expect(calls).toBe(1);
    unsub();
    notifyStoreTilesChanged();
    expect(calls).toBe(1); // unsubscribed → not called again
    notifyStoreTilesChanged(); // no subscribers → no throw
  });

  test("loadStoreTiles refreshes the cache from the bridge (falls back to empty off-bridge)", async () => {
    const real = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: async (c: string) =>
          c === "appstore_installed" ? [{ manifest, installed_at: 5 }] : null,
        listen: async () => async () => {},
      },
    };
    try {
      const tiles = await loadStoreTiles();
      expect(tiles).toHaveLength(1);
      expect(tiles[0]!.name).toBe("Pomodoro");
      expect(getStoreTiles()).toHaveLength(1); // cache refreshed
    } finally {
      (globalThis as { window?: unknown }).window = real;
      setStoreTiles([]);
    }
  });
});

