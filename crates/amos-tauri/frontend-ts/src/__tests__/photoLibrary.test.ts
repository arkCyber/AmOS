import { describe, expect, it } from "bun:test";
import type { MediaItem } from "../lib/media";
import { nativePhotoFromItem, photoGlyph } from "../lib/photoLibrary";

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
