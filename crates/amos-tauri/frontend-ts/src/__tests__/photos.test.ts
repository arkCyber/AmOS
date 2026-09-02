import { describe, expect, test } from "bun:test";
import { seedPhotos, removePhoto, newPhoto, PALETTE, EMOJIS } from "../lib/photos";

describe("photos helpers", () => {
  test("seedPhotos is deterministic and cycles palette/emoji", () => {
    const s = seedPhotos(8, 1700000000000);
    expect(s.length).toBe(8);
    expect(s[0].a).toBe(PALETTE[0][0]);
    expect(s[0].emoji).toBe(EMOJIS[0]);
    expect(s[0].ts).toBe(1700000000000);
    expect(s[1].ts).toBeLessThan(s[0].ts);
  });

  test("removePhoto filters by id and newPhoto fills required fields", () => {
    const list = seedPhotos(2, 1000);
    const after = removePhoto(list, list[0].id);
    expect(after.length).toBe(1);
    const p = newPhoto("x", 5000);
    expect(p.id).toBe("x");
    expect(p.ts).toBe(5000);
    expect(PALETTE.some(([a]) => a === p.a)).toBe(true);
    expect(EMOJIS.includes(p.emoji)).toBe(true);
  });
});
