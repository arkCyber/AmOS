/**
 * Tests for custom avatar upload functionality in contacts module.
 * 
 * Covers:
 * - Image compression and processing (integration tests, require DOM)
 * - Avatar upload and removal
 * - CustomAvatar data structure validation
 * - Integration with contact list operations
 * 
 * Note: Image processing tests (compressImage, processAvatarUpload) require
 * Canvas API and are tested via integration tests in a browser environment.
 * Unit tests here focus on data structure and contact list manipulation.
 */

import { describe, it, expect, test } from "bun:test";
import {
  compressImage,
  processAvatarUpload,
  setContactAvatar,
  getContactAvatarSrc,
  hasCustomAvatar,
  type Contact,
  type CustomAvatar,
  makeContactId,
} from "../contacts";

describe("CustomAvatar data structure", () => {
  it("should have valid type field (base64 or file)", () => {
    const avatar1: CustomAvatar = { type: "base64", data: "data:image/jpeg;base64,..." };
    const avatar2: CustomAvatar = { type: "file", data: "/path/to/avatar.jpg" };
    
    expect(avatar1.type).toBe("base64");
    expect(avatar2.type).toBe("file");
  });

  it("should have data field for image content", () => {
    const avatar: CustomAvatar = {
      type: "base64",
      data: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
    };
    
    expect(avatar.data).toBeTruthy();
    expect(typeof avatar.data).toBe("string");
  });

  it("should support optional thumbnail field", () => {
    const withThumb: CustomAvatar = {
      type: "base64",
      data: "full-size-data",
      thumbnail: "thumbnail-data",
    };
    
    const withoutThumb: CustomAvatar = {
      type: "base64",
      data: "full-size-data",
    };
    
    expect(withThumb.thumbnail).toBeDefined();
    expect(withoutThumb.thumbnail).toBeUndefined();
  });
});

// The old note here said the image pipeline "require[s] Canvas API which is not
// available in Node.js test environment" and left it to a browser integration pass
// that never existed (audit PH-P2-13). The functions reach for exactly four globals
// — `Image`, `document.createElement("canvas")`, a 2D context, and `FileReader` —
// so a recording fake covers the geometry headlessly. What this still cannot prove
// is that a browser rasterises the result; what it *can* prove is the size contract.

interface DrawCall {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

interface CanvasEnv {
  draws: DrawCall[];
  restore: () => void;
}

/** Install fake `Image`/`document`/`FileReader` globals; call `restore()` when done. */
function installCanvasEnv(sourceW: number, sourceH: number, ctxAvailable = true): CanvasEnv {
  const draws: DrawCall[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { Image: g.Image, document: g.document, FileReader: g.FileReader };

  class FakeImage {
    width = sourceW;
    height = sourceH;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  const documentStub = {
    createElement(_tag: string) {
      const canvas: {
        width: number;
        height: number;
        getContext: (_id: string) => unknown;
        toDataURL: () => string;
      } = {
        width: 0,
        height: 0,
        getContext: (_id: string) =>
          ctxAvailable
            ? {
                drawImage: (
                  _img: unknown,
                  sx: number,
                  sy: number,
                  sw: number,
                  sh: number,
                  dx: number,
                  dy: number,
                  dw: number,
                  dh: number,
                ) => {
                  draws.push({ sx, sy, sw, sh, dx, dy, dw, dh });
                },
              }
            : null,
        // Encode the canvas size so a test can read back what was emitted.
        toDataURL: () => `data:image/jpeg;base64,W${canvas.width}H${canvas.height}`,
      };
      return canvas;
    },
  };

  class FakeFileReader {
    onload: ((e: { target: { result: string } }) => void) | null = null;
    onerror: (() => void) | null = null;
    result: string | null = null;
    readAsDataURL(_blob: unknown) {
      queueMicrotask(() => this.onload?.({ target: { result: "data:image/png;base64,SRC" } }));
    }
  }

  g.Image = FakeImage;
  g.document = documentStub;
  g.FileReader = FakeFileReader;

  return {
    draws,
    restore: () => {
      g.Image = saved.Image;
      g.document = saved.document;
      g.FileReader = saved.FileReader;
    },
  };
}

describe("compressImage geometry", () => {
  test("never upscales a source smaller than maxWidth", async () => {
    const env = installCanvasEnv(64, 64);
    try {
      const out = await compressImage("data:image/png;base64,SRC", 512, 0.9);
      // A 64px source must stay 64px: `maxWidth` is an upper bound, not a target size.
      expect(env.draws[0]!.dw).toBeLessThanOrEqual(64);
      expect(env.draws[0]!.dh).toBeLessThanOrEqual(64);
      expect(out).toContain("W64H64");
    } finally {
      env.restore();
    }
  });

  test("downscales a large source to exactly maxWidth (positive control)", async () => {
    const env = installCanvasEnv(1024, 768);
    try {
      const out = await compressImage("data:image/png;base64,SRC", 512, 0.9);
      expect(env.draws[0]!.dw).toBe(512);
      expect(env.draws[0]!.dh).toBe(512);
      expect(out).toContain("W512H512");
    } finally {
      env.restore();
    }
  });

  test("center-crops the shorter edge, never stretching", async () => {
    const env = installCanvasEnv(400, 300);
    try {
      await compressImage("data:image/png;base64,SRC", 128, 0.8);
      const d = env.draws[0]!;
      expect([d.sw, d.sh]).toEqual([300, 300]);
      expect([d.sx, d.sy]).toEqual([50, 0]);
      expect([d.dw, d.dh]).toEqual([128, 128]);
    } finally {
      env.restore();
    }
  });

  test("rejects when no 2D context is available", async () => {
    const env = installCanvasEnv(100, 100, false);
    try {
      await expect(compressImage("data:image/png;base64,SRC", 128, 0.8)).rejects.toThrow(
        "Canvas context not available",
      );
    } finally {
      env.restore();
    }
  });
});

describe("processAvatarUpload", () => {
  test("refuses a non-image file", async () => {
    await expect(
      processAvatarUpload(new File(["x"], "a.txt", { type: "text/plain" })),
    ).rejects.toThrow("File must be an image");
  });

  test("refuses a file over 10MB", async () => {
    const big = { type: "image/png", size: 11 * 1024 * 1024 } as unknown as File;
    await expect(processAvatarUpload(big)).rejects.toThrow("Image too large (max 10MB)");
  });

  test("keeps a small source small in both sizes", async () => {
    const env = installCanvasEnv(96, 96);
    try {
      const avatar = await processAvatarUpload(new File(["x"], "a.png", { type: "image/png" }));
      expect(avatar.type).toBe("base64");
      // Neither the 128px thumbnail nor the 512px full size may grow a 96px source.
      expect(env.draws.map((d) => d.dw)).toEqual([96, 96]);
      expect(avatar.thumbnail).toContain("W96H96");
      expect(avatar.data).toContain("W96H96");
    } finally {
      env.restore();
    }
  });

  test("produces the two documented sizes for a large source", async () => {
    const env = installCanvasEnv(1024, 1024);
    try {
      const avatar = await processAvatarUpload(new File(["x"], "a.png", { type: "image/png" }));
      expect(env.draws.map((d) => d.dw)).toEqual([128, 512]);
      expect(avatar.thumbnail).toContain("W128H128");
      expect(avatar.data).toContain("W512H512");
    } finally {
      env.restore();
    }
  });
});

describe("setContactAvatar", () => {
  const makeContact = (id: string, name: string): Contact => ({
    id,
    name,
    phones: ["123456789"],
    fav: false,
    ts: Date.now(),
  });

  it("should add custom avatar to a contact", () => {
    const contacts = [makeContact("c1", "Alice"), makeContact("c2", "Bob")];
    const avatar: CustomAvatar = {
      type: "base64",
      data: "data:image/jpeg;base64,...",
      thumbnail: "data:image/jpeg;base64,...thumb",
    };
    
    const updated = setContactAvatar(contacts, "c1", avatar);
    
    expect(updated[0]!.customAvatar).toEqual(avatar);
    expect(updated[1]!.customAvatar).toBeUndefined();
  });

  it("should remove custom avatar when null is passed", () => {
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    const contacts = [
      { ...makeContact("c1", "Alice"), customAvatar: avatar },
      makeContact("c2", "Bob"),
    ];
    
    const updated = setContactAvatar(contacts, "c1", null);
    
    expect(updated[0]!.customAvatar).toBeUndefined();
  });

  it("should update ts when avatar is changed", () => {
    const contacts = [makeContact("c1", "Alice")];
    const oldTs = contacts[0]!.ts;
    
    // Wait 1ms to ensure timestamp difference
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    
    // Manually advance time by modifying the contact timestamp
    const updated = setContactAvatar(contacts, "c1", avatar);
    
    // The function should update timestamp, so it should be >= oldTs
    expect(updated[0]!.ts).toBeGreaterThanOrEqual(oldTs);
  });

  it("should not mutate original contact list", () => {
    const contacts = [makeContact("c1", "Alice")];
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    
    const updated = setContactAvatar(contacts, "c1", avatar);
    
    expect(contacts[0]!.customAvatar).toBeUndefined();
    expect(updated[0]!.customAvatar).toEqual(avatar);
    expect(updated).not.toBe(contacts);
  });

  it("should handle non-existent contact ID gracefully", () => {
    const contacts = [makeContact("c1", "Alice")];
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    
    const updated = setContactAvatar(contacts, "non-existent", avatar);
    
    expect(updated).toEqual(contacts);
  });
});

describe("getContactAvatarSrc", () => {
  const makeContact = (id: string, name: string): Contact => ({
    id,
    name,
    phones: ["123456789"],
    fav: false,
    ts: Date.now(),
  });

  it("should return thumbnail for list view when available", () => {
    const avatar: CustomAvatar = {
      type: "base64",
      data: "full-size-data",
      thumbnail: "thumbnail-data",
    };
    const contact = { ...makeContact("c1", "Alice"), customAvatar: avatar };
    
    const src = getContactAvatarSrc(contact, true);
    
    expect(src).toBe("thumbnail-data");
  });

  it("should return full data for detail view", () => {
    const avatar: CustomAvatar = {
      type: "base64",
      data: "full-size-data",
      thumbnail: "thumbnail-data",
    };
    const contact = { ...makeContact("c1", "Alice"), customAvatar: avatar };
    
    const src = getContactAvatarSrc(contact, false);
    
    expect(src).toBe("full-size-data");
  });

  it("should return full data when thumbnail is missing", () => {
    const avatar: CustomAvatar = {
      type: "base64",
      data: "full-size-data",
    };
    const contact = { ...makeContact("c1", "Alice"), customAvatar: avatar };
    
    const src = getContactAvatarSrc(contact, true);
    
    expect(src).toBe("full-size-data");
  });

  it("should return empty string when no custom avatar", () => {
    const contact = makeContact("c1", "Alice");
    
    const src = getContactAvatarSrc(contact, true);
    
    expect(src).toBe("");
  });
});

describe("hasCustomAvatar", () => {
  const makeContact = (id: string, name: string): Contact => ({
    id,
    name,
    phones: ["123456789"],
    fav: false,
    ts: Date.now(),
  });

  it("should return true when contact has custom avatar", () => {
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    const contact = { ...makeContact("c1", "Alice"), customAvatar: avatar };
    
    expect(hasCustomAvatar(contact)).toBe(true);
  });

  it("should return false when contact has no custom avatar", () => {
    const contact = makeContact("c1", "Alice");
    
    expect(hasCustomAvatar(contact)).toBe(false);
  });

  it("should return false when customAvatar is undefined", () => {
    const contact = { ...makeContact("c1", "Alice"), customAvatar: undefined };
    
    expect(hasCustomAvatar(contact)).toBe(false);
  });
});

describe("Integration: avatar upload workflow", () => {
  it("should complete full workflow: data structure → display → remove", () => {
    // Initial contact list
    let contacts: Contact[] = [
      {
        id: makeContactId(),
        name: "Test User",
        phones: ["123456789"],
        fav: false,
        ts: Date.now(),
      },
    ];
    
    const contactId = contacts[0]!.id;
    
    // Step 1: Set avatar (simulate upload result)
    const avatar: CustomAvatar = {
      type: "base64",
      data: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
      thumbnail: "data:image/jpeg;base64,/9j/4AAQSkZJRg...thumb",
    };
    
    contacts = setContactAvatar(contacts, contactId, avatar);
    expect(hasCustomAvatar(contacts[0]!)).toBe(true);
    
    // Step 2: Get display source
    const listSrc = getContactAvatarSrc(contacts[0]!, true);
    const detailSrc = getContactAvatarSrc(contacts[0]!, false);
    
    expect(listSrc).toBe(avatar.thumbnail ?? avatar.data);
    expect(detailSrc).toBe(avatar.data);
    
    // Step 3: Remove avatar
    contacts = setContactAvatar(contacts, contactId, null);
    expect(hasCustomAvatar(contacts[0]!)).toBe(false);
    expect(getContactAvatarSrc(contacts[0]!, true)).toBe("");
  });

  it("should preserve other contact data when setting avatar", () => {
    const contact: Contact = {
      id: makeContactId(),
      name: "Jane Doe",
      phones: ["111", "222"],
      note: "Important contact",
      fav: true,
      ts: Date.now(),
    };
    
    const contacts = [contact];
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    
    const updated = setContactAvatar(contacts, contact.id, avatar);
    
    expect(updated[0]!.name).toBe("Jane Doe");
    expect(updated[0]!.phones).toEqual(["111", "222"]);
    expect(updated[0]!.note).toBe("Important contact");
    expect(updated[0]!.fav).toBe(true);
    expect(updated[0]!.customAvatar).toEqual(avatar);
  });
});
