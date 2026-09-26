import { describe, expect, it } from "bun:test";
import type { MediaItem } from "../lib/media";
import { isNativePhoto, nativePhotoFromItem, photoGlyph } from "../lib/photoLibrary";

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

  it("keeps the source item whole — the host keys on it", () => {
    const it = item({
      name: "IMG.jpg",
      uri: "content://media/external/images/1",
      ts: 50,
      mime: "image/jpeg",
      id: "content://media/external/images/1",
    });
    const p = nativePhotoFromItem(it);
    // `media_stream_url` / `media_load` both take a MediaItem, so flattening it away left the
    // tile with no way to reach its own bytes (REQ-A1147). Identity + MIME survive.
    expect(p.media).toBe(it);
    expect(p.media.id).toBe("content://media/external/images/1");
    expect(p.media.mime).toBe("image/jpeg");
  });
});

describe("isNativePhoto", () => {
  it("tells a device item from a local capture (and from nothing)", () => {
    const native = nativePhotoFromItem(item({ name: "a.jpg", uri: "mock://a", ts: 1 }));
    expect(isNativePhoto(native)).toBe(true);
    // A local capture has no `uri`, so the viewer's chrome cannot mistake it for a device item.
    expect(isNativePhoto({ id: "p1", ts: 1, data: "data:image/png;base64,AAAA" })).toBe(false);
    expect(isNativePhoto({ id: "s1", ts: 1, a: "#000", b: "#fff", emoji: "🌅" })).toBe(false);
    expect(isNativePhoto(null)).toBe(false);
    expect(isNativePhoto(undefined)).toBe(false);
  });
});
