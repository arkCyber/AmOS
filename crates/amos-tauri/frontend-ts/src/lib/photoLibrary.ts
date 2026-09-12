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
