import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import CameraApp from "../components/CameraApp";
import { PHOTOS_KEY } from "../lib/photos";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
let lastFacing: string | null = null;
let gumCalls = 0;
let savedLocale: string | null | undefined;

const FAKE_STREAM = {
  getTracks: () => [{ stop: () => {} }],
  getVideoTracks: () => [{ applyConstraints: () => Promise.resolve() }],
};

function setupMedia() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: (c: { video?: { facingMode?: string } }) => {
        gumCalls += 1;
        lastFacing = c?.video?.facingMode ?? null;
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

async function mount() {
  if (savedLocale === undefined) savedLocale = window.localStorage.getItem("amos-ui.locale");
  window.localStorage.setItem("amos-ui.locale", "en");
  window.localStorage.setItem("amos.permissions", JSON.stringify({ camera: ["camera"] }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <CameraApp />
      </I18nProvider>,
    );
  });
  await act(async () => {});
  mounted.push({ root, host });
  return host;
}

const byAria = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll<HTMLElement>("button")).find(
    (b) => b.getAttribute("aria-label") === label,
  ) as HTMLElement | null;
const click = async (el: HTMLElement | null) => {
  expect(el).toBeTruthy();
  await act(async () => el!.click());
  await act(async () => {});
};

afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  tearDownMedia();
  gumCalls = 0;
  lastFacing = null;
  if (savedLocale !== undefined) {
    if (savedLocale === null) window.localStorage.removeItem("amos-ui.locale");
    else window.localStorage.setItem("amos-ui.locale", savedLocale);
    savedLocale = undefined;
  }
  window.localStorage.removeItem("amos.permissions");
  window.localStorage.removeItem(PHOTOS_KEY);
  window.localStorage.removeItem("amos.captures");
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
});

/** Minimal MediaRecorder stand-in for headless video recording. */
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
    this.ondataavailable?.({ data: new Blob(["vid"], { type: this.mimeType }) });
  }
  stop() {
    if (this.state !== "inactive") {
      this.state = "inactive";
      this.onstop?.();
    }
  }
}

describe("CameraApp iPhone-style controls", () => {
  test("flip switches lenses (environment→user), mirrors the preview, and re-acquires", async () => {
    setupMedia();
    const host = await mount();
    expect(gumCalls).toBe(1);
    expect(lastFacing).toBe("environment");

    const flip = byAria(host, "Flip camera");
    await click(flip);
    expect(gumCalls).toBe(2);
    expect(lastFacing).toBe("user");
    const video = host.querySelector("video");
    expect(video?.className ?? "").toContain("-scale-x-100"); // mirrored selfie
  });

  test("zoom / aspect / timer chips cycle their labels", async () => {
    setupMedia();
    const host = await mount();

    const zoom = byAria(host, "Zoom");
    expect(zoom?.textContent?.trim()).toBe("1×");
    await click(zoom);
    expect(byAria(host, "Zoom")?.textContent?.trim()).toBe("2×");
    await click(byAria(host, "Zoom"));
    expect(byAria(host, "Zoom")?.textContent?.trim()).toBe("3×");
    await click(byAria(host, "Zoom"));
    expect(byAria(host, "Zoom")?.textContent?.trim()).toBe("1×");

    const aspect = byAria(host, "Aspect ratio");
    expect(aspect?.textContent?.trim()).toBe("4:3");
    await click(aspect);
    expect(byAria(host, "Aspect ratio")?.textContent?.trim()).toBe("□");
    await click(byAria(host, "Aspect ratio"));
    expect(byAria(host, "Aspect ratio")?.textContent?.trim()).toBe("16:9");

    const timer = byAria(host, "Timer");
    await click(timer);
    expect(byAria(host, "Timer")?.textContent?.trim()).toBe("⏱3");
    await click(byAria(host, "Timer"));
    expect(byAria(host, "Timer")?.textContent?.trim()).toBe("⏱10");
  });

  test("grid toggle overlays rule-of-thirds lines", async () => {
    setupMedia();
    const host = await mount();
    expect(host.querySelector('[class*="left-1/3"]')).toBeNull();
    await click(byAria(host, "Grid"));
    expect(host.querySelector('[class*="left-1/3"]')).toBeTruthy();
  });

  test("shutter saves a capture into Photos (demo frame when no real pixels)", async () => {
    setupMedia();
    const host = await mount();
    expect(JSON.parse(window.localStorage.getItem(PHOTOS_KEY) ?? "[]").length).toBe(0);
    await click(byAria(host, "shutter"));
    const stored = JSON.parse(window.localStorage.getItem(PHOTOS_KEY) ?? "[]") as { data?: string }[];
    expect(stored.length).toBe(1);
    expect(host.textContent).toContain("Saved to Photos");
  });

  test("zoom slider drives the continuous zoom readout", async () => {
    setupMedia();
    const host = await mount();
    const slider = host.querySelector<HTMLInputElement>('input[aria-label="zoom slider"]');
    expect(slider).toBeTruthy();
    // React controlled range inputs aren't driven by synthetic `input` events in
    // happy-dom — call the attached onChange prop directly (matches other tests).
    const propKey = Object.keys(slider!).find((k) => k.startsWith("__reactProps$"));
    const props = (slider as unknown as Record<string, { onChange?: (e: { target: { value: string } }) => void }>)[propKey!]!;
    await act(async () => {
      props.onChange?.({ target: { value: "2.5" } });
    });
    expect(byAria(host, "Zoom")?.textContent?.trim()).toBe("2.5×");
  });

  test("video mode records and lands in the in-camera library", async () => {
    setupMedia();
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    const host = await mount();
    // Switch to Video.
    await click(byAria(host, "Video"));
    expect(byAria(host, "Video")?.getAttribute("aria-selected")).toBe("true");
    // Start recording (shutter toggles record in video mode).
    await click(byAria(host, "shutter"));
    expect(host.textContent).toContain("Recording…");
    // Stop recording → it persists and the library filmstrip appears.
    await click(byAria(host, "shutter"));
    const stored = JSON.parse(window.localStorage.getItem("amos.captures") ?? "[]") as unknown[];
    expect(stored.length).toBe(1);
    expect(host.querySelector('button[aria-label="Library"]')).toBeTruthy();
  });

  test("quality chip cycles tiers and re-acquires the stream", async () => {
    setupMedia();
    const host = await mount();
    const before = gumCalls;
    expect(byAria(host, "Quality")?.textContent?.trim()).toBe("HD");
    await click(byAria(host, "Quality"));
    expect(byAria(host, "Quality")?.textContent?.trim()).toBe("FHD");
    expect(gumCalls).toBe(before + 1); // re-requested at the new resolution
  });

  test("HDR toggle surfaces an honest capability note", async () => {
    setupMedia();
    const host = await mount();
    expect(host.textContent).not.toContain("HDR needs");
    await click(byAria(host, "HDR"));
    expect(host.textContent).toContain("HDR needs");
  });

  test("burst mode toggle is reflected (photo mode)", async () => {
    setupMedia();
    const host = await mount();
    const burst = byAria(host, "Burst");
    expect(burst?.getAttribute("aria-pressed")).toBe("false");
    await click(burst);
    expect(byAria(host, "Burst")?.getAttribute("aria-pressed")).toBe("true");
  });
});
