/**
 * Pure unit tests for the iOS "Days" library grouping (lib/photos.ts). Kept
 * deterministic by pinning `now` to a local noon and building sibling
 * timestamps from whole-day offsets, so no timezone/DST ambiguity can leak in.
 */
import { describe, expect, test } from "bun:test";
import {
  dayIndex,
  dayKey,
  groupDays,
  knownTs,
  setFavs,
  UNKNOWN_DAY_KEY,
  type DaySectionText,
} from "../lib/photos";

const now = new Date(2026, 8, 8, 12, 0, 0).getTime(); // 2026-09-08 12:00 local
const DAY = 86_400_000;
const D = (n: number) => ({ id: `p${n}`, ts: n });

const tx: DaySectionText = {
  today: "TODAY",
  yesterday: "YEST",
  date: (ts) => `D:${dayKey(ts)}`,
  unknown: "UNKNOWN",
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

  // REQ-A1852: a photo whose `ts` is the documented unknown sentinel (0) is NOT a
  // 1970-01-01 day. Before the fix this section carried `key === "1970-01-01"` and the
  // concrete-date label, so the wall drawn a date the host never reported.
  test("the unknown sentinel is not bucketed as a 1970 day, and trails the wall", () => {
    const sections = groupDays([D(0), D(now)], now, tx);
    // its own key — never the calendar day `dayKey(0)` would mint
    expect(sections.map((s) => s.key)).toEqual([dayKey(now), UNKNOWN_DAY_KEY]);
    expect(sections.map((s) => s.key)).not.toContain("1970-01-01");
    const unknown = sections[1];
    expect(unknown?.label).toBe("UNKNOWN");
    expect(unknown?.label).not.toContain("1970");
    // all sentinel rows collapse into one bucket (the same single source of truth)
    expect(groupDays([D(0), D(0), D(now)], now, tx)[1]?.items).toHaveLength(2);
  });

  // The positive controls (the two tests above) are what stop "always answer unknown":
  // a real today / yesterday / concrete date still gets its own label and key. `knownTs`
  // is the single predicate both halves read.
  test("knownTs admits every real stamp and rejects only the sentinel", () => {
    expect(knownTs(now)).toBe(true);
    expect(knownTs(1)).toBe(true); // a real 1970 stamp is a measurement, not "unknown"
    expect(knownTs(0)).toBe(false);
    expect(knownTs(Number.NaN)).toBe(false);
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
