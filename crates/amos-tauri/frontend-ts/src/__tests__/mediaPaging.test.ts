/**
 * Unit tests for `lib/mediaPaging.ts` — cumulative paging over several collections
 * (REQ-A316).
 *
 * The pager is the part of "load more" that can be wrong invisibly: a page boundary that
 * repeats or skips an item looks exactly like a working one until the user counts their
 * photos. These tests drive the whole state machine through an injected `fetch`, so the
 * claims (cursor from the host's own page, dedupe by id, empty page = end) are pinned
 * without a bridge.
 */
import { describe, expect, it } from "bun:test";
import type { MediaItem, MediaListing, StandardDir } from "../lib/media";
import {
  emptyPaging,
  fetchInto,
  foldPage,
  hasMore,
  pendingDirs,
  remainingTotal,
} from "../lib/mediaPaging";

const item = (id: string, ts: number, name = `${id}.jpg`): MediaItem => ({
  id,
  kind: "image",
  collection: "camera",
  name,
  uri: `mock://${id}`,
  mime: "image/jpeg",
  size_bytes: 3,
  ts,
});

/** A listing as the host would send it: items (newest-first) + what is left after them. */
const page = (items: MediaItem[], left: number): MediaListing => ({
  items,
  // The host's own `total` includes the items it just sent (Content-Range style)…
  total: items.length + left,
});

const DIRS: readonly StandardDir[] = ["camera", "screenshots"];

describe("mediaPaging — folding pages", () => {
  it("merges, orders and dedupes across collections", () => {
    let state = emptyPaging(DIRS);
    state = foldPage(state, "camera", page([item("a", 100), item("c", 80)], 0));
    state = foldPage(state, "screenshots", page([item("b", 90), item("a", 100)], 0));
    expect(state.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    // `a` arrived from both collections; it is one row, not two.
    expect(state.items.filter((i) => i.id === "a")).toHaveLength(1);
  });

  it("keeps one cursor per collection, taken from the host's own last item", () => {
    let state = emptyPaging(DIRS);
    state = foldPage(state, "camera", page([item("a", 100), item("b", 50)], 7));
    state = foldPage(state, "screenshots", page([item("s", 70)], 0));
    expect(state.cursors.camera).toEqual({ ts: 50, name: "b.jpg" });
    expect(state.cursors.screenshots).toEqual({ ts: 70, name: "s.jpg" });
    // `remaining` is what is left *after* the items the caller now holds, so a screen can
    // render "N of M" as `items.length + remainingTotal`.
    expect(remainingTotal(state, DIRS)).toBe(7);
    expect(state.items).toHaveLength(3);
  });

  it("an empty page retires that collection and zeroes its remainder", () => {
    let state = emptyPaging(DIRS);
    state = foldPage(state, "camera", page([item("a", 100)], 1));
    expect(pendingDirs(state, DIRS)).toEqual(["camera", "screenshots"]);

    state = foldPage(state, "camera", page([], 0));
    expect(state.exhausted).toEqual(["camera"]);
    expect(pendingDirs(state, DIRS)).toEqual(["screenshots"]);
    expect(remainingTotal(state, DIRS)).toBe(0);
    // The cursor from the previous page is kept: a later refresh must not restart the page
    // the user already scrolled past.
    expect(state.cursors.camera).toEqual({ ts: 100, name: "a.jpg" });
  });
});

describe("mediaPaging — fetching rounds", () => {
  const scripted = (pages: Record<string, MediaListing[]>) => {
    const calls: Array<{ dir: StandardDir; after: unknown }> = [];
    const fetch = async (dir: StandardDir, after: unknown): Promise<MediaListing | null> => {
      calls.push({ dir, after });
      const queue = pages[dir] ?? [];
      return queue.shift() ?? page([], 0);
    };
    return { calls, fetch };
  };

  it("walks every collection page by page, passing each cursor back verbatim", async () => {
    const { calls, fetch } = scripted({
      camera: [page([item("a", 300), item("b", 200)], 1), page([item("c", 100)], 0), page([], 0)],
      screenshots: [page([item("s", 250)], 0), page([], 0)],
    });
    let state = emptyPaging(DIRS);
    const first = await fetchInto(state, DIRS, fetch);
    state = first.state;
    expect(first.failed).toEqual([]);
    expect(state.items.map((i) => i.id)).toEqual(["a", "s", "b"]);
    expect(remainingTotal(state, DIRS)).toBe(1);
    expect(hasMore(state, DIRS)).toBe(true);

    const second = await fetchInto(state, DIRS, fetch);
    state = second.state;
    expect(state.items.map((i) => i.id)).toEqual(["a", "s", "b", "c"]);
    expect(remainingTotal(state, DIRS)).toBe(0);
    // screenshots answered empty ⇒ retired; camera still owes a page (its `total` said so).
    expect(state.exhausted).toEqual(["screenshots"]);

    const third = await fetchInto(state, DIRS, fetch);
    state = third.state;
    expect([...state.exhausted].sort()).toEqual(["camera", "screenshots"]);
    expect(hasMore(state, DIRS)).toBe(false);

    // The cursor handed back to the host is the one the *previous page* ended with.
    const cameraCalls = calls.filter((c) => c.dir === "camera");
    expect(cameraCalls[0]!.after).toBeNull();
    expect(cameraCalls[1]!.after).toEqual({ ts: 200, name: "b.jpg" });
    expect(cameraCalls[2]!.after).toEqual({ ts: 100, name: "c.jpg" });
  });

  it("a failed collection is reported and stays askable — never 'nothing left'", async () => {
    const fetch = async (dir: StandardDir): Promise<MediaListing | null> => {
      if (dir === "camera") throw new Error("media read on camera is not authorized");
      return page([item("s", 10)], 0);
    };
    const round = await fetchInto(emptyPaging(DIRS), DIRS, fetch);
    expect(round.failed).toEqual(["camera"]);
    expect(round.state.items.map((i) => i.id)).toEqual(["s"]);
    // The denial did not retire it: nothing was retired at all, so the prompt can be
    // granted and the page retried (only an *empty page* retires a collection).
    expect(round.state.exhausted).toEqual([]);
    expect(pendingDirs(round.state, DIRS)).toContain("camera");
    expect(hasMore(round.state, DIRS)).toBe(true);

    // A `null` reply (host vanished mid-round) is also "could not read", not "empty".
    const nullRound = await fetchInto(emptyPaging(DIRS), DIRS, async () => null);
    expect([...nullRound.failed].sort()).toEqual(["camera", "screenshots"]);
    expect(hasMore(nullRound.state, DIRS)).toBe(true);
  });

  it("a page that re-serves an item cannot duplicate it", () => {
    // The host is not supposed to overlap pages (its cursor is a total-order position), but
    // a host that did would otherwise show the same photo twice.
    let state = emptyPaging(DIRS);
    state = foldPage(state, "camera", page([item("a", 100), item("b", 50)], 0));
    state = foldPage(state, "camera", page([item("b", 50), item("c", 10)], 0));
    expect(state.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(state.cursors.camera).toEqual({ ts: 10, name: "c.jpg" });
  });
});
