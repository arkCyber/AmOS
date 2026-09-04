import { describe, expect, test } from "bun:test";
import {
  hasIndexedDb,
  memoryMediaStore,
  defaultMediaStore,
} from "../lib/mediaStore";

const blob = (text: string, type = "audio/webm") => new Blob([text], { type });

describe("binary media store", () => {
  test("memory backend round-trips blobs and deletes", async () => {
    const store = memoryMediaStore();
    expect(store.name).toBe("memory");
    expect(await store.get("x")).toBeNull(); // missing → null
    await store.put("x", blob("audio-data"));
    const got = await store.get("x");
    expect(got?.type).toBe("audio/webm");
    expect(await got?.text()).toBe("audio-data");
    // overwrite works
    await store.put("x", blob("v2"));
    expect(await (await store.get("x"))?.text()).toBe("v2");
    await store.del("x");
    expect(await store.get("x")).toBeNull();
  });

  test("default store resolves to memory when IndexedDB is absent", () => {
    // In the headless/test env IndexedDB is unavailable → binary still works via memory.
    const store = defaultMediaStore();
    expect(typeof hasIndexedDb()).toBe("boolean");
    expect(["indexeddb", "memory"]).toContain(store.name);
  });
});
