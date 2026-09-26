/**
 * VoiceMicButton — the accessible name carries the interaction state.
 *
 * REQ-A984 / F-SH-311. The mic button is a three-state control
 * (`idle → recording → transcribing`), but its only visual state is a glyph
 * (`🎤` / `●` / `…`) plus a colour class — and a **constant** `aria-label`
 * OVERRIDES element content for the accessible name, so every state read
 * identically to assistive tech: a screen-reader user could not tell a recording
 * mic from an idle one. The name is now driven by `VOICE_STATUS_LABEL_KEY`
 * (lib/voice.ts), the multi-state-cycle family of REQ-A969 / F-SH-305.
 *
 * Lives in its own file rather than `voice-buttons.svelte.test.ts` because that
 * suite is another round's in-flight work.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import VoiceMicButton from "../src/svelte/VoiceMicButton.svelte";
import StreamVoiceButton from "../src/svelte/StreamVoiceButton.svelte";
import DeviceMicButton from "../src/svelte/DeviceMicButton.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { PERMISSIONS_KEY } from "../src/lib/permissions";
import { VOICE_STATUS_LABEL_KEY } from "../src/lib/voice";
import { zh } from "../src/i18n/locales/zh";

// The transcription round-trip is what holds the button in `transcribing`.
const transcribe = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../src/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backend")>();
  return { ...actual, transcribeAudio: transcribe.fn };
});

afterEach(() => {
  cleanup();
  transcribe.fn.mockReset();
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  window.localStorage.clear();
});

/** Minimal Web Audio doubles: enough for `start()` to reach `recording`. */
function installAudio(): () => ((e: unknown) => void) | null {
  let onAudio: ((e: unknown) => void) | null = null;
  class FakeProc {
    set onaudioprocess(fn: ((e: unknown) => void) | null) {
      onAudio = fn;
    }
    connect(): void {}
    disconnect(): void {}
  }
  class FakeSource {
    connect(): void {}
    disconnect(): void {}
  }
  class FakeCtx {
    sampleRate = 16000;
    destination = {};
    createMediaStreamSource(): FakeSource {
      return new FakeSource();
    }
    createScriptProcessor(): FakeProc {
      return new FakeProc();
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  (window as unknown as { AudioContext?: unknown }).AudioContext = FakeCtx;
  return () => onAudio;
}

describe("VoiceMicButton — the accessible name carries the state", () => {
  test("idle → recording → transcribing each read a distinct name", async () => {
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    const proc = installAudio();
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
      configurable: true,
      writable: true,
    });
    // A transcription that has not answered yet — this is what keeps the button
    // in `transcribing` long enough for the assertion to read it.
    let release: (v: unknown) => void = () => {};
    transcribe.fn.mockReturnValue(new Promise((r) => (release = r)));

    const { container } = render(VoiceMicButton, {
      props: { online: true, onTranscript: () => {} },
    });
    const btn = () => container.querySelector("button") as HTMLButtonElement;
    const ariaName = () => btn().getAttribute("aria-label");

    // idle — the pre-existing name (the offline suite still selects by this key).
    expect(VOICE_STATUS_LABEL_KEY.idle).toBe("a11y.voiceInput");
    expect(ariaName()).toBe(zh[VOICE_STATUS_LABEL_KEY.idle]);

    // press → recording
    await fireEvent.click(btn());
    await vi.waitFor(() => expect(ariaName()).toBe(zh[VOICE_STATUS_LABEL_KEY.recording]));

    // one audible sample so the clip is not read as silence (which would fail fast)
    proc()?.({ inputBuffer: { getChannelData: () => Float32Array.from([0.5, 0.5, 0.5]) } });

    // press again → transcribing (the mocked synth has not answered)
    await fireEvent.click(btn());
    await vi.waitFor(() => expect(ariaName()).toBe(zh[VOICE_STATUS_LABEL_KEY.transcribing]));

    // The three names are pairwise distinct — the defect was precisely that they
    // were not (all three were the constant `a11y.voiceInput`).
    expect(
      new Set([
        zh[VOICE_STATUS_LABEL_KEY.idle],
        zh[VOICE_STATUS_LABEL_KEY.recording],
        zh[VOICE_STATUS_LABEL_KEY.transcribing],
      ]).size,
    ).toBe(3);

    // The round-trip closes back to idle (and the name with it).
    release({ text: "你好", recognized: true });
    await vi.waitFor(() => expect(ariaName()).toBe(zh[VOICE_STATUS_LABEL_KEY.idle]));
  });
});

/**
 * REQ-A1001 / F-SH-322 — the same defect, on the two mic buttons whose *state* is a
 * two-state toggle (up/down) rather than a three-state cycle. `aria-pressed` is the
 * repo's idiom for an on/off control (REQ-A962, 24+ sites); the multi-state
 * `VoiceMicButton` above could not use it, which is why its name carries the state
 * instead. Both directions are pinned (at rest AND while live), so a hard-coded
 * "true"/"false" fails either way.
 */
describe("the always-on / push-to-talk mic buttons report their own state", () => {
  const btn = (container: HTMLElement) => container.querySelector("button") as HTMLButtonElement;
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("StreamVoiceButton: aria-pressed follows the hold", async () => {
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    installAudio();
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async () => null,
      listen: async () => () => {},
    };
    // A stream WITH a track, so the capture is not torn down by the "no tracks" guard.
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
      writable: true,
    });
    const { container } = render(StreamVoiceButton, {
      props: { online: true, session: () => "s" },
    });
    expect(btn(container).getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(btn(container));
    await vi.waitFor(() => expect(btn(container).getAttribute("aria-pressed")).toBe("true"));
    await fireEvent.click(btn(container)); // keyboard/touch fallback toggles off
    await vi.waitFor(() => expect(btn(container).getAttribute("aria-pressed")).toBe("false"));
  });

  test("DeviceMicButton: aria-pressed follows the resident capture", async () => {
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "mic_permission_state") return { native: true, granted: true, state: "granted" };
        if (cmd === "mic_permission_request") return { native: true, granted: true, state: "granted" };
        if (cmd === "device_mic_start") return "aaudio"; // a native label ⇒ the indicator is live
        if (cmd === "device_mic_status") return { running: true, backend: "aaudio", submitted: 0 };
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    expect(btn(container).getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(btn(container));
    await vi.waitFor(() => expect(btn(container).getAttribute("aria-pressed")).toBe("true"));
  });
});
