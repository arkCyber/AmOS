/**
 * Vitest setup for the Svelte suite: happy-dom's localStorage is not reliably
 * functional under vitest (direct setItem/getItem round-trips fail), so we
 * install an in-memory Storage shim and reset it before every test.
 *
 * The real app runs in a browser/Tauri WebView where localStorage works; this
 * only normalises the test environment so store/weather persistence behaves.
 */
import { beforeEach } from "vitest";

const map = new Map<string, string>();
const storage: Storage = {
  get length() {
    return map.size;
  },
  key: (i) => [...map.keys()][i] ?? null,
  getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
  setItem: (k, v) => {
    map.set(String(k), String(v));
  },
  removeItem: (k) => {
    map.delete(String(k));
  },
  clear: () => {
    map.clear();
  },
};

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}
try {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
} catch {
  /* already non-configurable on some environments */
}

beforeEach(() => {
  storage.clear();
});
