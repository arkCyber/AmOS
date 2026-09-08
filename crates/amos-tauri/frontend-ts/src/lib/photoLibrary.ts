/**
 * Photo library view model: how AmOS's real media collections (from the
 * `media_*` bridge, i.e. DCIM/Camera etc. on a device) combine with the local
 * `amos.photos` layer (captures stored as base64 data URLs / gradient tiles).
 *
 * This is the pure Phase-D core that a screen will render. On host the native
 * items carry `mock://` handles with no real pixels, so each becomes a
 * kind-glyph tile (📷/🎬/…) whose `uri`/`sizeBytes` are kept for a later,
 * device-only thumbnail load (see `docs/android-storage-unify.md` §6 D). All
 * functions are pure + offline-testable; nothing here touches the bridge.
 */
import type { MediaItem, StandardDir } from "./media";
import type { Photo } from "./photos";

/** A native media item promoted into the Photos tile shape (glyph placeholder
 * until a real thumbnail loads; `uri`/`collection`/`sizeBytes` carried over). */
export interface NativePhoto extends Photo {
  kind: MediaItem["kind"];
  name: string;
  uri: string;
  collection: StandardDir;
  sizeBytes: number | null;
}

/** Kind → tile glyph (placeholder face; mirror of demo gradient tiles). */
export function photoGlyph(kind: MediaItem["kind"]): string {
  switch (kind) {
    case "image":
      return "📷";
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

/** Promote a native `MediaItem` into a `NativePhoto` with a unique id and the
 * source `ts`. `fav` is absent (favourites live on the local layer). */
export function nativePhotoFromItem(item: MediaItem): NativePhoto {
  return {
    id: `native:${item.uri}`,
    kind: item.kind,
    collection: item.collection,
    name: item.name,
    uri: item.uri,
    sizeBytes: item.size_bytes,
    ts: item.ts,
    emoji: photoGlyph(item.kind),
  };
}

/** Result of merging the local layer with the native collections. */
export interface PhotoGallery {
  /** Union newest-first; local real captures out-rank natives on equal ts. */
  gallery: (Photo | NativePhoto)[];
  /** Number of native tiles included. */
  nativeCount: number;
  /** Native items dropped as duplicates (by uri). */
  dropped: number;
}

const isNative = (p: Photo | NativePhoto): p is NativePhoto => "uri" in p;

function isRealLocal(p: Photo): boolean {
  return !!p.data;
}

/**
 * Merge local `amos.photos` with the native collections from the bridge.
 *
 * Ordering: newest `ts` first; on a timestamp tie, real local captures beat
 * native tiles, which beat demo/gradient tiles (stable). Duplicate native items
 * (same `uri`) collapse to one. Local vs native identity can't be reliably
 * linked on the host mock (locals carry no uri), so no cross-layer de-dupe is
 * attempted — that requires a device where both carry content handles.
 */
export function mergeMediaGallery(local: Photo[], native: MediaItem[]): PhotoGallery {
  const seen = new Set<string>();
  const nativeTiles: NativePhoto[] = [];
  let dropped = 0;
  for (const item of native) {
    if (seen.has(item.uri)) {
      dropped += 1;
      continue;
    }
    seen.add(item.uri);
    nativeTiles.push(nativePhotoFromItem(item));
  }

  const rank = (p: Photo | NativePhoto): number => {
    if (isNative(p)) return 1;
    return isRealLocal(p) ? 2 : 0;
  };

  const all: (Photo | NativePhoto)[] = [...local, ...nativeTiles];
  // Stable sort by (ts desc, rank desc) — preserves input order within a group.
  const sorted = all
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => {
      if (b.p.ts !== a.p.ts) return b.p.ts - a.p.ts;
      if (rank(b.p) !== rank(a.p)) return rank(b.p) - rank(a.p);
      return a.idx - b.idx;
    })
    .map((x) => x.p);

  return { gallery: sorted, nativeCount: nativeTiles.length, dropped };
}
