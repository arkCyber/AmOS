/**
 * DOM tests for the Svelte 5 camera screen (CameraApp.svelte).
 *
 * Pure control/capture math is unit-tested once against lib/camera.ts /
 * lib/cameraCapture.ts (shared by React + Svelte). Here we verify the Svelte UI
 * wiring for the paths that run headlessly:
 *   • no camera (happy-dom default) → demo viewfinder + disabled shutter/flip;
 *   • a stubbed navigator.mediaDevices.getUserMedia → live mode: shutter saves a
 *     photo into Photos, grid overlay, burst selectable, quality re-acquires,
 *     and video mode records into the in-camera library (stub MediaRecorder).
 * Real viewfinder pixels / torch / recording bytes need a device.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import CameraApp from "../src/svelte/CameraApp.svelte";
import { PHOTOS_KEY } from "../src/lib/photos";

afterEach(() => {
  cleanup();
  tearDownMedia();
  gumCalls = 0;
  window.localStorage.removeItem(PHOTOS_KEY);
  window.localStorage.removeItem("amos.captures");
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === aria,
  ) as HTMLButtonElement | undefined;

const FAKE_STREAM = {
  getTracks: () => [{ stop: () => {} }],
  getVideoTracks: () => [{ applyConstraints: () => Promise.resolve() }],
};

let gumCalls = 0;

function setupMedia() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: (c: { video?: { facingMode?: string } }) => {
        gumCalls += 1;
        return Promise.resolve(FAKE_STREAM);
      },
    },
  });
}
function tearDownMedia() {
  try {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  } catch {
    /* ignore */
  }
}

/** Let Svelte flush effects + the async getUserMedia resolution apply. */
async function settle() {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
}

async function renderLive() {
  setupMedia();
  const host = render(CameraApp);
  await settle();
  return host;
}

describe("CameraApp.svelte (offline / control surface)", () => {
  test("no camera → demo viewfinder, hint + disabled shutter/flip", async () => {
    const host = render(CameraApp);
    await settle();
    expect(txt(host)).toContain("当前环境无摄像头"); // camera.noCamera
    expect(txt(host)).toContain("🏔️"); // demo viewfinder
    expect(btnAria(host, "shutter")?.disabled).toBe(true);
    expect(btnAria(host, "翻转摄像头")?.disabled).toBe(true);
    // mode tabs still render
    expect(btnAria(host, "拍照")).toBeTruthy();
    expect(btnAria(host, "视频")).toBeTruthy();
  });

  test("live feed enables the shutter; a tap saves a photo into Photos", async () => {
    const host = await renderLive();
    const shot = btnAria(host, "shutter");
    expect(shot?.disabled).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(PHOTOS_KEY) ?? "[]").length).toBe(0);
    await fireEvent.click(shot as HTMLButtonElement);
    await settle();
    const stored = JSON.parse(window.localStorage.getItem(PHOTOS_KEY) ?? "[]") as unknown[];
    expect(stored.length).toBe(1);
    expect(txt(host)).toContain("已保存到相册"); // camera.saved
  });

  test("grid toggle overlays the rule-of-thirds lines (live)", async () => {
    const host = await renderLive();
    expect(host.container.querySelector('[class*="left-1/3"]')).toBeNull();
    await fireEvent.click(btnAria(host, "网格") as HTMLButtonElement);
    await settle();
    expect(host.container.querySelector('[class*="left-1/3"]')).toBeTruthy();
  });

  test("aspect chip cycles the ratio (4:3 → square → 16:9)", async () => {
    const host = await renderLive();
    const aspect = btnAria(host, "画面比例");
    expect(aspect?.textContent?.trim()).toBe("4:3");
    await fireEvent.click(aspect as HTMLButtonElement); // → square
    await settle();
    expect(btnAria(host, "画面比例")?.textContent?.trim()).toBe("□");
  });

  test("HDR toggle shows then clears the honest capability note", async () => {
    const host = await renderLive();
    expect(txt(host)).not.toContain("HDR 需支持");
    await fireEvent.click(btnAria(host, "HDR") as HTMLButtonElement);
    await settle();
    expect(txt(host)).toContain("HDR 需支持"); // camera.hdrNote
    await fireEvent.click(btnAria(host, "HDR") as HTMLButtonElement);
    await settle();
    expect(txt(host)).not.toContain("HDR 需支持");
  });

  test("flip lens re-acquires the stream and mirrors the front preview", async () => {
    const host = await renderLive();
    const before = gumCalls;
    // Back lens: not mirrored.
    const video = host.container.querySelector("video");
    expect(video?.classList.contains("-scale-x-100")).toBe(false);
    await fireEvent.click(btnAria(host, "翻转摄像头") as HTMLButtonElement);
    await settle();
    expect(gumCalls).toBe(before + 1); // re-requested for the new lens
    expect(host.container.querySelector("video")?.classList.contains("-scale-x-100")).toBe(true);
  });

  test("burst chip is selectable in photo mode (live)", async () => {
    const host = await renderLive();
    const burst = btnAria(host, "连拍");
    expect(burst?.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(burst as HTMLButtonElement);
    await settle();
    expect(btnAria(host, "连拍")?.getAttribute("aria-pressed")).toBe("true");
  });

  test("quality chip cycles tiers and re-acquires the stream", async () => {
    const host = await renderLive();
    const before = gumCalls;
    const q = btnAria(host, "画质");
    expect(q?.textContent?.trim()).toBe("HD");
    await fireEvent.click(q as HTMLButtonElement);
    await settle();
    expect(btnAria(host, "画质")?.textContent?.trim()).toBe("FHD");
    expect(gumCalls).toBe(before + 1); // re-requested at the new resolution
  });

  test("tap-to-focus aims an AF box; a second tap locks AE/AF (live)", async () => {
    const host = await renderLive();
    const app = host.container.querySelector('[role="application"]') as HTMLElement;
    expect(app).toBeTruthy();
    // stub a real viewfinder rect so the pure coordinate mapping runs in jsdom
    Object.defineProperty(app, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }),
    });
    const hasAfBox = () =>
      host.container.querySelector('.border-yellow-400, .border-amber-300') !== null;
    expect(hasAfBox()).toBe(false);
    // a quick, still single tap → unlocked AF box
    await fireEvent.pointerDown(app, { clientX: 50, clientY: 50, pointerId: 1 });
    await fireEvent.pointerUp(app, { clientX: 50, clientY: 50, pointerId: 1 });
    await settle();
    expect(hasAfBox()).toBe(true);
    expect(txt(host)).not.toContain("AE/AF LOCKED");
    // two slow taps on ~the same point lock AE/AF (must exceed the 300 ms
    // double-tap window so the second tap is a focus/lock tap, not a zoom)
    await new Promise<void>((r) => setTimeout(r, 350));
    await fireEvent.pointerDown(app, { clientX: 51, clientY: 51, pointerId: 2 });
    await fireEvent.pointerUp(app, { clientX: 51, clientY: 51, pointerId: 2 });
    await settle();
    expect(txt(host)).toContain("AE/AF LOCKED");
    expect(host.container.querySelector('.border-amber-300')).toBeTruthy();
  });

  test("a rapid double-tap does not lock focus (it is the zoom gesture)", async () => {
    const host = await renderLive();
    const app = host.container.querySelector('[role="application"]') as HTMLElement;
    Object.defineProperty(app, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }),
    });
    // two taps in quick succession (<300 ms): the first aims, the second is a
    // double-tap → focus is NOT applied a second time, so it never locks.
    await fireEvent.pointerDown(app, { clientX: 50, clientY: 50, pointerId: 1 });
    await fireEvent.pointerUp(app, { clientX: 50, clientY: 50, pointerId: 1 });
    await fireEvent.pointerDown(app, { clientX: 50, clientY: 50, pointerId: 2 });
    await fireEvent.pointerUp(app, { clientX: 50, clientY: 50, pointerId: 2 });
    await settle();
    expect(txt(host)).not.toContain("AE/AF LOCKED");
  });
});

/** Minimal MediaRecorder stand-in so video recording works headless. */
class FakeMediaRecorder {
  static isTypeSupported = () => true;
  mimeType: string;
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream, opts: { mimeType?: string } = {}) {
    this.mimeType = opts.mimeType ?? "video/webm";
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state !== "inactive") {
      this.state = "inactive";
      this.onstop?.();
    }
  }
}

describe("CameraApp.svelte (video library)", () => {
  test("video mode records and lands in the in-camera library", async () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    const host = await renderLive();
    // Switch to Video.
    await fireEvent.click(btnAria(host, "视频") as HTMLButtonElement);
    await settle();
    expect(btnAria(host, "视频")?.getAttribute("aria-selected")).toBe("true");
    // Start recording (shutter toggles record in video mode).
    await fireEvent.click(btnAria(host, "shutter") as HTMLButtonElement);
    await settle();
    expect(txt(host)).toContain("录制中…");
    // Stop → persists and the library filmstrip appears.
    await fireEvent.click(btnAria(host, "shutter") as HTMLButtonElement);
    await settle();
    const stored = JSON.parse(window.localStorage.getItem("amos.captures") ?? "[]") as unknown[];
    expect(stored.length).toBe(1);
    expect(btnAria(host, "媒体库")).toBeTruthy();
  });
});
