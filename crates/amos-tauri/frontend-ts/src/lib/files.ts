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

export function hasName(children: FEntry[], name: string): boolean {
  return children.some((e) => e.name === name);
}
