import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assistantVoiceEnd,
  assistantVoiceFeed,
  assistantVoiceStart,
  assistantVoiceStop,
  bridged,
  bridgeDiag,
  cancelAiSession,
  conversationId,
  getAiStatus,
  listSessions,
  clearSessions,
  removeSession,
  getSessionHistory,
  getAndroidAppIcon,
  getAndroidApps,
  interpretAudio,
  interpretPause,
  interpretResume,
  interpretStart,
  interpretStop,
  interpretText,
  invoke,
  launchAndroidApp,
  sendChat,
  subscribe,
  transcribeAudio,
  translateText,
  ttsSynthesize,
} from "../lib/backend";

let realWindow: unknown;

function setWindow(obj: Record<string, unknown>) {
  (globalThis as { window?: unknown }).window = obj;
}

beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

describe("backend bridge", () => {
  test("degrades gracefully outside Tauri", async () => {
    setWindow({ localStorage: new Map() as unknown as Storage });
    expect(bridged()).toBe(false);
    expect(await invoke("get_status")).toBeNull();
    expect(await sendChat("hi", "s")).toBeNull();
    expect(await getAiStatus()).toBeNull();
    const un = await subscribe("x", () => {});
    un();
    expect(conversationId().length).toBeGreaterThan(0);
  });

  test("calls Tauri commands when bridged", async () => {
    const calls: string[] = [];
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    const fake = {
      invoke: async (c: string) => {
        calls.push(c);
        if (c === "get_status") return { model: "ggml", active_sessions: 1 };
        return { ok: true };
      },
      listen: async (ch: string, h: (e: { payload: unknown }) => void) => {
        handlers[ch] = h;
        return async () => {};
      },
    };
    const store = new Map<string, string>();
    setWindow({ __TAURI_INTERNALS__: fake, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    expect(bridged()).toBe(true);
    const status = await getAiStatus();
    expect(status?.model).toBe("ggml");
    await sendChat("hello", "conv-1");
    expect(calls).toContain("chat_agent");
    const un = await subscribe("ai-token-received", () => {});
    un();
    expect(typeof handlers["ai-token-received"]).toBe("function");
  });

  test("records structured diagnostics instead of losing failure root cause", async () => {
    // Not bridged → classified as such.
    setWindow({ localStorage: new Map() as unknown as Storage });
    expect(await invoke("get_status")).toBeNull();
    expect(bridgeDiag()).toEqual({ ok: false, kind: "not-bridged", command: "get_status" });

    // Bridged command that rejects → classified, root cause kept; still returns null.
    const store = new Map<string, string>();
    const failing = {
      invoke: async () => {
        throw new Error("daemon: model load failed");
      },
      listen: async () => async () => {},
    };
    setWindow({
      __TAURI_INTERNALS__: failing,
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    expect(bridged()).toBe(true);
    expect(await invoke("chat_agent", { prompt: "hi", sessionId: "s", targetWindow: "ai" })).toBeNull();
    const diag = bridgeDiag();
    expect(diag.ok).toBe(false);
    if (!diag.ok) {
      expect(diag.kind).toBe("command-failed");
      expect(diag.command).toBe("chat_agent");
    }

    // A later success resets the diagnostic to ok.
    setWindow({
      __TAURI_INTERNALS__: { invoke: async () => ({ model: "ggml", active_sessions: 1 }), listen: async () => async () => {} },
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    const status = await getAiStatus();
    expect(status?.model).toBe("ggml");
    expect(bridgeDiag()).toEqual({ ok: true });
  });

  test("interpret RPC sends start/audio/stop with correct args", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const fake = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        return cmd === "interpret_start" ? "sess-9" : { ok: true };
      },
      listen: async () => async () => {},
    };
    setWindow({ __TAURI_INTERNALS__: fake, localStorage: new Map() as unknown as Storage });
    const sid = await interpretStart({ source: "auto", target: "zh" });
    expect(sid).toBe("sess-9");
    await interpretAudio("sess-9", [1, 2, 3]);
    await interpretStop("sess-9");
    expect(calls.map((c) => c.cmd)).toEqual(["interpret_start", "interpret_audio", "interpret_stop"]);
    expect(calls[0]!.args.source_lang).toBe("auto");
    expect(calls[1]!.args.sessionId).toBe("sess-9");
    expect(calls[1]!.args.chunk).toEqual([1, 2, 3]);
  });

  test("thin wrappers route to the expected daemon commands", async () => {
    const calls: string[] = [];
    const fake = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return null;
      },
      listen: async () => async () => {},
    };
    const store = new Map<string, string>();
    setWindow({
      __TAURI_INTERNALS__: fake,
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    expect(bridged()).toBe(true);

    await cancelAiSession();
    await listSessions();
    await clearSessions();
    await removeSession("s1");
    await getSessionHistory("s1");
    await interpretText("s1", "hi");
    await interpretPause("s1");
    await interpretResume("s1");
    await ttsSynthesize("你好", "zh");
    await transcribeAudio([0, 1, 2], { language: "zh" });
    await translateText("hi", { sourceLang: "en", targetLang: "zh" });
    await getAndroidApps();
    await launchAndroidApp("com.tencent.mm");
    await getAndroidAppIcon("com.tencent.mm");

    for (const cmd of [
      "cancel_ai_session",
      "get_ai_sessions",
      "clear_ai_sessions",
      "remove_ai_session",
      "get_ai_session_history",
      "interpret_text",
      "interpret_pause",
      "interpret_resume",
      "tts_synthesize",
      "transcribe_audio",
      "translate_text",
      "get_android_apps",
      "launch_android_app",
      "get_android_app_icon",
    ]) {
      expect(calls, `expected ${cmd} to be routed`).toContain(cmd);
    }
  });

  test("assistant voice wrappers route to start/feed/end/stop with correct args", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const fake = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        return { ok: true };
      },
      listen: async () => async () => {},
    };
    setWindow({ __TAURI_INTERNALS__: fake, localStorage: new Map() as unknown as Storage });

    await assistantVoiceStart("conv-v");
    await assistantVoiceFeed([1, 2, 3]);
    await assistantVoiceEnd();
    await assistantVoiceStop();

    expect(calls.map((c) => c.cmd)).toEqual([
      "assistant_voice_start",
      "assistant_voice_feed",
      "assistant_voice_end",
      "assistant_voice_stop",
    ]);
    expect(calls[0]!.args.sessionId).toBe("conv-v");
    expect(calls[1]!.args.frame).toEqual([1, 2, 3]);
  });
});
