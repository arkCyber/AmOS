import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import StreamVoiceButton from "../components/StreamVoiceButton";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* Drive the full streaming-voice lifecycle headlessly: real lib/backend over a
 * fake Tauri bridge that records assistant_voice_* calls and lets the test emit
 * `assistant-voice-event` frames, plus a fake mic/AudioContext. */
type Listener = (ev: { payload: unknown }) => void;
const handlers: Record<string, Listener> = {};
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    return { ok: true };
  },
  listen: (ch: string, cb: Listener) => {
    handlers[ch] = cb;
    return () => {
      delete handlers[ch];
    };
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
(navigator as unknown as Record<string, unknown>).mediaDevices = {
  getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
};

// Pre-grant the mic capability for the "ai" app (see lib/permissions.ts).
window.localStorage.setItem("amos.permissions", JSON.stringify({ ai: ["microphone"] }));

const mounted: { root: Root; host: HTMLElement }[] = [];
const replies: string[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  replies.length = 0;
  procs.length = 0;
  calls.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
});

async function mountBtn() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <StreamVoiceButton
          online
          disabled={false}
          session={() => "conv-s1"}
          onReply={(t) => replies.push(t)}
        />
      </I18nProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  mounted.push({ root, host });
  return host;
}

const btn = (host: HTMLElement) =>
  host.querySelector('button[aria-label="streaming voice input"]') as HTMLButtonElement;

describe("StreamVoiceButton — streaming hold-to-talk lifecycle (headless)", () => {
  test("start opens session + streams frames, release ends, turn_done replies", async () => {
    const host = await mountBtn();
    expect(btn(host).textContent).toBe("🎙️");

    // Start (click toggles): assistant_voice_start with the lazy session id, mic up.
    await act(async () => {
      btn(host).click();
    });
    await new Promise((r) => setTimeout(r, 0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(btn(host).textContent).toBe("●");
    expect(procs.length).toBe(1);
    expect(calls.map((c) => c.cmd)).toContain("assistant_voice_start");
    const start = calls.find((c) => c.cmd === "assistant_voice_start")!;
    expect(start.args.sessionId).toBe("conv-s1");

    // Stream a loud 160-sample frame -> assistant_voice_feed(bytes).
    const before = calls.length;
    const signal = new Float32Array(160).fill(0.5);
    await act(async () => {
      procs[0]!.onaudioprocess?.({ inputBuffer: { getChannelData: () => signal } });
    });
    const feeds = calls.filter((c) => c.cmd === "assistant_voice_feed");
    expect(feeds.length).toBeGreaterThan(0);
    const f = feeds[feeds.length - 1]!;
    expect(Array.isArray(f.args.frame)).toBe(true);
    expect((f.args.frame as number[]).length).toBe(160 * 4); // 16k f32-le

    // Release -> assistant_voice_end.
    await act(async () => {
      btn(host).click();
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(btn(host).textContent).toBe("🎙️");
    expect(calls.slice(before).map((c) => c.cmd)).toContain("assistant_voice_end");

    // The daemon's reply arrives as an assistant-voice-event turn_done.
    await act(async () => {
      handlers["assistant-voice-event"]?.({ payload: { kind: "turn_done", session: "conv-s1", text: "你好，我是 Amos" } });
    });
    expect(replies).toEqual(["你好，我是 Amos"]);
  });
});
