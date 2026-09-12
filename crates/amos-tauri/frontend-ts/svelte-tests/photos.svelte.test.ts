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

afterEach(() => {
  cleanup();
  setLocale("zh");
  window.localStorage.clear();
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
    expect(host.container.querySelector('button[aria-label="video"]')).toBeTruthy();
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
        expect(host.container.querySelector('[aria-label="native photos"]')).toBeTruthy();
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
      expect(host.container.querySelector('[aria-label="native photos"]')).toBeNull();

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
