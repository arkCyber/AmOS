/**
 * DOM tests for the Svelte 5 AI assistant screen (AiApp.svelte) — OFFLINE shell.
 *
 * Streaming/chat/cards/voice logic is backend + lib/stream driven and needs the
 * amos-ai daemon. Outside Tauri `bridged()` is false, so here we verify the Svelte
 * UI shell that runs headlessly: offline banner, empty-chat placeholder, sending
 * text offline echoes user + a localized "daemon offline" note (no silent no-op),
 * the two-step clear, and the sessions panel's offline empty state. The two voice
 * buttons degrade to disabled offline (checked in voice-buttons.svelte.test.ts).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AiApp from "../src/svelte/AiApp.svelte";

afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnText = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const btnByAria = (h: { container: HTMLElement }, label: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
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

describe("AiApp.svelte (offline shell)", () => {
  test("shows the in-browser banner + empty-chat placeholder", async () => {
    const host = render(AiApp);
    await settle();
    expect(txt(host)).toContain("make run-ui-release"); // backend.inBrowser
    expect(txt(host)).toContain("与 AI 对话"); // ai.placeholder
  });

  test("sending text offline echoes the user line + a daemon-offline note", async () => {
    const host = render(AiApp);
    await settle();
    const input = textareaByPlaceholder(host, "输入指令");
    await fireEvent.input(input as HTMLTextAreaElement, { target: { value: "你好" } });
    await fireEvent.click(btnByAria(host, "send") as HTMLButtonElement);
    await settle();
    expect(input?.value).toBe(""); // echoed, not a silent no-op
    expect(txt(host)).toContain("你好");
    expect(txt(host)).toContain("未连接守护进程"); // backend.offline note
    expect(btnText(host, "新建会话")).toBeTruthy(); // a conversation now exists
  });

  test("two-step clear empties the conversation back to the placeholder", async () => {
    const host = render(AiApp);
    await settle();
    // Seed a conversation by sending offline.
    const input = textareaByPlaceholder(host, "输入指令");
    await fireEvent.input(input as HTMLTextAreaElement, { target: { value: "hi" } });
    await fireEvent.click(btnByAria(host, "send") as HTMLButtonElement);
    await settle();
    expect(txt(host)).not.toContain("与 AI 对话"); // no longer empty
    // First tap arms...
    await fireEvent.click(btnText(host, "清空") as HTMLButtonElement);
    await settle();
    expect(btnText(host, "确认清空?")).toBeTruthy();
    // ...second tap confirms and returns to the empty placeholder.
    await fireEvent.click(btnText(host, "确认清空?") as HTMLButtonElement);
    await settle();
    expect(txt(host)).toContain("与 AI 对话");
    expect(btnText(host, "新建会话")).toBeFalsy();
  });

  test("new-chat while 清空 is armed resets the button label", async () => {
    const host = render(AiApp);
    await settle();
    const input = textareaByPlaceholder(host, "输入指令");
    await fireEvent.input(input as HTMLTextAreaElement, { target: { value: "hi" } });
    await fireEvent.click(btnByAria(host, "send") as HTMLButtonElement);
    await settle();
    // Arm the two-step clear...
    await fireEvent.click(btnText(host, "清空") as HTMLButtonElement);
    await settle();
    expect(btnText(host, "确认清空?")).toBeTruthy();
    // ...then start a fresh conversation instead: label + history reset cleanly.
    await fireEvent.click(btnText(host, "新建会话") as HTMLButtonElement);
    await settle();
    expect(btnText(host, "确认清空?")).toBeFalsy();
    expect(btnText(host, "清空")).toBeTruthy();
    expect(txt(host)).toContain("与 AI 对话"); // back to empty placeholder
  });

  test("an agent line makes copy-reply available (offline note counts)", async () => {
    const host = render(AiApp);
    await settle();
    expect(btnText(host, "复制回答")).toBeFalsy();
    const input = textareaByPlaceholder(host, "输入指令");
    await fireEvent.input(input as HTMLTextAreaElement, { target: { value: "hello" } });
    await fireEvent.click(btnByAria(host, "send") as HTMLButtonElement);
    await settle();
    expect(btnText(host, "复制回答")).toBeTruthy(); // last agent bubble has text
  });

  test("sessions panel shows the offline empty state", async () => {
    const host = render(AiApp);
    await settle();
    await fireEvent.click(btnText(host, "会话") as HTMLButtonElement);
    await settle();
    expect(txt(host)).toContain("暂无 daemon 会话"); // ai.sessionEmpty
  });
});

/**
 * Bridged: a single `assistant-voice-event` sink lives in AiApp, so an utterance
 * finalized by the ALWAYS-ON NATIVE device mic (DeviceMicButton) renders exactly
 * one agent bubble — it must not rely on StreamVoiceButton's presence, and there
 * must never be two subscribers double-pushing the same turn_done.
 */
describe("AiApp.svelte (bridged: single assistant-voice sink)", () => {
  afterEach(() => {
    cleanup();
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
  });

  const waitUntil = async (cond: () => boolean, timeoutMs = 3000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for subscription");
      await new Promise<void>((r) => setTimeout(r, 5));
    }
  };

  test("one native-mic turn_done → exactly one agent bubble", async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    const fake = {
      invoke: async () => null,
      listen: async (ch: string, h: (e: { payload: unknown }) => void) => {
        handlers[ch] = h;
        return async () => {};
      },
    };
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = fake;
    const host = render(AiApp);
    await waitUntil(() => typeof handlers["assistant-voice-event"] === "function");

    // A finalized utterance as the daemon pushes it for the native device mic.
    handlers["assistant-voice-event"]!({
      payload: { kind: "turn_done", session: "s", text: "原生语音答复-唯一" },
    });
    await settle();

    const log = host.container.querySelector('[role="log"]');
    const bubbles = [...(log?.querySelectorAll("div") ?? [])].filter((d) =>
      (d.textContent ?? "").includes("原生语音答复-唯一"),
    );
    expect(bubbles.length).toBe(1);
    expect(txt(host)).toContain("原生语音答复-唯一");
  });
});
