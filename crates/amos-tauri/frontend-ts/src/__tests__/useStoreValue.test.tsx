import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { writeStoreValue, STORE_CHANGED_EVENT } from "../lib/amosStore";
import { useStoreValue } from "../lib/useStoreValue";
import { SETTINGS_KEY } from "../lib/settings";

// Real DOM for this file (globals are per-process in bun).
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  // Never leak the fake Tauri bridge into other test files in this process.
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

interface Handlers {
  [ch: string]: (e: { payload: unknown }) => void;
}

/** Install a fake Tauri bridge that records `store-updated` handlers. */
function installBridge(): Handlers {
  const handlers: Handlers = {};
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    listen: async (ch: string, h: (e: { payload: unknown }) => void) => {
      handlers[ch] = h;
      return async () => {};
    },
  };
  return handlers;
}

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function Probe() {
    const v = useStoreValue<Record<string, unknown>>(SETTINGS_KEY, {});
    return <span>{JSON.stringify(v)}</span>;
  }
  root.render(<Probe />);
  mounted.push({ root, host });
  return host;
}

describe("useStoreValue (reactive store read)", () => {
  test("writeStoreValue dispatches STORE_CHANGED_EVENT carrying the key", () => {
    window.localStorage.clear();
    let got: unknown = null;
    const on = (e: Event) => {
      got = (e as CustomEvent<{ key: string }>).detail?.key;
    };
    window.addEventListener(STORE_CHANGED_EVENT, on);
    try {
      writeStoreValue(SETTINGS_KEY, { wifi: true });
      expect(got).toBe(SETTINGS_KEY);
    } finally {
      window.removeEventListener(STORE_CHANGED_EVENT, on);
    }
  });

  test("same-window STORE_CHANGED_EVENT triggers a re-read", async () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ wifi: true }));
    const host = mount();
    await act(async () => {});
    expect(host.textContent).toBe('{"wifi":true}');

    await act(async () => {
      writeStoreValue(SETTINGS_KEY, { wifi: false, location: true });
    });
    expect(host.textContent).toBe('{"wifi":false,"location":true}');
  });

  test("cross-window store-updated carries the authoritative payload (not stale localStorage)", async () => {
    // This window's localStorage holds an OLD value…
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ wifi: true }));
    const handlers = installBridge(); // bridged → hook subscribes to store-updated
    const host = mount();
    await act(async () => {});
    expect(typeof handlers["store-updated"]).toBe("function");
    expect(host.textContent).toBe('{"wifi":true}');

    // …but the Rust store says DND is now on. Another window's write does NOT
    // touch this window's localStorage, so the event payload must win.
    await act(async () => {
      handlers["store-updated"]?.({ payload: { key: SETTINGS_KEY, value: '{"dnd":true}' } });
    });
    expect(host.textContent).toBe('{"dnd":true}');
    // The authoritative value is also mirrored into localStorage.
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe('{"dnd":true}');
  });

  test("store-updated removal resets to the fallback and clears localStorage", async () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ wifi: true }));
    const handlers = installBridge();
    const host = mount();
    await act(async () => {});
    expect(host.textContent).toBe('{"wifi":true}');

    await act(async () => {
      handlers["store-updated"]?.({ payload: { key: SETTINGS_KEY, value: null } });
    });
    expect(host.textContent).toBe("{}"); // fallback {}
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });
});
