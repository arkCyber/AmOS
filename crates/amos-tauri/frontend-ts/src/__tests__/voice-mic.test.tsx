import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import VoiceMicButton from "../components/VoiceMicButton";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ---- Real lib/backend + fake bridge/audio/mic so the WHOLE ① record lifecycle
 *      can be driven headlessly (isolated process via bun-iso-test.mjs). ---- */
type Listener = (ev: { payload: unknown }) => void;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) =>
    cmd === "transcribe_audio" ? { text: "hello world", recognized: true } : "ok",
  listen: (_c: string, _cb: Listener) => () => {
    /* no events needed */
  },
};

interface FakeProc {
  onaudioprocess: ((e: unknown) => void) | null;
  connect: () => void;
  disconnect: () => void;
}
const procs: FakeProc[] = [];
(window as unknown as Record<string, unknown>).AudioContext = class {
  sampleRate = 16000;
  destination = {};
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createScriptProcessor(_n: number, _i: number, _o: number) {
    const p: FakeProc = {
      onaudioprocess: null,
      connect() {},
      disconnect() {},
    };
    procs.push(p);
    return p;
  }
  async close() {}
};

const streamTracks = { stop() {} };
(navigator as unknown as Record<string, unknown>).mediaDevices = {
  getUserMedia: async () => ({ getTracks: () => [streamTracks] }),
};

// These tests drive the record lifecycle, so pre-grant the mic capability for
// the default VoiceMicButton app ("ai"); see lib/permissions.ts.
window.localStorage.setItem("amos.permissions", JSON.stringify({ ai: ["microphone"] }));

const mounted: { root: Root; host: HTMLElement }[] = [];
const transcripts: string[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  transcripts.length = 0;
  procs.length = 0;
});

async function mountMic() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <VoiceMicButton online disabled={false} onTranscript={(t) => transcripts.push(t)} />
      </I18nProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  mounted.push({ root, host });
  return host;
}

const btn = (host: HTMLElement) => host.querySelector('button[aria-label="voice input"]') as HTMLButtonElement;

describe("VoiceMicButton — ① mic record lifecycle (headless)", () => {
  test("tap-to-record, feed audio frames, release -> transcript via transcribe_audio", async () => {
    const host = await mountMic();
    expect(btn(host).textContent).toBe("🎤");

    // ① Tap to start: getUserMedia + AudioContext spin up; button shows recording.
    await act(async () => {
      btn(host).click();
    });
    await new Promise((r) => setTimeout(r, 0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(btn(host).textContent).toBe("●");
    expect(procs.length).toBe(1);

    // Feed a non-silent audio frame into the ScriptProcessor (what real mic audio does).
    const proc = procs[0]!;
    const signal = new Float32Array(160).fill(0.5);
    await act(async () => {
      proc.onaudioprocess?.({ inputBuffer: { getChannelData: () => signal } });
    });

    // ② Release: stop() -> hasSignal true -> transcribe_audio -> onTranscript.
    await act(async () => {
      btn(host).click();
    });
    await new Promise((r) => setTimeout(r, 0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(transcripts).toEqual(["hello world"]);
    expect(btn(host).textContent).toBe("🎤"); // back to idle
  });
});
