/**
 * mediaPaging.ts — cumulative paging over several collections (REQ-A316).
 *
 * The host caps a listing and hands back a cursor; a screen that shows a *merged* view
 * (Photos = camera + screenshots, Files = downloads + pictures + …, Player = movies + music)
 * therefore has to keep **one cursor per collection** and merge the pages itself. That logic
 * is here, pure and injectable, because it is the part that can be wrong in a way nobody
 * sees: a pager that repeats or skips an item looks exactly like a working one until the
 * user counts their photos.
 *
 * Three rules make it correct, and each is tested:
 *  1. **A page's cursor comes from the host's own last item** — never from the merged view,
 *     whose order is ours, not the host's. `foldPage` read it off `listing.items.last()`.
 *  2. **Items are deduped by id** — a host that re-serves an item (or two collections that
 *     contain the same one) cannot show it twice.
 *  3. **An empty page ends that collection** — that is the only signal the host gives that
 *     nothing is left after the cursor, and it is also the loop's stop condition.
 *
 * Nothing here touches the bridge: the caller injects `fetch`, so the whole state machine is
 * unit-testable offline.
 */
import { cursorOf, newestFirst } from "./media";
import type { MediaCursor, MediaItem, MediaListing, StandardDir } from "./media";

/** The accumulated view plus, per collection, where the next page resumes. */
export interface PagingState {
  /** Everything loaded so far, newest-first, deduped by item id. */
  items: MediaItem[];
  /** Per collection: how many items the host still has after its cursor. */
  remaining: Partial<Record<StandardDir, number>>;
  /** Per collection: where its next page resumes (absent = its first page). */
  cursors: Partial<Record<StandardDir, MediaCursor>>;
  /** Collections whose last page came back empty (nothing left to ask for). */
  exhausted: StandardDir[];
}

/** A pager that has not asked the host anything yet. */
export function emptyPaging(dirs: readonly StandardDir[]): PagingState {
  return {
    items: [],
    remaining: Object.fromEntries(dirs.map((d) => [d, 0])),
    cursors: {},
    exhausted: [],
  };
}

/**
 * Fold one page of one collection into the view.
 *
 * The page's own last item sets that collection's cursor (rule 1); items are deduped by id
 * (rule 2); an empty page retires the collection (rule 3) and its `remaining` goes to zero.
 */
export function foldPage(state: PagingState, dir: StandardDir, listing: MediaListing): PagingState {
  const seen = new Set(state.items.map((i) => i.id));
  const fresh = listing.items.filter((i) => !seen.has(i.id));
  const items = [...state.items, ...fresh].sort(newestFirst);
  const last = listing.items[listing.items.length - 1];
  const exhausted = listing.items.length === 0;
  // The host's `total` counts what is left **after the cursor** (i.e. including the page it
  // just sent, like `Content-Range`'s denominator). What a caller rendering "N of M" needs is
  // what is left *after* the items it now holds — so it is this page's items subtracted here,
  // once, instead of at every call site.
  const left = Math.max(0, listing.total - listing.items.length);
  return {
    items,
    remaining: { ...state.remaining, [dir]: left },
    cursors: last ? { ...state.cursors, [dir]: cursorOf(last) } : state.cursors,
    exhausted: exhausted
      ? state.exhausted.includes(dir)
        ? state.exhausted
        : [...state.exhausted, dir]
      : state.exhausted.filter((d) => d !== dir),
  };
}

/** Collections that may still have more (not retired by an empty page). */
export function pendingDirs(state: PagingState, dirs: readonly StandardDir[]): StandardDir[] {
  return dirs.filter((d) => !state.exhausted.includes(d));
}

/** True when at least one collection may still have more. */
export function hasMore(state: PagingState, dirs: readonly StandardDir[]): boolean {
  return pendingDirs(state, dirs).length > 0;
}

/**
 * May the user usefully ask for another page?
 *
 * `hasMore` alone is not enough to render a button: a collection is *retired* only by an
 * empty page, so after the last real page it stays "pending" until the next round asks and
 * gets nothing. The host has already said how much is left (`remaining`, from its own
 * `total`), so a button keyed on `hasMore` alone would offer "load more (0 left)" — a
 * control whose only effect is a round-trip that returns nothing. The screens ask *this*.
 */
export function canLoadMore(state: PagingState, dirs: readonly StandardDir[]): boolean {
  return hasMore(state, dirs) && remainingTotal(state, dirs) > 0;
}

/** Items the host says it still has after the cursors (the "M" of "N of M"). */
export function remainingTotal(state: PagingState, dirs: readonly StandardDir[]): number {
  return dirs.reduce((sum, d) => sum + (state.remaining[d] ?? 0), 0);
}

/** What one round of paging produced. */
export interface PageRound {
  state: PagingState;
  /** Collections whose page **failed** (denied, host gone) — reported, not swallowed. */
  failed: StandardDir[];
}

/**
 * Ask every collection that may still have more for its next page, and fold the answers in.
 *
 * A collection that **rejects** is reported in `failed` and left un-retired: the caller can
 * tell the user ("some files could not be read") and a later attempt can still succeed. A
 * collection that answers `null` (no host) counts as failed too — never as "nothing left".
 */
export async function fetchInto(
  state: PagingState,
  dirs: readonly StandardDir[],
  fetch: (dir: StandardDir, after: MediaCursor | null) => Promise<MediaListing | null>,
): Promise<PageRound> {
  let next = state;
  const failed: StandardDir[] = [];
  for (const dir of pendingDirs(state, dirs)) {
    const after = next.cursors[dir] ?? null;
    let listing: MediaListing | null = null;
    try {
      listing = await fetch(dir, after);
    } catch {
      failed.push(dir);
      continue;
    }
    if (listing === null) {
      failed.push(dir);
      continue;
    }
    next = foldPage(next, dir, listing);
  }
  return { state: next, failed };
}