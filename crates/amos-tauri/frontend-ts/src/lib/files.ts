/**
 * Files app core — flat list keyed by unique `id` + `parent` id, mirroring a real
 * tree. Pure functions only (no window), so every op is unit-testable headlessly.
 */
import { localId } from "./localId";

export interface FEntry {
  id: string;
  type: "folder" | "file";
  name: string;
  parent?: string; // parent folder id; absent = root
  content?: string;
  ts: number;
}

export const FILES_KEY = "amos.files";

/**
 * A new entry id.
 *
 * Delegates to the shared `localId` (the same generator REQ-A390 introduced for the other
 * seven id sites). The previous inline form —
 * `` `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}` ``
 * — carries only ~20 bits of randomness, and in JavaScriptCore (Bun's engine)
 * `Number#toString(36)` prints the **shortest** representation, so ids minted inside one
 * millisecond can collide. Measured: `files.test.ts > makeId > generates unique ids`
 * (100 ids in a tight loop, asserting 100 distinct) failed exactly that way.
 *
 * `localId` appends a process-monotonic counter plus a zero-padded `crypto` tail, so
 * uniqueness does not rest on luck; the prefix contract is unchanged (`/^test/`, `/^n/`).
 */
export function makeId(prefix = "e"): string {
  return localId(prefix);
}

export function makeEntry(type: FEntry["type"], name: string, parent: string | undefined, ts: number): FEntry {
  const e: FEntry = { id: makeId(), type, name, ts };
  if (parent) e.parent = parent;
  if (type === "file") e.content = "";
  return e;
}

/**
 * Back-compat / corruption guard: coerce any stored array (tolerating malformed
 * entries) into a valid `FEntry[]`. Drops non-object/nameless/bad-type entries,
 * back-fills missing ids, and de-duplicates id collisions — so a corrupted or
 * hand-edited `amos.files` can never crash sorting/search/rendering.
 */
export function normalizeFiles(list: unknown): FEntry[] {
  if (!Array.isArray(list)) return [];
  const out: FEntry[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const type = o.type === "file" ? "file" : o.type === "folder" ? "folder" : undefined;
    if (!type) continue;
    if (typeof o.name !== "string" || o.name.trim() === "") continue;
    let id = typeof o.id === "string" && o.id ? o.id : makeId("n");
    let k = 1;
    while (seen.has(id)) id = `${id}-${k++}`;
    seen.add(id);
    const e: FEntry = {
      id,
      type,
      name: o.name,
      ts: typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : 0,
    };
    if (typeof o.parent === "string" && o.parent) e.parent = o.parent;
    if (type === "file" && typeof o.content === "string") e.content = o.content;
    out.push(e);
  }
  return out;
}

export function addEntry(list: FEntry[], entry: FEntry): FEntry[] {
  return [...list, entry];
}

/** Children of a folder id (undefined = root). */
export function childrenOf(list: FEntry[], parent: string | undefined): FEntry[] {
  return list.filter((e) => (e.parent || undefined) === parent);
}

/** Ancestry root → a folder (for deep-link breadcrumbs). Cycle-safe: stops if a
 * corrupted parent chain loops back on itself instead of hanging forever. */
export function pathOf(list: FEntry[], id: string | undefined): FEntry[] {
  const segs: FEntry[] = [];
  const seen = new Set<string>();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const f = list.find((e) => e.id === cur);
    if (!f) break;
    segs.unshift(f);
    cur = f.parent;
  }
  return segs;
}

/** Is `from` equal to / inside the subtree rooted at `outer`? (cycle guard).
 * Cycle-safe: tolerates a corrupted parent chain without looping forever. */
export function isInside(list: FEntry[], from: string | undefined, outer: string): boolean {
  const seen = new Set<string>();
  let cur = from;
  while (cur && !seen.has(cur)) {
    if (cur === outer) return true;
    seen.add(cur);
    const f = list.find((e) => e.id === cur);
    cur = f?.parent;
  }
  return false;
}

export function renameEntry(list: FEntry[], id: string, name: string): FEntry[] {
  return list.map((e) => (e.id === id ? { ...e, name } : e));
}

/** Move entry under `dest` (undefined = root). Rejects moving a folder into
 * itself/its own subtree by returning the unchanged list. */
export function moveEntry(list: FEntry[], id: string, dest: string | undefined): FEntry[] {
  const target = list.find((e) => e.id === id);
  if (!target) return list;
  if (target.type === "folder" && dest && isInside(list, dest, id)) return list;
  return list.map((e) => (e.id === id ? { ...e, ...(dest ? { parent: dest } : { parent: undefined }) } : e));
}

/** Move every id in `ids` under `dest` (undefined = root). Applies the same
 * cycle-safe guard per entry; returns the input unchanged when nothing moves. */
export function moveEntries(list: FEntry[], ids: ReadonlySet<string>, dest: string | undefined): FEntry[] {
  if (ids.size === 0) return list;
  let out = list;
  for (const id of ids) {
    const next = moveEntry(out, id, dest);
    if (next !== out) out = next;
  }
  return out;
}

/** Breadth-first list of all folders with their nesting depth (for an indented
 * picker). Cycle-safe: tolerates a corrupted parent chain without looping. */
export interface FolderNode {
  id: string;
  name: string;
  depth: number;
}
export function folderTree(list: readonly FEntry[]): FolderNode[] {
  const out: FolderNode[] = [];
  const seen = new Set<string>();
  const q: { f: FEntry; depth: number }[] = childrenOf(list as FEntry[], undefined)
    .filter((e) => e.type === "folder")
    .map((f) => ({ f, depth: 0 }));
  while (q.length > 0) {
    const { f, depth } = q.shift()!;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ id: f.id, name: f.name, depth });
    for (const c of childrenOf(list as FEntry[], f.id)) {
      if (c.type === "folder" && !seen.has(c.id)) q.push({ f: c, depth: depth + 1 });
    }
  }
  return out;
}

/**
 * Remove an entry and everything nested beneath it — **the trash's own primitive**.
 *
 * This used to be exported as `deleteEntry`/`deleteEntries` and called straight from the
 * files screen, which is why a delete was permanent. REQ-A455 moved the user-facing act to
 * `moveToTrash` (the ledger keeps the subtree), and the pair was **deleted** rather than kept
 * as "API": a helper that removes entries *without* a ledger is exactly the footgun this
 * round removes — one future caller reaching for it would put data loss back. The
 * subtree/cycle behaviour it had is covered through `moveToTrash`'s cases.
 */
function collectSubtree(list: FEntry[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of list) {
      if (e.parent && out.has(e.parent) && !out.has(e.id)) {
        out.add(e.id);
        changed = true;
      }
    }
  }
  return out;
}

export function hasName(children: FEntry[], name: string): boolean {
  return children.some((e) => e.name === name);
}

/** Stable display order for a folder's children. */
export type SortKey = "default" | "name" | "time";

/** Children of `parent`, optionally sorted by name (A→Z) or by timestamp
 * (newest first). "default" preserves the stored insertion order. */
export function sortChildren(
  list: FEntry[],
  parent: string | undefined,
  key: SortKey,
): FEntry[] {
  const kids = childrenOf(list, parent);
  const out = [...kids];
  if (key === "name") {
    out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  } else if (key === "time") {
    out.sort((a, b) => b.ts - a.ts);
  }
  return out;
}

/** Case-insensitive substring filter on a display list; an empty query passes
 * every entry through unchanged. */
export function filterByName(list: FEntry[], query: string): FEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((e) => e.name.toLowerCase().includes(q));
}

/** Whether a file entry's content contains `query` (case-insensitive). Folders
 * and files without content never match content. */
export function contentContains(e: FEntry, query: string): boolean {
  return e.type === "file" && (e.content ?? "").toLowerCase().includes(query.toLowerCase());
}

/** Cross-directory search across the whole (flat) tree. Matches entry names and
 * (optionally) file contents; returns matches in name order. Empty query → []. */
export function searchFiles(
  list: FEntry[],
  query: string,
  includeContent: boolean,
): FEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return list
    .filter((e) => e.name.toLowerCase().includes(q) || (includeContent && contentContains(e, query)))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/** Breadcrumb of ancestor *folder* names for an entry (e.g. "A / B"), or "" when
 * it lives at the root. Helps global-search results show where each hit is. */
export function folderPath(list: FEntry[], id: string): string {
  const e = list.find((x) => x.id === id);
  if (!e) return "";
  return pathOf(list, e.parent)
    .map((x) => x.name)
    .join(" / ");
}

export const FILES_FAV_KEY = "amos.files.favorites";

/**
 * The **cross-window** reveal intent (REQ-A458): `{ id, nonce }`, written by whoever wants the
 * Files screen to show one entry, cleared by the Files screen once it has.
 *
 * Why a store key and not the existing `files` props channel: that channel (`propsBus`) is a
 * **same-window** bus. It is exactly right for the touch shell, where the Spotlight sheet and the
 * Files surface are mounted in one page — and useless on the desktop, where the Spotlight runs in
 * the launcher window and Files in its own `WebviewWindow` (writing the bus there reaches nobody,
 * which is a dead row with extra steps). The shared store is the shell's cross-window mechanism
 * (it broadcasts `store-updated` and every window re-reads), so a one-shot *intent* belongs here.
 *
 * It is a **command, not state**: clearing it after the read is what keeps it one-shot, and a
 * second Files window opened later finds `null` rather than re-firing a reveal nobody asked for.
 */
export const FILES_REVEAL_KEY = "amos.files.reveal";

/** One reveal request: the entry to show, and a nonce so a repeat of the same id still fires. */
export interface FilesReveal {
  id: string;
  nonce: number;
}

/**
 * Coerce a stored reveal value — `null` for "nothing pending" (the honest default: an empty
 * string id, a missing/foreign nonce and a non-object are all *not* requests).
 */
export function normalizeReveal(raw: unknown): FilesReveal | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.trim() === "") return null;
  const nonce = typeof o.nonce === "number" && Number.isFinite(o.nonce) ? o.nonce : 0;
  return { id: o.id, nonce };
}

/** Toggle an entry id in a favorites id-list (returns a new array). */
export function toggleFav(favs: string[], id: string): string[] {
  return favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id];
}

/** The `max` most recently modified files, newest first. */
export function recentFiles(list: FEntry[], max: number): FEntry[] {
  const n = Number.isFinite(max) && max > 0 ? max : 0;
  return [...list.filter((e) => e.type === "file")]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, n);
}

/* ---- Trash (REQ-A455) ------------------------------------------------------ */

/**
 * Where the trash ledger lives.
 *
 * A **separate store key** rather than a field inside `amos.files`: the ledger is not a
 * tree the user browses, and keeping it out of `FEntry[]` means every existing file
 * operation (`sortChildren`, `searchFiles`, `folderTree`, …) stays correct without
 * learning about a fourth entry kind (a "trashed" flag would have to be filtered out in
 * each of them — the shape this repo removes rather than adds).
 */
export const FILES_TRASH_KEY = "amos.files.trash";

/**
 * Upper bound on trashed items (Power of 10 rule 3: bounded resources).
 *
 * The trash is a **safety net, not an archive** (macOS rotates it by age the same way),
 * and an unbounded ledger would grow the shared store until writes start failing — the
 * one failure a safety net must not have. At the cap the **oldest** item is dropped and
 * the count is reported to the caller (`MoveToTrashResult.dropped`) so the UI can say it
 * instead of doing it silently.
 */
export const MAX_TRASH_ITEMS = 100;

/**
 * One deleted item — the subtree that left the tree, plus where it came from.
 *
 * `members` holds the **root first**, then the rest in list order: a folder must come back
 * whole, the root is what the UI names, and it is what `restoreFromTrash` looks up by
 * `id`. A trashed item is addressed by id (the root's entry id, free again the moment it
 * is trashed) — never by name, because names are what users collide on.
 */
export interface TrashItem {
  /** The trashed root's entry id. */
  id: string;
  /** The removed subtree, **root first**. */
  members: FEntry[];
  /** The folder it was deleted from (`undefined` = it lived at the root). */
  fromParent?: string;
  /** Wall-clock ms when it was trashed (0 = unknown, e.g. a repaired ledger row). */
  deletedAt: number;
}

/** What `moveToTrash` did: the new tree, the new ledger, what moved, what was evicted. */
export interface MoveToTrashResult {
  list: FEntry[];
  trash: TrashItem[];
  moved: TrashItem[];
  /** How many older items the cap evicted (0 normally; the UI must report it when > 0). */
  dropped: number;
}

/**
 * The top-most entries selected: a selection holding a folder **and** something inside it
 * moves as one item, so the ledger cannot carry a copy of a child whose parent is also in
 * it. Order follows `list` (stable), and a corrupted parent chain cannot loop.
 */
function topmostSelection(list: FEntry[], ids: ReadonlySet<string>): FEntry[] {
  const out: FEntry[] = [];
  const inside = (id: string): boolean => {
    const seen = new Set<string>([id]);
    let cur = list.find((e) => e.id === id)?.parent;
    while (cur && !seen.has(cur)) {
      if (ids.has(cur)) return true;
      seen.add(cur);
      cur = list.find((e) => e.id === cur)?.parent;
    }
    return false;
  };
  for (const e of list) {
    if (ids.has(e.id) && !inside(e.id)) out.push(e);
  }
  return out;
}

/**
 * Move `ids` (with their subtrees) into the trash. **Pure** — the clock is a parameter, so
 * "oldest first" and the cap are testable without waiting.
 *
 * Returns the tree without those subtrees, the ledger with the new items **first** (newest
 * first, the order the trash view renders) and an honest account of what happened. An
 * empty selection is a no-op that returns its inputs unchanged.
 */
export function moveToTrash(
  list: FEntry[],
  trash: TrashItem[],
  ids: ReadonlySet<string>,
  now: number,
): MoveToTrashResult {
  if (ids.size === 0) return { list, trash, moved: [], dropped: 0 };
  const roots = topmostSelection(list, ids);
  if (roots.length === 0) return { list, trash, moved: [], dropped: 0 };

  const doomed = new Set<string>();
  const moved: TrashItem[] = [];
  for (const root of roots) {
    const subtree = collectSubtree(list, root.id);
    for (const id of subtree) doomed.add(id);
    const members = [root, ...list.filter((e) => e.id !== root.id && subtree.has(e.id))];
    const item: TrashItem = { id: root.id, members, deletedAt: now };
    if (root.parent) item.fromParent = root.parent;
    moved.push(item);
  }

  const kept = [...moved, ...trash];
  const capped = kept.slice(0, MAX_TRASH_ITEMS);
  return {
    list: list.filter((e) => !doomed.has(e.id)),
    trash: capped,
    moved,
    dropped: kept.length - capped.length,
  };
}

/** What `restoreFromTrash` did — a named outcome, never a silent no-op. */
export type RestoreOutcome =
  /** Back where it came from. */
  | { kind: "restored"; to?: string }
  /** Its original folder is gone, so it comes back at the root — said out loud. */
  | { kind: "restored-to-root" }
  /** No such ledger row (already restored, or purged in another window). */
  | { kind: "not-found" }
  /** A sibling already carries that name; the user decides, not us. */
  | { kind: "name-conflict"; name: string }
  /** One of its ids is already in the tree (hand-edited store). */
  | { kind: "id-conflict"; id: string };

/**
 * Put a trashed item back. **Pure.**
 *
 * The root returns under `fromParent` — or, when that folder no longer exists, at the root
 * (macOS's own fallback), reported as `restored-to-root` rather than disguised as a normal
 * restore. Two collisions are **refused, not resolved**: a sibling with the same name
 * (`name-conflict` — silently renaming would hide that the user now has two things called
 * the same) and an id already present (`id-conflict`). Restored entries land **after**
 * their siblings: `FEntry` carries no order, so inventing a position would be a number
 * nobody measured.
 */
export function restoreFromTrash(
  list: FEntry[],
  trash: TrashItem[],
  id: string,
): { list: FEntry[]; trash: TrashItem[]; outcome: RestoreOutcome } {
  const item = trash.find((t) => t.id === id);
  const root = item?.members[0];
  if (!item || !root) return { list, trash, outcome: { kind: "not-found" } };

  const clash = item.members.find((m) => list.some((e) => e.id === m.id));
  if (clash) return { list, trash, outcome: { kind: "id-conflict", id: clash.id } };

  const originExists = item.fromParent
    ? list.some((e) => e.id === item.fromParent && e.type === "folder")
    : false;
  const to = originExists ? item.fromParent : undefined;
  if (hasName(childrenOf(list, to), root.name)) {
    return { list, trash, outcome: { kind: "name-conflict", name: root.name } };
  }

  const restored = item.members.map((m) =>
    m.id === root.id ? { ...m, ...(to ? { parent: to } : { parent: undefined }) } : m,
  );
  return {
    list: [...list, ...restored],
    trash: trash.filter((t) => t.id !== id),
    outcome: item.fromParent && !originExists ? { kind: "restored-to-root" } : { kind: "restored", to },
  };
}

/**
 * Drop items from the ledger **for good** — the only destructive operation left, and the
 * reason the dock tile's "empty" act is reachable only from inside the trash view. An empty
 * selection returns the input unchanged, so "empty the trash" is one line at the call site
 * (`purgeFromTrash(trash, new Set(trash.map((t) => t.id)))`) and needs no second code path.
 */
export function purgeFromTrash(trash: TrashItem[], ids: ReadonlySet<string>): TrashItem[] {
  if (ids.size === 0) return trash;
  const out = trash.filter((t) => !ids.has(t.id));
  return out.length === trash.length ? trash : out;
}

/**
 * Corruption guard for `amos.files.trash` — the same contract `normalizeFiles` has for the
 * tree: a hand-edited or partially written value can never crash the trash view. Drops rows
 * whose root is missing from `members` (nothing to name, nothing to look up), repairs a
 * non-numeric `deletedAt` to 0, re-orders `members` root-first, de-duplicates by root id and
 * applies the cap.
 */
export function normalizeTrash(raw: unknown): TrashItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TrashItem[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (out.length >= MAX_TRASH_ITEMS) break;
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || seen.has(o.id)) continue;
    const members = normalizeFiles(o.members);
    const root = members.find((m) => m.id === o.id);
    if (!root) continue;
    seen.add(o.id);
    const item: TrashItem = {
      id: o.id,
      members: [root, ...members.filter((m) => m.id !== o.id)],
      deletedAt:
        typeof o.deletedAt === "number" && Number.isFinite(o.deletedAt) ? o.deletedAt : 0,
    };
    if (typeof o.fromParent === "string" && o.fromParent) item.fromParent = o.fromParent;
    out.push(item);
  }
  return out;
}
