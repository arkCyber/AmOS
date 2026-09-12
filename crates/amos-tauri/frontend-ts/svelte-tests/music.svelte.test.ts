/**
 * DOM tests for the Svelte 5 music screen (MusicApp.svelte).
 *
 * Pure playback/navigation/lyric logic is unit-tested once against lib/music.ts
 * (shared by the React + Svelte UIs). Here we verify the Svelte UI wiring: a
 * seeded current track, play/pause toggle, and that next/prev change the track.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import MusicApp from "../src/svelte/MusicApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";

afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const bigTitle = (h: { container: HTMLElement }) =>
  h.container.querySelector("p.text-center.text-lg")?.textContent ?? "";
const playBtn = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find((b) =>
    b.getAttribute("aria-label") === "play" || b.getAttribute("aria-label") === "pause",
  ) as HTMLButtonElement | undefined;
const btnByIcon = (h: { container: HTMLElement }, name: string) =>
  [...h.container.querySelectorAll("button")].find((b) => b.getAttribute("data-icon") === name);

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

describe("MusicApp.svelte", () => {
  test("a rejected delete keeps the track and reports it", async () => {
    const restore = failWritesFor("amos.music");
    try {
      const host = render(MusicApp);
      const before = bigTitle(host);
      await fireEvent.click(btnByIcon(host, "x") as HTMLButtonElement);
      // The track is still in the store, so the playlist must not drop it.
      expect(txt(host)).toContain("本机存储写入失败");
      expect(bigTitle(host)).toBe(before);
    } finally {
      restore();
    }
  });

  test("an intentionally emptied playlist is not re-seeded with demo tracks", () => {
    window.localStorage.setItem("amos.music", "[]");
    const host = render(MusicApp);
    expect(txt(host)).toContain("暂无歌曲");
    expect(txt(host)).not.toContain("晨光");
    expect(readStoreValue<unknown>("amos.music", null)).toEqual([]);
  });

  test("seeded playlist shows a current track + rows", () => {
    const host = render(MusicApp);
    expect(bigTitle(host).length).toBeGreaterThan(0);
    // several playlist rows exist (each row carries a play/music-note indicator)
    const rows = [
      ...host.container.querySelectorAll('span[data-icon="musicNote"], span[data-icon="play"]'),
    ];
    expect(rows.length).toBeGreaterThan(1);
  });

  test("play button toggles to pause", async () => {
    const host = render(MusicApp);
    expect(playBtn(host)?.getAttribute("aria-label")).toBe("play");
    await fireEvent.click(playBtn(host) as HTMLButtonElement);
    expect(playBtn(host)?.getAttribute("aria-label")).toBe("pause");
  });

  test("next changes the current track", async () => {
    const host = render(MusicApp);
    const t0 = bigTitle(host);
    const next = btnByIcon(host, "skipForward");
    expect(next).toBeTruthy();
    await fireEvent.click(next as HTMLButtonElement);
    expect(bigTitle(host)).not.toBe(t0);
  });
});
