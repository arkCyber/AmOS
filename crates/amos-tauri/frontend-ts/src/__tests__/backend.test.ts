import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bridged, conversationId, getAiStatus, invoke, interpretAudio, interpretStart, interpretStop, sendChat, subscribe } from "../lib/backend";

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
    expect(calls[0].args.source_lang).toBe("auto");
    expect(calls[1].args.sessionId).toBe("sess-9");
    expect(calls[1].args.chunk).toEqual([1, 2, 3]);
  });
});
