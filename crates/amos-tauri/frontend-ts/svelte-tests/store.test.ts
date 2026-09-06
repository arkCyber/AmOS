/**
 * Unit tests for the Svelte reactive persisted store (src/svelte/store.ts) —
 * the Svelte counterpart of the React `useStoreValue` hook. Exercises the
 * same-window broadcast path: a `writeStoreValue` must notify subscribers.
 */
import { describe, expect, test } from "vitest";
import { createStoreValue } from "../src/svelte/store";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";

describe("createStoreValue (Svelte persisted store)", () => {
  test("seeds from the shared store and updates on same-window broadcast", () => {
    const key = "amos.test.svelte.store." + Math.random();
    writeStoreValue(key, ["a"]);
    // sanity: did the shared store persist in this happy-dom env?
    expect(readStoreValue<string[]>(key, [])).toEqual(["a"]);

    const sv = createStoreValue<string[]>(key, []);
    const seen: string[][] = [];
    const unsub = sv.subscribe((v) => seen.push(v));

    // Initial seed delivered on first subscribe.
    expect(seen[0]).toEqual(["a"]);
    expect(readStoreValue<string[]>(key, [])).toEqual(["a"]);

    // A write through the shared store dispatches STORE_CHANGED_EVENT → reload.
    writeStoreValue(key, ["a", "b"]);
    expect(seen.at(-1)).toEqual(["a", "b"]);

    // save() persists through the same channel → also reflected.
    sv.save(["a", "b", "c"]);
    expect(seen.at(-1)).toEqual(["a", "b", "c"]);

    unsub();
    window.localStorage.removeItem(key);
  });

  test("isolated keys don't cross-talk", () => {
    const ka = "amos.test.svelte.store.a." + Math.random();
    const kb = "amos.test.svelte.store.b." + Math.random();
    writeStoreValue(ka, 1);
    writeStoreValue(kb, 2);

    const sa = createStoreValue<number>(ka, 0);
    const sb = createStoreValue<number>(kb, 0);
    let va = -1;
    let vb = -1;
    const ua = sa.subscribe((v) => (va = v));
    const ub = sb.subscribe((v) => (vb = v));

    // Initial seeds should be delivered on first subscribe.
    expect(va).toBe(1);
    expect(vb).toBe(2);

    writeStoreValue(ka, 42);
    expect(va).toBe(42);
    expect(vb).toBe(2); // unaffected

    ua();
    ub();
    window.localStorage.removeItem(ka);
    window.localStorage.removeItem(kb);
  });

  test("updates on a cross-tab 'storage' event (another window wrote)", () => {
    const key = "amos.test.svelte.store.storage." + Math.random();
    writeStoreValue(key, ["a"]);
    const sv = createStoreValue<string[]>(key, []);
    const seen: string[][] = [];
    const unsub = sv.subscribe((v) => seen.push(v));
    expect(seen.at(-1)).toEqual(["a"]);

    // Simulate another tab/window writing the same key directly to storage.
    window.localStorage.setItem(key, JSON.stringify(["b", "c"]));
    window.dispatchEvent(new Event("storage"));

    expect(seen.at(-1)).toEqual(["b", "c"]);

    unsub();
    window.localStorage.removeItem(key);
  });

  test("stops notifying subscribers once unsubscribed (listener teardown)", () => {
    const key = "amos.test.svelte.store.teardown." + Math.random();
    writeStoreValue(key, [1]);
    const sv = createStoreValue<number[]>(key, []);
    let got: unknown = null;
    const unsub = sv.subscribe((v) => (got = v));
    expect(got).toEqual([1]);

    unsub();
    writeStoreValue(key, [2]); // no subscriber now → no callback
    expect(got).toEqual([1]); // unchanged

    window.localStorage.removeItem(key);
  });

  test("applies a Tauri 'store-updated' broadcast (authoritative cross-window value)", async () => {
    const key = "amos.test.svelte.store.tauri." + Math.random();
    writeStoreValue(key, ["a"]);

    // Fake a Tauri bridge so bridged() is true and subscribe() captures handlers.
    const fakeListeners = new Map<string, (e: { payload: unknown }) => void>();
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async () => null,
      listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
        fakeListeners.set(channel, handler);
        return () => fakeListeners.delete(channel);
      },
    };
    try {
      const sv = createStoreValue<string[]>(key, []);
      const seen: string[][] = [];
      const unsub = sv.subscribe((v) => seen.push(v));
      expect(seen.at(-1)).toEqual(["a"]);
      await new Promise((r) => setTimeout(r, 0)); // let subscribe() settle + register

      const handler = fakeListeners.get("store-updated");
      expect(handler).toBeTruthy();

      // Another Tauri window pushed an authoritative value → store + localStorage update.
      handler!({ payload: { key, value: JSON.stringify(["x", "y"]) } });
      expect(seen.at(-1)).toEqual(["x", "y"]);
      expect(window.localStorage.getItem(key)).toBe(JSON.stringify(["x", "y"]));

      // A null value removes the key and falls back.
      handler!({ payload: { key, value: null } });
      expect(seen.at(-1)).toEqual([]);
      expect(window.localStorage.getItem(key)).toBeNull();

      unsub();
      window.localStorage.removeItem(key);
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});
