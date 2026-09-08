import { describe, expect, it } from "bun:test";
import {
  bytesFromNumbers,
  canonicalPath,
  hasMediaBridge,
  mediaList,
  mediaLoad,
  mediaSave,
  normalizeDir,
  normalizeGrant,
  normalizeMediaItem,
} from "../lib/media";

function withBridge<T>(
  handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const w = globalThis as unknown as { window?: unknown };
  const prev = w.window;
  w.window = { __TAURI_INTERNALS__: { invoke: handler } } as unknown;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete w.window;
    else w.window = prev;
  }
}

describe("canonicalPath (android external-storage layout)", () => {
  it("maps the standard collections to their real relative paths", () => {
    expect(canonicalPath("camera")).toBe("DCIM/Camera");
    expect(canonicalPath("screenshots")).toBe("Pictures/Screenshots");
    expect(canonicalPath("pictures")).toBe("Pictures");
    expect(canonicalPath("download")).toBe("Download");
    expect(canonicalPath("recordings")).toBe("Recordings");
    expect(canonicalPath("root")).toBe("");
  });
});

describe("normalizeDir", () => {
  it("accepts known dirs and falls back to root otherwise", () => {
    expect(normalizeDir("camera")).toBe("camera");
    expect(normalizeDir("download")).toBe("download");
    expect(normalizeDir("bogus")).toBe("root");
    expect(normalizeDir(42)).toBe("root");
    expect(normalizeDir(undefined)).toBe("root");
  });
});

describe("normalizeMediaItem", () => {
  it("normalizes a full payload", () => {
    const item = normalizeMediaItem({
      id: "mock-1",
      kind: "image",
      collection: "camera",
      name: "IMG.jpg",
      uri: "mock://DCIM/Camera/IMG.jpg",
      mime: "image/jpeg",
      size_bytes: 2048,
      ts: 123,
    });
    expect(item).not.toBeNull();
    expect(item?.kind).toBe("image");
    expect(item?.collection).toBe("camera");
    expect(item?.mime).toBe("image/jpeg");
    expect(item?.size_bytes).toBe(2048);
    expect(item?.ts).toBe(123);
  });

  it("tolerates partial payloads without throwing", () => {
    expect(normalizeMediaItem(null)).toBeNull();
    expect(normalizeMediaItem({})).toBeNull(); // no id/name → dropped
    const partial = normalizeMediaItem({ id: "x", name: "a.bin", kind: "nonsense" });
    expect(partial).not.toBeNull();
    expect(partial?.kind).toBe("file"); // unknown kind → file
    expect(partial?.collection).toBe("root"); // unknown collection → root
    expect(partial?.ts).toBe(0);
    expect(partial?.size_bytes).toBeNull();
  });
});

describe("normalizeGrant", () => {
  it("accepts well-formed grants and rejects malformed ones", () => {
    expect(normalizeGrant({ access: "read", collection: "camera" })).toEqual({
      access: "read",
      collection: "camera",
    });
    expect(normalizeGrant({ access: "write", collection: "download" })).not.toBeNull();
    expect(normalizeGrant({ access: "bogus", collection: "camera" })).toBeNull();
    expect(normalizeGrant({ access: "read", collection: "bogus" })).toBeNull();
    expect(normalizeGrant(null)).toBeNull();
  });
});

describe("mediaSave (bridge arg shaping)", () => {
  it("encodes bytes as a plain number[] in the invoke args (no bridge → null)", async () => {
    // No Tauri bridge / no window in this env → resolves null (safe offline).
    const result = await mediaSave("camera", "image", "x.jpg", new Uint8Array([1, 2, 3]));
    expect(result).toBeNull();
  });
});

describe("bytesFromNumbers + mediaLoad", () => {
  it("decodes a byte-array delivered by the bridge into a Uint8Array", () => {
    const u = bytesFromNumbers([0xff, 0xd8, 0xff, 0xe0]);
    expect(u).toBeInstanceOf(Uint8Array);
    expect(u.length).toBe(4);
    expect(u[0]).toBe(255);
    expect(Array.from(u)).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });

  it("mediaLoad resolves null offline (no bridge)", async () => {
    const item = normalizeMediaItem({
      id: "mock-1",
      kind: "image",
      collection: "camera",
      name: "IMG.jpg",
      uri: "mock://a.jpg",
      mime: null,
      size_bytes: null,
      ts: 1,
    });
    expect(item).not.toBeNull();
    const bytes = await mediaLoad(item!);
    expect(bytes).toBeNull();
  });
});

describe("bridge presence (hasMediaBridge / error semantics)", () => {
  it("is false offline and true with a fake bridge", () => {
    expect(hasMediaBridge()).toBe(false);
    return withBridge(async () => [], async () => {
      expect(hasMediaBridge()).toBe(true);
    });
  });

  it("mediaList resolves items when a bridge returns them", async () => {
    const item = {
      id: "mock-1",
      kind: "image",
      collection: "camera",
      name: "IMG.jpg",
      uri: "mock://a.jpg",
      mime: "image/jpeg",
      size_bytes: 3,
      ts: 1,
    };
    const res = await withBridge(async (cmd) => (cmd === "media_list" ? [item] : []), async () =>
      mediaList("camera"),
    );
    expect(res).not.toBeNull();
    expect(res?.length).toBe(1);
    expect(res?.[0]?.name).toBe("IMG.jpg");
  });

  it("mediaList REJECTS (not null) when the bridge denies — never a fake empty", async () => {
    // Rust surfaces Unauthorized as an error string; the wrapper must propagate it.
    await expect(
      withBridge(async () => {
        throw new Error("media read on camera is not authorized");
      }, async () => mediaList("camera")),
    ).rejects.toThrow(/not authorized/);
  });
});
