/**
 * mediaPaging.ts — cumulative paging over several collections (REQ-A316).
 *
 * **What the host actually gives us (measured, REQ-A354)** — not what an earlier draft of this
 * comment assumed: `media_list(state, collection) -> Vec<MediaItem>` returns the **whole**
 * collection, sorted by `ts` descending and nothing else (`crates/amos-media/src/hostfs.rs`
 * and `provider.rs`: `sort_by_key(|i| cmp::Reverse(i.ts))`). There is **no cursor parameter,
 * no page size and no total**, and among items that share a timestamp the order is whatever
 * the directory scan produced. Paging is therefore **ours**: we hold the list in our own total
 * order (`(ts desc, id asc)`, `newestFirst`) and slice it ourselves (`pageOf`), which is also
 * why a resume point can never be "the host's last item" alone.
 *
 * A screen that shows a *merged* view (Photos = camera + screenshots, Files = downloads +
 * pictures + …, Player = movies + music) has to keep **one cursor per collection** and merge
 * the pages itself. That logic is here, pure and injectable, because it is the part that can
 * be wrong in a way nobody sees: a pager that repeats or skips an item looks exactly like a
 * working one until the user counts their photos.
 *
 * Three rules make it correct, and each is tested:
 *  1. **A page's cursor is read off the page, in our order** — `foldPage` takes it from the
 *     listing's last item, and `afterCursor`/`pageOf` express resuming in the same order, so a
 *     boundary inside a tie group neither drops nor repeats the rest of it.
 *  2. **Items are deduped by id** — a host that re-serves an item (or two collections that
 *     contain the same one) cannot show it twice.
 *  3. **An empty page ends that collection** — that is the only signal there is that nothing is
 *     left after the cursor, and it is also the loop's stop condition.
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
  const exhausted = listing.items.length === 0;
  // Rule 1: the cursor is the page's **last item in our order** — which holds because the page
  // came from `pageOf` (the host's own order has no tiebreaker and cannot be resumed on; see
  // `afterCursor`). The pre-REQ-A343 shape passed a single item here, which read
  // `undefined.length` and silently produced no cursor — that is what broke these cases.
  const cursor = cursorOf(listing.items);
  // `remaining` is what `pageOf` computed for the collection it sliced (the host reports no
  // total); an empty page means nothing is left, whatever a caller passed.
  const left = exhausted ? 0 : listing.remaining;
  return {
    items,
    remaining: { ...state.remaining, [dir]: left },
    cursors: cursor ? { ...state.cursors, [dir]: cursor } : state.cursors,
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
 * gets nothing. `remaining` is what `pageOf` said was left (the host reports no total, so this
 * is our own count), and a button keyed on `hasMore` alone would offer "load more (0 left)" —
 * a control whose only effect is a round-trip that returns nothing. The screens ask *this*.
 */
export function canLoadMore(state: PagingState, dirs: readonly StandardDir[]): boolean {
  return hasMore(state, dirs) && remainingTotal(state, dirs) > 0;
}

/** Items the host says it still has after the cursors (the "M" of "N of M"). */
export function remainingTotal(state: PagingState, dirs: readonly StandardDir[]): number {
  return dirs.reduce((sum, d) => sum + (state.remaining[d] ?? 0), 0);
}

/**
 * Is `it` strictly after `cursor` in **our** order — `(ts desc, id asc)`, the same order
 * `newestFirst` sorts by?
 *
 * The host cannot answer this for us. Measured (REQ-A354) against the code we actually run:
 * `crates/amos-media/src/hostfs.rs` and `provider.rs` both do
 * `items.sort_by_key(|i| std::cmp::Reverse(i.ts))` — **`ts` descending only, with no
 * tiebreaker at all**, so among items that share a timestamp the host's order is whatever the
 * directory scan produced, and `media_list(state, collection) -> Vec<MediaItem>` carries
 * neither a cursor nor a total. "The last item of the page the host sent" is therefore not a
 * well-defined resume point on its own: a client that resumes by timestamp alone repeats the
 * rest of a tie group or drops it, which is exactly the invisible failure this module exists
 * to prevent. The resume point has to be expressed in *our* total order, and this is where
 * that order is written down (`pageOf` below applies it).
 */
export function afterCursor(it: MediaItem, cursor: MediaCursor): boolean {
  if (it.ts !== cursor.last_ts) return it.ts < cursor.last_ts;
  return it.id > cursor.last_id;
}

/**
 * One page of `all` — which must already be in our order — after `cursor`, plus how many
 * items are left after it.
 *
 * This is the `fetch` a screen hands to `fetchInto`. No screen calls it yet — that gap is the
 * `media.loadMore` entry in `scripts/i18n-allowlist.json` — which is exactly why the slicing
 * lives here, exported and tested, instead of being written fresh inside whichever screen
 * wires the pager first. A cursor that is not in `all` still works: `afterCursor` is monotone
 * in our order, so `findIndex` lands on the first item that would follow it.
 */
export function pageOf(
  all: readonly MediaItem[],
  cursor: MediaCursor | null,
  limit: number,
): MediaListing {
  const from = cursor === null ? 0 : (() => {
    const i = all.findIndex((it) => afterCursor(it, cursor));
    return i < 0 ? all.length : i;
  })();
  const items = all.slice(from, from + Math.max(0, limit));
  return { items, remaining: Math.max(0, all.length - (from + items.length)) };
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