/**
 * DOM tests for the Svelte 5 Measure screen (MeasureApp.svelte).
 *
 * Pure measurement math (pixel distance, pinhole estimate, calibration, unit
 * parsing) is unit-tested against lib/measure.ts. Here we verify the screen
 * wiring that has no pure seam: the measure/calibrate/history tab bar announces
 * which view is active to assistive tech (REQ-A981).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MeasureApp from "../src/svelte/MeasureApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

afterEach(() => {
  cleanup();
  setLocale("zh");
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

const tabByText = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((b) =>
    (b.textContent ?? "").includes(s),
  );

/**
 * A real `MediaStream` (happy-dom type-checks `srcObject` against it) with
 * `getTracks` patched on, since happy-dom's stream has none and `stopCamera`
 * calls it on unmount.
 */
function makeStream(): MediaStream {
  const s = new MediaStream();
  (s as unknown as { getTracks: () => Array<{ stop: () => void }> }).getTracks = () => [
    { stop: () => {} },
  ];
  return s;
}

function setupMedia(stream: MediaStream) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve(stream) },
  });
}

function setupDenied() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
    },
  });
}

/** Let the async read-store/`getUserMedia` chain and the effects flush. */
async function settle() {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
}

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return a
 * restore function. (`window.localStorage` is a per-access proxy, so the prototype cannot
 * be patched — the window property itself is replaced.)
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

const HISTORY_KEY = "amos.measure.history";
const seedRow = {
  id: "m-seed",
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
  distance: 500,
  timestamp: 1,
};
const deleteButtons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes("🗑️"));

// REQ-A981 / F-SH-308: the measure/calibrate/history switch is a tab bar, but it was
// the last one in the tree without `role="tablist"` / `role="tab"` / `aria-selected` —
// ClockApp, CalendarApp, PhoneApp, CameraApp, EnterprisePage and CompassApp all use
// that idiom. The active tab was drawn only by `class:bg-slate-700` /
// `class:text-sky-400`, so AT read an unchanging name in every state.
describe("MeasureApp.svelte tab bar", () => {
  test("the tab list and its tabs expose the selected view to AT", async () => {
    const host = render(MeasureApp);
    expect(host.container.querySelector('[role="tablist"]')).toBeTruthy();
    const measure = tabByText(host, zh["measure.measure"]);
    const calibrate = tabByText(host, zh["measure.calibrate"]);
    const history = tabByText(host, zh["measure.history"]);
    expect(measure).toBeTruthy();
    expect(calibrate).toBeTruthy();
    expect(history).toBeTruthy();
    expect(measure!.getAttribute("aria-selected")).toBe("true");
    expect(calibrate!.getAttribute("aria-selected")).toBe("false");
    expect(history!.getAttribute("aria-selected")).toBe("false");
    await fireEvent.click(calibrate as HTMLElement);
    expect(calibrate!.getAttribute("aria-selected")).toBe("true");
    expect(measure!.getAttribute("aria-selected")).toBe("false");
  });
});

// REQ-A1280 / F-SH-554: `startCamera` set `cameraActive = true` only inside
// `if (videoEl)`, but the `<video>` that binds `videoEl` is rendered only while
// `cameraActive` is true — a circle. `videoEl` was therefore always null when
// the stream arrived, the "Video element not ready" branch was the only one that
// could run, and the app was stuck on 无法访问相机 forever: the feed never
// appeared, the retry button re-ran the same dead path, and measuring could not
// start. The fix sets `cameraActive` from the acquired stream (not from the
// element) and attaches `srcObject` from an effect once the element binds, which
// also covers the calibrate tab's *own* `<video>` (a fresh element per tab).
describe("MeasureApp.svelte camera wiring (REQ-A1280)", () => {
  test("the measure tab shows the feed instead of 'video element not ready'", async () => {
    const stream = makeStream();
    setupMedia(stream);
    const host = render(MeasureApp);
    await settle();

    const video = host.container.querySelector("video") as HTMLVideoElement | null;
    expect(video).toBeTruthy();
    expect(video!.srcObject).toBe(stream);
    // The stuck-error text is gone and the measure affordance is on screen.
    expect(host.container.textContent).not.toContain(zh["measure.cameraError"]);
    expect(host.container.textContent).toContain(zh["measure.tapToStart"]);
  });

  test("the calibrate tab's own video carries the feed after a tab switch", async () => {
    const stream = makeStream();
    setupMedia(stream);
    const host = render(MeasureApp);
    await settle();

    const measureVideo = host.container.querySelector("video") as HTMLVideoElement | null;
    expect(measureVideo!.srcObject).toBe(stream);

    await fireEvent.click(tabByText(host, zh["measure.calibrate"]) as HTMLElement);
    await settle();
    // The reference list is step "select"; the video appears once a reference
    // is chosen (step "measure").
    const refBtn = host.container.querySelector(".space-y-3 button") as HTMLElement | null;
    expect(refBtn).toBeTruthy();
    await fireEvent.click(refBtn as HTMLElement);
    await settle();

    const calVideo = host.container.querySelector("video") as HTMLVideoElement | null;
    expect(calVideo).toBeTruthy();
    // A different element than the measure tab's — and it got the stream too.
    expect(calVideo).not.toBe(measureVideo);
    expect(calVideo!.srcObject).toBe(stream);
  });

  test("a camera that refuses still reports the refusal", async () => {
    setupDenied();
    const host = render(MeasureApp);
    await settle();

    expect(host.container.querySelector("video")).toBeNull();
    expect(host.container.textContent).toContain(zh["measure.cameraPermissionDenied"]);
  });
});

// REQ-A1418 ∕ FMEA F-SH-676 — the measurement history is **the user's content**: a row is created
// by a deliberate two-tap measurement and can be deleted one at a time from the history tab. It
// was persisted through a bare `writeStoreValue` inside an `$effect`, with no error surface
// anywhere in the file — so a refused write left the history tab drawing a row that was not on
// disk, and a reload put a deleted row back. This is the fourth key named in `F-SH-253`'s
// boundary (「既定政策而非缺陷」); the other three (`amos.weather.cities` ∕ `amos.worldclock` ∕
// `amos.webman.history`) have each since grown a verdict reader, so the reason no longer holds.
describe("MeasureApp.svelte history-write verdict (REQ-A1418)", () => {
  test("a rejected history write is reported (the rows are the user's content)", async () => {
    const restore = failWritesFor(HISTORY_KEY);
    try {
      const host = render(MeasureApp);
      await settle();
      // The effect wrote on mount and the refusal is a fact that stays true — the sentence is
      // the only thing that can tell the user the history tab is not backed by disk.
      expect(txt(host)).toContain(zh["common.storeWriteFailed"]);
      expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
    } finally {
      restore();
    }
  });

  test("a deletion on a refused store drops the row from the screen but not from disk", async () => {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify([seedRow]));
    const restore = failWritesFor(HISTORY_KEY);
    try {
      const host = render(MeasureApp);
      await settle();
      await fireEvent.click(tabByText(host, zh["measure.history"]) as HTMLElement);
      await settle();
      expect(deleteButtons(host).length).toBe(1);

      await fireEvent.click(deleteButtons(host)[0] as HTMLElement);
      await settle();
      // The screen moved ahead of disk — the row is gone here…
      expect(deleteButtons(host).length).toBe(0);
      // …and the sentence says so, because the reload will put it back.
      expect(txt(host)).toContain(zh["common.storeWriteFailed"]);
      // …and the disk really still holds it: that is what the next launch reads.
      expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY) as string)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("a landed deletion drops the row from the screen and from disk, and says nothing", async () => {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify([seedRow]));
    const host = render(MeasureApp);
    await settle();
    await fireEvent.click(tabByText(host, zh["measure.history"]) as HTMLElement);
    await settle();
    expect(deleteButtons(host).length).toBe(1);

    await fireEvent.click(deleteButtons(host)[0] as HTMLElement);
    await settle();
    expect(deleteButtons(host).length).toBe(0);
    expect(txt(host)).not.toContain(zh["common.storeWriteFailed"]);
    expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY) as string)).toHaveLength(0);
  });

  test("the history tab draws a restored row (the load path still works)", async () => {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify([seedRow]));
    const host = render(MeasureApp);
    await settle();
    await fireEvent.click(tabByText(host, zh["measure.history"]) as HTMLElement);
    await settle();
    expect(txt(host)).toContain("50.0 cm"); // formatDistance(500, "metric")
  });
});
