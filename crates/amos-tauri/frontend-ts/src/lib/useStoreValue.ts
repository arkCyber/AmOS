import { useEffect, useRef, useState } from "react";
import { readStoreValue, STORE_CHANGED_EVENT } from "./amosStore";
import { bridged, subscribe } from "./backend";

/**
 * Reactive read of one `amos.*` store key.
 *
 * Re-renders when the value changes from any of:
 * - the same window (any writer dispatches `STORE_CHANGED_EVENT`),
 * - another tab/window sharing localStorage (`storage` event),
 * - a Tauri cross-window update (`store-updated` backend event, when bridged).
 *
 * SSR/tests without a `window` degrade to a static read (never crashes).
 *
 * The `fallback` is kept in a ref (not an effect dependency) so callers can pass
 * a fresh object literal each render without causing the subscription to be torn
 * down and rebuilt on every render (e.g. the StatusBar, which re-renders every
 * second for its clock).
 */
export function useStoreValue<T>(key: string, fallback: T): T {
  const [value, setValue] = useState<T>(() => readStoreValue<T>(key, fallback));
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | null = null;

    // Same-window / cross-tab changes arrive via localStorage → re-read it.
    const reload = () => {
      if (!alive) return;
      setValue(readStoreValue<T>(key, fallbackRef.current));
    };

    // Tauri cross-window updates arrive as `store-updated` events carrying the
    // Rust store's *authoritative* { key, value }. Another window's write does
    // NOT update this window's localStorage, so we must take the payload value
    // (and mirror it into localStorage so plain reads stay consistent) rather
    // than re-reading stale local state.
    const onStoreUpdated = (payload: unknown) => {
      if (!alive) return;
      const p = payload as { key?: unknown; value?: unknown } | null;
      if (!p || p.key !== key) return;
      if (p.value == null) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          /* ignore */
        }
        setValue(fallbackRef.current);
        return;
      }
      let parsed: T;
      try {
        parsed = JSON.parse(String(p.value)) as T;
      } catch {
        parsed = fallbackRef.current;
      }
      try {
        window.localStorage.setItem(key, String(p.value));
      } catch {
        /* ignore */
      }
      setValue(parsed);
    };

    window.addEventListener(STORE_CHANGED_EVENT, reload);
    window.addEventListener("storage", reload);
    if (bridged()) {
      void subscribe("store-updated", onStoreUpdated).then((u) => {
        if (!alive) u();
        else unsub = u;
      });
    }
    return () => {
      alive = false;
      window.removeEventListener(STORE_CHANGED_EVENT, reload);
      window.removeEventListener("storage", reload);
      if (unsub) unsub();
    };
  }, [key]);

  return value;
}

