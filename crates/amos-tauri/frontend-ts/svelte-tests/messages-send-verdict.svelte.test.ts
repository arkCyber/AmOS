/**
 * messages-send-verdict.svelte.test.ts — REQ-A1620 / F-TEL-040 —
 * 「发送短信只有成功与失败两种说法：`SmsGlue.send` 把 sentIntent 传成 null，平台从不上报
 * 结果，而 glue 一律回 `{"ok":true}`；于是关机、无信号时屏幕上照样清空输入框、像发送成功了」。
 *
 * 真实的三态是 **sent ∕ unconfirmed ∕ rejected**：只有电台确认收下才算成功；被拒是错误；
 * 「窗口内没有结果」是第三种事实 —— 既不能说成功，也不能说失败（短信可能已经发出去了）。
 * 本文件盯住屏幕上的第三种：它必须有一个自己的、不是红色告警的说法，并且**保留**输入框里的
 * 文字（重发一次会真的多收一条短信）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MessagesApp from "../src/svelte/MessagesApp.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { CONV_KEY, seedConversations } from "../src/lib/messages";
import { DRAFT_KEY } from "../src/lib/smsDrafts";
import { resetPropsChannels } from "../src/svelte/propsBus";

const SEEDED = {
  id: "1",
  address: "13800138000",
  display_name: "家人",
  last_text: "在吗",
  last_ts_ms: 1_700_000_000_000,
  unread: 0,
};

/**
 * A device bridge whose `sms_send` answers with whatever the platform said.
 * `null` is the bridge's own "unavailable/refused" answer (what `invoke` returns
 * on a rejected command) — the third shape the screen must not confuse with the
 * second.
 */
function installHost(sendAnswer: unknown) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "sms_status") return { provider: "android-sms", device: true };
      if (cmd === "sms_snapshot") return [SEEDED];
      if (cmd === "sms_messages")
        return [
          {
            thread_id: "1",
            id: "m1",
            from_me: false,
            text: "在吗",
            ts_ms: 1_700_000_000_000,
            read: true,
          },
        ];
      if (cmd === "sms_send") return sendAnswer;
      return null;
    },
    listen: async () => () => {},
  };
}

const settle = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const box = (h: { container: HTMLElement }) =>
  h.container.querySelector<HTMLInputElement>('input[data-testid="real-message-input"]')!;
const note = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="real-sms-note"]');

/** Render, type a reply into the open device thread and press Enter. */
async function sendReply(answer: unknown) {
  installHost(answer);
  const host = render(MessagesApp);
  await settle();
  const input = box(host);
  expect(input).toBeTruthy();
  await fireEvent.input(input, { target: { value: "测试短信" } });
  await fireEvent.keyDown(input, { key: "Enter" });
  await settle();
  return host;
}

beforeEach(() => {
  writeStoreValue(CONV_KEY, seedConversations(Date.now()));
  writeStoreValue(DRAFT_KEY, []);
  resetPropsChannels();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  resetPropsChannels();
});

describe("MessagesApp — 发送结果的三态", () => {
  test("电台确认后：清空输入框，没有任何「未收到结果」的说法", async () => {
    const host = await sendReply("sent");
    expect(box(host).value).toBe("");
    expect(note(host)).toBeNull();
    expect(txt(host)).not.toContain("发送失败");
  });

  test("平台没有给结果时：保留文字、说「可能已发出」，且不是红色告警的口气", async () => {
    const host = await sendReply("unconfirmed");
    // The message may already be on its way — sending again would deliver twice.
    expect(box(host).value).toBe("测试短信");
    // Its own sentence, and never the failure one.
    expect(txt(host)).toContain("尚未收到发送结果");
    expect(txt(host)).not.toContain("发送失败");
    // Not an error alert: this is a question, not a refusal.
    const line = note(host);
    expect(line?.getAttribute("role")).toBe("status");
  });

  test("被拒（桥接返回 null）时：保留文字、说「发送失败」，没有「可能已发出」的说法", async () => {
    const host = await sendReply(null);
    expect(box(host).value).toBe("测试短信");
    expect(txt(host)).toContain("发送失败");
    expect(txt(host)).not.toContain("尚未收到发送结果");
    expect(note(host)).toBeNull();
  });

  test("改一下文字就收回那句提示：它只属于刚发出去的那条", async () => {
    const host = await sendReply("unconfirmed");
    expect(note(host)).not.toBeNull();
    await fireEvent.input(box(host), { target: { value: "测试短信，再改一下" } });
    await tick();
    expect(note(host)).toBeNull();
  });
});
