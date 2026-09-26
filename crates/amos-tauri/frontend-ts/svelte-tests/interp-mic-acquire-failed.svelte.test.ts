/**
 * InterpApp.svelte — a microphone that never opened must say so, not leave a live-looking session.
 *
 * `startCapture` awaits `navigator.mediaDevices.getUserMedia({audio})` and, in its original
 * shape, let the rejection escape: the call site is `onclick={() => void toggleMic()}` (the
 * promise is discarded), so a denied permission was an **unhandled rejection with no visible
 * effect** — the daemon session was already open (`beginSession` had set `running`), the mic
 * chip stayed unlit, and the status line kept its "中文 → 英文" pair. A session that can never
 * produce a transcript read exactly like a quiet one. The missing-AudioContext arm was the same
 * shape with a bare `return`.
 *
 * Its siblings on the same screen all speak: `toggleMic` itself answers `camera.noCamera` for a
 * missing capture API, `beginSession` / `send` name their refusals, and `CameraApp.acquire` (the
 * repo's other `getUserMedia`) catches, discriminates `NotAllowedError`, sets a hint and logs
 * `amosWarn`. This file pins the interpreter's half of that rule: a refused or failed capture is
 * reported, and `rec` is never claimed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { grantCap, loadLedger, saveLedger } from "../src/lib/permissions";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

vi.mock("../src/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backend")>();
  return {
    ...actual,
    bridged: () => true,
    bridgeDiag: () => ({ ok: true }),
    subscribe: async (_channel: string, cb: (payload: unknown) => void) => {
      void cb;
      return () => {};
    },
    interpretStart: async () => 1,
    interpretStop: async () => null,
    interpretPause: async () => null,
    interpretResume: async () => null,
    interpretAudio: async () => null,
    interpretText: async () => null,
    interpretEndOfSpeech: async () => null,
  };
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const shows = (h: { container: HTMLElement }, key: string) =>
  [zh[key], en[key]].some((v) => v !== undefined && (h.container.textContent ?? "").includes(v));
const byText = (h: { container: HTMLElement }, text: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  ) as HTMLButtonElement | undefined;
const micButton = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("title") === zh["a11y.mic"],
  ) as HTMLButtonElement | undefined;

/** The chip reads "●" only while `rec` is true — the observable that the capture really started. */
const capturing = (h: { container: HTMLElement }) => (micButton(h)?.textContent ?? "").trim() === "●";

type MediaStub = { getUserMedia: (c?: unknown) => Promise<unknown> };
let restoreMedia: (() => void) | null = null;

function stubMedia(gum: MediaStub["getUserMedia"]): void {
  const had = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: gum },
    configurable: true,
    writable: true,
  });
  restoreMedia = () => {
    if (had) Object.defineProperty(navigator, "mediaDevices", had);
    else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  };
}

/** A Web Audio stub so the *successful* path can reach `rec = true` (happy-dom has none). */
class FakeCtx {
  sampleRate = 48000;
  destination = {};
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  createScriptProcessor() {
    return { connect: () => {}, onaudioprocess: null };
  }
  close() {
    return Promise.resolve();
  }
}

let hadAudioCtx = false;
let savedAudioCtx: unknown;

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
  // Pre-grant the mic so a single tap reaches `startCapture` (skips the two-tap consent).
  saveLedger(grantCap(loadLedger(), "interpreter", "microphone"));
  hadAudioCtx = "AudioContext" in window;
  savedAudioCtx = (window as unknown as { AudioContext?: unknown }).AudioContext;
  (window as unknown as { AudioContext?: unknown }).AudioContext = FakeCtx;
});

afterEach(() => {
  cleanup();
  restoreMedia?.();
  restoreMedia = null;
  if (hadAudioCtx) (window as unknown as { AudioContext?: unknown }).AudioContext = savedAudioCtx;
  else delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  window.localStorage.clear();
});

/** Open a session so the microphone button (rendered only while `running`) appears. */
async function startSession(h: { container: HTMLElement }): Promise<void> {
  await waitFor(() => expect(byText(h, zh["interp.start"])).toBeTruthy());
  await fireEvent.click(byText(h, zh["interp.start"])!);
  await waitFor(() => expect(micButton(h)).toBeTruthy());
}

describe("InterpApp.svelte — a microphone that never opened is reported", () => {
  test("a denied microphone permission is reported instead of a silent no-op", async () => {
    stubMedia(() => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })));
    const h = render(InterpApp);
    await startSession(h);

    await fireEvent.click(micButton(h)!);
    await settle();

    // The rejection used to escape an `onclick={() => void toggleMic()}` and reach nobody: the
    // session stayed open, the chip stayed off, and the screen said nothing about why.
    expect(shows(h, "interp.micDenied")).toBe(true);
    // And no capture may be claimed: `rec` never became true.
    expect(capturing(h)).toBe(false);
  });

  test("a microphone that fails for another reason is reported too", async () => {
    stubMedia(() => Promise.reject(Object.assign(new Error("boom"), { name: "NotFoundError" })));
    const h = render(InterpApp);
    await startSession(h);

    await fireEvent.click(micButton(h)!);
    await settle();

    expect(shows(h, "interp.micFailed")).toBe(true);
    expect(capturing(h)).toBe(false);
  });

  test("a microphone that opens still starts capture (regression)", async () => {
    stubMedia(async () => ({ getTracks: () => [{ stop: () => {} }] }));
    const h = render(InterpApp);
    await startSession(h);

    await fireEvent.click(micButton(h)!);
    await settle();

    expect(capturing(h)).toBe(true);
    expect(shows(h, "interp.micDenied")).toBe(false);
    expect(shows(h, "interp.micFailed")).toBe(false);
  });
});
