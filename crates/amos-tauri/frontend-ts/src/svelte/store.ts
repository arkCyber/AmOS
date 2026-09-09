/**
 * Reactive, persisted store value for Svelte 5 apps, usable from plain `.ts`.
 *
 * Svelte 5's runes can't create dynamic `$state` from a function, so for
 * ARBITRARY persisted keys the idiomatic primitive is a `svelte/store`
 * `writable` (dynamic, works in plain `.ts`). Any Svelte store subscriber is
 * notified when the key changes from ANY of:
 *   - the same window (writers dispatch `STORE_CHANGED_EVENT`),
 *   - another tab/window sharing localStorage (`storage` event),
 *   - a Tauri cross-window update (`store-updated` backend event, when bridged).
 *
 * Usage (a component that wants it as runes state can bridge via $effect, or
 * read `$store` in legacy-mode components). `save(v)` persists + broadcasts.
 */
import { writable, type Readable } from "svelte/store";
import { readStoreValue, writeStoreValue, STORE_CHANGED_EVENT } from "../lib/amosStore";
import { bridged, subscribe } from "../lib/backend";

export interface StoreValue<T> extends Readable<T> {
  /** Persist `v` through the shared store (localStorage + bridge + broadcast). */
  save: (v: T) => void;
}

/**
 * Create a reactive view of one shared `amos.*` store key. Subscribing starts
 * the event wiring; when the last subscriber leaves, wiring is torn down (via
 * the `writable` start/stop contract) — nothing leaks across components/tests.
 */
export function createStoreValue<T>(key: string, fallback: T): StoreValue<T> {
  const store = writable<T>(readStoreValue<T>(key, fallback), (set) => {
    if (typeof window === "undefined") return; // SSR/tests w/o DOM: no events
    const reload = () => set(readStoreValue<T>(key, fallback));

    // Tauri cross-window update: payload is the authoritative { key, value }.
    const onStoreUpdated = (payload: unknown) => {
      const p = payload as { key?: unknown; value?: unknown } | null;
      if (!p || p.key !== key) return;
      if (p.value == null) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          /* ignore */
        }
        set(fallback);
        return;
      }
      let parsed: T;
      try {
        parsed = JSON.parse(String(p.value)) as T;
      } catch {
        parsed = fallback;
      }
      try {
        window.localStorage.setItem(key, String(p.value));
      } catch {
        /* ignore */
      }
      set(parsed);
    };

    window.addEventListener(STORE_CHANGED_EVENT, reload);
    window.addEventListener("storage", reload);
    let unsubBridge: (() => void) | null = null;
    if (bridged()) {
      void subscribe("store-updated", onStoreUpdated).then((u) => {
        unsubBridge = u;
      });
    }
    return () => {
      window.removeEventListener(STORE_CHANGED_EVENT, reload);
      window.removeEventListener("storage", reload);
      if (unsubBridge) unsubBridge();
    };
  });

  return {
    subscribe: store.subscribe,
    save: (v) => writeStoreValue(key, v),
  };
}
