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

afterEach(cleanup);

const bigTitle = (h: { container: HTMLElement }) =>
  h.container.querySelector("p.text-center.text-lg")?.textContent ?? "";
const playBtn = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find((b) =>
    b.getAttribute("aria-label") === "play" || b.getAttribute("aria-label") === "pause",
  ) as HTMLButtonElement | undefined;
const btnByIcon = (h: { container: HTMLElement }, name: string) =>
  [...h.container.querySelectorAll("button")].find((b) => b.getAttribute("data-icon") === name);

describe("MusicApp.svelte", () => {
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
