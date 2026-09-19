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
  dockReorderIds,
  reorderVisibleDock,
  type HomeLayout,
  addAppsToDock,
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

/**
 * REQ-A406 — `addAppsToDock`（自定义分组"发送到主屏"）与此前三处**从未进入**的
 * "存储不可用" 分支。判定标准同样是从外部可观察的结果：布局内容 + 是否留下半条数据。
 */
describe("addAppsToDock (REQ-A406)", () => {
  const layout = (page: string[], dock: string[], hidden: string[] = []) => ({ page, dock, hidden });

  test("把应用从页面移进 dock（顺序：先来的先入，留在原 dock 项之后）", () => {
    expect(addAppsToDock(layout(["a", "b", "c"], ["d"]), ["a", "b"])).toEqual(
      layout(["c"], ["d", "a", "b"]),
    );
  });

  test("隐藏中的应用重新出现（hidden 与 page 一样是「不显示」的状态）", () => {
    expect(addAppsToDock(layout([], [], ["x"]), ["x"])).toEqual(layout([], ["x"], []));
  });

  test("已在 dock 里的不动、也不会重复；但必须从 hidden 里摘掉", () => {
    expect(addAppsToDock(layout(["a"], ["d"], ["d"]), ["d"])).toEqual(layout(["a"], ["d"], []));
  });

  test("空 id 被忽略（不会往 dock 里塞一个空字符串）", () => {
    expect(addAppsToDock(layout([], ["d"]), ["", "a"])).toEqual(layout([], ["d", "a"]));
  });

  test("同一个 id 在入参里出现两次只入一次", () => {
    expect(addAppsToDock(layout(["a"], []), ["a", "a"])).toEqual(layout([], ["a"]));
  });

  test("认不出的 id 会**原样进 dock** —— 这个函数没有 available 列表，过滤是调用方的事", () => {
    // 源码注释此前写着 "unknown ids are ignored"，而实现（也没有 available 参数）做不到。
    // 事实是：调用方 `Shell.svelte` 给的 id 必须已经是可用的（App Library 打开分组时会把
    // 已卸载的成员滤掉并回写）—— 这里把契约钉成"原样入 dock"，免得注释继续骗人。
    expect(addAppsToDock(layout([], ["d"]), ["store:gone.away"])).toEqual(
      layout([], ["d", "store:gone.away"]),
    );
  });

  test("不改入参（返回新对象，三个数组都是副本）", () => {
    const before = layout(["a"], ["d"], ["h"]);
    const after = addAppsToDock(before, ["a"]);
    expect(before).toEqual(layout(["a"], ["d"], ["h"]));
    expect(after).not.toBe(before);
    expect(after.dock).not.toBe(before.dock);
  });
});

describe("存储不可用时既不崩、也不假装写成功 (REQ-A406)", () => {
  /** 换一个"读就抛"的 localStorage（描述符可配置 ⇒ 能还原）。 */
  function withDeadStorage<T>(fn: () => T): T {
    const desc = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    const dead = {
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {
        throw new Error("storage unavailable");
      },
      removeItem() {
        throw new Error("storage unavailable");
      },
      key() {
        throw new Error("storage unavailable");
      },
      get length(): number {
        throw new Error("storage unavailable");
      },
    };
    try {
      Object.defineProperty(window, "localStorage", { value: dead, configurable: true, writable: true });
      return fn();
    } finally {
      Object.defineProperty(window, "localStorage", desc);
    }
  }

  test("listQuarantined 回空表（不编造条目）；readQuarantine 回 null", () => {
    expect(withDeadStorage(() => listQuarantined())).toEqual([]);
    expect(withDeadStorage(() => readQuarantine(KEY))).toBeNull();
    expect(withDeadStorage(() => readStoreValue<number[]>(KEY, [7]))).toEqual([7]);
  });

  test("坏档**备份**不进去时，错误里说清「备份也失败了」（用户数据仍然丢，但不静默）", () => {
    installWarnSpy();
    const real = window.localStorage;
    const noWrite = {
      getItem: (k: string) => real.getItem(k),
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem: (k: string) => real.removeItem(k),
      key: (i: number) => real.key(i),
      get length() {
        return real.length;
      },
    };
    const desc = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    try {
      real.setItem(KEY, "{ corrupt but i can still read it");
      Object.defineProperty(window, "localStorage", { value: noWrite, configurable: true, writable: true });
      expect(readStoreValue<number[]>(KEY, [])).toEqual([]); // 回落到默认值
      expect(warns.some((w) => w.includes("could not be backed up"))).toBe(true);
    } finally {
      Object.defineProperty(window, "localStorage", desc);
      real.removeItem(KEY);
    }
  });
});


/**
 * REQ-A456 — the dock's own reorder. `moveBefore` (above) is the **cross-list** move the
 * home screen uses; a dock drag is a different rule (the icon lands in the hovered icon's
 * slot, direction-aware), and the layout write-back has to leave the entries the desktop
 * does not draw exactly where they were.
 */
describe("dock reorder (REQ-A456)", () => {
  test("a drag lands IN the hovered slot, from either side", () => {
    const dock = ["a", "b", "c", "d"];
    // Moving right: `b` dropped on `d` takes `d`'s slot (d closes up to the left).
    expect(dockReorderIds(dock, "b", "d")).toEqual(["a", "c", "d", "b"]);
    // Moving left: `d` dropped on `b` takes `b`'s slot (b shifts right).
    expect(dockReorderIds(dock, "d", "b")).toEqual(["a", "d", "b", "c"]);
    // One step each way — the case a "always insert before" rule gets wrong on the way right.
    expect(dockReorderIds(dock, "c", "b")).toEqual(["a", "c", "b", "d"]);
    expect(dockReorderIds(dock, "b", "c")).toEqual(["a", "c", "b", "d"]);
  });

  test("no-ops keep the same array (identical drag, unknown ids)", () => {
    const dock = ["a", "b", "c"];
    expect(dockReorderIds(dock, "b", "b")).toBe(dock);
    expect(dockReorderIds(dock, "ghost", "b")).toBe(dock);
    expect(dockReorderIds(dock, "b", "ghost")).toBe(dock);
  });

  test("the reorder permutes ONLY what the surface shows", () => {
    // The default dock is exactly this shape: `phone` is in `layout.dock` and the desktop
    // never draws it (`withoutPhone`), so a naive write-back would delete it on the first
    // drag — and `phone` is the phone form's dock entry.
    const base: HomeLayout = { page: ["notes"], dock: ["phone", "ai", "interpreter", "files"], hidden: [] };
    const visible = ["ai", "interpreter", "files"];
    const next = reorderVisibleDock(base, visible, "files", "ai");
    expect(next.dock).toEqual(["phone", "files", "ai", "interpreter"]);
    // `phone` kept its slot (index 0) and the page/hidden lists are untouched.
    expect(next.page).toEqual(base.page);
    expect(next.hidden).toEqual(base.hidden);
  });

  test("a no-op reorder returns the very same layout object", () => {
    const base: HomeLayout = { page: [], dock: ["ai", "files"], hidden: [] };
    expect(reorderVisibleDock(base, ["ai", "files"], "ai", "ai")).toBe(base);
    expect(reorderVisibleDock(base, ["ai", "files"], "ghost", "ai")).toBe(base);
    // A "visible" list that names nothing in the dock is not a reorder either.
    expect(reorderVisibleDock(base, ["nope"], "ai", "files")).toBe(base);
  });
});

