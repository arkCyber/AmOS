import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  readStoreValue,
  getLayout,
  saveLayout,
  defaultLayout,
  hideFromHome,
  restoreToHome,
  moveBefore,
  pushRecent,
  getRecents,
  LAYOUT_KEY,
  RECENTS_KEY,
  DEFAULT_DOCK,
} from "../lib/amosStore";

// Bring up a real DOM for this file (globals are per-process in bun).
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const KEY = "amos.test.corrupt-guard";
const BACKUP = `${KEY}.corrupt`;
const realWarn = console.warn;
let warns: string[] = [];

function installWarnSpy() {
  warns = [];
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
}
function restoreWarn() {
  console.warn = realWarn;
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
  ];

  test("defaultLayout docks the dock-first apps and pages the rest", () => {
    const l = defaultLayout(available);
    expect(l.dock).toEqual(DEFAULT_DOCK); // all default-dock apps are available
    expect(l.page).toEqual(["camera", "settings", "clock", "maps"]);
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
