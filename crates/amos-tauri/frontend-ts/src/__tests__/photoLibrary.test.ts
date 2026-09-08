import { describe, expect, it } from "bun:test";
import type { MediaItem } from "../lib/media";
import type { Photo } from "../lib/photos";
import { mergeMediaGallery, nativePhotoFromItem, photoGlyph } from "../lib/photoLibrary";

function item(partial: Partial<MediaItem> & { name: string; uri: string; ts: number }): MediaItem {
  return {
    id: partial.uri,
    kind: "image",
    collection: "camera",
    mime: null,
    size_bytes: null,
    ...partial,
  };
}

function localPhoto(id: string, ts: number, data?: string): Photo {
  return { id, ts, ...(data ? { data } : { emoji: "🌅" }) };
}

describe("photoGlyph", () => {
  it("maps each kind to a stable placeholder face", () => {
    expect(photoGlyph("image")).toBe("📷");
    expect(photoGlyph("video")).toBe("🎬");
    expect(photoGlyph("audio")).toBe("🎵");
    expect(photoGlyph("file")).toBe("📄");
    expect(photoGlyph("download")).toBe("📦");
  });
});

describe("nativePhotoFromItem", () => {
  it("promotes a MediaItem into a NativePhoto, keeping uri/collection/size", () => {
    const it = item({ name: "IMG.jpg", uri: "mock://DCIM/Camera/IMG.jpg", ts: 50, size_bytes: 2048 });
    const p = nativePhotoFromItem(it);
    expect(p.id).toBe("native:mock://DCIM/Camera/IMG.jpg");
    expect(p.uri).toBe("mock://DCIM/Camera/IMG.jpg");
    expect(p.collection).toBe("camera");
    expect(p.sizeBytes).toBe(2048);
    expect(p.ts).toBe(50);
    expect(p.emoji).toBe("📷");
    expect(p.fav).toBeUndefined(); // favourites live on the local layer
  });
});

describe("mergeMediaGallery", () => {
  it("merges local + native newest-first", () => {
    const local = [localPhoto("l1", 100)];
    const native = [
      item({ name: "a.jpg", uri: "mock://a.jpg", ts: 300 }),
      item({ name: "b.jpg", uri: "mock://b.jpg", ts: 50 }),
    ];
    const { gallery, nativeCount, dropped } = mergeMediaGallery(local, native);
    expect(nativeCount).toBe(2);
    expect(dropped).toBe(0);
    expect(gallery.map((p) => p.ts)).toEqual([300, 100, 50]);
  });

  it("de-dupes native items sharing a uri", () => {
    const dup = item({ name: "a.jpg", uri: "mock://a.jpg", ts: 300 });
    const { gallery, nativeCount, dropped } = mergeMediaGallery([], [dup, dup]);
    expect(nativeCount).toBe(1);
    expect(dropped).toBe(1);
    expect(gallery.length).toBe(1);
  });

  it("real local captures out-rank natives on equal ts", () => {
    const localReal = localPhoto("real", 100, "data:image/jpeg;base64,x");
    const native = [item({ name: "a.jpg", uri: "mock://a.jpg", ts: 100 })];
    const { gallery } = mergeMediaGallery([localReal], native);
    // local real capture (rank 2) sorts before the native tile (rank 1)
    expect(gallery[0]?.id).toBe("real");
    expect(gallery[1]?.id).toBe("native:mock://a.jpg");
  });

  it("handles empty inputs", () => {
    expect(mergeMediaGallery([], [])).toEqual({ gallery: [], nativeCount: 0, dropped: 0 });
    const onlyLocal = mergeMediaGallery([localPhoto("l", 1)], []);
    expect(onlyLocal.nativeCount).toBe(0);
    expect(onlyLocal.gallery.length).toBe(1);
  });
});
