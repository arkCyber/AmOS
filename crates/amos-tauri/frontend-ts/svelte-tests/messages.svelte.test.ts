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
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { CONV_KEY, seedConversations } from "../src/lib/messages";
import { NOTIF_KEY } from "../src/lib/settings";
import { DRAFT_KEY } from "../src/lib/smsDrafts";
import { beforeEach } from "vitest";
import { afterEach } from "vitest";
import { tick } from "svelte";
import { messagesChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";

// Each test starts from a fresh, single seeded 小安 conversation (the Messages
// screen persists to the shared store, which is not reset between tests) and an
// empty local drafts store.
beforeEach(() => {
  writeStoreValue(CONV_KEY, seedConversations(Date.now()));
  writeStoreValue(DRAFT_KEY, []);
  resetPropsChannels();
});

// Never let a fake device bridge leak into the next test (the screen resolves its
// backend on mount, so a leftover bridge would flip offline tests into device mode).
afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  resetPropsChannels();
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. (`window.localStorage` is a per-access proxy, so the prototype
 * cannot be patched — the window property itself is replaced.)
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}
const input = (h: { container: HTMLElement }) =>
  h.container.querySelector('input[aria-label="message-input"]') as HTMLInputElement | null;

describe("MessagesApp.svelte", () => {
  test("an intentionally emptied store is not re-seeded with the demo thread", () => {
    window.localStorage.setItem("amos.messages.convs", "[]");
    const host = render(MessagesApp);
    expect(txt(host)).toContain("暂无会话");
    expect(txt(host)).not.toContain("小安");
    expect(readStoreValue<unknown>("amos.messages.convs", null)).toEqual([]);
  });

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

  test("reading a thread marks its incoming messages read (badge clears)", async () => {
    // The seeded thread's newest incoming message is unread (`read: false`).
    const host = render(MessagesApp);
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    const saved = readStoreValue<{ msgs: { from: string; read?: boolean }[] }[]>(CONV_KEY, []);
    const incoming = saved.flatMap((c) => c.msgs).filter((m) => m.from === "them");
    expect(incoming.length).toBeGreaterThan(0);
    // Opening the thread reads it — the ● badge / "N 未读" banner must not linger
    // until the user happens to send something.
    expect(incoming.every((m) => m.read === true)).toBe(true);
    expect(txt(host)).not.toContain("未读");
  });

  test("the open thread raises no notification; another thread's unread still does", async () => {
    const now = Date.now();
    writeStoreValue(CONV_KEY, [
      { id: "c:a", name: "小安", msgs: [{ from: "them", text: "在读的", ts: now - 10, read: false }] },
      { id: "c:b", name: "小李", msgs: [{ from: "them", text: "别人的未读", ts: now - 5, read: false }] },
    ]);
    writeStoreValue(NOTIF_KEY, []);
    render(MessagesApp);
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    const titles = readStoreValue<{ title: string }[]>(NOTIF_KEY, []).map((n) => n.title);
    expect(titles.some((t) => t.includes("别人的未读"))).toBe(true);
    expect(titles.some((t) => t.includes("在读的"))).toBe(false);
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

  test("a rejected write is reported and the new thread is not added", async () => {
    const restore = failWritesFor(CONV_KEY);
    try {
      const host = render(MessagesApp);
      const ni = host.container.querySelector(
        'input[aria-label="new-contact"]',
      ) as HTMLInputElement;
      await fireEvent.input(ni, { target: { value: "李四" } });
      await fireEvent.click(
        host.container.querySelector('button[aria-label="add-contact"]') as HTMLButtonElement,
      );
      await tick();
      // Nothing was stored, so the thread list must not show it.
      expect(txt(host)).toContain("本机存储写入失败");
      expect(txt(host)).not.toContain("李四");
      expect(readStoreValue<{ name: string }[]>(CONV_KEY, []).some((c) => c.name === "李四")).toBe(
        false,
      );
    } finally {
      restore();
    }
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

  test("folder tabs read that folder and show thread counts", async () => {
    const calls: Record<string, unknown>[] = [];
    const threadsFor: Record<string, unknown[]> = {
      inbox: [
        {
          id: "1",
          address: "13800138000",
          display_name: "家人",
          last_text: "回吗",
          last_ts_ms: 1_700_000_000_000,
          unread: 1,
        },
      ],
      sent: [
        {
          id: "1",
          address: "13800138000",
          display_name: "家人",
          last_text: "好的，六点到家。",
          last_ts_ms: 1_699_999_500_000,
          unread: 0,
        },
      ],
      draft: [],
    };
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ?? {}) });
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 2, sent: 1, draft: 0 };
        if (cmd === "sms_snapshot") return threadsFor[String(args?.folder)] ?? [];
        if (cmd === "sms_messages") {
          // Folder-scoped messages, so the panel proves which folder was read.
          return args?.folder === "sent"
            ? [
                {
                  thread_id: "1",
                  id: "s1",
                  from_me: true,
                  text: "好的，六点到家。",
                  ts_ms: 1_699_999_500_000,
                  read: true,
                },
              ]
            : [
                {
                  thread_id: "1",
                  id: "i1",
                  from_me: false,
                  text: "回吗",
                  ts_ms: 1_700_000_000_000,
                  read: false,
                },
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
    // Inbox by default, with the count badge from `sms_counts`.
    expect(calls.find((c) => c.cmd === "sms_snapshot")?.folder).toBe("inbox");
    expect(txt(host)).toContain("回吗");
    expect(txt(host)).toContain("2"); // inbox count chip
    // Switching to 发件箱 re-reads that folder (and never shows the inbox preview).
    await fireEvent.click(host.container.querySelector('button[data-folder="sent"]') as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const sentCalls = calls.filter((c) => c.cmd === "sms_snapshot");
    expect(sentCalls[sentCalls.length - 1]?.folder).toBe("sent");
    expect(txt(host)).toContain("好的，六点到家。");
    // Messages are scoped to the folder too.
    const msgCall = calls.filter((c) => c.cmd === "sms_messages").pop();
    expect(msgCall?.folder).toBe("sent");
  });

  test("a draft is kept locally and removed once sent", async () => {
    const calls: Record<string, unknown>[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ?? {}) });
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 0, sent: 0, draft: 0 };
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
    // Compose → 存草稿 (not sending anything).
    await fireEvent.click(host.container.querySelector('button[aria-label="new-sms"]') as HTMLButtonElement);
    await tick();
    await fireEvent.input(host.container.querySelector('input[aria-label="new-sms-to"]') as HTMLInputElement, {
      target: { value: "10086" },
    });
    await fireEvent.input(host.container.querySelector('input[aria-label="new-sms-text"]') as HTMLInputElement, {
      target: { value: "想问下流量包" },
    });
    await fireEvent.click(host.container.querySelector('button[aria-label="new-sms-draft"]') as HTMLButtonElement);
    await tick();
    expect(calls.some((c) => c.cmd === "sms_send")).toBe(false); // nothing was sent
    // The drafts folder lists it from the local store.
    await fireEvent.click(host.container.querySelector('button[data-folder="draft"]') as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(host.container.querySelector('[data-testid="drafts-list"]')).toBeTruthy();
    expect(txt(host)).toContain("想问下流量包");
    // Editing it prefils the composer; sending clears the draft and sends for real.
    await fireEvent.click(host.container.querySelector('button[aria-label="draft-edit-10086"]') as HTMLButtonElement);
    await tick();
    const to = host.container.querySelector('input[aria-label="new-sms-to"]') as HTMLInputElement;
    expect(to.value).toBe("10086");
    await fireEvent.click(host.container.querySelector('button[aria-label="new-sms-send"]') as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const sent = calls.find((c) => c.cmd === "sms_send");
    expect(sent?.address).toBe("10086");
    expect(sent?.text).toBe("想问下流量包");
    expect(txt(host)).not.toContain("想问下流量包"); // draft consumed
    expect(txt(host)).toContain("暂无草稿");
  });

  test("a compose link from the call history opens a local thread for that number", async () => {
    const host = render(MessagesApp);
    await tick();
    // The phone's "回短信" sets the channel; offline this opens a local thread.
    messagesChannel().set({ composeTo: "18616091470", nonce: 1 });
    await tick();
    expect(txt(host)).toContain("18616091470");
    // The link is consumed, so re-opening Messages must not re-fire it.
    expect(messagesChannel().get()?.composeTo).toBe("");
  });

  test("blocks the open device thread's sender (exact/both) and explains the outcome", async () => {
    const seen: Record<string, unknown>[] = [];
    let blocked = false;
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        seen.push({ cmd, ...(args ?? {}) });
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: blocked ? 0 : 1, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot") {
          // Once blocked the provider filters the sender out — like the SMS filter does.
          if (blocked) return [];
          return [
            {
              id: "1",
              address: "18616091470",
              display_name: "推销",
              last_text: "优惠活动",
              last_ts_ms: 1_700_000_000_000,
              unread: 0,
            },
          ];
        }
        if (cmd === "sms_messages") {
          return [
            { thread_id: "1", id: "m1", from_me: false, text: "优惠活动", ts_ms: 1_700_000_000_000, read: true },
          ];
        }
        if (cmd === "blocklist_add") {
          blocked = true;
          return {
            id: "r1",
            pattern: String(args?.pattern),
            kind: args?.kind,
            channel: args?.channel,
            label: "",
            created_ms: 1,
          };
        }
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const btn = host.container.querySelector(
      'button[aria-label="block-sender-18616091470"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    const readsBefore = seen.filter((c) => c.cmd === "sms_messages").length;
    await fireEvent.click(btn);
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const add = seen.find((c) => c.cmd === "blocklist_add");
    expect(add?.pattern).toBe("18616091470");
    expect(add?.kind).toBe("exact");
    expect(add?.channel).toBe("both");
    const note = host.container.querySelector('[data-testid="block-sender-msg"]')!;
    expect(note.getAttribute("data-ok")).toBe("true");
    expect(note.textContent).toContain("已屏蔽 18616091470");
    // The blocked sender is filtered out of the inbox, so the thread is gone.
    expect(host.container.querySelector('[data-testid="sms-empty"]')).toBeTruthy();
    // …and the vanished thread is not read again (the block side refuses it
    // anyway): the pane is cleared rather than refilled from a hidden thread.
    expect(seen.filter((c) => c.cmd === "sms_messages").length).toBe(readsBefore);
  });

  test("a rejected block is an explicit error, never a silent no-op", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 1, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot")
          return [
            { id: "1", address: "10086", display_name: "", last_text: "hi", last_ts_ms: 1, unread: 0 },
          ];
        if (cmd === "sms_messages") return [];
        if (cmd === "blocklist_add") throw new Error("invalid number");
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    await fireEvent.click(
      host.container.querySelector('button[aria-label="block-sender-10086"]') as HTMLButtonElement,
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const note = host.container.querySelector('[data-testid="block-sender-msg"]')!;
    expect(note.getAttribute("data-ok")).toBe("false");
    expect(note.getAttribute("role")).toBe("alert");
    expect(note.textContent).toContain("屏蔽失败");
  });

  // ---- View-layer trash (REQ-A42) -------------------------------------------
  /**
   * A device bridge answering exactly what the trash panel reads. The list is the
   * **raw wire payload** (snake_case — serde's default), and `sms_trash_add`
   * answers the bridge's three-state contract. This is the coverage that was
   * missing when the panel shipped broken (Round 47, REQ-A108).
   */
  function deviceBridge(
    opts: {
      trashList?: unknown[];
      addReply?: unknown;
      restoreReply?: unknown;
      purgeReply?: unknown;
    } = {},
  ) {
    const seen: Record<string, unknown>[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        seen.push({ cmd, ...(args ?? {}) });
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 1, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot")
          return [
            {
              id: "1",
              address: "13800138000",
              display_name: "家人",
              last_text: "回吗",
              last_ts_ms: 1_700_000_000_000,
              unread: 0,
            },
          ];
        if (cmd === "sms_messages")
          return [
            {
              thread_id: "1",
              id: "m1",
              from_me: false,
              text: "晚上回家吃饭吗？",
              ts_ms: 1_700_000_000_000,
              read: true,
            },
          ];
        if (cmd === "sms_trash_list") return opts.trashList ?? [];
        if (cmd === "sms_trash_add") return opts.addReply ?? { trashed: true };
        if (cmd === "sms_trash_restore") return opts.restoreReply ?? true;
        if (cmd === "sms_trash_purge") return opts.purgeReply ?? 2;
        return null;
      },
      listen: async () => () => {},
    };
    return seen;
  }
  const settle = async () => {
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
  };
  const clickTestId = async (c: HTMLElement, id: string) => {
    const el = c.querySelector(`[data-testid="${id}"]`);
    expect(el).toBeTruthy();
    await fireEvent.click(el as HTMLElement);
    await settle();
  };

  test("the trash panel reads the wire's snake_case rows (name, time, per-row target)", async () => {
    deviceBridge({
      trashList: [
        { thread_id: "1", message_id: "m1", ts_ms: 1_700_000_000_000, trashed_ms: 1_700_000_000_000 },
      ],
    });
    const host = render(MessagesApp);
    await settle();
    await clickTestId(host.container, "trash-toggle");
    const row = host.container.querySelector('[data-testid="trash-row"]');
    expect(row).toBeTruthy();
    // A camelCase read of the wire (`e.threadId`/`e.trashedMs`) yields `undefined`:
    // the row would carry no name/time and the restore button no target id.
    expect(row!.textContent).toContain("家人");
    expect(row!.textContent).toMatch(/\d{2}:\d{2}|今天|昨天|\d{4}-\d{2}-\d{2}/);
    expect(host.container.querySelector('[data-testid="trash-restore-m1"]')).toBeTruthy();
    expect(host.container.querySelector('[data-testid="trash-restore-undefined"]')).toBeNull();
  });

  test("restoring a trashed message reports success and re-reads the thread", async () => {
    const seen = deviceBridge({
      trashList: [
        { thread_id: "1", message_id: "m1", ts_ms: 1_700_000_000_000, trashed_ms: 1_700_000_000_000 },
      ],
      restoreReply: true,
    });
    const host = render(MessagesApp);
    await settle();
    await clickTestId(host.container, "trash-toggle");
    const readsBefore = seen.filter((c) => c.cmd === "sms_messages").length;
    await clickTestId(host.container, "trash-restore-m1");
    const call = seen.find((c) => c.cmd === "sms_trash_restore")!;
    expect(call.threadId).toBe("1");
    expect(call.messageId).toBe("m1");
    // The command answers a **bool**; comparing it to a string would report failure.
    const note = host.container.querySelector('[data-testid="trash-msg"]')!;
    expect(note.getAttribute("data-ok")).toBe("true");
    expect(note.textContent).toContain("已恢复显示");
    expect(seen.filter((c) => c.cmd === "sms_messages").length).toBeGreaterThan(readsBefore);

    // "Purge" answers the number restored: a successful call is a success.
    await clickTestId(host.container, "trash-purge");
    expect(seen.some((c) => c.cmd === "sms_trash_purge")).toBe(true);
    expect(host.container.querySelector('[data-testid="trash-msg"]')!.textContent).toContain("回收站已清空");
  });

  test("trashing a message reports the bridge's three honest outcomes", async () => {
    // (1) trashed → the success copy (and the honest "platform keeps it" wording).
    deviceBridge({ addReply: { trashed: true } });
    let host = render(MessagesApp);
    await settle();
    await clickTestId(host.container, "trash-msg-btn-m1");
    expect(host.container.querySelector('[data-testid="trash-msg"]')!.textContent).toContain("已移入回收站");

    // (2) not_found → "the message is no longer in this folder", never a generic failure.
    deviceBridge({ addReply: { trashed: false, not_found: true } });
    host = render(MessagesApp);
    await settle();
    await clickTestId(host.container, "trash-msg-btn-m1");
    expect(host.container.querySelector('[data-testid="trash-msg"]')!.textContent).toContain(
      "该短信已不在当前文件夹中",
    );

    // (3) refused (blocked sender / storage) → the generic failure, and `data-ok=false`.
    deviceBridge({ addReply: { trashed: false, reason: "blocked sender" } });
    host = render(MessagesApp);
    await settle();
    await clickTestId(host.container, "trash-msg-btn-m1");
    const note = host.container.querySelector('[data-testid="trash-msg"]')!;
    expect(note.getAttribute("data-ok")).toBe("false");
    expect(note.textContent).toContain("移入回收站失败");
  });
});
