/**
 * DOM tests for the Svelte 5 magnifier (MagnifierApp.svelte) — CONTROL surface.
 *
 * Camera grant → the viewer controls appear; even without a working Canvas 2D /
 * camera (happy-dom) the UI still renders a demo badge + the zoom/brightness/
 * contrast sliders. We verify: the permission gate, moving the zoom slider
 * persists to amos.magnifier, and Reset restores the defaults. A stubbed
 * `getUserMedia` also lets us pin the acquisition effect's *dependencies*
 * (REQ-A1304). (The real magnified lens view needs Canvas 2D + a real camera →
 * device acceptance.)
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MagnifierApp from "../src/svelte/MagnifierApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { MAGNIFIER_SETTINGS_KEY, MAX_TONE, MIN_TONE } from "../src/lib/magnifier";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

afterEach(() => {
  cleanup();
  setLocale("zh");
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

// Camera-path instrumentation (REQ-A1304). `stops` counts `track.stop()` calls —
// the observable teardown of a live `MediaStream`.
let calls = 0;
let stops = 0;
beforeEach(() => {
  calls = 0;
  stops = 0;
});

/**
 * A real `MediaStream` (happy-dom type-checks `srcObject` against it) with
 * `getTracks` patched on, since happy-dom's stream has none and the component's
 * effect cleanup calls it.
 */
function makeStream(): MediaStream {
  const s = new MediaStream();
  (s as unknown as { getTracks: () => Array<{ stop: () => void }> }).getTracks = () => [
    { stop: () => void (stops += 1) },
  ];
  return s;
}

/** Install a working camera; every `getUserMedia` call is counted in `calls`. */
function setupCamera(stream: MediaStream) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => {
        calls += 1;
        return Promise.resolve(stream);
      },
    },
  });
}

/** Let the async `getUserMedia` chain and the effects flush. */
async function settle() {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
}

const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const inputByAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === aria) as
    HTMLInputElement | undefined;
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

async function grantCamera(h: { container: HTMLElement }) {
  await fireEvent.click(buttonContaining(h, "允许") as HTMLButtonElement);
}

describe("MagnifierApp.svelte (control surface)", () => {
  test("shows the camera permission gate before allowing", () => {
    const host = render(MagnifierApp);
    expect(buttonContaining(host, "允许")).toBeTruthy();
    expect(inputByAria(host, "放大倍数")).toBeUndefined();
  });

  test("after allowing, the demo viewer + sliders render", async () => {
    const host = render(MagnifierApp);
    await grantCamera(host);
    expect(txt(host)).toContain("演示画面"); // demo badge (no camera here)
    expect(inputByAria(host, "放大倍数")).toBeTruthy();
    expect(inputByAria(host, "亮度")).toBeTruthy();
    expect(inputByAria(host, "对比度")).toBeTruthy();
  });

  test("moving the zoom slider persists to amos.magnifier", async () => {
    const host = render(MagnifierApp);
    await grantCamera(host);
    const zoom = inputByAria(host, "放大倍数");
    await fireEvent.input(zoom as HTMLInputElement, { target: { value: "4" } });
    expect(txt(host)).toContain("4.0×");
    const stored = readStoreValue<{ zoom?: number }>(MAGNIFIER_SETTINGS_KEY, {});
    expect(stored.zoom).toBe(4);
  });

  test("the tone sliders expose the declared range and report the moved value", async () => {
    // REQ-A729: the sliders used to hardcode min=0/max=200 while the file's own
    // MIN_TONE/MAX_TONE declared the range; binding them keeps one source. And the
    // readout must follow the value (the control is live, not decorative).
    const host = render(MagnifierApp);
    await grantCamera(host);
    const bright = inputByAria(host, "亮度") as HTMLInputElement;
    const contrast = inputByAria(host, "对比度") as HTMLInputElement;
    for (const el of [bright, contrast]) {
      expect(el.min).toBe(String(MIN_TONE));
      expect(el.max).toBe(String(MAX_TONE));
    }
    await fireEvent.input(bright, { target: { value: "150" } });
    expect(txt(host)).toContain("150%");
    const stored = readStoreValue<{ brightness?: number }>(MAGNIFIER_SETTINGS_KEY, {});
    expect(stored.brightness).toBe(150);
  });

  test("reset restores the default zoom", async () => {
    const host = render(MagnifierApp);
    await grantCamera(host);
    const zoom = inputByAria(host, "放大倍数");
    await fireEvent.input(zoom as HTMLInputElement, { target: { value: "6" } });
    expect(txt(host)).toContain("6.0×");
    await fireEvent.click(buttonContaining(host, "复位") as HTMLButtonElement);
    expect(txt(host)).toContain("2.0×");
    const stored = readStoreValue<{ zoom?: number }>(MAGNIFIER_SETTINGS_KEY, {});
    expect(stored.zoom).toBe(2);
  });

  // The demo/live sentence is drawn **twice** on this screen: the corner badge
  // (`{t("magnifier.demo")}` in the markup — reactive, as the locale module
  // promises) and the footer hint. The footer used to be a `$state` holding the
  // *translated string*, so it kept whatever language was current when the camera
  // settled — one sentence in two languages at once (D-1 family: a value read
  // outside a reactive context). It is now a `$derived` over a key; this test
  // pins that the derived still re-keys.
  test("a live locale switch re-keys the footer hint, not just the corner badge", async () => {
    const host = render(MagnifierApp);
    await grantCamera(host);
    await tick();
    expect(txt(host).match(/演示画面/g)?.length).toBe(2);

    setLocale("en");
    await tick();

    // Both copies re-keyed — asserted as a count, so this cannot pass by the
    // sentence having simply disappeared from both places.
    expect(txt(host).match(/Demo scene/g)?.length).toBe(2);
    expect(txt(host).match(/演示画面/g)).toBeNull();
  });

  // --- camera acquisition --------------------------------------------------
  // This screen's own header says the camera path "needs device acceptance", so
  // nothing ever drove `getUserMedia` here — which is exactly why the acquisition
  // effect's *dependencies* were never pinned. It wrote the footer sentence via
  // `t()`, which reads the reactive locale, so the locale became a dependency of
  // camera acquisition: its cleanup stops the live `MediaStream`, so a UI language
  // switch tore the camera down and re-opened it (REQ-A1304).
  test("switching the UI language does not tear down the live camera", async () => {
    const stream = makeStream();
    setupCamera(stream);
    const host = render(MagnifierApp);
    await grantCamera(host);
    await settle();

    const video = host.container.querySelector("video") as HTMLVideoElement | null;
    expect(video).toBeTruthy();
    expect(video!.srcObject).toBe(stream); // the feed really is wired

    setLocale("en");
    await settle();

    expect(calls).toBe(1); // the camera is not re-opened
    expect(stops).toBe(0); // and the live stream is not stopped
    expect(video!.srcObject).toBe(stream);
    // …while the footer copy *does* re-key: the fix must not freeze it again.
    // (The camera never reports a frame in happy-dom, so the footer still reads
    // the "opening" sentence — that is the very string this leaf pins.)
    expect(txt(host)).toContain(en["magnifier.starting"]);
    expect(txt(host)).not.toContain(zh["magnifier.starting"]);
  });
});
