/**
 * DOM tests for the Svelte 5 photos screen (PhotosApp.svelte).
 *
 * Pure photo logic is unit-tested once against lib/photos.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: the seeded grid,
 * opening the single-photo viewer, and multi-select batch delete.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PhotosApp from "../src/svelte/PhotosApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { setLocale } from "../src/svelte/locale.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { PHOTOS_KEY } from "../src/lib/photos";
import { CAPTURES_KEY } from "../src/lib/cameraCapture";
import { zh } from "../src/i18n/locales/zh";
import { photosChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { setFormFactor } from "../src/lib/formAuthority.svelte";

import { installFakeObserver } from "./lazy-observer";

afterEach(() => {
  cleanup();
  setLocale("zh");
  window.localStorage.clear();
  resetPropsChannels(); // a channel is process-wide: never leak a link between cases
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. (`window.localStorage` is a per-access proxy, so the prototype
 * cannot be patched — the window property itself is replaced.)
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}
const btnAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === aria) as
    HTMLButtonElement | undefined;
const firstTile = (h: { container: HTMLElement }) =>
  h.container.querySelector(".grid button") as HTMLButtonElement | null;
const btnText = (h: { container: HTMLElement }, text: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text) as
    HTMLButtonElement | undefined;

/**
 * A decoding `<img>` stand-in for the editor's save path.
 *
 * happy-dom implements no 2D context, so the *render* cannot succeed here — the point is to
 * let the flow reach `drawEdited` instead of stalling on a load that never fires, so the
 * refusal path (and only that path) is exercised. Declared at module scope: Svelte's
 * compiler rejects a class below top level.
 */
class StubImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 4;
  naturalHeight = 3;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}

describe("PhotosApp.svelte", () => {
  test("an intentionally emptied store is not re-seeded with demo photos", () => {
    window.localStorage.setItem("amos.photos", "[]");
    const host = render(PhotosApp);
    // No demo photo glyphs, and the store stays empty.
    expect(txt(host)).not.toContain("🏔️");
    expect(readStoreValue<unknown>("amos.photos", null)).toEqual([]);
  });

  test("seeded gallery is non-empty", () => {
    const host = render(PhotosApp);
    expect(txt(host)).not.toContain("暂无照片");
    expect(firstTile(host)).toBeTruthy();
  });

  test("Videos smart-filter shows only camera videos; All restores stills", async () => {
    // Seed one camera video capture → the 🎬 chip appears.
    writeStoreValue(CAPTURES_KEY, [
      { id: "v1", ts: Date.now() - 1000, mime: "video/webm", durationMs: 3000, w: 1280, h: 720 },
    ]);
    const host = render(PhotosApp);
    await tick();
    const vidChip = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("🎬 (1)"),
    );
    expect(vidChip).toBeTruthy();
    const photoCount = () =>
      host.container.querySelectorAll('button[class*="aspect-square"]').length;
    expect(photoCount()).toBeGreaterThan(0); // stills present in All view
    // switch to Videos → only the video tile remains, stills hidden
    await fireEvent.click(vidChip as HTMLButtonElement);
    await tick();
    expect(host.container.querySelector(`button[aria-label="${zh["a11y.video"]}"]`)).toBeTruthy();
    expect(photoCount()).toBe(0);
    // back to All → stills return
    const allChip = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("全部"),
    );
    await fireEvent.click(allChip as HTMLButtonElement);
    await tick();
    expect(photoCount()).toBeGreaterThan(0);
  });

  test("grid is grouped into iOS-style day sections; headers relabel on locale switch", async () => {
    const host = render(PhotosApp);
    // the newest seeded photo is "today" → a Today section header exists
    const headings = [...host.container.querySelectorAll('p[role="heading"]')].map(
      (h) => h.textContent ?? "",
    );
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.some((h) => h.includes("今天"))).toBe(true);
    // still renders photo tiles under the sections
    expect(firstTile(host)).toBeTruthy();

    // reactive i18n: switch to en → the same header reads "Today" without remount
    setLocale("en");
    await tick();
    const enHeadings = [...host.container.querySelectorAll('p[role="heading"]')].map(
      (h) => h.textContent ?? "",
    );
    expect(enHeadings.some((h) => h.includes("Today"))).toBe(true);
  });

  // REQ-A1852: a stored photo whose `ts` the host could not report carries the documented
  // 0 sentinel. Before the fix it was bucketed under `dayKey(0)` and both the section header
  // and the viewer's timestamp line printed 1970 — a date no photo was taken on.
  test("an un-dated photo is not drawn as 1970; it reads as unknown", async () => {
    writeStoreValue(PHOTOS_KEY, [
      { id: "t", ts: Date.now(), emoji: "🏔️" },
      { id: "z", ts: 0, emoji: "🌅" },
    ]);
    const host = render(PhotosApp);
    await tick();
    // its own trailing section, with the honest wording — never a fabricated day
    const headings = [...host.container.querySelectorAll('p[role="heading"]')].map(
      (h) => h.textContent ?? "",
    );
    expect(headings.some((h) => h.includes(zh["photo.unknownDate"]))).toBe(true);
    expect(txt(host)).not.toContain("1970");
    // the viewer's own timestamp line withholds it too (the same `tsText`)
    const tiles = [...host.container.querySelectorAll(".grid button")] as HTMLButtonElement[];
    await fireEvent.click(tiles[tiles.length - 1]!);
    await tick();
    expect(txt(host)).toContain(zh["photo.unknownDate"]);
    expect(txt(host)).not.toContain("1970");
  });

  test("opening a photo shows the viewer; deleting returns to the gallery", async () => {
    const host = render(PhotosApp);
    await fireEvent.click(firstTile(host)!);
    expect(btnAria(host, "上一张")).toBeTruthy(); // viewer open
    const del = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "删除",
    );
    expect(del).toBeTruthy();
    await fireEvent.click(del as HTMLButtonElement);
    expect(btnAria(host, "上一张")).toBeFalsy(); // back to gallery
    expect(txt(host)).toContain("＋ 拍照");
  });

  // REQ-A962: the ♥/♡ glyph is the toggle's only state signal and a static `aria-label`
  // shadows it — so the button must *say* its state. The invariant pinned here is the tie
  // between the two: whatever the glyph shows, `aria-pressed` must agree.
  test("the viewer's ♥ toggle reports its state, not just the glyph", async () => {
    const host = render(PhotosApp);
    await fireEvent.click(firstTile(host)!); // open the newest photo
    const fav = btnAria(host, "收藏");
    expect(fav).toBeTruthy();
    const painted = () => (fav!.textContent ?? "").includes("♥");
    expect(fav!.getAttribute("aria-pressed")).toBe(String(painted()));
    const first = painted();
    await fireEvent.click(fav!);
    expect(painted()).toBe(!first); // the glyph really moved
    expect(fav!.getAttribute("aria-pressed")).toBe(String(painted())); // and so did the state
  });

  // REQ-A1001 / F-SH-322: the *video* tile carries the very same ♥/♡ toggle, and the REQ-A962 fix
  // reached only the photo one. Two-sided on the glyph↔attribute tie plus an explicit `false`
  // before the click, so neither an omitted attribute nor a hard-coded "true" can pass.
  test("the video tile's ♥ toggle reports its state too", async () => {
    writeStoreValue(CAPTURES_KEY, [
      { id: "v1", ts: Date.now() - 1000, mime: "video/webm", durationMs: 3000, w: 1280, h: 720 },
    ]);
    const host = render(PhotosApp);
    await tick();
    const favOf = () =>
      [...host.container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === zh["a11y.favouriteVideo"],
      ) as HTMLButtonElement | undefined;
    expect(favOf()).toBeTruthy();
    const painted = () => (favOf()!.textContent ?? "").includes("♥");
    expect(painted()).toBe(false);
    expect(favOf()!.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(favOf()!);
    await tick();
    expect(painted()).toBe(true); // the glyph really moved
    expect(favOf()!.getAttribute("aria-pressed")).toBe("true");
  });

  // REQ-A1001 / F-SH-322: in select mode the tile IS a multi-select toggle whose picked state lived
  // only in a ring class and a ✓ badge, with the same accessible name either way. Outside select
  // mode the same tile opens the photo, so it must carry NO pressed state there — asserted
  // explicitly, or a blanket `aria-pressed={isSel}` that lies outside select mode would pass.
  test("select mode: each tile reports its own picked state", async () => {
    const host = render(PhotosApp);
    expect(firstTile(host)!.getAttribute("aria-pressed")).toBeNull(); // viewer mode: not a toggle
    await fireEvent.click(
      [...host.container.querySelectorAll("button")].find(
        (b) => (b.textContent ?? "").trim() === "选择",
      ) as HTMLButtonElement,
    );
    await tick();
    expect(firstTile(host)!.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(firstTile(host)!);
    await tick();
    expect(firstTile(host)!.getAttribute("aria-pressed")).toBe("true");
  });

  test("a rejected write is reported and the deleted photo stays", async () => {
    const restore = failWritesFor("amos.photos");
    try {
      const host = render(PhotosApp);
      await fireEvent.click(firstTile(host)!);
      const del = [...host.container.querySelectorAll("button")].find(
        (b) => (b.textContent ?? "").trim() === "删除",
      );
      await fireEvent.click(del as HTMLButtonElement);
      // The photo is still stored, so it must not be reported as deleted: the banner
      // shows and the viewer stays open.
      expect(txt(host)).toContain("本机存储写入失败");
      expect(btnAria(host, "上一张")).toBeTruthy();
    } finally {
      restore();
    }
  });

  // REQ-A1242 / F-SH-521: the ♥ toggle was the one write in this file whose verdict was not
  // consulted — `persist` ran for its effect on `list`, then `sel` was pointed at the intended
  // row anyway. A refused write flipped the heart in the viewer while the store kept the old
  // value, and the refusal notice renders OUTSIDE the full-screen viewer, so the one line that
  // contradicts the heart sits behind the surface asserting it. Three claims in one: the heart
  // does not move, the store did not move, and the notice is not inside the viewer.
  test("a refused write must not move the viewer's ♥ either", async () => {
    writeStoreValue(PHOTOS_KEY, [
      { id: "p1", ts: Date.now() - 1000, fav: false, emoji: "💙", a: "#f00", b: "#00f" },
    ]);
    const restore = failWritesFor("amos.photos");
    try {
      const host = render(PhotosApp);
      await fireEvent.click(firstTile(host)!);
      const fav = btnAria(host, "收藏")!;
      expect(fav.getAttribute("aria-pressed")).toBe("false");
      expect(fav.textContent ?? "").toContain("♡");
      await fireEvent.click(fav);
      // the glyph did NOT move: nothing the store accepted backs a ♥ here.
      expect(fav.getAttribute("aria-pressed")).toBe("false");
      expect(fav.textContent ?? "").toContain("♡");
      // and the store still holds the un-favourited row.
      expect(readStoreValue<{ fav?: boolean }[]>(PHOTOS_KEY, [])[0]?.fav).toBe(false);
      // the refusal IS reported — but the notice sits outside the viewer overlay, which is
      // exactly why a lie drawn inside it would not be self-correcting on screen.
      const banner = host.container.querySelector('[data-testid="store-write-error"]');
      expect(banner).toBeTruthy();
      const overlay = host.container.querySelector("[data-viewer-stage]")!.closest(".z-20")!;
      expect(overlay.contains(banner!)).toBe(false);
    } finally {
      restore();
    }
  });

  test("multi-select can batch-delete", async () => {
    const host = render(PhotosApp);
    const selBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "选择",
    );
    expect(selBtn).toBeTruthy();
    await fireEvent.click(selBtn as HTMLButtonElement); // enter select mode
    await fireEvent.click(firstTile(host)!); // select one tile
    const delSel = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("删除所选 (1)"),
    );
    expect(delSel).toBeTruthy();
    await fireEvent.click(delSel as HTMLButtonElement);
    // still a gallery (list shrunk by one); select mode exited
    expect(txt(host)).not.toContain("删除所选");
    expect(firstTile(host)).toBeTruthy();
  });

  test("select-mode batch favourite marks the chosen photos and exits", async () => {
    const host = render(PhotosApp);
    // enter select mode
    const selBtn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "选择",
    );
    await fireEvent.click(selBtn as HTMLButtonElement);
    await fireEvent.click(firstTile(host)!); // pick one photo
    const favBtn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("收藏所选 (1)"),
    );
    expect(favBtn).toBeTruthy();
    await fireEvent.click(favBtn as HTMLButtonElement);
    // select mode exited; the ♥ filter chip now reports one favourite
    expect(txt(host)).toContain("♥ (1)");
    expect(txt(host)).not.toContain("收藏所选");
  });

  test("Select All selects every shown photo (delete count), Deselect All clears", async () => {
    const host = render(PhotosApp);
    await fireEvent.click([...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "选择",
    ) as HTMLButtonElement);
    // Select All → all shown photos selected → delete-count equals the full list
    await fireEvent.click([...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "全选",
    ) as HTMLButtonElement);
    const seedCount = host.container.querySelectorAll('button[class*="aspect-square"]').length;
    expect(seedCount).toBeGreaterThan(0);
    expect(txt(host)).toContain("取消全选"); // now fully selected
    expect(txt(host)).toContain(`删除所选 (${seedCount})`);
    // Deselect All clears the selection (actions disappear)
    await fireEvent.click([...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "取消全选",
    ) as HTMLButtonElement);
    expect(txt(host)).not.toContain("删除所选");
  });

  test("viewer navigation stays inside the active ♥ filter (no jump to unfavourited)", async () => {
    // Seed two photos: one favourited (newer), one not (older).
    writeStoreValue(PHOTOS_KEY, [
      { id: "p-fav", ts: Date.now() - 1000, fav: true, emoji: "💙", a: "#f00", b: "#00f" },
      { id: "p-old", ts: Date.now() - 2 * 86_400_000, emoji: "💛", a: "#0f0", b: "#0ff" },
    ]);
    const host = render(PhotosApp);
    // switch to Favourites → only the favourited tile is shown
    await fireEvent.click([...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("♥ (1)"),
    ) as HTMLButtonElement);
    expect(txt(host)).not.toContain("💛"); // non-favourite hidden
    // open the favourited photo
    await fireEvent.click(host.container.querySelector('button[class*="aspect-square"]') as HTMLButtonElement);
    // prev/next disabled: the only other item is outside the filter
    expect(btnAria(host, "下一张")?.disabled).toBe(true);
    expect(btnAria(host, "上一张")?.disabled).toBe(true);
    // the viewer counter reflects the **filtered** set, not the raw library:
    // one favourited photo of two → "1 / 1", never "1 / 2"
    expect(txt(host)).toContain("1 / 1");
    expect(txt(host)).not.toContain("1 / 2");
    // and the slideshow (which advances over `shown`) is hidden — it could never move
    expect(txt(host)).not.toContain("幻灯片");
  });

  test("shows a read-only native strip when a media bridge serves stills", async () => {
    // Offline (no bridge) the strip stays hidden; with a stubbed bridge the
    // camera collection returns one native still → a read-only native tile.
    const stub = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { collection?: string }) => {
        if (cmd === "media_list" && args?.collection === "camera") {
          return [
            {
              id: "content://cam/1",
              kind: "image",
              collection: "camera",
              name: "IMG_native.jpg",
              uri: "content://cam/1",
              mime: "image/jpeg",
              size_bytes: 10,
              ts: 200,
            },
          ];
        }
        return [];
      },
    };
    try {
      const host = render(PhotosApp);
      await vi.waitFor(() => {
        expect(host.container.querySelector(`[aria-label="${zh["a11y.nativePhotos"]}"]`)).toBeTruthy();
      });
      expect(host.container.querySelector('[title="IMG_native.jpg"]')).toBeTruthy();
    } finally {
      if (stub === undefined) delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      else (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = stub;
    }
  });

  test("a denied media list prompts for access; granting loads the stills", async () => {
    // The Rust side surfaces an Unauthorized list as a *rejection* — the gallery
    // must say "not authorized", never render it as an empty library.
    let granted = false;
    const calls: string[] = [];
    const stub = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { collection?: string }) => {
        calls.push(cmd);
        if (cmd === "media_list") {
          if (!granted) throw new Error("camera: not authorized (call media_grant_read)");
          return args?.collection === "camera"
            ? [
                {
                  id: "content://cam/9",
                  kind: "image",
                  collection: "camera",
                  name: "IMG_granted.jpg",
                  uri: "content://cam/9",
                  mime: "image/jpeg",
                  size_bytes: 10,
                  ts: 900,
                },
              ]
            : [];
        }
        if (cmd === "media_grant_read") {
          granted = true;
          return null;
        }
        return null;
      },
    };
    try {
      const host = render(PhotosApp);
      await vi.waitFor(() => {
        expect(host.container.querySelector('[data-testid="native-blocked"]')).toBeTruthy();
      });
      // No fabricated native strip while the read is denied.
      expect(host.container.querySelector(`[aria-label="${zh["a11y.nativePhotos"]}"]`)).toBeNull();

      await fireEvent.click(btnAria(host, "授权读取")!);
      await vi.waitFor(() => {
        expect(host.container.querySelector('[title="IMG_granted.jpg"]')).toBeTruthy();
      });
      // Both listed collections were granted read access (camera + screenshots).
      expect(calls.filter((c) => c === "media_grant_read")).toHaveLength(2);
      expect(host.container.querySelector('[data-testid="native-blocked"]')).toBeNull();
    } finally {
      if (stub === undefined) delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      else (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = stub;
    }
  });
});

describe("PhotosApp.svelte - form-aware gallery columns (REQ-A292)", () => {
  // The gallery used to render `grid-cols-3` unconditionally. On a 900x1200 iPad-class
  // window that was the phone's 3 columns stretched out — half the width empty.
  // The PhotosApp now reads `form` from the host via `currentFormFactor()` and
  // asks `lib/formLayout::photosCols` how many columns. This group pins the column
  // count per class via the same inline `grid-template-columns` style that
  // HomeDock / AppLibrary use (Tailwind purges constructed class names).

  /** Read the `repeat(N, …)` count from the gallery grid's style attribute. */
  function galleryCols(container: HTMLElement): number {
    const grid = container.querySelector(".grid[style*=\"grid-template-columns\"]") as HTMLElement | null;
    if (!grid) throw new Error("no gallery grid");
    const m = grid.getAttribute("style")?.match(/repeat\(\s*(\d+)\s*,/);
    return m && m[1] ? Number(m[1]) : 0;
  }

  test("no host form → the phone's 3 columns (the conservative default)", () => {
    // `currentFormFactor()` returns `null` when the shell has not pushed a form;
    // `photosCols(null ? "phone" : …)` keeps today's iOS-Phone layout so the
    // preview build is unaffected. (REQ-A292, mirroring `formLayout`'s "no
    // measurement → phone grid" rule.)
    const host = render(PhotosApp);
    expect(galleryCols(host.container)).toBe(3);
  });

  test("phone form → 3 columns", () => {
    setFormFactor("phone");
    const host = render(PhotosApp);
    expect(galleryCols(host.container)).toBe(3);
  });

  test("tablet form → 5 columns (iPadOS My-Photos density)", () => {
    setFormFactor("tablet");
    const host = render(PhotosApp);
    expect(galleryCols(host.container)).toBe(5);
  });

  test("desktop form → DESKTOP_MAX_COLS (8), pinned to the launcher cap", () => {
    setFormFactor("desktop");
    const host = render(PhotosApp);
    // 8 = DESKTOP_MAX_COLS — pinned by formLayout.test.ts so the launcher and the
    // gallery cannot drift apart to a hand-picked number.
    expect(galleryCols(host.container)).toBe(8);
  });

  test("robot form → the phone's 3 columns (no UI, conservative default)", () => {
    setFormFactor("robot");
    const host = render(PhotosApp);
    expect(galleryCols(host.container)).toBe(3);
  });
});

/**
 * Export to the shared camera roll (REQ-A352).
 *
 * `lib/photos.ts` is a **private** store: without an export the shot exists only inside AmOS, so
 * the system gallery and every other app see nothing. The six `camera.export*` keys shipped with
 * **no producer at all** until this wiring — an entire UX (button label, in-flight line, one
 * message per outcome) that no code path could reach. These cases pin the wiring: the bytes really
 * go to the host, the name and collection are the camera ones, and no outcome is invented.
 */
describe("PhotosApp — export to the shared camera roll (REQ-A352)", () => {
  /** A fake host recording the media commands (the pair the service's own tests drive). */
  function installMediaHost(reply: "item" | "refused") {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "media_save") {
          // A refusal is a **rejected** invoke: `null` would mean "no bridge" (offline).
          if (reply === "refused") throw new Error("media: not authorized to write camera");
          return { id: "saved-1", name: (args?.name as string) ?? "x.png" };
        }
        if (cmd === "media_list") return [];
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (clipboardDescriptor) Object.defineProperty(window.navigator, "clipboard", clipboardDescriptor);
    else delete (window.navigator as unknown as { clipboard?: unknown }).clipboard;
  });

  /** Poll for text instead of sleeping a fixed time (the repo's anti-flake discipline). */
  async function waitFor(host: { container: HTMLElement }, needle: string, ms = 500) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (txt(host).includes(needle)) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return txt(host).includes(needle);
  }
  const btnByText = (host: { container: HTMLElement }, text: string) =>
    [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(text),
    ) as HTMLButtonElement | undefined;
  /** The export lives in the viewer, so open the first tile first. */
  async function openFirstTile(host: { container: HTMLElement }) {
    await fireEvent.click(firstTile(host)!);
    await tick();
  }

  test("writes the still's own bytes into DCIM/Camera as an image", async () => {
    writeStoreValue(PHOTOS_KEY, [
      // A PNG data URL: the extension must follow this, not a guessed `.jpg`.
      { id: "p1", ts: new Date(2026, 8, 16, 18, 5, 7).getTime(), data: "data:image/png;base64,AAAA" },
    ]);
    const calls = installMediaHost("item");
    const host = render(PhotosApp);
    await tick();
    await openFirstTile(host);
    const exportBtn = btnByText(host, zh["camera.exportToSystem"]!);
    expect(exportBtn, "the viewer offers a real export").toBeTruthy();
    await fireEvent.click(exportBtn!);
    expect(
      await waitFor(host, zh["camera.exported"]!),
      `the outcome is shown, not assumed — got: ${txt(host)}`,
    ).toBe(true);
    expect(calls.map((c) => c.cmd)).toContain("media_grant_write");
    const save = calls.find((c) => c.cmd === "media_save");
    expect(save, "the file was written through the host").toBeTruthy();
    // A byte array (the host's own type), the **camera** collection, and the name from the
    // photo's own stamp.
    expect(Array.isArray((save?.args as { data?: unknown })?.data)).toBe(true);
    expect((save?.args as { collection?: string })?.collection).toBe("camera");
    expect((save?.args as { kind?: string })?.kind).toBe("image");
    expect(String((save?.args as { name?: string })?.name ?? "")).toBe("Amos-20260916-180507.png");
  });

  test("a refusal is reported as a refusal, never as a save", async () => {
    writeStoreValue(PHOTOS_KEY, [{ id: "p1", ts: Date.now(), data: "data:image/jpeg;base64,AAAA" }]);
    installMediaHost("refused");
    const host = render(PhotosApp);
    await tick();
    await openFirstTile(host);
    await fireEvent.click(btnByText(host, zh["camera.exportToSystem"]!)!);
    expect(await waitFor(host, zh["camera.exportRefused"]!)).toBe(true);
    expect(txt(host), "…and it never claims otherwise").not.toContain(zh["camera.exported"]!);
  });

  test("a demo tile with no pixels says so and never touches the host's write path", async () => {
    writeStoreValue(PHOTOS_KEY, [{ id: "p2", ts: Date.now(), emoji: "🏔️" }]);
    const calls = installMediaHost("item");
    const host = render(PhotosApp);
    await tick();
    await openFirstTile(host);
    await fireEvent.click(btnByText(host, zh["camera.exportToSystem"]!)!);
    expect(await waitFor(host, zh["camera.exportFailed"]!)).toBe(true);
    // An empty file in the user's gallery would claim a photo that is not there, so nothing is
    // attempted. (`media_list`, from the native strip, is a read — not counted here.)
    expect(calls.filter((c) => c.cmd === "media_save").length).toBe(0);
    expect(calls.filter((c) => c.cmd === "media_grant_write").length).toBe(0);
  });

  test("a blocked clipboard is not reported as a successful share", async () => {
    writeStoreValue(PHOTOS_KEY, [{ id: "p1", ts: Date.now(), data: "data:image/png;base64,AAAA" }]);
    Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
    const host = render(PhotosApp);
    await tick();
    await openFirstTile(host);
    await fireEvent.click(btnByText(host, zh["photo.share"]!)!);
    expect(await waitFor(host, zh["photo.shareFailed"]!)).toBe(true);
    expect(txt(host), "no claim of a copy that did not happen").not.toContain(zh["photo.shared"]!);
  });

  test("a working clipboard still reports the copy (the case that must keep passing)", async () => {
    writeStoreValue(PHOTOS_KEY, [{ id: "p1", ts: Date.now(), data: "data:image/png;base64,AAAA" }]);
    const written: string[] = [];
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: async (s: string) => void written.push(s) },
      configurable: true,
    });
    const host = render(PhotosApp);
    await tick();
    await openFirstTile(host);
    await fireEvent.click(btnByText(host, zh["photo.share"]!)!);
    expect(await waitFor(host, zh["photo.shared"]!)).toBe(true);
    expect(written.length, "the caption really reached the clipboard").toBe(1);
  });
});


/**
 * Deep link from the camera's last-photo thumbnail (REQ-A358).
 *
 * That thumbnail had **no handler at all**: it looked like the way to see the shot just taken
 * and tapping it did nothing — worse than no control, because it implies content. It now asks
 * this screen for that item through the same `appLinks` channel the Spotlight chooser uses for
 * notes, and the viewer opens **on the requested item**, not on the newest one. An id this
 * screen no longer holds is ignored: the grid stays what is shown, and nothing is invented.
 */
describe("PhotosApp — deep link from the camera thumbnail (REQ-A358)", () => {
  test("opens the viewer on the requested item, not on the newest one", async () => {
    writeStoreValue(PHOTOS_KEY, [
      // `p1` is deliberately the OLDER one, so "newest first" would open `p2` instead.
      { id: "p1", ts: Date.now() - 60_000, emoji: "🌅" },
      { id: "p2", ts: Date.now(), data: "data:image/png;base64,AAAA" },
    ]);
    const host = render(PhotosApp);
    await tick();
    photosChannel().set({ photoId: "p1", nonce: 1 });
    await tick();
    // The viewer's own counter (`{idx} / {len}`) is viewer-only text: `1 / 2` is `p1`.
    expect(txt(host), `viewer should show the linked item — got: ${txt(host)}`).toContain("1 / 2");
    // two items shown (no filter) → the slideshow is available; it advances over `shown`
    expect(txt(host)).toContain("幻灯片");
  });

  test("an id this screen no longer holds is ignored, never fabricated", async () => {
    writeStoreValue(PHOTOS_KEY, [{ id: "p1", ts: Date.now(), emoji: "🌅" }]);
    const host = render(PhotosApp);
    await tick();
    photosChannel().set({ photoId: "gone", nonce: 2 });
    await tick();
    expect(txt(host), "no viewer for an item we do not have").not.toMatch(/\d+ \/ \d+/);
  });
});

/**
 * REQ-A502 — the native strip is **paged**.
 *
 * `media_list(collection)` returns the whole collection (measured: no cursor, no page size, no
 * total), so the gallery used to build every tile of every collection in one go — a device with
 * tens of thousands of photos rendered tens of thousands of 64px tiles. The strip now shows one
 * page and offers 「加载更多（还有 N 项）」, where N is **our own** count (the host reports none).
 *
 * The last case is the one that matters most and is easiest to get wrong: when a whole group of
 * photos shares one timestamp, the host's order inside the group is whatever the directory scan
 * produced, so resuming "from the host's last item" repeats or drops the rest of the group — and
 * that looks exactly like a working pager until the user counts their photos. It is why the
 * screen sorts by `newestFirst` before slicing (the module's documented contract).
 */
describe("PhotosApp — 原生照片分页 (REQ-A502)", () => {
  /**
   * `n` stills in the camera collection.
   *
   * `sameTs` puts them all in one tie group; `reverse` then presents them in the order a
   * **host** plausibly would (ts-descending only, and inside a tie group whatever the directory
   * scan produced). Without `reverse` the fixture's order happens to equal `newestFirst`, which
   * would make the tie-group case pass even with the sort missing — the measurement that made
   * this parameter necessary.
   */
  const stills = (n: number, sameTs = false, reverse = false) => {
    const base = Array.from({ length: n }, (_, i) => ({
      id: `content://cam/${String(i).padStart(3, "0")}`,
      kind: "image",
      collection: "camera",
      name: `IMG_${String(i).padStart(3, "0")}.jpg`,
      uri: `content://cam/${String(i).padStart(3, "0")}`,
      mime: "image/jpeg",
      size_bytes: 10,
      ts: sameTs ? 5_000 : 10_000 - i,
    }));
    return reverse ? base.reverse() : base;
  };

  /** Install a bridge whose `camera` listing is `camera`. Returns a restore function. */
  function withBridge(camera: unknown[]): () => void {
    const stub = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { collection?: string }) => {
        if (cmd === "media_list") return args?.collection === "camera" ? camera : [];
        return null;
      },
    };
    return () => {
      if (stub === undefined) delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      else (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = stub;
    };
  }

  const tiles = (h: { container: HTMLElement }) =>
    [...h.container.querySelectorAll(`[aria-label="${zh["a11y.nativePhotos"]}"] button[title]`)];
  const loadMore = (h: { container: HTMLElement }) =>
    h.container.querySelector('[data-testid="native-load-more"]') as HTMLButtonElement | null;
  const interpolate = (key: keyof typeof zh, params: Record<string, string>) =>
    Object.entries(params).reduce(
      (s, [k, v]) => s.replace(`{${k}}`, v),
      String(zh[key]),
    );

  test("第一页是有界的：只渲染一页，并说出「共多少」与「还有多少」", async () => {
    const restore = withBridge(stills(80));
    try {
      const host = render(PhotosApp);
      await vi.waitFor(() => expect(tiles(host)).toHaveLength(60));

      expect(txt(host)).toContain(
        interpolate("media.showingNewest", { shown: "60", total: "80" }),
      );
      expect(loadMore(host)?.textContent).toContain(
        interpolate("media.loadMore", { n: "20" }),
      );
    } finally {
      restore();
    }
  });

  test("按「加载更多」取下一页；取完之后按钮消失（不再有假按钮）", async () => {
    const restore = withBridge(stills(80));
    try {
      const host = render(PhotosApp);
      await vi.waitFor(() => expect(tiles(host)).toHaveLength(60));

      await fireEvent.click(loadMore(host)!);
      await vi.waitFor(() => expect(tiles(host)).toHaveLength(80));

      expect(loadMore(host)).toBeNull();
      expect(txt(host)).toContain(
        interpolate("media.showingNewest", { shown: "80", total: "80" }),
      );
    } finally {
      restore();
    }
  });

  test("数量不超过一页时不出现按钮（`remaining` 才是判据，不是「集合还没退休」）", async () => {
    const restore = withBridge(stills(12));
    try {
      const host = render(PhotosApp);
      await vi.waitFor(() => expect(tiles(host)).toHaveLength(12));
      expect(loadMore(host)).toBeNull();
    } finally {
      restore();
    }
  });

  test("同一时间戳的一整组跨页：一张不丢、一张不重", async () => {
    // The host's order inside the tie group is **not** ours (fixture reversed on purpose).
    const restore = withBridge(stills(80, true, true));
    try {
      const host = render(PhotosApp);
      await vi.waitFor(() => expect(tiles(host)).toHaveLength(60));
      await fireEvent.click(loadMore(host)!);
      await vi.waitFor(() => expect(tiles(host)).toHaveLength(80));

      const names = tiles(host).map((el) => el.getAttribute("title"));
      expect(new Set(names).size).toBe(80);
      expect([...names].sort()).toEqual(stills(80, true, true).map((s) => s.name).sort());
    } finally {
      restore();
    }
  });
});

/**
 * The measurement the backlog asked for (REQ-A587): the gallery's tile grid used to start decoding
 * every image the moment the page rendered. Counted on a 60-tile page — `NATIVE_PAGE`'s own page
 * size — because "adopting LazyImage is a **measured** performance change"
 * (`scripts/unwired-allowlist.json`, the entry this round closes) is a claim, not a hope.
 */
describe("PhotosApp — 懒加载测量：一页 60 张，渲染时不再起 60 次解码", () => {
  /** `n` photos with an inline data URL each — what the captures layer actually stores. */
  const seedPhotos = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      ts: Date.now() - i * 1000,
      data: `data:image/png;base64,PIC${i}`,
    }));

  /** The tile images that carry a real `src` — i.e. the ones that would start decoding. */
  const loadingImages = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("img")).filter((img) =>
      (img.getAttribute("src") ?? "").startsWith("data:image/png"),
    );

  test("60 张瓦片渲染完成时 0 张在加载；只有被看见的那几张才开始", async () => {
    const fake = installFakeObserver();
    setLocale("zh");
    writeStoreValue(PHOTOS_KEY, seedPhotos(60));
    const { container } = render(PhotosApp);
    await tick();

    expect(container.querySelectorAll('button[aria-label^="p"]').length).toBe(60);
    // 改动前这里是 60（整页 data URL 同时解码）；改动后是 0。
    expect(loadingImages(container).length).toBe(0);
    // 每张瓦片都被观察着——懒加载不是"忘了加载"。
    expect(fake.instances.length).toBeGreaterThan(0);

    // 模拟"视口只看见前 4 张"。
    fake.instances.slice(0, 4).forEach((io) => io.reveal(1));
    await tick();
    expect(loadingImages(container).length).toBe(4);
  });

  test("没加载的瓦片不是空白：字形仍在（懒加载只影响 <img> 的 src）", async () => {
    installFakeObserver();
    setLocale("zh");
    writeStoreValue(PHOTOS_KEY, seedPhotos(3));
    const { container } = render(PhotosApp);
    await tick();
    expect(container.querySelectorAll('button[aria-label^="p"]').length).toBe(3);
    expect((container.textContent ?? "").length).toBeGreaterThan(0);
  });
});
describe("PhotosApp — 图片编辑 (REQ-A1147)", () => {
  const realPhoto = { id: "r1", ts: 1_700_000_000_000, data: "data:image/png;base64,AAAA" };

  const openEditor = async () => {
    writeStoreValue(PHOTOS_KEY, [realPhoto]);
    const host = render(PhotosApp);
    await fireEvent.click(firstTile(host)!);
    await fireEvent.click(btnText(host, zh["photo.edit"])!);
    return host;
  };

  test("编辑入口只对真实照片出现（渐变瓦片没有像素可编辑）", async () => {
    const g = render(PhotosApp);
    await fireEvent.click(firstTile(g)!);
    expect(btnText(g, zh["photo.edit"])).toBeUndefined();
    cleanup();

    writeStoreValue(PHOTOS_KEY, [realPhoto]);
    const host = render(PhotosApp);
    await fireEvent.click(firstTile(host)!);
    expect(btnText(host, zh["photo.edit"])).toBeTruthy();
  });

  test("打开编辑器渲染工具栏，旋转会改变预览的 transform", async () => {
    const host = await openEditor();
    const img = host.container.querySelector("[data-frame] img") as HTMLImageElement;
    expect(img.getAttribute("style")).toContain("rotate(0deg)");
    await fireEvent.click(btnText(host, zh["photo.editRotR"])!);
    expect(
      (host.container.querySelector("[data-frame] img") as HTMLImageElement).getAttribute("style"),
    ).toContain("rotate(90deg)");
    // 裁剪框仍在（一个 90° 的转向不会把它推出 frame）。
    expect(host.container.querySelector("[data-frame] > div")).toBeTruthy();
  });

  test("滤镜按钮报告自己的选中状态", async () => {
    const host = await openEditor();
    expect(btnText(host, zh["photo.editFilterMono"])!.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(btnText(host, zh["photo.editFilterMono"])!);
    expect(btnText(host, zh["photo.editFilterMono"])!.getAttribute("aria-pressed")).toBe("true");
  });

  test("取消关闭编辑器，且不写任何东西", async () => {
    const host = await openEditor();
    const before = readStoreValue<unknown[]>(PHOTOS_KEY, []);
    await fireEvent.click(btnText(host, zh["photo.close"])!);
    expect(host.container.querySelector("[data-stage]")).toBeNull();
    expect(readStoreValue<unknown[]>(PHOTOS_KEY, [])).toEqual(before);
  });

  test("没有改动就存储：如实说没改，不新增照片", async () => {
    const host = await openEditor();
    const before = readStoreValue<unknown[]>(PHOTOS_KEY, []);
    await fireEvent.click(btnText(host, zh["photo.editSave"])!);
    await tick();
    expect(txt(host)).toContain(zh["photo.editNoop"]);
    expect(readStoreValue<unknown[]>(PHOTOS_KEY, [])).toEqual(before);
  });

  test("画布不可用时如实报「无法编辑」，绝不假装存了一张", async () => {
    // happy-dom 没有 2D context。这里的 Image 只保证「解码」这一步会回调，
    // 好让流程走到 drawEdited 而不是卡在加载上。
    const realImage = globalThis.Image;
    globalThis.Image = StubImage as unknown as typeof Image;
    try {
      const host = await openEditor();
      await fireEvent.click(btnText(host, zh["photo.editRotR"])!);
      const before = readStoreValue<unknown[]>(PHOTOS_KEY, []);
      await fireEvent.click(btnText(host, zh["photo.editSave"])!);
      await vi.waitFor(() => expect(txt(host)).toContain(zh["photo.editUnsupported"]));
      expect(readStoreValue<unknown[]>(PHOTOS_KEY, [])).toEqual(before);
    } finally {
      globalThis.Image = realImage;
    }
  });
});

describe("PhotosApp — 查看器全屏 / 缩放（REQ-A1147）", () => {
  const realPhoto = { id: "r1", ts: 1_700_000_000_000, data: "data:image/png;base64,AAAA" };
  const stageStyle = (h: { container: HTMLElement }) =>
    (h.container.querySelector("[data-viewer-stage] img") as HTMLImageElement | null)?.getAttribute(
      "style",
    ) ?? "";

  const openViewer = async () => {
    writeStoreValue(PHOTOS_KEY, [realPhoto]);
    const host = render(PhotosApp);
    await fireEvent.click(firstTile(host)!);
    return host;
  };

  test("查看器是一块全屏舞台，而不是固定 160×160 的方框", async () => {
    const host = await openViewer();
    expect(host.container.querySelector("[data-viewer-stage]")).toBeTruthy();
    expect(stageStyle(host)).toContain("scale(1)");
  });

  test("放大/缩小按钮改变视图 transform；到端点是 disabled 而不是空操作", async () => {
    const host = await openViewer();
    const zoomOut = btnAria(host, zh["photo.zoomOut"])!;
    const zoomIn = btnAria(host, zh["photo.zoomIn"])!;
    // At fit there is nothing to shrink back to, and that is reported, not silently ignored.
    expect(zoomOut.disabled).toBe(true);
    expect(btnText(host, zh["photo.zoomFit"])!.disabled).toBe(true);

    await fireEvent.click(zoomIn);
    expect(stageStyle(host)).toContain("scale(1.5)");
    expect(zoomOut.disabled).toBe(false);
    expect(btnText(host, zh["photo.zoomFit"])!.disabled).toBe(false);

    // 「适应」returns to fit, and the zoom-out end closes again.
    await fireEvent.click(btnText(host, zh["photo.zoomFit"])!);
    expect(stageStyle(host)).toContain("scale(1)");
    expect(zoomOut.disabled).toBe(true);
  });

  test("Escape 关闭查看器（键盘用户不必用鼠标才能离开）", async () => {
    const host = await openViewer();
    await fireEvent.keyDown(window, { key: "Escape" });
    await tick();
    expect(host.container.querySelector("[data-viewer-stage]")).toBeNull();
  });
});

describe("PhotosApp — 系统照片可打开、可编辑（REQ-A1147）", () => {
  /** A bridge whose camera listing holds one still, and which answers `media_load` with `bytes`. */
  function withDevicePhotos(bytes: number[] | null): () => void {
    const stub = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const cam = [
      {
        id: "content://cam/1",
        kind: "image",
        collection: "camera",
        name: "IMG_0001.jpg",
        uri: "content://cam/1",
        mime: "image/jpeg",
        size_bytes: 4,
        ts: 9_000,
      },
    ];
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { collection?: string }) => {
        if (cmd === "media_list") return args?.collection === "camera" ? cam : [];
        if (cmd === "media_load") return bytes;
        return null; // media_stream_url: the host serves this build no URL
      },
    };
    return () => {
      if (stub === undefined) delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      else (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = stub;
    };
  }

  const openDevice = async () => {
    const host = render(PhotosApp);
    await vi.waitFor(() =>
      expect(host.container.querySelector('button[aria-label="IMG_0001.jpg"]')).toBeTruthy(),
    );
    await fireEvent.click(host.container.querySelector('button[aria-label="IMG_0001.jpg"]')!);
    await tick();
    return host;
  };

  test("系统照片的瓦片是按钮（曾是不可点击的 div），点开进入查看器", async () => {
    const restore = withDevicePhotos(null);
    try {
      const host = await openDevice();
      expect(host.container.querySelector("[data-viewer-stage]")).toBeTruthy();
      expect(txt(host)).toContain("IMG_0001.jpg");
      // The host serves no URL for this item — that is said, not drawn as an empty image.
      expect(txt(host)).toContain(zh["photo.nativeUnavailable"]);
      // No local-store chrome on a device item: there is no local record to delete or export.
      expect(btnText(host, zh["photo.delete"])).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("读不到字节时如实报「没有导入」，绝不假装打开了编辑器", async () => {
    const restore = withDevicePhotos(null);
    try {
      const host = await openDevice();
      const before = readStoreValue<unknown[]>(PHOTOS_KEY, []);
      await fireEvent.click(btnText(host, zh["photo.edit"])!);
      await vi.waitFor(() => expect(txt(host)).toContain(zh["photo.nativeNoBytes"]));
      expect(host.container.querySelector("[data-stage]")).toBeNull(); // no editor
      expect(readStoreValue<unknown[]>(PHOTOS_KEY, [])).toEqual(before);
    } finally {
      restore();
    }
  });

  test("字节可读时把照片导入编辑器：预览用的是从宿主取回的那张图", async () => {
    const restore = withDevicePhotos([1, 2, 3, 4]);
    try {
      const host = await openDevice();
      await fireEvent.click(btnText(host, zh["photo.edit"])!);
      await vi.waitFor(() => expect(host.container.querySelector("[data-stage]")).toBeTruthy());
      // The preview is the imported data URL (`media_load`'s bytes, wrapped by the host MIME) —
      // not the device URL, which this build was not served.
      const src = host.container.querySelector("[data-frame] img")!.getAttribute("src") ?? "";
      expect(src.startsWith("data:image/jpeg;base64,")).toBe(true);
    } finally {
      restore();
    }
  });
});

/**
 * REQ-A1148 — the four defects this round closed. Each one is the same family: a surface that
 * asserted something the code had not established (a write that never landed, a verdict shown
 * over the wrong subject, a control that could not act, an emptiness that hid what existed).
 */
describe("PhotosApp — 诚实性审计 (REQ-A1148)", () => {
  const realPhoto = (id: string, ts: number) => ({
    id,
    ts,
    emoji: "🌅",
    data: "data:image/png;base64,iVBORw0KGgo=", // `isRealPhoto` requires pixels
  });

  test("存储拒绝时「设为壁纸」说未成功，且没有把设置写成空壁纸", async () => {
    writeStoreValue(PHOTOS_KEY, [realPhoto("p1", Date.now())]);
    writeStoreValue("amos.settings", { keep: 1 });
    const host = render(PhotosApp);
    await tick();
    await fireEvent.click(firstTile(host)!);
    await tick();
    const restore = failWritesFor("amos.settings");
    try {
      await fireEvent.click(btnText(host, zh["photo.setWallpaper"])!);
      await tick();
      // The claim has to follow the effect: a refused write is never 已设为壁纸 …
      expect(txt(host)).not.toContain(zh["photo.setWallpaperDone"]);
      expect(txt(host)).toContain(zh["common.storeWriteFailed"]);
    } finally {
      restore();
    }
    // … and the previous settings are intact — no blank wallpaper was forced in.
    expect(readStoreValue<Record<string, unknown>>("amos.settings", {})).toEqual({ keep: 1 });
  });

  test("写入落地时才报「已设为壁纸」，并把这张照片的字节存进设置", async () => {
    writeStoreValue(PHOTOS_KEY, [realPhoto("p1", Date.now())]);
    const host = render(PhotosApp);
    await tick();
    await fireEvent.click(firstTile(host)!);
    await tick();
    await fireEvent.click(btnText(host, zh["photo.setWallpaper"])!);
    await tick();
    expect(txt(host)).toContain(zh["photo.setWallpaperDone"]);
    expect(readStoreValue<Record<string, unknown>>("amos.settings", {}).wallpaper).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  test("一张照片的结论不会跟到下一张（切换照片即清）", async () => {
    writeStoreValue(PHOTOS_KEY, [realPhoto("p1", 2000), realPhoto("p2", 1000)]);
    const host = render(PhotosApp);
    await tick();
    await fireEvent.click(firstTile(host)!);
    await tick();
    await fireEvent.click(btnText(host, zh["photo.setWallpaper"])!);
    await tick();
    expect(txt(host)).toContain(zh["photo.setWallpaperDone"]);
    // Next photo: the last photo's verdict must not be pinned onto this one.
    await fireEvent.click(btnAria(host, zh["photo.next"])!);
    await tick();
    expect(txt(host)).not.toContain(zh["photo.setWallpaperDone"]);
  });

  test("照片的结论不会溢到视频播放器（两个表面共用同一个槽）", async () => {
    writeStoreValue(PHOTOS_KEY, [realPhoto("p1", Date.now())]);
    writeStoreValue(CAPTURES_KEY, [
      { id: "v1", ts: Date.now() - 1000, mime: "video/webm", durationMs: 3000, w: 1280, h: 720 },
    ]);
    const host = render(PhotosApp);
    await tick();
    await fireEvent.click(firstTile(host)!);
    await tick();
    await fireEvent.click(btnText(host, zh["photo.setWallpaper"])!);
    await tick();
    expect(txt(host)).toContain(zh["photo.setWallpaperDone"]);
    // Leave the viewer, then open a video: the video overlay reads the same slot.
    await fireEvent.click(btnText(host, zh["photo.close"])!);
    await tick();
    await fireEvent.click(host.container.querySelector(`button[aria-label="${zh["a11y.video"]}"]`)!);
    await tick();
    expect(txt(host), "视频播放器上不能出现照片的结算语").not.toContain(
      zh["photo.setWallpaperDone"],
    );
  });

  test("Videos 视图里没有「选择」——它在那儿按不动", async () => {
    writeStoreValue(CAPTURES_KEY, [
      { id: "v1", ts: Date.now(), mime: "video/webm", durationMs: 3000, w: 1280, h: 720 },
    ]);
    const host = render(PhotosApp);
    await tick();
    expect(btnText(host, zh["photo.select"]), "All 视图里有").toBeTruthy();
    const vidChip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("🎬 (1)"),
    );
    await fireEvent.click(vidChip as HTMLButtonElement);
    await tick();
    expect(btnText(host, zh["photo.select"]), "Videos 视图里没有").toBeFalsy();
  });

  test("没有本地照片但有视频时，不谎报「暂无照片」，视频照常显示", async () => {
    window.localStorage.setItem("amos.photos", "[]");
    writeStoreValue(CAPTURES_KEY, [
      { id: "v1", ts: Date.now(), mime: "video/webm", durationMs: 3000, w: 1280, h: 720 },
    ]);
    const host = render(PhotosApp);
    await tick();
    expect(
      host.container.querySelector(`button[aria-label="${zh["a11y.video"]}"]`),
      "视频在 All 视图里必须看得见",
    ).toBeTruthy();
    expect(txt(host)).not.toContain(zh["photo.empty"]);
  });

  test("删掉最后一个视频后说「暂无视频」，而不是什么都不说", async () => {
    window.localStorage.setItem("amos.photos", "[]");
    writeStoreValue(CAPTURES_KEY, [
      { id: "v1", ts: Date.now(), mime: "video/webm", durationMs: 3000, w: 1280, h: 720 },
    ]);
    const host = render(PhotosApp);
    await tick();
    // The defect is the *filtered* case: the 🎬 chip vanishes with the last clip while the filter
    // it selected is still latched, which used to draw an empty region with no line at all.
    const vidChip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("🎬 (1)"),
    );
    await fireEvent.click(vidChip as HTMLButtonElement);
    await tick();
    // Delete the clip from its own player (the only delete path for videos).
    await fireEvent.click(host.container.querySelector(`button[aria-label="${zh["a11y.video"]}"]`)!);
    await tick();
    await fireEvent.click(btnText(host, zh["photo.delete"])!);
    await vi.waitFor(() => expect(txt(host)).toContain(zh["photo.videosEmpty"]));
    expect(txt(host), "理由是当前筛选取空，不是「本地没有照片」").not.toContain(zh["photo.empty"]);
  });

  test("本地一张照片都没有时，系统照片条仍然显示（它不属于本地库）", async () => {
    window.localStorage.setItem("amos.photos", "[]");
    const prev = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { collection?: string }) =>
        cmd === "media_list" && args?.collection === "camera"
          ? [
              {
                id: "content://cam/1",
                kind: "image",
                collection: "camera",
                name: "IMG_0001.jpg",
                uri: "content://cam/1",
                mime: "image/jpeg",
                size_bytes: 4,
                ts: 9_000,
              },
            ]
          : null,
    };
    try {
      const host = render(PhotosApp);
      await vi.waitFor(() =>
        expect(host.container.querySelector('button[aria-label="IMG_0001.jpg"]')).toBeTruthy(),
      );
      // The device's photos exist whether or not this app holds any of its own, so the strip
      // must not be hidden behind the local library's empty state.
      expect(txt(host), "有内容时不该再喊「暂无照片」").not.toContain(zh["photo.empty"]);
    } finally {
      if (prev === undefined)
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      else (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = prev;
    }
  });

  /**
   * 拒绝的那一叶，落在**多选**这半边。
   *
   * 本文件已经写下这条规则并逐个把兄弟改了（`deleteSel` ∕ `setWallpaper` ∕ `favVideo` ∕
   * `deleteVideo` ∕ `saveEdit`，以及 REQ-A1242 补上的 `toggleFavSel` —— 它的注释甚至断言
   * 「Every sibling gates」）。而两个**批量**动作没有照做：`deleteSelected` 与 `batchFav`
   * 把 `persist` 的返回值丢掉，照样把 `selected` 清空、把 `selecting` 关掉。写没落地的时候
   * 界面却往回走了一步 —— 用户选好的一堆照片被一键清掉，要重来一次得重新逐个点选。
   * 这正是 `deleteSel`（单张）与 `deleteSelected`（多张）之间那处不对称：
   * 单张的拒绝会把查看器与那张照片原样留住，多张的拒绝什么都不留。
   */
  test("存储拒绝时「删除所选」不得清掉用户的多选（没落地的写不能把界面推走）", async () => {
    writeStoreValue(PHOTOS_KEY, [realPhoto("p1", Date.now()), realPhoto("p2", Date.now() + 1)]);
    const host = render(PhotosApp);
    await tick();

    // 进入多选，选中两张。
    await fireEvent.click(btnText(host, zh["photo.select"])!);
    await tick();
    const tiles = [...host.container.querySelectorAll(".grid button")] as HTMLButtonElement[];
    expect(tiles.length, "两张照片应是两块瓦片").toBe(2);
    await fireEvent.click(tiles[0]);
    await fireEvent.click(tiles[1]);
    await tick();
    const delBtn = () =>
      [...host.container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").trim().startsWith("删除所选"),
      ) as HTMLButtonElement | undefined;
    expect(delBtn(), "选中之后才有「删除所选」").toBeTruthy();

    const restore = failWritesFor(PHOTOS_KEY);
    try {
      await fireEvent.click(delBtn()!);
      await tick();
      // 拒绝 ⇒ 有一句成句的说明，且选区必须还在（用户可以原样重按一次）。
      expect(txt(host)).toContain(zh["common.storeWriteFailed"]);
      expect(delBtn(), "写没落地，选区不能没有").toBeTruthy();
      expect(
        (host.container.querySelectorAll('.grid button[aria-pressed="true"]') as NodeListOf<HTMLElement>)
          .length,
        "两张仍应处于选中态",
      ).toBe(2);
    } finally {
      restore();
    }
    // 照片一张也没少。
    expect(readStoreValue(PHOTOS_KEY, []).length).toBe(2);
  });

  test("存储拒绝时「收藏所选」也不得清掉用户的多选（同一条纪律的另一叶）", async () => {
    writeStoreValue(PHOTOS_KEY, [realPhoto("p1", Date.now()), realPhoto("p2", Date.now() + 1)]);
    const host = render(PhotosApp);
    await tick();

    await fireEvent.click(btnText(host, zh["photo.select"])!);
    await tick();
    const tiles = [...host.container.querySelectorAll(".grid button")] as HTMLButtonElement[];
    expect(tiles.length, "两张照片应是两块瓦片").toBe(2);
    await fireEvent.click(tiles[0]);
    await fireEvent.click(tiles[1]);
    await tick();
    const favBtn = () =>
      [...host.container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").trim().startsWith("收藏所选"),
      ) as HTMLButtonElement | undefined;
    expect(favBtn(), "选中之后才有「收藏所选」").toBeTruthy();

    const restore = failWritesFor(PHOTOS_KEY);
    try {
      await fireEvent.click(favBtn()!);
      await tick();
      expect(txt(host)).toContain(zh["common.storeWriteFailed"]);
      expect(favBtn(), "写没落地，选区不能没有").toBeTruthy();
      expect(
        (host.container.querySelectorAll('.grid button[aria-pressed="true"]') as NodeListOf<HTMLElement>)
          .length,
        "两张仍应处于选中态",
      ).toBe(2);
    } finally {
      restore();
    }
    // 两张都还没被标成收藏。
    const kept = readStoreValue(PHOTOS_KEY, []) as Array<{ fav?: boolean }>;
    expect(kept.length).toBe(2);
    expect(kept.every((p) => !p.fav), "没落地的写不能把收藏标上").toBe(true);
  });
});

/**
 * REQ-A1172 — gesture / lifecycle leaks. Each of these is a listener or a latch that outlived
 * the surface that owned it, so the *next* use of the screen behaved as if the old one were
 * still going. The viewer's own gesture block already handled `pointercancel`; the crop drag
 * beside it and the slideshow latch did not.
 */
describe("PhotosApp — 手势与生命周期审计 (REQ-A1172)", () => {
  const realPhoto = (id: string, ts: number) => ({
    id,
    ts,
    emoji: "🌅",
    data: "data:image/png;base64,iVBORw0KGgo=", // `isRealPhoto` requires pixels
  });
  const cropOverlay = (h: { container: HTMLElement }) =>
    h.container.querySelector("[data-frame] div") as HTMLDivElement | null;

  test("删掉正在预览的照片会关掉幻灯片，下一张不会自己开动", async () => {
    // Three photos: one to delete and, since the slideshow control only exists with a
    // neighbour to advance to, two left behind to prove the latch did not survive.
    writeStoreValue(PHOTOS_KEY, [
      realPhoto("p1", 3000),
      realPhoto("p2", 2000),
      realPhoto("p3", 1000),
    ]);
    const host = render(PhotosApp);
    await tick();
    await fireEvent.click(firstTile(host)!);
    await tick();
    // Arm the slideshow, then delete the very photo being shown.
    await fireEvent.click(btnText(host, zh["photo.slidePlay"])!);
    await tick();
    expect(btnText(host, zh["photo.slideStop"]), "先确认幻灯片确实开着").toBeTruthy();
    await fireEvent.click(btnText(host, zh["photo.delete"])!);
    await tick();
    // Open a surviving photo: it must not inherit the dead photo's slideshow.
    await fireEvent.click(firstTile(host)!);
    await tick();
    expect(btnText(host, zh["photo.slidePlay"]), "新照片上幻灯片应是关的").toBeTruthy();
    expect(btnText(host, zh["photo.slideStop"])).toBeFalsy();
  });

  test("查看器的图片不发起原生拖拽（否则鼠标平移收不到 pointermove）", async () => {
    writeStoreValue(PHOTOS_KEY, [realPhoto("p1", Date.now())]);
    const host = render(PhotosApp);
    await tick();
    await fireEvent.click(firstTile(host)!);
    await tick();
    const img = host.container.querySelector("[data-viewer-stage] img") as HTMLImageElement | null;
    expect(img, "有字节的照片应以 <img> 呈现").toBeTruthy();
    // happy-dom 无法模拟原生拖拽，只能钉住让它不可能发生的那个属性：`<img>` 默认可拖拽，
    // 一旦它接管了指针，阶段元素上的 `pointermove` 就不再到达，平移手势整条失效。
    expect(img!.getAttribute("draggable")).toBe("false");
  });

  test("没有字节的录像说清原因，而不是只剩一个省略号", async () => {
    writeStoreValue(CAPTURES_KEY, [
      { id: "v1", ts: Date.now(), mime: "video/webm", durationMs: 3000, w: 1280, h: 720 },
    ]);
    const host = render(PhotosApp);
    await tick();
    await fireEvent.click(host.container.querySelector(`button[aria-label="${zh["a11y.video"]}"]`)!);
    // A seeded capture has no bytes in the media store, so the read honestly comes back empty.
    await vi.waitFor(() => {
      const msg = host.container.querySelector('[data-testid="video-msg"]');
      expect(msg?.textContent).toContain(zh["media.recordingMissing"]);
    });
    expect(txt(host)).not.toContain("…");
  });

  test("裁剪拖动在 pointercancel 后松手——后续 pointermove 不再牵动裁剪框", async () => {
    writeStoreValue(PHOTOS_KEY, [realPhoto("p1", Date.now())]);
    const host = render(PhotosApp);
    await tick();
    await fireEvent.click(firstTile(host)!);
    await tick();
    await fireEvent.click(btnText(host, zh["photo.edit"])!);
    await tick();
    expect(cropOverlay(host), "编辑器应画出裁剪框").toBeTruthy();
    // The drag bails on a 0×0 frame (happy-dom lays nothing out), so give it a real box.
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200, toJSON: () => ({}) } as DOMRect;
    };
    try {
      const handles = host.container.querySelectorAll(`button[aria-label="${zh["a11y.cropHandle"]}"]`);
      const se = handles[3] as HTMLButtonElement; // HANDLES order: nw, ne, sw, se
      await fireEvent.pointerDown(se, { clientX: 100, clientY: 100 });
      await tick();
      await fireEvent.pointerMove(window, { clientX: 80, clientY: 80 });
      await tick();
      const dragged = cropOverlay(host)!.style.width;
      expect(dragged, "拖动确实缩小了裁剪框").not.toBe("100%");
      // The browser takes the pointer away — `cancel`, never `up`.
      await fireEvent.pointerCancel(window);
      await tick();
      await fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
      await tick();
      expect(cropOverlay(host)!.style.width, "松手后指针再走不该还在拖").toBe(dragged);
    } finally {
      Element.prototype.getBoundingClientRect = real;
    }
  });
});
