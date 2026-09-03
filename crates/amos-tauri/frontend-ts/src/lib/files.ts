/**
 * Files app core — flat list keyed by unique `id` + `parent` id, mirroring a real
 * tree. Pure functions only (no window), so every op is unit-testable headlessly.
 */
export interface FEntry {
  id: string;
  type: "folder" | "file";
  name: string;
  parent?: string; // parent folder id; absent = root
  content?: string;
  ts: number;
}

export const FILES_KEY = "amos.files";

export function makeId(prefix = "e"): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
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

/** Remove an entry and everything nested beneath it. */
export function deleteEntry(list: FEntry[], id: string): FEntry[] {
  const doomed = collectSubtree(list, id);
  return list.filter((e) => !doomed.has(e.id));
}

/** Batch-delete: removes the union of the subtrees rooted at `ids`. Empty set is
 * a no-op returning the input unchanged. */
export function deleteEntries(list: FEntry[], ids: ReadonlySet<string>): FEntry[] {
  if (ids.size === 0) return list;
  const doomed = new Set<string>();
  for (const id of ids) {
    for (const x of collectSubtree(list, id)) doomed.add(x);
  }
  return list.filter((e) => !doomed.has(e.id));
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
