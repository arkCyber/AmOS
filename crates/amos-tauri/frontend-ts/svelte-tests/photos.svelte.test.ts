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
import { setFormFactor } from "../src/lib/desktopApps";

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

