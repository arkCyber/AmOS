/**
 * External-collection view model for the Files screen — a **read-only** window
 * over the standard Android collections (`Download`, `Pictures`, …) served by the
 * `media_*` bridge. It is deliberately **isolated from the `amos.files` store**:
 * it models display metadata only (name / kind / uri / size / mtime), never
 * FEntry trees, so a screen can show real external files without risking the
 * local store's create/rename/delete semantics.
 *
 * Pure + offline-testable; nothing here touches the bridge (normalize helpers
 * tolerate missing fields). Wire: crates/amos-media → media_list → this lib.
 */
import { normalizeMediaItem } from "./media";
import type { MediaItem, MediaKind, StandardDir } from "./media";

/** A read-only display node for one external file. */
export interface ExternalFile {
  id: string;
  name: string;
  kind: MediaKind;
  collection: StandardDir;
  uri: string;
  sizeBytes: number | null;
  /** Last-modified epoch ms (0 = unknown). */
  ts: number;
  mime: string | null;
}

export type ExternalSort = "name" | "date" | "size";

/** Kind → tile glyph (mirror of photoLibrary placeholder faces). */
export function externalGlyph(kind: MediaKind): string {
  switch (kind) {
    case "image":
      return "🖼";
    case "video":
      return "🎬";
    case "audio":
      return "🎵";
    case "download":
      return "📦";
    case "file":
      return "📄";
  }
}

/** Human-friendly byte size ("1.5 MB", "0 B", "—" when unknown). */
export function formatBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const s = v >= 100 || u === 0 ? String(Math.round(v)) : v.toFixed(1);
  return `${s} ${units[u]}`;
}

/** Promote a native `MediaItem` into a display node. */
export function toExternalFile(item: MediaItem): ExternalFile {
  return {
    id: item.uri,
    name: item.name,
    kind: item.kind,
    collection: item.collection,
    uri: item.uri,
    sizeBytes: item.size_bytes,
    ts: item.ts,
    mime: item.mime,
  };
}

/** Coerce a raw bridge item; null when unparseable. Never throws. */
export function normalizeExternalFile(raw: unknown): ExternalFile | null {
  const it = normalizeMediaItem(raw);
  if (!it) return null;
  return toExternalFile(it);
}

/** Stable sort of a display list. "default" keeps the given order. */
export function sortExternalFiles(files: ExternalFile[], key: ExternalSort): ExternalFile[] {
  const out = [...files];
  if (key === "name") {
    out.sort((a, b) => a.name.localeCompare(b.name));
  } else if (key === "date") {
    out.sort((a, b) => b.ts - a.ts);
  } else if (key === "size") {
    out.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
  }
  return out;
}

/** Case-insensitive name filter (empty query passes everything through). */
export function filterExternalByName(files: ExternalFile[], query: string): ExternalFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return files;
  return files.filter((f) => f.name.toLowerCase().includes(q));
}

/** Total bytes of the visible files (0 when all sizes are unknown). */
export function totalExternalBytes(files: ExternalFile[]): number {
  return files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
}

/** A group of external files under one standard collection. */
export interface ExternalCollection {
  collection: StandardDir;
  files: ExternalFile[];
}

/** Group files by collection, preserving first-seen collection order. */
export function groupByCollection(files: ExternalFile[]): ExternalCollection[] {
  const order: StandardDir[] = [];
  const map = new Map<StandardDir, ExternalFile[]>();
  for (const f of files) {
    let list = map.get(f.collection);
    if (!list) {
      list = [];
      map.set(f.collection, list);
      order.push(f.collection);
    }
    list.push(f);
  }
  return order.map((c) => ({ collection: c, files: map.get(c) ?? [] }));
}

/** Drop duplicate files that share a `uri` (keeps the first occurrence). */
export function dedupeExternal(files: ExternalFile[]): ExternalFile[] {
  const seen = new Set<string>();
  const out: ExternalFile[] = [];
  for (const f of files) {
    if (seen.has(f.uri)) continue;
    seen.add(f.uri);
    out.push(f);
  }
  return out;
}

/** Union of two sources by `uri` (useful to merge a live list with local recents). */
export function mergeDeduped(a: ExternalFile[], b: ExternalFile[]): ExternalFile[] {
  return dedupeExternal([...a, ...b]);
}

/**
 * The `max` most recently modified external files. Entries with an unknown
 * mtime (ts = 0) sort last (never dropped if `max` covers them).
 */
export function recentExternalFiles(files: ExternalFile[], max: number): ExternalFile[] {
  const n = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  const known = files.filter((f) => f.ts > 0).sort((a, b) => b.ts - a.ts);
  const unknown = files.filter((f) => f.ts <= 0);
  return known.concat(unknown).slice(0, n);
}

/** A ready-to-render view over external files: groups + aggregates. */
export interface ExternalFileGroupView {
  groups: ExternalCollection[];
  fileCount: number;
  totalBytes: number;
}

/**
 * Build a ready-to-render external view from a raw `media_list` payload: normalize
 * every entry, drop the unparseable, group by collection (first-seen order),
 * sort each group by name, and aggregate counts/sizes. This is the single entry
 * a Files screen calls; it never touches the `amos.files` store.
 */
export function buildExternalFileView(items: unknown[]): ExternalFileGroupView {
  const files: ExternalFile[] = [];
  for (const raw of items) {
    const f = normalizeExternalFile(raw);
    if (f) files.push(f);
  }
  const groups = groupByCollection(sortExternalFiles(files, "name"));
  return {
    groups,
    fileCount: files.length,
    totalBytes: totalExternalBytes(files),
  };
}


