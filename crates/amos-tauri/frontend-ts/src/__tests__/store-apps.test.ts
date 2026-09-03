import { describe, expect, test } from "bun:test";
import type { AppManifest, InstalledApp } from "../lib/backend";
import { extIdOf, installedToTiles, isExtId, midOf } from "../lib/storeApps";

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
