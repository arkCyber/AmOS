/**
 * DOM tests for the Svelte 5 local media player (PlayerApp.svelte).
 *
 * Pure classification / queue / transport logic is unit-tested once against
 * lib/player.ts. Here we verify the screen wiring: the demo fallback playlist
 * when there is no bridge and no local media, play/pause toggling, track
 * skipping, aggregation of the app's own voice memos + camera videos, and that a
 * bridge denial is surfaced honestly (never masked by demo clips).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PlayerApp from "../src/svelte/PlayerApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { VMEMOS_KEY } from "../src/lib/voiceMemos";
import { CAPTURES_KEY } from "../src/lib/cameraCapture";
import { savePlayerPrefs } from "../src/lib/playerPrefs";
import { defaultMediaStore } from "../src/lib/mediaStore";

afterEach(() => {
  cleanup();
  setLocale("zh");
  window.localStorage.clear();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

type Host = { container: HTMLElement };
const title = (h: Host) => h.container.querySelector("p.text-lg")?.textContent?.trim() ?? "";
const btnIcon = (h: Host, name: string) =>
  [...h.container.querySelectorAll("button")].find((b) => b.getAttribute("data-icon") === name) as
    | HTMLButtonElement
    | undefined;
const rows = (h: Host) => [
  ...h.container.querySelectorAll('span[data-icon="musicNote"], span[data-icon="play"], span[data-icon="film"]'),
];

const seedMemo = () =>
  writeStoreValue(VMEMOS_KEY, [
    {
      id: "m1",
      title: "会议记录",
      createdAt: 1,
      durationMs: 3000,
      audio: { kind: "seed", seconds: 3, toneHz: 440 },
      sizeBytes: 10,
      mime: "audio/wav",
    },
  ]);

const seedCapture = () =>
  writeStoreValue(CAPTURES_KEY, [
    { id: "v1", ts: 2, mime: "video/webm", durationMs: 4000, w: 1280, h: 720 },
  ]);

describe("PlayerApp.svelte", () => {
  test("no bridge + empty library → demo playlist with a current track", async () => {
    const host = render(PlayerApp);
    await tick();
    expect(title(host).length).toBeGreaterThan(0);
    expect(host.container.querySelector("audio")).toBeTruthy();
    expect(rows(host).length).toBeGreaterThan(1);
    expect(btnIcon(host, "play")).toBeTruthy();
  });

  test("play button toggles to pause", async () => {
    const host = render(PlayerApp);
    await tick();
    expect(btnIcon(host, "play")).toBeTruthy();
    await fireEvent.click(btnIcon(host, "play") as HTMLButtonElement);
    await tick();
    expect(btnIcon(host, "pause")).toBeTruthy();
  });

  test("next changes the current track", async () => {
    const host = render(PlayerApp);
    await tick();
    const t0 = title(host);
    await fireEvent.click(btnIcon(host, "skipForward") as HTMLButtonElement);
    await tick();
    expect(title(host)).not.toBe(t0);
  });

  test("aggregates voice memos + camera video captures", async () => {
    seedMemo();
    seedCapture();
    const host = render(PlayerApp);
    await tick();
    expect(host.container.textContent).toContain("会议记录");
    // memo plays as audio first (files none → memos, then captures)
    expect(host.container.querySelector("audio")).toBeTruthy();
    // selecting the video row swaps in a <video> stage
    const filmRow = host.container.querySelector('span[data-icon="film"]')?.closest("button");
    expect(filmRow).toBeTruthy();
    await fireEvent.click(filmRow as HTMLButtonElement);
    await tick();
    expect(host.container.querySelector("video")).toBeTruthy();
  });

  test("a bridge denial is surfaced, not masked by demo clips", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: () => Promise.reject(new Error("media not authorized")),
    };
    const host = render(PlayerApp);
    await tick();
    await tick();
    expect(host.container.querySelector("audio")).toBeNull();
    expect(rows(host).length).toBe(0);
    expect(btnIcon(host, "skipForward")).toBeUndefined();
  });

  test("rescan picks up media added while the player is open", async () => {
    const host = render(PlayerApp);
    await tick();
    expect(host.container.textContent).not.toContain("会议记录");
    seedMemo();
    const refreshBtn = btnIcon(host, "rotateCcw");
    expect(refreshBtn).toBeTruthy();
    await fireEvent.click(refreshBtn as HTMLButtonElement);
    await tick();
    await tick();
    expect(host.container.textContent).toContain("会议记录");
  });

  test("a seeded video capture renders a video stage + video kind chip", async () => {
    seedCapture();
    const host = render(PlayerApp);
    await tick();
    expect(host.container.querySelector("video")).toBeTruthy();
    expect(host.container.textContent).toContain("视频");
  });

  test("rescan keeps the active track (does not recreate its object URL)", async () => {
    seedMemo();
    const host = render(PlayerApp);
    await tick();
    const src1 = host.container.querySelector("audio")?.getAttribute("src") ?? "";
    expect(src1).not.toBe("");
    await fireEvent.click(btnIcon(host, "rotateCcw") as HTMLButtonElement);
    await tick();
    await tick();
    const src2 = host.container.querySelector("audio")?.getAttribute("src") ?? "";
    expect(src2).toBe(src1);
  });

  test("the speed button cycles through the presets", async () => {
    const host = render(PlayerApp);
    await tick();
    const rateBtn = () => btnIcon(host, "rate");
    expect(rateBtn()?.textContent).toBe("1×");
    await fireEvent.click(rateBtn() as HTMLButtonElement);
    await tick();
    expect(rateBtn()?.textContent).toBe("1.25×");
  });

  test("restores a saved playhead on the matching track", async () => {
    seedMemo();
    savePlayerPrefs({ trackId: "memo:m1", positionSec: 42, volume: 1, muted: false, repeat: "all", shuffle: false });
    const host = render(PlayerApp);
    await tick();
    const audio = host.container.querySelector("audio");
    expect(audio).toBeTruthy();
    // The saved position is applied once metadata is known.
    await fireEvent(audio as HTMLAudioElement, new Event("loadedmetadata"));
    await tick();
    expect(host.container.textContent).toContain("0:42");
  });

  test("retry re-resolves a track whose bytes were missing", async () => {
    writeStoreValue(VMEMOS_KEY, [
      {
        id: "m7",
        title: "稍后",
        createdAt: 1,
        durationMs: 1000,
        audio: { kind: "recorded" },
        sizeBytes: 5,
        mime: "audio/webm",
      },
    ]);
    const host = render(PlayerApp);
    await tick();
    await tick();
    expect(host.container.textContent).toContain("无法读取该媒体");
    const retryBtn = [...host.container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "重试",
    ) as HTMLButtonElement | undefined;
    expect(retryBtn).toBeTruthy();
    await defaultMediaStore().put("m7", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }));
    await fireEvent.click(retryBtn as HTMLButtonElement);
    await tick();
    await tick();
    expect(host.container.querySelector("audio")?.getAttribute("src") ?? "").not.toBe("");
  });

  test("clicking the ACTIVE row restarts the same track from the top", async () => {
    seedMemo();
    savePlayerPrefs({ trackId: "memo:m1", positionSec: 42, volume: 1, muted: false, repeat: "all", shuffle: false });
    const host = render(PlayerApp);
    await tick();
    await tick();
    const audio = host.container.querySelector("audio");
    expect(audio?.getAttribute("src") ?? "").not.toBe("");
    await fireEvent(audio as HTMLAudioElement, new Event("loadedmetadata"));
    await tick();
    expect(host.container.textContent).toContain("0:42");
    // The first row IS the active one (its glyph is "play"): clicking it again
    // must rewind to 0:00 and keep playing — not act as a dead row.
    const activeRow = host.container.querySelector('span[data-icon="play"]')?.closest("button");
    expect(activeRow).toBeTruthy();
    await fireEvent.click(activeRow as HTMLButtonElement);
    await tick();
    expect(host.container.textContent).not.toContain("0:42");
    expect(host.container.textContent).toContain("会议记录");
    expect(btnIcon(host, "pause")).toBeTruthy();
  });

  test("a >MAX_PLAY_BYTES file shows the too-large badge up front", async () => {
    const bigItem = {
      id: "big1",
      name: "巨大演唱会.mp4",
      kind: "video",
      collection: "movies",
      uri: "file:///movies/big.mp4",
      mime: "video/mp4",
      size_bytes: 300 * 1024 * 1024, // > MAX_PLAY_BYTES (256 MiB)
      ts: 5,
    };
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string) =>
        cmd === "media_list" ? Promise.resolve([bigItem]) : Promise.resolve(null),
    };
    const host = render(PlayerApp);
    await tick();
    await tick();
    expect(host.container.textContent).toContain("巨大演唱会");
    expect(host.container.textContent).toContain("过大");
  });
});
