/**
 * photos-live-captures.svelte.test.ts — the Photos album's video grid must FOLLOW
 * `amos.captures`, not photograph it (REQ-A1466 ∕ F-SH-735).
 *
 * The photo half of this screen was made store-driven by REQ-A1354 ∕ F-SH-618 (that
 * round's own comment sits at `PhotosApp.svelte:117`-`:132`, and its test is
 * `photos-live-store.svelte.test.ts`). The **video** half is a different key —
 * `amos.captures` — and it was left reading once, at mount:
 *
 *     let vids = $state<VideoCapture[]>(listCaptures());   // PhotosApp.svelte:147, pre-fix
 *
 * `listCaptures()` is a one-shot `readStoreValue` of `amos.captures`
 * (`lib/cameraCapture.ts:70`). Its two writers are these same two screens:
 * `CameraApp.endRecord` → `persistVideoCapture`, and `PhotosApp.deleteVideo` →
 * `removeVideoCapture`. On a tablet they are on stage together — Photos as the
 * surface, the Camera in the Slide Over panel (or as the split's second pane). There,
 * recording or deleting a clip writes `amos.captures`, and nothing remounts either
 * screen, so Photos' `🎬 (N)` chip and video tiles, and the Camera's filmstrip
 * (`CameraApp.svelte:183`, pre-fix: `let captures = $state(listCaptures())`), keep
 * describing the library as it was when they opened.
 *
 * Why the existing cases cannot see it: `photos.svelte.test.ts` and
 * `photos-live-store.svelte.test.ts` only ever write `amos.photos`;
 * `camera.svelte.test.ts` mounts the Camera alone. So a writer and this reader are
 * never both mounted, and a value that never changes is indistinguishable from a value
 * that is followed.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PhotosApp from "../src/svelte/PhotosApp.svelte";
import CameraApp from "../src/svelte/CameraApp.svelte";
import { zh } from "../src/i18n/locales/zh";
import { CAPTURES_KEY, normalizeCaptures } from "../src/lib/cameraCapture";
import type { VideoCapture } from "../src/lib/cameraCapture";
import { readStoreValue, writeStoreValueChecked } from "../src/lib/amosStore";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { setLocale } from "../src/svelte/locale.svelte";

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const chipText = (h: { container: HTMLElement }, starts: string) =>
  [...h.container.querySelectorAll("button")]
    .map((b) => (b.textContent ?? "").trim())
    .find((s) => s.startsWith(starts)) ?? "";
const videoTiles = (h: { container: HTMLElement }) =>
  h.container.querySelectorAll('button[aria-label="播放视频"]').length;
const favButtons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll<HTMLButtonElement>('button[aria-label="收藏视频"]')];
const btnAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === aria) as
    | HTMLButtonElement
    | undefined;
/** The Camera's video filmstrip: one tile per clip in `amos.captures`. */
const filmstrip = (h: { container: HTMLElement }) =>
  h.container.querySelectorAll(`button[aria-label="${zh["camera.library"]!}"]`).length;

/**
 * The write `CameraApp.endRecord` makes — a **second writer** outside this component:
 * read the shared library, prepend, write it back. Returns the new id.
 */
function cameraRecordsVideo(id = "cap-new", ts = Date.now()): string {
  const list = normalizeCaptures(readStoreValue<unknown>(CAPTURES_KEY, []));
  const cap: VideoCapture = { id, ts, mime: "video/webm", durationMs: 1000 };
  expect(writeStoreValueChecked(CAPTURES_KEY, [cap, ...list])).toBe(true);
  return id;
}

/** The write `CameraApp.delCapture` makes — a second writer outside this component. */
function cameraDeletesVideo(id: string): void {
  const next = normalizeCaptures(readStoreValue<unknown>(CAPTURES_KEY, [])).filter((c) => c.id !== id);
  expect(writeStoreValueChecked(CAPTURES_KEY, next)).toBe(true);
}

const oneCapture = (id = "cap-old", ts = 1): VideoCapture => ({
  id,
  ts,
  mime: "video/webm",
  durationMs: 1000,
});

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  setLocale("zh");
});
afterEach(() => {
  cleanup();
  resetPropsChannels();
  setLocale("zh");
});

describe("PhotosApp.svelte — the video grid follows amos.captures (REQ-A1466)", () => {
  test("a clip the camera saved while Photos is on screen is listed without a remount", async () => {
    window.localStorage.setItem(CAPTURES_KEY, JSON.stringify([oneCapture()]));
    const host = render(PhotosApp);
    await tick();
    expect(chipText(host, "🎬")).toBe("🎬 (1)");
    expect(videoTiles(host)).toBe(1);

    cameraRecordsVideo("cap-new");
    await tick();

    expect(chipText(host, "🎬"), `grid should follow the library — got: ${txt(host)}`).toBe("🎬 (2)");
    expect(videoTiles(host)).toBe(2);
  });

  test("a clip the camera deleted while Photos is on screen leaves the grid", async () => {
    window.localStorage.setItem(
      CAPTURES_KEY,
      JSON.stringify([oneCapture("cap-a", 2), oneCapture("cap-b", 1)]),
    );
    const host = render(PhotosApp);
    await tick();
    expect(chipText(host, "🎬")).toBe("🎬 (2)");

    cameraDeletesVideo("cap-b");
    await tick();

    // The library holds one clip now, so the chip says 1 and the grid draws one tile —
    // it must not keep offering a tile whose bytes were already unlinked.
    expect(chipText(host, "🎬")).toBe("🎬 (1)");
    expect(videoTiles(host)).toBe(1);
  });

  test("complement: this screen's own ♥ verb still writes the key and moves the tile", async () => {
    window.localStorage.setItem(CAPTURES_KEY, JSON.stringify([oneCapture()]));
    const host = render(PhotosApp);
    await tick();
    expect(favButtons(host)[0]?.textContent?.trim()).toBe("♡");

    await fireEvent.click(favButtons(host)[0]!);
    await tick();

    expect(favButtons(host)[0]?.textContent?.trim()).toBe("♥");
    expect(normalizeCaptures(readStoreValue<unknown>(CAPTURES_KEY, []))[0]?.fav).toBe(true);
  });
});

describe("CameraApp.svelte — the filmstrip follows amos.captures too (REQ-A1466)", () => {
  test("a clip Photos deleted while the camera is on screen leaves the filmstrip", async () => {
    window.localStorage.setItem(
      CAPTURES_KEY,
      JSON.stringify([oneCapture("cap-a", 2), oneCapture("cap-b", 1)]),
    );
    const host = render(CameraApp);
    await tick();
    await fireEvent.click(btnAria(host, zh["camera.video"]!)!);
    await tick();
    expect(filmstrip(host)).toBe(2);

    cameraDeletesVideo("cap-b");
    await tick();

    expect(filmstrip(host)).toBe(1);
  });
});
