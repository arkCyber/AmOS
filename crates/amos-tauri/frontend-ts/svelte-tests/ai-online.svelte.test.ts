/**
 * DOM tests for the Svelte 5 AI assistant screen (AiApp.svelte) — BRIDGED.
 *
 * `ai.svelte.test.ts` covers the offline shell (no `__TAURI_INTERNALS__`). Here a
 * fake host is installed so the *online* branch runs, and the point under test is
 * the one thing the offline suite cannot see: what the screen says after a command
 * the host **accepted**.
 *
 * `chat_agent` and `cancel_ai_session` are both `Result<(), AmosError>` on the Rust
 * side, so a successful call resolves with `null` — exactly the value `lib/backend`'s
 * `invoke` answers on failure. Reading that `null` as failure made the screen claim
 * the daemon was offline after every accepted send, and null the streaming bubble's
 * id so no token could land.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AiApp from "../src/svelte/AiApp.svelte";
import { zh } from "../src/i18n/locales/zh";
import { writeStoreValue } from "../src/lib/amosStore";
import { PERMISSIONS_KEY } from "../src/lib/permissions";

afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  window.localStorage.clear();
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnByAria = (h: { container: HTMLElement }, label: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
const btnText = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(s),
  ) as HTMLButtonElement | undefined;
const textareaByPlaceholder = (h: { container: HTMLElement }, p: string) =>
  [...h.container.querySelectorAll("textarea")].find((t) =>
    (t.getAttribute("placeholder") ?? "").includes(p),
  ) as HTMLTextAreaElement | undefined;

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/**
 * Install a host whose `chat_agent`/`cancel_ai_session` resolve `null` — the wire
 * value Tauri sends for `Ok(())` on a unit-returning command. `refuseChat` makes the
 * daemon reject the send the way `chat_agent`'s own `Err` does.
 */
function installBridge(opts: { refuseChat?: boolean; refuseVoiceStart?: boolean } = {}) {
  const handlers = new Map<string, (e: { payload: unknown }) => void>();
  const invoke = async (cmd: string): Promise<unknown> => {
    if (cmd === "get_status") return { model: "demo", active_sessions: 0, degraded: false };
    if (cmd === "chat_agent") {
      if (opts.refuseChat) {
        throw { code: "amos.ai.rpc_failed", message: "ai chat open failed" };
      }
      return null; // `Ok(())` — indistinguishable from a refusal by payload alone.
    }
    if (cmd === "cancel_ai_session") return null;
    if (cmd === "assistant_voice_start" && opts.refuseVoiceStart) {
      // The daemon is unreachable (Tauri present, no daemon): `VoiceLink::open` fails.
      throw { code: "amos.ai.rpc_failed", message: "assistant voice chat open failed" };
    }
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
  };
  return {
    /** Push one token on the daemon's stream channel. */
    emitToken: (token: string) => handlers.get("ai-token-received")?.({ payload: token }),
  };
}

const sendText = async (host: { container: HTMLElement }, text: string) => {
  const input = textareaByPlaceholder(host, "输入指令");
  await fireEvent.input(input as HTMLTextAreaElement, { target: { value: text } });
  await fireEvent.click(btnByAria(host, zh["a11y.send"]) as HTMLButtonElement);
  await settle();
};

describe("AiApp.svelte (bridged): a command the host accepted is not a failure", () => {
  test("a successful send keeps the turn busy and never claims the daemon is offline", async () => {
    installBridge();
    const host = render(AiApp);
    await settle();
    await sendText(host, "你好");
    // The turn is in flight: the stop control is the honest busy readout.
    expect(txt(host)).not.toContain("未连接守护进程");
    expect(btnText(host, zh["ai.stop"])).toBeTruthy();
  });

  test("a token from the accepted stream lands in the agent bubble", async () => {
    const host0 = installBridge();
    const host = render(AiApp);
    await settle();
    await sendText(host, "你好");
    host0.emitToken("流式");
    await settle();
    expect(txt(host)).toContain("流式");
  });

  test("a successful stop does not claim the daemon is offline", async () => {
    installBridge();
    const host = render(AiApp);
    await settle();
    await sendText(host, "你好");
    const stop = btnText(host, zh["ai.stop"]);
    expect(stop, "the stop control should be present while busy").toBeTruthy();
    await fireEvent.click(stop);
    await settle();
    expect(txt(host)).not.toContain("未连接守护进程");
  });

  test("a send the daemon refuses is reported with its typed code", async () => {
    installBridge({ refuseChat: true });
    const host = render(AiApp);
    await settle();
    await sendText(host, "你好");
    expect(txt(host)).toContain("amos.ai.rpc_failed");
    expect(txt(host)).not.toContain("未连接守护进程");
  });
});

/**
 * REQ-A1055 / F-SH-370 — the push-to-talk mic shares the family. `assistant_voice_start` is
 * `Result<(), AmosError>`, so a listener the host never opened (Tauri present, no daemon)
 * resolved with the same `null` a success does. The button swallowed it AND pushed a false
 * "you spoke" bubble; this pins that the screen now says why, and claims nothing it did not do.
 */
describe("AiApp.svelte (bridged): a refused push-to-talk start", () => {
  function grantMicAndAudio() {
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    class FakeProc {
      onaudioprocess: ((e: unknown) => void) | null = null;
      connect(): void {}
      disconnect(): void {}
    }
    class FakeCtx {
      sampleRate = 16000;
      destination = {};
      createMediaStreamSource(): { connect(): void; disconnect(): void } {
        return { connect() {}, disconnect() {} };
      }
      createScriptProcessor(): FakeProc {
        return new FakeProc();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext?: unknown }).AudioContext = FakeCtx;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
      configurable: true,
      writable: true,
    });
  }

  test("the refusal reaches the status line, and no 'you spoke' bubble is pushed", async () => {
    installBridge({ refuseVoiceStart: true });
    grantMicAndAudio();
    const host = render(AiApp);
    await settle();

    await fireEvent.click(btnByAria(host, zh["a11y.streamingVoiceInput"])!);
    await settle();

    // The reason is said (with the typed code), rather than left as silence.
    expect(txt(host)).toContain(zh["ai.voiceRefused"].split("{")[0]);
    expect(txt(host)).toContain("amos.ai.rpc_failed");
    // The false claim this replaced: the user bubble said "voice prompt" for a listener that
    // never opened. `onStart` now fires only after the host accepted.
    expect(txt(host)).not.toContain(zh["ai.voicePrompt"]);
  });
});
