/**
 * photos-live-store.svelte.test.ts — the Photos album must FOLLOW `amos.photos`, not
 * photograph it (REQ-A1354 ∕ F-SH-618).
 *
 * `amos.photos` has **two** writers in one session, and only one of them is this screen:
 *
 *   * this screen's own verbs (`add` ∕ delete ∕ batch favourite ∕ the editor's 存储 …) go
 *     through `persist()`, which writes the key *and* assigns its own `list` copy — so a
 *     write from here is indistinguishable from a write that was followed;
 *   * the Camera's shutter (`CameraApp.doCapture`) writes the shot into the **same**
 *     album, and the Camera's last-photo thumbnail calls `openPhoto(last.id)`
 *     (`appLinks.openPhoto`) — it writes the `photos` deep-link channel *and* opens this
 *     app, i.e. it deliberately asks *this* screen to reveal what it just stored.
 *
 * `PhotosApp` read the key once at mount (`let list = $state(seed)`) and never
 * subscribed. The two screens are on stage together on a tablet: Photos as the surface
 * with the Camera in the **Slide Over** panel (or as the split's second pane). There,
 * `open("photos")` re-commits the same `{kind:"app", id:"photos"}` — for the split it is
 * refused outright by `isSplittablePair` — so nothing remounts, this screen keeps its
 * mount-time `list`, and the deep link's own lookup
 * (`const target = list.find((p) => p.id === v.photoId)`, `PhotosApp.svelte:401`)
 * resolves the fresh id against the pre-write array and honestly decides the photo does
 * not exist. The shutter said 「已保存到相册」; the album that owns the photos never hears.
 *
 * Why the existing cases cannot see it: `photos.svelte.test.ts` writes the key **before**
 * `render`, and its deep-link cases (`REQ-A358`) set the channel to an id the mount-time
 * list *already* holds — so the writer and the reader are never both after mount, and a
 * value that never changes is indistinguishable from one that is followed.
 * `camera.svelte.test.ts` mounts the Camera alone.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PhotosApp from "../src/svelte/PhotosApp.svelte";
import { PHOTOS_KEY, normalizePhotos } from "../src/lib/photos";
import type { Photo } from "../src/lib/photos";
import { readStoreValue, writeStoreValueChecked } from "../src/lib/amosStore";
import { photosChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { setLocale } from "../src/svelte/locale.svelte";

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const chipText = (h: { container: HTMLElement }, starts: string) =>
  [...h.container.querySelectorAll("button")]
    .map((b) => (b.textContent ?? "").trim())
    .find((s) => s.startsWith(starts)) ?? "";

/**
 * Take a shot the way `CameraApp.doCapture` does — a **second writer** outside this
 * component: read the shared album, prepend, write it back. Returns the new id.
 * (The Camera's `[photo, ...list]` is the exact shape; the demo/gradient fallback is used
 * so no pixel data is needed, which keeps `LazyImage` out of the assertion.)
 */
function cameraSavesPhoto(emoji: string, id = `shot-${emoji}`): string {
  const list = normalizePhotos(readStoreValue<unknown>(PHOTOS_KEY, []));
  const photo: Photo = { id, ts: Date.now(), emoji };
  expect(writeStoreValueChecked(PHOTOS_KEY, [photo, ...list])).toBe(true);
  return id;
}

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

describe("PhotosApp.svelte — the album follows amos.photos (REQ-A1354)", () => {
  test("a shot the camera saved while Photos is on screen is listed without a remount", async () => {
    window.localStorage.setItem(PHOTOS_KEY, JSON.stringify([{ id: "old", ts: 1, emoji: "🌅" }]));
    const host = render(PhotosApp);
    await tick();
    expect(chipText(host, "全部")).toBe("全部 (1)");

    cameraSavesPhoto("🆕");
    await tick();

    expect(chipText(host, "全部")).toBe("全部 (2)");
    expect(txt(host)).toContain("🆕");
  });

  test("the camera's last-photo deep link reveals the shot it just saved", async () => {
    window.localStorage.setItem(PHOTOS_KEY, JSON.stringify([{ id: "old", ts: 1, emoji: "🌅" }]));
    const host = render(PhotosApp);
    await tick();

    // Write, *then* link — the Camera's real order: the shutter stores the shot, and a
    // later tap on its thumbnail hands the id back to this screen.
    const id = cameraSavesPhoto("🆕");
    await tick();
    photosChannel().set({ photoId: id, nonce: 1 });
    await tick();

    // The viewer's own counter: `1 / 2` means it opened the linked (older) shot, not the
    // newest — and there are two now, so it was not looking at a stale one-item album.
    expect(txt(host), `viewer should open the linked shot — got: ${txt(host)}`).toContain("1 / 2");
  });

  test("an id nobody has is still ignored (no phantom photo)", async () => {
    window.localStorage.setItem(PHOTOS_KEY, JSON.stringify([{ id: "old", ts: 1, emoji: "🌅" }]));
    const host = render(PhotosApp);
    await tick();

    photosChannel().set({ photoId: "no-such-photo-id", nonce: 7 });
    await tick();

    expect(chipText(host, "全部")).toBe("全部 (1)");
    expect(txt(host)).not.toMatch(/\d+ \/ \d+/);
  });

  test("complement: the screen's own ＋ 拍照 still writes the key and lists the shot", async () => {
    const host = render(PhotosApp);
    await tick();
    expect(chipText(host, "全部")).toBe("全部 (8)"); // the demo seed

    await fireEvent.click(
      [...host.container.querySelectorAll("button")].find(
        (b) => (b.textContent ?? "").trim() === "＋ 拍照",
      ) as HTMLButtonElement,
    );
    await tick();

    expect(chipText(host, "全部")).toBe("全部 (9)");
    expect(normalizePhotos(readStoreValue<unknown>(PHOTOS_KEY, [])).length).toBe(9);
  });
});
