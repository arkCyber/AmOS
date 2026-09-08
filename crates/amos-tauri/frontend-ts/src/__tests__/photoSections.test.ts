/**
 * Pure unit tests for the iOS "Days" library grouping (lib/photos.ts). Kept
 * deterministic by pinning `now` to a local noon and building sibling
 * timestamps from whole-day offsets, so no timezone/DST ambiguity can leak in.
 */
import { describe, expect, test } from "bun:test";
import { dayIndex, dayKey, groupDays, setFavs, type DaySectionText } from "../lib/photos";

const now = new Date(2026, 8, 8, 12, 0, 0).getTime(); // 2026-09-08 12:00 local
const DAY = 86_400_000;
const D = (n: number) => ({ id: `p${n}`, ts: n });

const tx: DaySectionText = {
  today: "TODAY",
  yesterday: "YEST",
  date: (ts) => `D:${dayKey(ts)}`,
};

describe("photo day grouping", () => {
  test("dayKey/daysIndex are stable for today / yesterday / earlier", () => {
    expect(dayIndex(now, now)).toBe(0);
    expect(dayIndex(now - DAY, now)).toBe(1);
    expect(dayIndex(now - 3 * DAY, now)).toBe(3);
    // day keys share a single calendar day
    expect(dayKey(now)).toBe(dayKey(now + 1000));
    expect(dayKey(now)).toBe("2026-09-08");
  });

  test("groupDays buckets by local day, newest first, with the right labels", () => {
    const sections = groupDays(
      [D(now - 3 * DAY), D(now), D(now - DAY), D(now - 3 * DAY + 3600_000)],
      now,
      tx,
    );
    expect(sections.map((s) => s.day)).toEqual([0, 1, 3]);
    expect(sections[0]?.label).toBe("TODAY");
    expect(sections[1]?.label).toBe("YEST");
    // older days fall back to the concrete-date formatter
    expect(sections[2]?.label).toBe("D:2026-09-05");
    // same-day items collapse into one section, preserving input order
    const day3 = sections[2];
    expect(day3?.items).toHaveLength(2);
    expect(day3?.items[0]?.ts).toBe(now - 3 * DAY);
    expect(day3?.items[1]?.ts).toBe(now - 3 * DAY + 3600_000);
  });

  test("empty input yields no sections; single day yields one", () => {
    expect(groupDays([], now, tx)).toEqual([]);
    const one = groupDays([D(now)], now, tx);
    expect(one).toHaveLength(1);
    expect(one[0]?.items).toHaveLength(1);
  });
});

// setFavs lives in lib/photos.ts alongside toggleFav.
describe("photo setFavs", () => {
  const mk = () => [
    { id: "a", ts: 1 },
    { id: "b", ts: 2, fav: true },
    { id: "c", ts: 3 },
  ];
  test("sets fav=true on the chosen subset, leaving others untouched", () => {
    const out = setFavs(mk(), new Set(["a", "c"]), true);
    expect(out.map((p) => [p.id, p.fav])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);
  });
  test("can clear fav on a subset", () => {
    const out = setFavs(mk(), new Set(["b"]), false);
    expect(out.find((p) => p.id === "b")?.fav).toBeUndefined();
    expect(out.find((p) => p.id === "a")?.fav).toBeUndefined();
  });
  test("returns the input unchanged for an empty selection", () => {
    const list = mk();
    expect(setFavs(list, new Set(), true)).toBe(list);
    // unknown ids are ignored but the array is still rebuilt
    const out = setFavs(list, new Set(["nope"]), true);
    expect(out).toEqual(list);
  });
});
