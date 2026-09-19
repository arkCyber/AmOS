import { describe, expect, test } from "bun:test";
import {
  seedPhotos,
  removePhoto,
  removePhotos,
  newPhoto,
  newPhotoForCapture,
  newCapturePhoto,
  isRealPhoto,
  neighborOf,
  toggleFav,
  favsOf,
  shareCaption,
  normalizePhotos,
  PALETTE,
  EMOJIS,
} from "../lib/photos";

describe("photos helpers", () => {
  test("seedPhotos is deterministic and cycles palette/emoji", () => {
    const s = seedPhotos(8, 1700000000000);
    expect(s.length).toBe(8);
    expect(s[0]!.a).toBe(PALETTE[0]![0]);
    expect(s[0]!.emoji).toBe(EMOJIS[0]);
    expect(s[0]!.ts).toBe(1700000000000);
    expect(s[1]!.ts).toBeLessThan(s[0]!.ts);
  });

  test("removePhoto filters by id and newPhoto fills required fields", () => {
    const list = seedPhotos(2, 1000);
    const after = removePhoto(list, list[0]!.id);
    expect(after.length).toBe(1);
    const p = newPhoto(5000);
    // The factory mints its own id (REQ-A402): the caller used to pass `p${Date.now()}`,
    // which gave two same-millisecond adds one id. It now comes from `localId`.
    expect(p.id).toMatch(/^p-/);
    expect(p.ts).toBe(5000);
    expect(PALETTE.some(([a]) => a === p.a)).toBe(true);
    expect(p.emoji !== undefined && EMOJIS.includes(p.emoji)).toBe(true);
  });

  test("newCapturePhoto stores a real frame data URL and isRealPhoto flags it", () => {
    const p = newCapturePhoto("c1", 123, "data:image/jpeg;base64,abc");
    expect(p).toEqual({ id: "c1", data: "data:image/jpeg;base64,abc", ts: 123 });
    expect(isRealPhoto(p)).toBe(true);
    expect(isRealPhoto(newPhoto(1))).toBe(false);
  });

  test("newPhotoForCapture keeps the caller's id (one shot, one identity — REQ-A402)", () => {
    // The frame path (`newCapturePhoto`) and the no-frame fallback must agree on the id,
    // so the caller mints it (with `localId`) and this factory keeps it verbatim. Before,
    // the camera's own id was `c${Date.now()}-${shotSeq++}` — the clock plus a per-process
    // counter, which two contexts can both produce.
    const p = newPhotoForCapture("shot-abc-1-0gur3ba", 5000);
    expect(p.id).toBe("shot-abc-1-0gur3ba");
    expect(p.ts).toBe(5000);
    expect(isRealPhoto(p)).toBe(false);
  });

  test("removePhotos batch-deletes only the selected ids, immutably", () => {
    const list = seedPhotos(4, 1000); // ids seed-0..seed-3
    const after = removePhotos(list, new Set(["seed-1", "seed-3"]));
    expect(after.map((p) => p.id)).toEqual(["seed-0", "seed-2"]);
    expect(list.length).toBe(4); // original untouched
    // empty selection is a no-op (same reference)
    expect(removePhotos(list, new Set())).toBe(list);
  });

  test("neighborOf wraps prev/next and returns null for empty/single/unknown", () => {
    const list = seedPhotos(3, 1000); // seed-0, seed-1, seed-2
    expect(neighborOf(list, "seed-1", 1)?.id).toBe("seed-2");
    expect(neighborOf(list, "seed-2", 1)?.id).toBe("seed-0"); // wraps forward
    expect(neighborOf(list, "seed-0", -1)?.id).toBe("seed-2"); // wraps backward
    expect(neighborOf(list, "nope", 1)).toBeNull();
    expect(neighborOf(seedPhotos(1, 0), "seed-0", 1)).toBeNull(); // single photo
    expect(neighborOf([], "x", 1)).toBeNull();
  });

  test("toggleFav flips one heart and favsOf filters", () => {
    const list = seedPhotos(3, 1000);
    expect(list.some((p) => p.fav)).toBe(false); // seeds start unfavourited
    const once = toggleFav(list, "seed-0");
    expect(favsOf(once).map((p) => p.id)).toEqual(["seed-0"]);
    const twice = toggleFav(once, "seed-0");
    expect(favsOf(twice)).toEqual([]); // toggled back off
    expect(toggleFav(list, "nope")).toBe(list); // id missing → same ref (no-op)
    expect(once).not.toBe(list); // immutable
  });

  test("shareCaption mentions the capture time or the demo emoji", () => {
    const real = { id: "r", ts: 0, data: "data:image/jpeg;base64,abc" };
    expect(shareCaption(real, "2024-01-01 09:00")).toContain("📷 2024-01-01 09:00");
    const demo = seedPhotos(1, 0)[0]!;
    expect(shareCaption(demo, "now")).toContain("🌅 now");
    // every caption carries the shared-by line and is multi-line
    for (const c of [shareCaption(real, "t"), shareCaption(demo, "t")]) {
      expect(c).toContain("— shared from Amos");
      expect(c.split("\n").length).toBeGreaterThanOrEqual(2);
    }
  });

  test("normalizePhotos drops garbage, back-fills ids, dedups, keeps fav", () => {
    const corrupt: unknown = [
      { id: "p1", emoji: "🌅", a: "#111", b: "#222", ts: 5, fav: true },
      { id: "p1", emoji: "🏔️", ts: 6 }, // id collision
      { emoji: "🌸" }, // no id → back-filled
      { id: "r", data: "data:image/jpeg;base64,x", ts: 7 }, // real capture
      {},
      null,
      7,
      "x",
    ];
    const out = normalizePhotos(corrupt);
    expect(out.length).toBe(4); // p1 + p1dup + backfill + real
    const ids = new Set(out.map((p) => p.id));
    expect(ids.size).toBe(4);
    const fav = out.find((p) => p.emoji === "🌅");
    expect(fav?.fav).toBe(true); // preserved
    expect(out.find((p) => p.data)).toMatchObject({ id: "r", data: "data:image/jpeg;base64,x", ts: 7 });
    expect(normalizePhotos(null)).toEqual([]);
    expect(normalizePhotos({})).toEqual([]);
  });
});
