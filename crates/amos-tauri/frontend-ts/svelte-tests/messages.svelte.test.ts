/**
 * DOM tests for the Svelte 5 messages screen (MessagesApp.svelte).
 *
 * Pure message logic is unit-tested once against lib/messages.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: the seeded thread,
 * sending a message, and clearing to the empty state.
 */
import { describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import MessagesApp from "../src/svelte/MessagesApp.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { CONV_KEY, seedConversations } from "../src/lib/messages";
import { beforeEach } from "vitest";
import { tick } from "svelte";

// Each test starts from a fresh, single seeded 小安 conversation (the Messages
// screen persists to the shared store, which is not reset between tests).
beforeEach(() => {
  writeStoreValue(CONV_KEY, seedConversations(Date.now()));
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const input = (h: { container: HTMLElement }) =>
  h.container.querySelector('input[aria-label="message-input"]') as HTMLInputElement | null;

describe("MessagesApp.svelte", () => {
  test("shows the seeded thread + contact header", () => {
    const host = render(MessagesApp);
    expect(txt(host)).toContain("小安");
    // seeded thread is non-empty → no "暂无消息"
    expect(txt(host)).not.toContain("暂无消息");
  });

  test("sending a message appends it", async () => {
    const host = render(MessagesApp);
    const before = txt(host);
    await fireEvent.input(input(host)!, { target: { value: "你好 Amos" } });
    const sendBtn = [...host.container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "send",
    );
    expect(sendBtn).toBeTruthy();
    await fireEvent.click(sendBtn as HTMLButtonElement);
    expect(txt(host)).toContain("你好 Amos");
    // input cleared
    expect(input(host)!.value).toBe("");
    expect(before.length).toBeGreaterThan(0);
  });

  test("clear empties the thread", async () => {
    const host = render(MessagesApp);
    const clearBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("清空会话"),
    );
    expect(clearBtn).toBeTruthy();
    await fireEvent.click(clearBtn as HTMLButtonElement);
    expect(txt(host)).toContain("暂无消息");
  });

  test("adding a new contact opens an empty thread and switches to it", async () => {
    const host = render(MessagesApp);
    const ni = host.container.querySelector('input[aria-label="new-contact"]') as HTMLInputElement | null;
    expect(ni).toBeTruthy();
    await fireEvent.input(ni as HTMLInputElement, { target: { value: "李四" } });
    const addBtn = host.container.querySelector('button[aria-label="add-contact"]') as HTMLButtonElement | null;
    expect(addBtn).toBeTruthy();
    await fireEvent.click(addBtn as HTMLButtonElement);
    await tick();
    // new empty thread becomes active
    expect(txt(host)).toContain("李四");
    expect(txt(host)).toContain("暂无消息");
  });

  test("each thread keeps its own messages (send stays in the active one)", async () => {
    const host = render(MessagesApp);
    // add 李四 (the new-contact row is always visible)
    const ni = host.container.querySelector('input[aria-label="new-contact"]') as HTMLInputElement;
    await fireEvent.input(ni, { target: { value: "李四" } });
    await fireEvent.click(host.container.querySelector('button[aria-label="add-contact"]') as HTMLButtonElement);
    await tick();
    // send a message to 李四
    const msgIn = host.container.querySelector('input[aria-label="message-input"]') as HTMLInputElement;
    await fireEvent.input(msgIn, { target: { value: "给李四的私信" } });
    const sendBtn = host.container.querySelector('button[aria-label="send"]') as HTMLButtonElement;
    await fireEvent.click(sendBtn);
    await tick();
    expect(txt(host)).toContain("给李四的私信");
    // switch back to 小安 chip → that message must not leak
    const xiaoanChip = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim().startsWith("小安"),
    ) as HTMLButtonElement;
    expect(xiaoanChip).toBeTruthy();
    await fireEvent.click(xiaoanChip);
    await tick();
    expect(txt(host)).not.toContain("给李四的私信");
  });

  test("deleting a thread (only when >1) removes it and selects another", async () => {
    const host = render(MessagesApp);
    // only one thread → no delete button yet
    expect(host.container.querySelector('button[aria-label="delete-thread"]')).toBeNull();
    const ni = host.container.querySelector('input[aria-label="new-contact"]') as HTMLInputElement;
    await fireEvent.input(ni, { target: { value: "王五" } });
    await fireEvent.click(host.container.querySelector('button[aria-label="add-contact"]') as HTMLButtonElement);
    await tick();
    expect(host.container.querySelector('button[aria-label="delete-thread"]')).toBeTruthy();
    await fireEvent.click(host.container.querySelector('button[aria-label="delete-thread"]') as HTMLButtonElement);
    await tick();
    // falls back to the remaining 小安 thread
    expect(txt(host)).toContain("小安");
    expect(txt(host)).not.toContain("王五");
  });

  test("shows real device SMS threads when a provider is bridged", async () => {
    const seen: Record<string, unknown>[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        seen.push({ cmd, ...(args ?? {}) });
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_snapshot") {
          return [
            {
              id: "1",
              address: "13800138000",
              display_name: "家人",
              last_text: "回吗",
              last_ts_ms: 1_700_000_000_000,
              unread: 1,
            },
          ];
        }
        if (cmd === "sms_messages") {
          return [
            {
              thread_id: "1",
              id: "m1",
              from_me: false,
              text: "晚上回家吃饭吗？",
              ts_ms: 1_700_000_000_000,
              read: false,
            },
          ];
        }
        if (cmd === "sms_send") return "sent";
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(host.container.querySelector('[data-testid="real-sms-badge"]')).toBeTruthy();
    expect(txt(host)).toContain("家人");
    expect(txt(host)).toContain("晚上回家吃饭吗？");
    // the messages call must use Tauri's camelCase arg key (device-verified)
    const msgCall = seen.find((c) => c.cmd === "sms_messages");
    expect(msgCall?.threadId).toBe("1");
    expect(msgCall && "thread_id" in msgCall).toBe(false);
    // local-only affordances are hidden in real-SMS mode
    expect(host.container.querySelector('input[aria-label="new-contact"]')).toBeNull();
  });

  test("keeps local conversations with the honest host mock", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "mock", device: false };
        return null; // a mock backend has no device snapshot
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    // Host/offline: local conversations stay, and no real-SMS state is shown.
    expect(txt(host)).toContain("小安");
    expect(host.container.querySelector('[data-testid="real-sms-badge"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="sms-error"]')).toBeNull();
  });

  test("shows an honest permission error and recovers on retry", async () => {
    let granted = false;
    const threads = [
      {
        id: "1",
        address: "13800138000",
        display_name: "家人",
        last_text: "回吗",
        last_ts_ms: 1_700_000_000_000,
        unread: 1,
      },
    ];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_snapshot") {
          if (!granted) throw new Error("SMS permission denied: READ_SMS not granted");
          return threads;
        }
        if (cmd === "sms_messages") {
          return [
            { thread_id: "1", id: "m1", from_me: false, text: "晚上回家吃饭吗？", ts_ms: 1_700_000_000_000, read: false },
          ];
        }
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    // Denied is an error state — never an empty inbox, never the local demo chat.
    expect(host.container.querySelector('[data-testid="sms-error"]')).toBeTruthy();
    expect(txt(host)).toContain("短信权限被拒绝");
    expect(host.container.querySelector('input[aria-label="new-contact"]')).toBeNull();
    // Granting the permission and retrying recovers into the real inbox.
    granted = true;
    await fireEvent.click(host.container.querySelector('button[aria-label="sms-retry"]') as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(host.container.querySelector('[data-testid="sms-error"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="real-sms-badge"]')).toBeTruthy();
    expect(txt(host)).toContain("家人");
  });

  test("an empty device inbox is honest, not the local demo chat", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_snapshot") return []; // real, empty inbox
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(host.container.querySelector('[data-testid="sms-empty"]')).toBeTruthy();
    expect(txt(host)).toContain("本机暂无短信");
    expect(host.container.querySelector('input[aria-label="new-contact"]')).toBeNull();
  });

  test("refreshes live when the device pushes a received SMS", async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    const one = {
      id: "1",
      address: "13800138000",
      display_name: "家人",
      last_text: "回吗",
      last_ts_ms: 1_700_000_000_000,
      unread: 1,
    };
    const two = {
      id: "2",
      address: "10086",
      display_name: "中国移动",
      last_text: "新消息",
      last_ts_ms: 1_700_000_100_000,
      unread: 0,
    };
    let threads = [one];
    // The open thread gains a message when the push arrives (loopback incoming).
    let msgs = [
      { thread_id: "1", id: "m1", from_me: false, text: "回吗", ts_ms: 1_700_000_000_000, read: true },
    ];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_snapshot") return threads;
        if (cmd === "sms_messages") return msgs;
        return null;
      },
      listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
        handlers[channel] = handler;
        return () => {};
      },
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(txt(host)).not.toContain("中国移动");
    expect(txt(host)).not.toContain("刚收到的新短信");
    // The device pushes `sms-received` → the screen re-reads the inbox AND the
    // open thread's messages itself (no manual refresh, no polling).
    threads = [one, two];
    msgs = [
      ...msgs,
      { thread_id: "1", id: "m2", from_me: false, text: "刚收到的新短信", ts_ms: 1_700_000_100_000, read: false },
    ];
    handlers["sms-received"]?.({ payload: { address: "13800138000" } });
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(txt(host)).toContain("中国移动");
    expect(txt(host)).toContain("刚收到的新短信");
  });

  test("composes to an arbitrary number and refreshes the inbox", async () => {
    const calls: Record<string, unknown>[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ?? {}) });
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_snapshot") return [];
        if (cmd === "sms_messages") return [];
        if (cmd === "sms_send") return "sent";
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    await fireEvent.click(host.container.querySelector('button[aria-label="new-sms"]') as HTMLButtonElement);
    await tick();
    await fireEvent.input(host.container.querySelector('input[aria-label="new-sms-to"]') as HTMLInputElement, {
      target: { value: "+8613800138000" },
    });
    await fireEvent.input(host.container.querySelector('input[aria-label="new-sms-text"]') as HTMLInputElement, {
      target: { value: "测试短信" },
    });
    await fireEvent.click(host.container.querySelector('button[aria-label="new-sms-send"]') as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const sent = calls.find((c) => c.cmd === "sms_send");
    expect(sent?.address).toBe("+8613800138000");
    expect(sent?.text).toBe("测试短信");
    // The send is followed by a re-read so a newly created thread shows up.
    expect(calls.filter((c) => c.cmd === "sms_snapshot").length).toBeGreaterThan(1);
  });
});
