import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  readStoreValue,
  writeStoreValue,
  writeStoreValueChecked,
  listQuarantined,
  readQuarantine,
  getLayout,
  saveLayout,
  defaultLayout,
  hideFromHome,
  restoreToHome,
  moveBefore,
  pushRecent,
  getRecents,
  hydrateFromSystemStore,
  STORE_CHANGED_EVENT,
  LAYOUT_KEY,
  RECENTS_KEY,
  DEFAULT_DOCK,
} from "../lib/amosStore";
import { writeStored } from "../lib/themeCore";

// Bring up a real DOM for this file (globals are per-process in bun).
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const KEY = "amos.test.corrupt-guard";
const BACKUP = `${KEY}.corrupt`;
const realWarn = console.warn;
const realError = console.error;
let warns: string[] = [];

function installWarnSpy() {
  warns = [];
  // The corruption is reported at **error** level (data loss), so the spy covers both
  // channels the ledger uses.
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => warns.push(a.map(String).join(" "));
}
function restoreWarn() {
  console.warn = realWarn;
  console.error = realError;
}
afterEach(() => {
  restoreWarn();
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(BACKUP);
  window.localStorage.removeItem(LAYOUT_KEY);
  window.localStorage.removeItem(RECENTS_KEY);
});

describe("amosStore corruption guard (P1-1)", () => {
  test("corrupt JSON falls back AND is quarantined, not silently dropped", () => {
    installWarnSpy();
    window.localStorage.setItem(KEY, "{ this is not valid json !!!");

    expect(readStoreValue<number[]>(KEY, [])).toEqual([]); // graceful fallback
    // The original bytes must be preserved under a quarantine slot.
    expect(window.localStorage.getItem(BACKUP)).toBe("{ this is not valid json !!!");
    expect(warns.some((w) => w.includes(KEY) && w.includes(".corrupt"))).toBe(true);
  });

  test("valid stored JSON is returned normally and not quarantined", () => {
    installWarnSpy();
    window.localStorage.setItem(KEY, JSON.stringify([1, 2, 3]));
    expect(readStoreValue<number[]>(KEY, [])).toEqual([1, 2, 3]);
    expect(window.localStorage.getItem(BACKUP)).toBeNull();
    expect(warns).toEqual([]);
  });

  test("absent key returns the fallback and writes nothing", () => {
    installWarnSpy();
    expect(readStoreValue<number[]>(KEY, [7])).toEqual([7]);
    expect(window.localStorage.getItem(BACKUP)).toBeNull();
    expect(warns).toEqual([]);
  });

  test("the quarantine is readable — the preserved bytes are not a dead end", () => {
    installWarnSpy();
    window.localStorage.setItem(KEY, "{ not json at all");
    expect(readStoreValue<number[]>(KEY, [])).toEqual([]); // falls back…
    // …and the read side can now find and hand back exactly those bytes.
    expect(listQuarantined()).toEqual([{ key: KEY, bytes: "{ not json at all".length }]);
    expect(readQuarantine(KEY)).toBe("{ not json at all");
    expect(readQuarantine("amos.test.nothing-quarantined")).toBeNull();
  });

  test("replacing an existing quarantine is reported as the further loss it is", () => {
    installWarnSpy();
    window.localStorage.setItem(KEY, "{ first");
    readStoreValue<number[]>(KEY, []);
    // A second corruption overwrites the bounded slot: the older bytes are dropped, and
    // that must not happen silently.
    window.localStorage.setItem(KEY, "{ second");
    readStoreValue<number[]>(KEY, []);
    expect(readQuarantine(KEY)).toBe("{ second");
    expect(warns.some((w) => w.includes("replaced an earlier quarantine"))).toBe(true);
    expect(warns.some((w) => w.includes("7 byte(s) dropped"))).toBe(true);
  });
});

describe("amos home layout & recents (pure logic)", () => {
  const available = [
    "phone",
    "messages",
    "camera",
    "settings",
    "ai",
    "interpreter",
    "mail",
    "clock",
    "maps",
    "monitor",
  ];

  test("defaultLayout docks the dock-first apps and pages the rest", () => {
    const l = defaultLayout(available);
    expect(l.dock).toEqual(DEFAULT_DOCK); // all default-dock apps are available
    expect(l.page).toEqual(["messages", "camera", "settings", "mail", "clock", "maps", "monitor"]);
    expect(l.hidden).toEqual([]);
  });

  test("getLayout prunes unknown ids and merges newly registered apps", () => {
    saveLayout({ page: ["clock", "ghost-app"], dock: ["phone", "maps"], hidden: ["settings"] });
    const got = getLayout(available);
    expect(got.dock).toEqual(["phone", "maps"]);
    expect(got.hidden).toEqual(["settings"]);
    expect(got.page).toContain("clock");
    expect(got.page).not.toContain("ghost-app"); // unknown app dropped
    // every available app is placed exactly once
    const placed = [...got.page, ...got.dock, ...got.hidden].sort();
    expect(placed).toEqual([...available].sort());
  });

  test("hideFromHome moves a dock icon back to the page and a page icon to hidden", () => {
    const base = { page: ["clock"], dock: ["phone", "maps"], hidden: [] };
    const fromDock = hideFromHome(base, "phone");
    expect(fromDock.dock).toEqual(["maps"]);
    expect(fromDock.page).toContain("phone"); // dock icons return to the page

    const fromPage = hideFromHome(fromDock, "clock");
    expect(fromPage.page).not.toContain("clock");
    expect(fromPage.hidden).toContain("clock");
  });

  test("restoreToHome brings a hidden app back to the page", () => {
    const base = { page: ["clock"], dock: ["phone"], hidden: ["maps"] };
    const restored = restoreToHome(base, "maps");
    expect(restored.hidden).toEqual([]);
    expect(restored.page).toContain("maps");
  });

  test("moveBefore reorders and is cross-list aware", () => {
    const base = { page: ["clock", "maps"], dock: ["phone"], hidden: [] };
    expect(moveBefore(base, "maps", "clock").page).toEqual(["maps", "clock"]);
    // moving a page app just before a dock app drops it into the dock head
    const toDock = moveBefore(base, "maps", "phone");
    expect(toDock.dock).toEqual(["maps", "phone"]);
    expect(toDock.page).toEqual(["clock"]);
  });

  test("recents dedupe and cap at 8", () => {
    pushRecent("a");
    pushRecent("b");
    pushRecent("a"); // revisit moves to front
    expect(getRecents()).toEqual(["a", "b"]);
    for (let i = 0; i < 12; i++) pushRecent(`x${i}`);
    const r = getRecents();
    expect(r.length).toBe(8);
    expect(r[0]).toBe("x11");
    expect(new Set(r).size).toBe(r.length); // no duplicates
  });
});

describe("hydrateFromSystemStore (boot hydration)", () => {
  const HKEY = "amos.test.hydrated";
  const setBridge = (invoke: (cmd: string) => Promise<unknown>) => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };
  };
  afterEach(() => {
    window.localStorage.removeItem(HKEY);
    window.localStorage.removeItem("amos.test.hydrated.other");
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("no-op without a Tauri bridge (never throws)", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    await hydrateFromSystemStore();
    expect(window.localStorage.getItem(HKEY)).toBeNull();
  });

  test("copies the Rust store snapshot into localStorage", async () => {
    setBridge(async (cmd) =>
      cmd === "store_snapshot"
        ? { [HKEY]: "\"persisted\"", "amos.test.hydrated.other": "1" }
        : null,
    );
    await hydrateFromSystemStore();
    // Values are the raw strings the Rust store persisted (localStorage holds
    // strings, so a JSON string is stored with its quotes intact).
    expect(window.localStorage.getItem(HKEY)).toBe("\"persisted\"");
    expect(window.localStorage.getItem("amos.test.hydrated.other")).toBe("1");
  });

  test("an absent/failed snapshot leaves localStorage untouched (no throw)", async () => {
    setBridge(async () => null);
    await hydrateFromSystemStore();
    expect(window.localStorage.getItem(HKEY)).toBeNull();
  });
});

describe("shared-store write-through (store_set)", () => {
  const WKEY = "amos.test.write-through";
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

  const setBridge = (invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };
  };
  afterEach(() => {
    calls.length = 0;
    window.localStorage.removeItem(WKEY);
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("writeStoreValue mirrors the JSON string to the Rust shared store", async () => {
    setBridge(async (cmd, args = {}) => {
      calls.push({ cmd, args });
      return null;
    });
    writeStoreValue(WKEY, { a: 1 });
    await settle();
    // The local write stands, and the Rust store gets the *same raw string* the
    // old `window.Amos.storeWrite` shim was supposed to send (nothing injected it,
    // so this mirror silently never happened).
    expect(window.localStorage.getItem(WKEY)).toBe(JSON.stringify({ a: 1 }));
    expect(calls).toContainEqual({
      cmd: "store_set",
      args: { key: WKEY, value: JSON.stringify({ a: 1 }) },
    });
  });

  test("offline the local write still lands and nothing throws", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    writeStoreValue(WKEY, { b: 2 });
    await settle();
    expect(window.localStorage.getItem(WKEY)).toBe(JSON.stringify({ b: 2 }));
    expect(calls.length).toBe(0);
  });

  test("writeStored (theme) mirrors the raw string, not a JSON encoding", async () => {
    setBridge(async (cmd, args = {}) => {
      calls.push({ cmd, args });
      return null;
    });
    writeStored("amos-ui.theme", "dark");
    await settle();
    expect(window.localStorage.getItem("amos-ui.theme")).toBe("dark");
    expect(calls).toContainEqual({
      cmd: "store_set",
      args: { key: "amos-ui.theme", value: "dark" },
    });
    window.localStorage.removeItem("amos-ui.theme");
  });
});

describe("a rejected store write is reported, never swallowed", () => {
  const WKEY = "amos.test.write-outcome";
  const QUOTA = 1_000_000;
  const real = window.localStorage;
  const changes: string[] = [];
  const onChange = (e: Event) => changes.push((e as CustomEvent<{ key: string }>).detail.key);

  /**
   * Swap in a storage whose writes of `failKey` throw the way a full quota does.
   * (Patching `Storage.prototype`/the instance does not intercept the *proxy*
   * `window.localStorage` hands out per access, so the property itself is replaced.)
   */
  const failWritesFor = (failKey: string) => {
    const fake = {
      get length() {
        return real.length;
      },
      clear: () => real.clear(),
      key: (i: number) => real.key(i),
      getItem: (k: string) => real.getItem(k),
      removeItem: (k: string) => real.removeItem(k),
      setItem: (k: string, v: string) => {
        if (k === failKey) throw new Error(`QuotaExceededError: ${QUOTA} bytes`);
        real.setItem(k, v);
      },
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  };
  const restoreStorage = () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });

  afterEach(() => {
    restoreStorage();
    window.removeEventListener(STORE_CHANGED_EVENT, onChange);
    changes.length = 0;
    real.removeItem(WKEY);
  });

  test("writeStoreValueChecked reports success and announces the change", () => {
    window.addEventListener(STORE_CHANGED_EVENT, onChange);
    expect(writeStoreValueChecked(WKEY, { ok: true })).toBe(true);
    expect(window.localStorage.getItem(WKEY)).toBe(JSON.stringify({ ok: true }));
    expect(changes).toEqual([WKEY]);
  });

  test("a rejected write reports false, stores nothing, announces nothing, and logs an error", () => {
    installWarnSpy();
    window.addEventListener(STORE_CHANGED_EVENT, onChange);
    failWritesFor(WKEY);
    expect(writeStoreValueChecked(WKEY, { nope: 1 })).toBe(false);
    // Nothing landed, so nothing may be claimed or broadcast — and a *user-visible*
    // loss is an error (audit P1-3), not a silently ignored exception.
    expect(real.getItem(WKEY)).toBeNull();
    expect(changes).toEqual([]);
    expect(warns.some((w) => w.includes(WKEY) && w.includes("write failed"))).toBe(true);
  });

  test("the fire-and-forget writeStoreValue still never throws when storage rejects", () => {
    installWarnSpy();
    failWritesFor(WKEY);
    expect(() => writeStoreValue(WKEY, 1)).not.toThrow();
    expect(real.getItem(WKEY)).toBeNull();
  });

  test("an unencodable value (circular) is a failed write, not an exception", () => {
    installWarnSpy();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(writeStoreValueChecked(WKEY, circular)).toBe(false);
    expect(() => writeStoreValue(WKEY, circular)).not.toThrow();
    expect(real.getItem(WKEY)).toBeNull();
  });

  test("a host without an event bus still completes the write (announcing is best-effort)", () => {
    // Regression: `dispatchEvent` used to sit inside the blanket try/catch, so a host
    // (or test stub) whose `window` has no event bus still persisted the value. Making
    // the write *report* its outcome must not turn that into a thrown error.
    const realDispatch = window.dispatchEvent;
    Object.defineProperty(window, "dispatchEvent", { value: undefined, configurable: true, writable: true });
    try {
      expect(() => writeStoreValue(WKEY, { quiet: 1 })).not.toThrow();
      expect(writeStoreValueChecked(WKEY, { quiet: 1 })).toBe(true);
      expect(real.getItem(WKEY)).toBe(JSON.stringify({ quiet: 1 }));
    } finally {
      Object.defineProperty(window, "dispatchEvent", { value: realDispatch, configurable: true, writable: true });
    }
  });
});
