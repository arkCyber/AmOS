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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import PlayerApp from "../src/svelte/PlayerApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";
import { writeStoreValue } from "../src/lib/amosStore";
import { VMEMOS_KEY } from "../src/lib/voiceMemos";
import { CAPTURES_KEY } from "../src/lib/cameraCapture";
import { PLAYER_PREFS_KEY, savePlayerPrefs } from "../src/lib/playerPrefs";
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

  // REQ-A969: the repeat cycle (all/one/off), the boolean shuffle and the
  // six-way speed cycle all carried their state only in an opacity/colour class.
  // aria-pressed/aria-expanded are two-state, so a cycle's NAME must say the
  // current mode; and a constant aria-label OVERRIDES the visible "1×" text.
  test("the speed button's accessible name carries the current rate", async () => {
    // The visible text ("1×") is a speed, but a constant aria-label ("播放速度")
    // OVERRIDES element content for the accessible name — so AT heard the purpose
    // and never the value. The name must say which speed is selected.
    const host = render(PlayerApp);
    await tick();
    const rateBtn = () => btnIcon(host, "rate");
    expect(rateBtn()?.getAttribute("aria-label")).toBe(zh["player.rateValue"].replace("{rate}", "1×"));
    await fireEvent.click(rateBtn() as HTMLButtonElement);
    await tick();
    expect(rateBtn()?.getAttribute("aria-label")).toBe(zh["player.rateValue"].replace("{rate}", "1.25×"));
  });

  test("the shuffle button exposes its on/off state to AT", async () => {
    const host = render(PlayerApp);
    await tick();
    const shuffleBtn = () => btnIcon(host, "shuffle");
    expect(shuffleBtn()?.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(shuffleBtn() as HTMLButtonElement);
    await tick();
    expect(shuffleBtn()?.getAttribute("aria-pressed")).toBe("true");
    await fireEvent.click(shuffleBtn() as HTMLButtonElement);
    await tick();
    expect(shuffleBtn()?.getAttribute("aria-pressed")).toBe("false");
  });

  test("the repeat button's accessible name names the current mode", async () => {
    // A three-state cycle has no ARIA attribute for its state, so the NAME must
    // say which mode is on (--off/all/one), not a constant "循环模式".
    const host = render(PlayerApp);
    await tick();
    const repeatBtn = () => btnIcon(host, "repeat");
    expect(repeatBtn()?.getAttribute("aria-label")).toBe(zh["player.repeatAll"]);
    await fireEvent.click(repeatBtn() as HTMLButtonElement);
    await tick();
    expect(repeatBtn()?.getAttribute("aria-label")).toBe(zh["player.repeatOne"]);
    await fireEvent.click(repeatBtn() as HTMLButtonElement);
    await tick();
    expect(repeatBtn()?.getAttribute("aria-label")).toBe(zh["player.repeatOff"]);
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

  /**
   * The other half of the too-large story (docs/media-player.md §8): when the host **will**
   * serve the item, the screen must play it through the stream URL in bounded windows
   * instead of refusing it. Both directions are asserted in one place, because the point is
   * the *contrast*: the stream URL is not ours to revoke, while a blob we made is.
   */
  test("a >MAX_PLAY_BYTES file plays through the host's stream URL, which is never revoked", async () => {
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
    const streamed = "amos-media://movies/content%3A%2F%2Fmedia%2Fvideo%2F1234";
    const revoked: string[] = [];
    const created: string[] = [];
    const realRevoke = URL.revokeObjectURL;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = ((_b: Blob) => {
      const u = `blob:amos/${created.length}`;
      created.push(u);
      return u;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((u: string) => {
      revoked.push(u);
    }) as typeof URL.revokeObjectURL;
    try {
      (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
        invoke: (cmd: string) => {
          if (cmd === "media_list") return Promise.resolve([bigItem]);
          if (cmd === "media_stream_url") return Promise.resolve(streamed);
          return Promise.resolve(null);
        },
      };
      const host = render(PlayerApp);
      // The resolve is asynchronous (scan → `media_stream_url`), so wait for the *state*
      // rather than counting scheduler ticks — the tick count is not part of the contract.
      await waitFor(() =>
        expect(host.container.querySelector("video")?.getAttribute("src")).toBe(streamed),
      );
      expect(host.container.textContent).toContain("流式播放");
      expect(created).toEqual([]);
      host.unmount();
      // The host's URL is the host's to release — the player never made it.
      expect(revoked).not.toContain(streamed);

      // Contrast, so the assertion above cannot pass vacuously: a blob the player DID
      // create is still revoked on unmount. The no-bridge demo playlist is exactly that
      // path — a synthesized WAV materialised as an object URL.
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      const second = render(PlayerApp);
      await waitFor(() => expect(created.length).toBeGreaterThan(0));
      second.unmount();
      expect(revoked).toContain(created[created.length - 1]);
    } finally {
      URL.revokeObjectURL = realRevoke;
      URL.createObjectURL = realCreate;
    }
  });

  // REQ-A1421: `lib/playerPrefs.ts::savePlayerPrefs` signs `void` and dropped the
  // store's verdict, so a refused session write (which track was playing, the
  // playhead, volume/mute/repeat/shuffle) showed the new state on the controls and
  // said nothing — reopening the app then came back on the defaults, contradicting
  // the lib's own promise that the session "must survive a remount".
  const REFUSED = zh["common.storeWriteFailed"];
  const shuffleBtn = (h: Host) => btnIcon(h, "shuffle") as HTMLButtonElement;

  test("a refused session write is reported (the session is the user's own state)", async () => {
    const restore = failWritesFor(PLAYER_PREFS_KEY);
    try {
      const host = render(PlayerApp);
      await tick();
      // The demo playlist is a library, so the mount-flush persist has run.
      expect(title(host).length).toBeGreaterThan(0);
      expect(host.container.textContent).toContain(REFUSED);
      expect(window.localStorage.getItem(PLAYER_PREFS_KEY)).toBeNull();
    } finally {
      restore();
    }
  });

  test("toggling shuffle on a refused store shows the choice and says it did not land", async () => {
    const restore = failWritesFor(PLAYER_PREFS_KEY);
    try {
      const host = render(PlayerApp);
      await tick();
      expect(shuffleBtn(host).getAttribute("aria-pressed")).toBe("false");
      await fireEvent.click(shuffleBtn(host));
      await tick();
      // The control honestly reflects the user's intent (in-memory)...
      expect(shuffleBtn(host).getAttribute("aria-pressed")).toBe("true");
      // ...and the screen says the store did not take it.
      expect(host.container.textContent).toContain(REFUSED);
      expect(window.localStorage.getItem(PLAYER_PREFS_KEY)).toBeNull();
    } finally {
      restore();
    }
  });

  test("a landed session write says nothing (control)", async () => {
    const host = render(PlayerApp);
    await tick();
    await fireEvent.click(shuffleBtn(host));
    await tick();
    expect(host.container.textContent).not.toContain(REFUSED);
    expect(JSON.parse(window.localStorage.getItem(PLAYER_PREFS_KEY) ?? "null")?.shuffle).toBe(true);
  });
});
