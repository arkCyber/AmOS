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
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(() => {
  cleanup();
  setLocale("zh");
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === aria) as
    HTMLButtonElement | undefined;
const firstTile = (h: { container: HTMLElement }) =>
  h.container.querySelector(".grid button") as HTMLButtonElement | null;

describe("PhotosApp.svelte", () => {
  test("seeded gallery is non-empty", () => {
    const host = render(PhotosApp);
    expect(txt(host)).not.toContain("暂无照片");
    expect(firstTile(host)).toBeTruthy();
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
});
