import { describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { indexedDbMediaStore } from "../lib/mediaStore";

const g = globalThis as { indexedDB?: unknown };

describe("IndexedDB media backend (fake-indexeddb)", () => {
  test("round-trips binary data and deletes through a real store", async () => {
    const prev = g.indexedDB;
    g.indexedDB = fakeIndexedDB;
    try {
      const db = `db-idb-media-${Date.now()}`;
      const store = indexedDbMediaStore(db, "voice");
      expect(store.name).toBe("indexeddb");

      const bytes = new Uint8Array([0, 1, 2, 3, 250, 255]);
      // The wrapper stores whatever binary value the app persists (Blob in the
      // shell; here fake-indexeddb handles an ArrayBuffer cleanly).
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await store.put("m1", buf as unknown as Blob);
      const got = await store.get("m1");
      expect(got).not.toBeNull();
      expect(Array.from(new Uint8Array(got as unknown as ArrayBuffer))).toEqual(Array.from(bytes));

      // Missing key → null.
      expect(await store.get("nope")).toBeNull();

      // Overwrite then delete.
      const b2 = new Uint8Array([9, 9]).buffer as ArrayBuffer;
      await store.put("m1", b2 as unknown as Blob);
      expect(new Uint8Array((await store.get("m1")) as unknown as ArrayBuffer).length).toBe(2);
      await store.del("m1");
      expect(await store.get("m1")).toBeNull();
    } finally {
      g.indexedDB = prev;
    }
  });
});
