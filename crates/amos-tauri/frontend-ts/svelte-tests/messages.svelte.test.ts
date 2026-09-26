/**
 * DOM tests for the Svelte 5 messages screen (MessagesApp.svelte).
 *
 * Pure message logic is unit-tested once against lib/messages.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: the seeded thread,
 * sending a message, and clearing to the empty state.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import MessagesApp from "../src/svelte/MessagesApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { CONV_KEY, seedConversations } from "../src/lib/messages";
import { NOTIF_KEY, newestAddedNotif } from "../src/lib/settings";
import { DRAFT_KEY } from "../src/lib/smsDrafts";
import { beforeEach } from "vitest";
import { afterEach } from "vitest";
import { tick } from "svelte";
import { messagesChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { zh } from "../src/i18n/locales/zh";
import { t } from "../src/svelte/locale.svelte";

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
  h.container.querySelector('input[data-testid="message-input"]') as HTMLInputElement | null;

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
      (b) => b.getAttribute("aria-label") === zh["message.send"],
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

  test("switching threads does not re-announce an already-seen notification (REQ-A1441)", async () => {
    // Two unread threads besides the open one, so the unread list has an *index* that
    // can move. The id used to be `msg:<index>:<ts>`, where the index is a position in
    // this activeId-filtered list — switching to 小安 drops it from the list and 小李's
    // row slides from index 1 to 0, so its id changes and the arrival banner (which
    // diffs id **sets**, `newestAddedNotif`) announces a message the user already saw.
    const now = Date.now();
    writeStoreValue(CONV_KEY, [
      { id: "c:x", name: "老王", msgs: [{ from: "them", text: "已读的", ts: now - 20, read: true }] },
      { id: "c:a", name: "小安", msgs: [{ from: "them", text: "在读的", ts: now - 10, read: false }] },
      { id: "c:b", name: "小李", msgs: [{ from: "them", text: "别人的未读", ts: now - 5, read: false }] },
    ]);
    writeStoreValue(NOTIF_KEY, []);
    const host = render(MessagesApp);
    await tick();
    await new Promise((r) => setTimeout(r, 0));

    type Row = { id: string; title: string };
    const before = readStoreValue<Row[]>(NOTIF_KEY, []);
    const seenB = before.find((n) => n.title.includes("别人的未读"));
    expect(seenB).toBeTruthy(); // 小李's unread was announced at mount

    // Open 小安 — 小李's notice must keep its identity (nothing new arrived).
    const chip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim().startsWith("小安"),
    ) as HTMLButtonElement;
    expect(chip).toBeTruthy();
    await fireEvent.click(chip);
    await tick();
    await new Promise((r) => setTimeout(r, 0));

    const after = readStoreValue<Row[]>(NOTIF_KEY, []);
    const stillB = after.find((n) => n.title.includes("别人的未读"));
    expect(stillB).toBeTruthy();
    // Identity is stable across the switch (position is not part of a message's identity).
    expect(stillB!.id).toBe(seenB!.id);
    // And the arrival banner sees no arrival at all.
    expect(newestAddedNotif(before as never, after as never)).toBeNull();
  });

  // Two local threads, the open one read — the shape where the "notify about the
  // *other* thread" path really fires (a single seeded thread is the open one, which
  // the mark-all-read effect clears before the backend even resolves).
  const twoLocalThreads = (now: number) => [
    { id: "c:a", name: "小安", msgs: [{ from: "them", text: "在读的", ts: now - 10, read: true }] },
    { id: "c:b", name: "小李", msgs: [{ from: "them", text: "别人的未读", ts: now - 5, read: false }] },
  ];

  test("in real device SMS mode an off-screen local thread raises no notification", async () => {
    // The local model is not the visible one once a device backend is bridged, and
    // its messages are not on the device either: a notice about them claims a message
    // the user can find nowhere. Must also retract one published while the mode was
    // still "unknown" at mount.
    writeStoreValue(CONV_KEY, twoLocalThreads(Date.now()));
    writeStoreValue(NOTIF_KEY, []);
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
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
        if (cmd === "sms_messages") return [];
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    await tick();
    expect(host.container.querySelector('[data-testid="real-sms-badge"]')).toBeTruthy();
    expect(txt(host)).toContain("家人");
    const titles = readStoreValue<{ title: string }[]>(NOTIF_KEY, []).map((n) => n.title);
    expect(titles.some((t) => t.includes("别人的未读"))).toBe(false);
  });

  test("in local mode that same off-screen thread still raises its notification", async () => {
    // Boundary twin: the retraction must not become "never notify".
    writeStoreValue(CONV_KEY, twoLocalThreads(Date.now()));
    writeStoreValue(NOTIF_KEY, []);
    render(MessagesApp);
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    const titles = readStoreValue<{ title: string }[]>(NOTIF_KEY, []).map((n) => n.title);
    expect(titles.some((t) => t.includes("别人的未读"))).toBe(true);
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
        'input[data-testid="new-contact"]',
      ) as HTMLInputElement;
      await fireEvent.input(ni, { target: { value: "李四" } });
      await fireEvent.click(
        host.container.querySelector('button[data-testid="add-contact"]') as HTMLButtonElement,
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
    const ni = host.container.querySelector('input[data-testid="new-contact"]') as HTMLInputElement | null;
    expect(ni).toBeTruthy();
    await fireEvent.input(ni as HTMLInputElement, { target: { value: "李四" } });
    const addBtn = host.container.querySelector('button[data-testid="add-contact"]') as HTMLButtonElement | null;
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
    const ni = host.container.querySelector('input[data-testid="new-contact"]') as HTMLInputElement;
    await fireEvent.input(ni, { target: { value: "李四" } });
    await fireEvent.click(host.container.querySelector('button[data-testid="add-contact"]') as HTMLButtonElement);
    await tick();
    // send a message to 李四
    const msgIn = host.container.querySelector('input[data-testid="message-input"]') as HTMLInputElement;
    await fireEvent.input(msgIn, { target: { value: "给李四的私信" } });
    const sendBtn = host.container.querySelector(`button[aria-label="${zh["message.send"]}"]`) as HTMLButtonElement;
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
    expect(host.container.querySelector('button[data-testid="delete-thread"]')).toBeNull();
    const ni = host.container.querySelector('input[data-testid="new-contact"]') as HTMLInputElement;
    await fireEvent.input(ni, { target: { value: "王五" } });
    await fireEvent.click(host.container.querySelector('button[data-testid="add-contact"]') as HTMLButtonElement);
    await tick();
    expect(host.container.querySelector('button[data-testid="delete-thread"]')).toBeTruthy();
    await fireEvent.click(host.container.querySelector('button[data-testid="delete-thread"]') as HTMLButtonElement);
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
    expect(host.container.querySelector('input[data-testid="new-contact"]')).toBeNull();
  });

  test("a second Enter while a device send is in flight does not send twice (REQ-A1152)", async () => {
    let sentCount = 0;
    let releaseSend: (() => void) | null = null;
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_snapshot")
          return [
            {
              id: "1",
              address: "13800138000",
              display_name: "家人",
              last_text: "在吗",
              last_ts_ms: 1_700_000_000_000,
              unread: 0,
            },
          ];
        if (cmd === "sms_messages")
          return [
            { thread_id: "1", id: "m1", from_me: false, text: "在吗", ts_ms: 1_700_000_000_000, read: true },
          ];
        // The send stays in flight until the test releases it, so a second
        // attempt lands while the first has not yet answered.
        if (cmd === "sms_send")
          return new Promise<string>((resolve) => {
            sentCount += 1;
            releaseSend = () => resolve("sent");
          });
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const input = host.container.querySelector('input[data-testid="real-message-input"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await fireEvent.input(input, { target: { value: "只发一次" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    // The first send is still unresolved; a second Enter (or button re-tap) here
    // used to issue a *second* SMS, since the thread composer carried no guard.
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(sentCount).toBe(1);
    releaseSend?.();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
  });

  test("reading a real device thread clears its ● badge — and a later message brings it back (REQ-A1075)", async () => {
    let inbox = [
      { id: "1", address: "10086", display_name: "家人", last_text: "在吗", last_ts_ms: 1_700_000_000_000, unread: 0 },
      { id: "2", address: "13900139000", display_name: "李四", last_text: "回一下", last_ts_ms: 1_700_000_100_000, unread: 2 },
    ];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_snapshot") return inbox;
        if (cmd === "sms_messages") {
          const id = String(args?.threadId ?? "1");
          return [
            {
              thread_id: id,
              id: `m-${id}`,
              from_me: false,
              text: "hi",
              ts_ms: inbox.find((t) => t.id === id)?.last_ts_ms ?? 0,
              read: false,
            },
          ];
        }
        return null;
      },
      listen: async () => () => {},
    };
    const settle = async () => {
      await tick();
      await new Promise<void>((r) => setTimeout(r, 0));
      await tick();
    };
    const host = render(MessagesApp);
    const chip = (name: string) =>
      [...host.container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(name),
      ) as HTMLButtonElement;
    await settle();
    // 李四's thread is not the auto-opened one, and the device reports 2 unread.
    expect(chip("李四").textContent).toContain("●2");
    await fireEvent.click(chip("李四"));
    await settle();
    // Opened → read. No `sms_mark_read` exists, so the device keeps its own count —
    // but the ●2 is about the messages now on screen and must not linger.
    expect(chip("李四").textContent).not.toContain("●");
    // Switching away must not resurrect it: those messages were displayed.
    await fireEvent.click(chip("家人"));
    await settle();
    expect(chip("李四").textContent).not.toContain("●");
    // A *new* message advances the device's own timestamp → unread again.
    inbox = inbox.map((t) =>
      t.id === "2" ? { ...t, last_text: "再看一眼", last_ts_ms: 1_700_000_200_000, unread: 1 } : t,
    );
    await fireEvent.click(
      host.container.querySelector('button[data-testid="refresh-sms"]') as HTMLButtonElement,
    );
    await settle();
    expect(chip("李四").textContent).toContain("●1");
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
    expect(host.container.querySelector('input[data-testid="new-contact"]')).toBeNull();
    // Granting the permission and retrying recovers into the real inbox.
    granted = true;
    await fireEvent.click(host.container.querySelector('button[data-testid="sms-retry"]') as HTMLButtonElement);
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
    expect(host.container.querySelector('input[data-testid="new-contact"]')).toBeNull();
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
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms"]') as HTMLButtonElement);
    await tick();
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-to"]') as HTMLInputElement, {
      target: { value: "+8613800138000" },
    });
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-text"]') as HTMLInputElement, {
      target: { value: "测试短信" },
    });
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms-send"]') as HTMLButtonElement);
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
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms"]') as HTMLButtonElement);
    await tick();
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-to"]') as HTMLInputElement, {
      target: { value: "10086" },
    });
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-text"]') as HTMLInputElement, {
      target: { value: "想问下流量包" },
    });
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms-draft"]') as HTMLButtonElement);
    await tick();
    expect(calls.some((c) => c.cmd === "sms_send")).toBe(false); // nothing was sent
    // The drafts folder lists it from the local store.
    await fireEvent.click(host.container.querySelector('button[data-folder="draft"]') as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(host.container.querySelector('[data-testid="drafts-list"]')).toBeTruthy();
    expect(txt(host)).toContain("想问下流量包");
    // Editing it prefils the composer; sending clears the draft and sends for real.
    const draftEdit = host.container.querySelector('button[data-testid="draft-edit-10086"]') as HTMLButtonElement;
    // the hook id lives in data-testid; the announced name is real copy (REQ-A1080)
    expect(draftEdit.getAttribute("aria-label")).toBe(zh["message.openDraft"]);
    await fireEvent.click(draftEdit);
    await tick();
    const to = host.container.querySelector('input[data-testid="new-sms-to"]') as HTMLInputElement;
    expect(to.value).toBe("10086");
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms-send"]') as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const sent = calls.find((c) => c.cmd === "sms_send");
    expect(sent?.address).toBe("10086");
    expect(sent?.text).toBe("想问下流量包");
    expect(txt(host)).not.toContain("想问下流量包"); // draft consumed
    expect(txt(host)).toContain("暂无草稿");
  });

  /**
   * REQ-A1759 / F-TEL-045 — an **absent** verdict is neither a success nor a refusal.
   *
   * The Rust bridge answers `"unconfirmed"` when the provider named no verdict in
   * time — including when our own 8 s bridge timeout expires first, which the send
   * path used to fold into `SmsProviderRejected` (i.e. 「发送失败」 for a message the
   * radio may well have taken). This branch was dead: nothing produced
   * `"unconfirmed"` from a timeout, and no test had ever driven it. The text must
   * stay in the box and the draft must survive, because "we don't know" is not
   * "it did not go out".
   */
  test("a send with no verdict keeps the text and says so (REQ-A1759)", async () => {
    const calls: Record<string, unknown>[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ?? {}) });
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 0, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot") return [];
        if (cmd === "sms_messages") return [];
        // The bridge's own answer when the platform gave no verdict in time.
        if (cmd === "sms_send") return "unconfirmed";
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await settle();
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms"]') as HTMLButtonElement);
    await tick();
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-to"]') as HTMLInputElement, {
      target: { value: "10086" },
    });
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-text"]') as HTMLInputElement, {
      target: { value: "流量包还有吗" },
    });
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms-send"]') as HTMLButtonElement);
    await settle();
    expect(calls.some((c) => c.cmd === "sms_send")).toBe(true);
    // The honest sentence, not the refusal one.
    expect(txt(host)).toContain(zh["message.sendUnconfirmed"]);
    expect(txt(host)).not.toContain(zh["message.sendFailed"]);
    // The text is still in the composer — a message that may have gone out must not
    // be silently consumed.
    const still = host.container.querySelector('input[data-testid="new-sms-text"]') as HTMLInputElement | null;
    expect(still).toBeTruthy();
    expect(still?.value).toBe("流量包还有吗");
  });

  /**
   * REQ-A1069 — the new-message composer's refusal notice must be reachable from
   * **every** folder the composer can be opened in.
   *
   * `sendNew` reports a refused device send by setting `realErr`, but `realErr` is
   * rendered only inside the `{:#if folder === "draft"}` chain's *other* branches —
   * the draft branch itself renders nothing for it. The compose form is a sibling
   * *above* that chain, so a user sitting in 草稿 who composes and gets a refusal
   * sees the form sit there unchanged and nothing say why (「发送失败」 has no
   * render point in the view the action was taken from).
   */
  const deviceSendFails = (): Record<string, unknown>[] => {
    const calls: Record<string, unknown>[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ?? {}) });
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 0, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot") return [];
        if (cmd === "sms_messages") return [];
        // Not "sent" — anything else is a refusal (`smsSend` returns `r === "sent"`).
        if (cmd === "sms_send") return { kind: "denied" };
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  };

  test("a refused device send says so from the inbox (the branch the notice lives in)", async () => {
    const calls = deviceSendFails();
    const host = render(MessagesApp);
    await tick();
    await settle();
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms"]') as HTMLButtonElement);
    await tick();
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-to"]') as HTMLInputElement, {
      target: { value: "10086" },
    });
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-text"]') as HTMLInputElement, {
      target: { value: "流量包" },
    });
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms-send"]') as HTMLButtonElement);
    await settle();
    expect(calls.some((c) => c.cmd === "sms_send")).toBe(true);
    expect(txt(host)).toContain(zh["message.sendFailed"]);
  });

  test("a refused device send says so from the drafts folder too (REQ-A1069)", async () => {
    const calls = deviceSendFails();
    const host = render(MessagesApp);
    await tick();
    await settle();
    // The composer is opened while the user is looking at 草稿.
    await fireEvent.click(host.container.querySelector('button[data-folder="draft"]') as HTMLButtonElement);
    await settle();
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms"]') as HTMLButtonElement);
    await tick();
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-to"]') as HTMLInputElement, {
      target: { value: "10086" },
    });
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-text"]') as HTMLInputElement, {
      target: { value: "流量包" },
    });
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms-send"]') as HTMLButtonElement);
    await settle();
    expect(calls.some((c) => c.cmd === "sms_send")).toBe(true);
    // The send was refused; the screen must say so wherever the composer was opened.
    expect(txt(host)).toContain(zh["message.sendFailed"]);
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
      'button[data-testid="block-sender-18616091470"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    // the hook id lives in data-testid; the announced name is real copy (REQ-A1080)
    expect(btn.getAttribute("aria-label")).toBe(zh["message.blockSender"]);
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
      host.container.querySelector('button[data-testid="block-sender-10086"]') as HTMLButtonElement,
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
      /** Commands whose call **rejects** (a Rust `Err`): `lib/backend` records it in the
       *  diagnostics ledger and answers `null`, which is how a command failure reaches a
       *  caller. Passing `null` as a reply cannot express this — `opts.x ?? default`
       *  treats it as "unset". */
      throwFor?: string[];
    } = {},
  ) {
    const seen: Record<string, unknown>[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        seen.push({ cmd, ...(args ?? {}) });
        if (opts.throwFor?.includes(cmd)) throw new Error(`refused: ${cmd}`);
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

  test("a restore the host no longer matches says so — it never names the trash-add action (REQ-A288)", async () => {
    // `sms_trash_restore` answers a bool, and the host's `SmsTrashState::restore` answers
    // `false` **exactly** when no entry matched (a stale row — already restored elsewhere —
    // or a malformed id; persisting is best-effort and never flips the answer). So the
    // false branch must say "it is no longer in the trash": the sentence it used to show,
    // `message.trashFailed` = "移入回收站失败，请重试", names the *opposite* action ("could not
    // move **to** the trash") for a case where nothing was being moved anywhere.
    deviceBridge({
      trashList: [
        { thread_id: "1", message_id: "m1", ts_ms: 1_700_000_000_000, trashed_ms: 1_700_000_000_000 },
      ],
      restoreReply: false,
    });
    const host = render(MessagesApp);
    await settle();
    await clickTestId(host.container, "trash-toggle");
    await clickTestId(host.container, "trash-restore-m1");
    const note = host.container.querySelector('[data-testid="trash-msg"]')!;
    expect(note.textContent).toContain(t("message.trashNotInTrash"));
    expect(note.textContent).not.toContain(t("message.trashFailed"));
    // Still an alert (the outcome is surprising), and the thread is NOT re-read on a
    // no-op — there is nothing new to show.
    expect(note.getAttribute("data-ok")).toBe("false");
    expect(note.getAttribute("role")).toBe("alert");
  });

  test("a restore the bridge never answered says the restore failed, not that the row is stale (REQ-A1153)", async () => {
    // `sms_trash_restore` now persists on the blocking pool, so the command can
    // `Err` (worker timeout/panic) where it previously could not. The frontend
    // wrapper answers `null` for "not answered" and `false` for "no entry
    // matched" — folding them together would report a host failure as a claim
    // about the trash's contents ("该短信已不在回收站里").
    deviceBridge({
      trashList: [
        { thread_id: "1", message_id: "m1", ts_ms: 1_700_000_000_000, trashed_ms: 1_700_000_000_000 },
      ],
      throwFor: ["sms_trash_restore"],
    });
    const host = render(MessagesApp);
    await settle();
    await clickTestId(host.container, "trash-toggle");
    await clickTestId(host.container, "trash-restore-m1");
    const note = host.container.querySelector('[data-testid="trash-msg"]')!;
    expect(note.textContent).toContain(t("message.trashRestoreFailed"));
    expect(note.textContent).not.toContain(t("message.trashNotInTrash"));
    expect(note.getAttribute("data-ok")).toBe("false");
  });

  test("a purge the bridge never answered names the purge, not the trash-add (REQ-A288)", async () => {
    // `sms_trash_purge` returning nothing means the *call* was not answered (a `0` count is
    // a successful no-op and reads as success — pinned by the case below). The failure
    // sentence must therefore be about emptying the trash.
    deviceBridge({
      trashList: [
        { thread_id: "1", message_id: "m1", ts_ms: 1_700_000_000_000, trashed_ms: 1_700_000_000_000 },
      ],
      throwFor: ["sms_trash_purge"],
    });
    const host = render(MessagesApp);
    await settle();
    await clickTestId(host.container, "trash-toggle");
    await clickTestId(host.container, "trash-purge");
    const note = host.container.querySelector('[data-testid="trash-msg"]')!;
    expect(note.textContent).toContain(t("message.trashPurgeFailed"));
    expect(note.textContent).not.toContain(t("message.trashFailed"));
  });

  test("a purge that finds nothing left is a success, not a failure (REQ-A288)", async () => {
    // A stale panel: the tab still lists one entry (so the button is enabled), but the
    // host's trash is already empty ⇒ the command answers `0`. That is a *successful*
    // no-op — the wrapper's `typeof purged === "number"` is what keeps `0` out of the
    // falsy trap, and the sentence must not call it a failure.
    deviceBridge({
      trashList: [
        { thread_id: "1", message_id: "m1", ts_ms: 1_700_000_000_000, trashed_ms: 1_700_000_000_000 },
      ],
      purgeReply: 0,
    });
    const host = render(MessagesApp);
    await settle();
    await clickTestId(host.container, "trash-toggle");
    await clickTestId(host.container, "trash-purge");
    const note = host.container.querySelector('[data-testid="trash-msg"]')!;
    expect(note.getAttribute("data-ok")).toBe("true");
    expect(note.textContent).toContain(t("message.trashPurged"));
    expect(note.textContent).not.toContain(t("message.trashPurgeFailed"));
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

/**
 * The per-message actions on a **touch** class.
 *
 * These buttons are `opacity-0` + `pointer-events-none` until their row is revealed
 * (hover-scan rule 2 forbids invisible-but-hit-testable, and a finger cannot hover), so
 * before this round the whole action set — including 引用回复 — existed only as paint no
 * finger could hit. The gesture is iOS's own: press-and-hold a bubble, or swipe it left,
 * and the actions *slide out and wait*. The gesture itself must never run the action —
 * the old swipe **deleted** the message outright, with no confirmation and no undo.
 */
describe("MessagesApp.svelte — per-message actions are reachable by touch", () => {
  const tap = (el: Element, x = 0, y = 0) => ({ touches: [{ clientX: x, clientY: y }] });
  const lift = (el: Element, x = 0, y = 0) => ({ changedTouches: [{ clientX: x, clientY: y }] });

  const btn = (c: HTMLElement, id: string) =>
    c.querySelector(`button[data-testid="${id}"]`) as HTMLButtonElement;
  const rowOf = (el: Element) => el.closest('[role="group"]') as HTMLElement;
  const revealed = (el: HTMLElement) => !el.className.includes("pointer-events-none");

  test("the actions are invisible AND un-hit-testable until the row is revealed", () => {
    const host = render(MessagesApp);
    const reply = btn(host.container, "reply-msg-btn-0");
    expect(reply).toBeTruthy();
    expect(reply.className).toContain("opacity-0");
    expect(reply.className).toContain("pointer-events-none");
  });

  test("press-and-hold reveals the row; the lift leaves it open", async () => {
    vi.useFakeTimers();
    try {
      const host = render(MessagesApp);
      const reply = btn(host.container, "reply-msg-btn-0");
      const row = rowOf(reply);
      await fireEvent.touchStart(row, tap(row, 200, 200));
      expect(revealed(reply)).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(revealed(reply)).toBe(true);
      // Lifting the finger must not immediately slam the row shut (the hold that
      // revealed it is not a swipe, and `pressFired` proves it).
      await fireEvent.touchEnd(row, lift(row, 200, 200));
      expect(revealed(reply)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a left swipe reveals the actions — and does NOT delete the message", async () => {
    const host = render(MessagesApp);
    const reply = btn(host.container, "reply-msg-btn-0");
    const row = rowOf(reply);
    const before = txt(host);
    await fireEvent.touchStart(row, tap(row, 200, 200));
    await fireEvent.touchEnd(row, lift(row, 100, 200)); // 100 px left, no vertical drift
    expect(revealed(reply)).toBe(true);
    // The old behaviour destroyed the message here. The text must survive.
    expect(txt(host)).toBe(before);
  });

  test("a vertical scroll opens nothing — and so does a diagonal drag", async () => {
    const host = render(MessagesApp);
    const reply = btn(host.container, "reply-msg-btn-0");
    const row = rowOf(reply);
    // A plain downward scroll.
    await fireEvent.touchStart(row, tap(row, 200, 200));
    await fireEvent.touchEnd(row, lift(row, 195, 100));
    expect(revealed(reply)).toBe(false);
    // A diagonal drag that *does* travel >50 px left but travels 140 px down: the
    // dominance test (`dx > dy`), not the distance test alone, is what refuses it.
    await fireEvent.touchStart(row, tap(row, 200, 200));
    await fireEvent.touchEnd(row, lift(row, 140, 60));
    expect(revealed(reply)).toBe(false);
  });

  test("a finger that drifts past the slop before the threshold cancels the hold", async () => {
    vi.useFakeTimers();
    try {
      const host = render(MessagesApp);
      const reply = btn(host.container, "reply-msg-btn-0");
      const row = rowOf(reply);
      await fireEvent.touchStart(row, tap(row, 200, 200));
      await fireEvent.touchMove(row, tap(row, 200, 260)); // 60 px down — scrolling
      await vi.advanceTimersByTimeAsync(500);
      expect(revealed(reply)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the revealed action is the only way in: tapping it removes that message", async () => {
    const host = render(MessagesApp);
    const remove = btn(host.container, "remove-msg-btn-0");
    const row = rowOf(remove);
    expect(txt(host)).toContain("你好！Amos 系统感觉怎么样？");
    await fireEvent.touchStart(row, tap(row, 200, 200));
    await fireEvent.touchEnd(row, lift(row, 100, 200));
    await fireEvent.click(remove);
    await tick();
    // That one bubble is gone; the rest of the thread is untouched.
    expect(txt(host)).not.toContain("你好！Amos 系统感觉怎么样？");
    expect(txt(host)).toContain("很棒，像 iOS 一样顺滑。");
  });
});

/**
 * `saveConvs` reports a refused write (it sets `storeErr` and leaves the store and
 * `conversations` untouched) — but a caller that also moves *view* state must honour
 * that verdict too. These two did not: the add moved the open thread to one that was
 * never stored and blanked the name box, and the send emptied the composer.
 */
describe("MessagesApp.svelte — 被拒的写入不得当成写入成功", () => {
  /** The composer input of the active (local) thread. */
  const composer = (h: { container: HTMLElement }) => input(h)!;
  const addBtn = (h: { container: HTMLElement }) =>
    h.container.querySelector('button[data-testid="add-contact"]') as HTMLButtonElement;
  const newName = (h: { container: HTMLElement }) =>
    h.container.querySelector('input[data-testid="new-contact"]') as HTMLInputElement;

  test("a refused add keeps the open thread and the typed name", async () => {
    const restore = failWritesFor(CONV_KEY);
    try {
      const host = render(MessagesApp);
      // The seeded thread is open and its messages are on screen.
      expect(txt(host)).toContain("你好！Amos 系统感觉怎么样？");
      await fireEvent.input(newName(host), { target: { value: "李四" } });
      await fireEvent.click(addBtn(host));
      await tick();
      expect(txt(host)).toContain("本机存储写入失败");
      // Nothing was stored, so nothing may be claimed — including the *view*: the
      // thread 李四 never existed, so it must not be the one on screen, and the
      // conversation that WAS open must still be there.
      expect(txt(host)).not.toContain("暂无会话");
      expect(txt(host)).toContain("你好！Amos 系统感觉怎么样？");
      // The name stays so the user can retry once storage is back.
      expect(newName(host).value).toBe("李四");
    } finally {
      restore();
    }
  });

  test("a refused send keeps the typed message and claims nothing", async () => {
    const restore = failWritesFor(CONV_KEY);
    try {
      const host = render(MessagesApp);
      await fireEvent.input(composer(host), { target: { value: "在的" } });
      const sendBtn = [...host.container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === t("message.send"),
      ) as HTMLButtonElement;
      expect(sendBtn).toBeTruthy();
      await fireEvent.click(sendBtn);
      await tick();
      expect(txt(host)).toContain("本机存储写入失败");
      // The message never landed, so it is neither in the thread nor gone from the box.
      expect(txt(host)).not.toContain("在的");
      expect(composer(host).value).toBe("在的");
      expect(readStoreValue<{ msgs: { text: string }[] }[]>(CONV_KEY, []).some((c) =>
        c.msgs.some((m) => m.text === "在的"),
      )).toBe(false);
    } finally {
      restore();
    }
  });

  test("a refused clear keeps the typed message too (REQ-A1039)", async () => {
    const restore = failWritesFor(CONV_KEY);
    try {
      const host = render(MessagesApp);
      await fireEvent.input(composer(host), { target: { value: "草稿" } });
      const clearBtn = [...host.container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === t("message.clear"),
      ) as HTMLButtonElement;
      expect(clearBtn).toBeTruthy();
      await fireEvent.click(clearBtn);
      await tick();
      expect(txt(host)).toContain("本机存储写入失败");
      expect(composer(host).value).toBe("草稿");
    } finally {
      restore();
    }
  });

  test("a refused thread delete keeps the typed message too (REQ-A1039)", async () => {
    const host = render(MessagesApp);
    const ni = host.container.querySelector('input[data-testid="new-contact"]') as HTMLInputElement;
    await fireEvent.input(ni, { target: { value: "王五" } });
    await fireEvent.click(host.container.querySelector('button[data-testid="add-contact"]') as HTMLButtonElement);
    await tick();
    await fireEvent.input(composer(host), { target: { value: "草稿" } });
    const restore = failWritesFor(CONV_KEY);
    try {
      await fireEvent.click(host.container.querySelector('button[data-testid="delete-thread"]') as HTMLButtonElement);
      await tick();
      expect(txt(host)).toContain("本机存储写入失败");
      expect(txt(host)).toContain("王五");
      expect(composer(host).value).toBe("草稿");
    } finally {
      restore();
    }
  });

  // The drafts folder is its own branch (`{#if folder === "draft"}`) and, at HEAD, that
  // branch came *first* in the same `{#if}/{:else if}` chain that owns `smsErr`. So a
  // failed device read of the draft folder had **no render point at all**: the local
  // drafts (AmOS-local, always readable) were still drawn, and the screen looked exactly
  // like a device with no drafts — "could not read" silently became "there are none",
  // the very collapse `SmsFolderSnapshotResult`'s own doc says would lie to the user.
  // The local list is still true and must stay; only the *system* drafts section is
  // unknown, so the honest answer is the list plus a line saying the read failed.
  test("a failed device read of the drafts folder says so instead of reading as empty (REQ-A1070)", async () => {
    const settle = async () => {
      await tick();
      await new Promise<void>((r) => setTimeout(r, 0));
      await tick();
    };
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 0, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot") {
          if (args?.folder === "draft") return null; // the draft folder could not be read
          return [];
        }
        if (cmd === "sms_messages") return [];
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await settle();
    await fireEvent.click(host.container.querySelector('button[data-folder="draft"]') as HTMLButtonElement);
    await settle();
    // The local drafts are still shown...
    expect(host.container.querySelector('[data-testid="drafts-list"]')).toBeTruthy();
    // ...and the failed read is spoken, not folded into 「草稿箱为空」.
    expect(txt(host)).toContain(zh["message.smsUnavailable"]);
  });

  test("a refused draft write keeps the composed message (REQ-A1042)", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 0, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot") return [];
        if (cmd === "sms_messages") return [];
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms"]') as HTMLButtonElement);
    await tick();
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-to"]') as HTMLInputElement, {
      target: { value: "10086" },
    });
    await fireEvent.input(host.container.querySelector('input[data-testid="new-sms-text"]') as HTMLInputElement, {
      target: { value: "想问下流量包" },
    });
    const restore = failWritesFor(DRAFT_KEY);
    try {
      await fireEvent.click(host.container.querySelector('button[data-testid="new-sms-draft"]') as HTMLButtonElement);
      await tick();
      expect(txt(host)).toContain("本机存储写入失败");
      const body = host.container.querySelector('input[data-testid="new-sms-text"]') as HTMLInputElement | null;
      expect(body?.value ?? "").toBe("想问下流量包");
    } finally {
      restore();
    }
  });

  // The real inbox renders `realMsgs` under the *open* thread's name. Switching threads
  // moves the name immediately; the body must move with it. A failed read of the newly
  // opened thread used to leave the previous thread's messages under the new name —
  // the error line said 「无法读取该会话」 while the wrong conversation filled the pane,
  // so the screen showed valid-looking content that belonged to someone else.
  test("a failed read of the switched-to thread shows no other thread's messages (REQ-A1043)", async () => {
    const threads = [
      { id: "1", address: "13800138000", display_name: "家人", last_text: "A", last_ts_ms: 1_700_000_000_000, unread: 0 },
      { id: "2", address: "10086", display_name: "李四", last_text: "B", last_ts_ms: 1_700_000_100_000, unread: 0 },
    ];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 2, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot") return threads;
        if (cmd === "sms_messages") {
          if (args?.threadId === "1") {
            return [{ thread_id: "1", id: "m1", from_me: false, text: "甲线程独有的正文", ts_ms: 1_700_000_000_000, read: true }];
          }
          return null; // thread 2 could not be read
        }
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    // Thread 1 is auto-opened and read successfully.
    expect(txt(host)).toContain("甲线程独有的正文");
    // Switch to thread 2, whose read fails: the header moves, the stale body must not.
    const chip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("李四"),
    ) as HTMLButtonElement;
    expect(chip).toBeTruthy();
    await fireEvent.click(chip);
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(txt(host)).toContain("李四");
    expect(txt(host)).toContain("无法读取该会话");
    expect(txt(host)).not.toContain("甲线程独有的正文");
  });

  // The mirror of the guard above, one step later in time: the read of the thread we
  // just left *succeeds*, but lands after the switch. Without a stale-response guard it
  // overwrites the new thread's body, so the header says 李四 while the pane shows
  // 家人's texts — valid-looking content belonging to someone else, exactly what the
  // failed-read guard was written to prevent (identity and content must move together).
  test("a read that lands after the user switched threads must not fill the new one (REQ-A1053)", async () => {
    const threads = [
      { id: "1", address: "13800138000", display_name: "家人", last_text: "A", last_ts_ms: 1_700_000_000_000, unread: 0 },
      { id: "2", address: "10086", display_name: "李四", last_text: "B", last_ts_ms: 1_700_000_100_000, unread: 0 },
    ];
    const pending = new Map<string, (v: unknown) => void>();
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 2, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot") return threads;
        if (cmd === "sms_trash_list") return [];
        if (cmd === "sms_messages") {
          const id = String(args?.threadId ?? "");
          return new Promise((resolve) => pending.set(id, resolve));
        }
        return null;
      },
      listen: async () => () => {},
    };
    const flush = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      await tick();
    };
    const host = render(MessagesApp);
    await flush();
    // Thread 1 is auto-opened; its read is still in flight.
    expect(pending.has("1")).toBe(true);
    // The user switches to thread 2 while thread 1's read is outstanding.
    const chip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("李四"),
    ) as HTMLButtonElement;
    await fireEvent.click(chip);
    await flush();
    // Thread 2 answers first — its body is the one on screen.
    pending.get("2")?.([{ thread_id: "2", id: "b1", from_me: false, text: "乙线程正文", ts_ms: 1_700_000_100_000, read: true }]);
    await flush();
    expect(txt(host)).toContain("乙线程正文");
    // Now thread 1's read finally lands: it belongs to a thread that is no longer open.
    pending.get("1")?.([{ thread_id: "1", id: "a1", from_me: false, text: "甲线程正文", ts_ms: 1_700_000_000_000, read: true }]);
    await flush();
    expect(txt(host)).toContain("李四");
    expect(txt(host)).toContain("乙线程正文");
    expect(txt(host)).not.toContain("甲线程正文");
  });

  // The same rule one level up: the *folder* read is asynchronous too, so a snapshot
  // that lands after the user switched folders describes the folder they left. Applying
  // it draws that folder's threads under the new tab — and auto-opens one of them — so
  // the tab strip and the list disagree about which folder is on screen.
  test("a folder snapshot that lands after the user switched folders must not fill the new tab (REQ-A1053)", async () => {
    const threadsFor: Record<string, unknown[]> = {
      inbox: [{ id: "1", address: "13800138000", display_name: "家人", last_text: "收件箱预览", last_ts_ms: 1_700_000_000_000, unread: 0 }],
      sent: [{ id: "9", address: "10086", display_name: "已发送者", last_text: "发件箱预览", last_ts_ms: 1_700_000_100_000, unread: 0 }],
    };
    const snapshots: { folder: string; resolve: (v: unknown) => void }[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 1, sent: 1, draft: 0 };
        if (cmd === "sms_trash_list") return [];
        if (cmd === "sms_snapshot") {
          const folder = String(args?.folder ?? "");
          return new Promise((resolve) => snapshots.push({ folder, resolve }));
        }
        if (cmd === "sms_messages") return [];
        return null;
      },
      listen: async () => () => {},
    };
    const flush = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      await tick();
    };
    const folderTab = (h: { container: HTMLElement }, f: string) =>
      h.container.querySelector(`button[data-folder="${f}"]`) as HTMLButtonElement;
    const host = render(MessagesApp);
    await flush();
    // The inbox read answers first — its threads are on screen.
    snapshots[0]?.resolve(threadsFor["inbox"]);
    await flush();
    expect(txt(host)).toContain("家人");
    // The user visits 发件箱 (read still in flight), then returns to 收件箱.
    await fireEvent.click(folderTab(host, "sent"));
    await flush();
    await fireEvent.click(folderTab(host, "inbox"));
    await flush();
    // The 发件箱 snapshot finally lands: the active tab is 收件箱, so nothing may change.
    const sent = snapshots.find((s) => s.folder === "sent");
    expect(sent, "the sent-folder snapshot was requested").toBeTruthy();
    sent?.resolve(threadsFor["sent"]);
    await flush();
    expect(folderTab(host, "inbox").getAttribute("aria-pressed")).toBe("true");
    expect(txt(host)).toContain("家人");
    expect(txt(host)).not.toContain("已发送者");
  });

  // The *other half* of that same window. The guard above stops a late snapshot from
  // filling the new tab; it says nothing about the stretch of time between pressing a tab
  // and that tab's snapshot arriving — and `setFolder` cleared the open thread's messages
  // but left `realThreads` standing. So for the whole duration of the read (a JNI round
  // trip) the tab strip named one folder while the list drew the folder just left: the
  // exact "the tab strip and the list disagree about which folder is on screen" the guard
  // above was written to prevent, surviving in the window the guard does not cover. In
  // 草稿 it is worse still — those rows are drawn under 「系统草稿（只读）」, so the screen
  // labels an inbox thread as a system draft. REQ-A1212 / F-SH-498.
  test("threads belonging to the folder just left are not drawn under the new tab (REQ-A1212)", async () => {
    const threadsFor: Record<string, unknown[]> = {
      inbox: [{ id: "1", address: "13800138000", display_name: "家人", last_text: "收件箱预览", last_ts_ms: 1_700_000_000_000, unread: 0 }],
      sent: [{ id: "9", address: "10086", display_name: "已发送者", last_text: "发件箱预览", last_ts_ms: 1_700_000_100_000, unread: 0 }],
    };
    const snapshots: { folder: string; resolve: (v: unknown) => void }[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 1, sent: 1, draft: 0 };
        if (cmd === "sms_trash_list") return [];
        if (cmd === "sms_snapshot") {
          const folder = String(args?.folder ?? "");
          return new Promise((resolve) => snapshots.push({ folder, resolve }));
        }
        if (cmd === "sms_messages") return [];
        return null;
      },
      listen: async () => () => {},
    };
    const flush = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      await tick();
    };
    const folderTab = (h: { container: HTMLElement }, f: string) =>
      h.container.querySelector(`button[data-folder="${f}"]`) as HTMLButtonElement;
    const host = render(MessagesApp);
    await flush();
    snapshots[0]?.resolve(threadsFor["inbox"]);
    await flush();
    expect(txt(host)).toContain("家人");

    // Press 发件箱: its read is still in flight. The tab now names a folder whose threads
    // we do not have — so the inbox thread must not be on screen, and the list must say
    // it is reading rather than claiming the folder is empty.
    await fireEvent.click(folderTab(host, "sent"));
    await flush();
    expect(folderTab(host, "sent").getAttribute("aria-pressed")).toBe("true");
    expect(txt(host)).not.toContain("家人");
    expect(txt(host)).toContain(t("message.reading"));
    expect(txt(host)).not.toContain(t("message.inboxEmpty"));

    // …and 草稿 must not draw it as a system draft either.
    await fireEvent.click(folderTab(host, "draft"));
    await flush();
    expect(txt(host)).not.toContain("家人");
    expect(txt(host)).not.toContain(t("message.draftsSystem"));

    // The draft read lands, then we return to 发件箱: now the tab's own threads are the
    // ones on screen, and the inbox thread is gone for good.
    snapshots.find((s) => s.folder === "draft")?.resolve([]);
    await flush();
    await fireEvent.click(folderTab(host, "sent"));
    await flush();
    const sentReads = snapshots.filter((s) => s.folder === "sent");
    sentReads[sentReads.length - 1]?.resolve(threadsFor["sent"]);
    await flush();
    expect(txt(host)).toContain("已发送者");
    expect(txt(host)).not.toContain("家人");
  });

  // The empty-list branch is reached by 收件箱 **and** 发件箱, and it spoke one sentence —
  // 「本机暂无短信」, a claim about the *whole device*. So a phone whose inbox has threads
  // but from which the user has never sent one read 「本机暂无短信」 under 发件箱: the tab
  // strip said 发件箱, the sentence denied the device held any SMS, and the 收件箱 tab one
  // across proved it false with its own thread list and count badge. 草稿 has its own
  // sentence (`message.draftsEmpty`) and the thread pane has one (`message.empty`); only
  // these two folders shared a single key — and the key that names a folder is the other
  // folder's (the *inbox* is not empty). REQ-A1214 / F-SH-500.
  test("an empty folder names itself, not the whole device (REQ-A1214)", async () => {
    const threadsFor: Record<string, unknown[]> = {
      inbox: [{ id: "1", address: "13800138000", display_name: "家人", last_text: "收件箱预览", last_ts_ms: 1_700_000_000_000, unread: 0 }],
      sent: [],
    };
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 1, sent: 0, draft: 0 };
        if (cmd === "sms_trash_list") return [];
        if (cmd === "sms_snapshot") return threadsFor[String(args?.folder ?? "")] ?? [];
        if (cmd === "sms_messages") return [];
        return null;
      },
      listen: async () => () => {},
    };
    const flush = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      await tick();
    };
    const folderTab = (h: { container: HTMLElement }, f: string) =>
      h.container.querySelector(`button[data-folder="${f}"]`) as HTMLButtonElement;
    const host = render(MessagesApp);
    await flush();
    // The device demonstrably is not empty: 收件箱 is showing a thread.
    expect(txt(host)).toContain("家人");

    await fireEvent.click(folderTab(host, "sent"));
    await flush();
    expect(folderTab(host, "sent").getAttribute("aria-pressed")).toBe("true");
    expect(host.container.querySelector('[data-testid="sms-empty"]')).toBeTruthy();
    expect(txt(host)).toContain(t("message.sentEmpty"));
    // …and it must not deny that the device holds any SMS at all.
    expect(txt(host)).not.toContain(t("message.inboxEmpty"));
  });

  // The composer belongs to the thread. `send`, `clear`, `deleteThread` and `confirmAdd`
  // each say so (they move composer state only once the thread's change really landed),
  // and the device pane's `openReal` says so by clearing its messages; the thread strip
  // alone did not. So switching conversations carried the **reply target** — a pointer at
  // one specific message of the conversation just left, which the bar kept rendering with
  // the 「回复」 label — and the half-typed **text** into the new thread. REQ-A1219 / F-SH-504.
  test("switching the open conversation takes the reply target and its text with it (REQ-A1219)", async () => {
    const host = render(MessagesApp);
    const convTab = (name: string) =>
      Array.from(host.container.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").trim().startsWith(name),
      ) as HTMLButtonElement;
    // A second conversation to switch to.
    await fireEvent.input(
      host.container.querySelector('input[data-testid="new-contact"]') as HTMLInputElement,
      { target: { value: "小李" } },
    );
    await fireEvent.click(
      host.container.querySelector('button[data-testid="add-contact"]') as HTMLButtonElement,
    );
    await tick();
    expect(txt(host)).toContain("小李");

    // Back to 小安: take one of its bubbles as the reply target, and type into the box.
    await fireEvent.click(convTab("小安"));
    await tick();
    const QUOTED = "你好！Amos 系统感觉怎么样？";
    expect(txt(host)).toContain(QUOTED);
    const reply = host.container.querySelector('button[data-testid="reply-msg-btn-0"]') as HTMLButtonElement;
    const row = reply.closest('[role="group"]') as HTMLElement;
    await fireEvent.touchStart(row, { touches: [{ clientX: 200, clientY: 200 }] });
    await fireEvent.touchEnd(row, { changedTouches: [{ clientX: 100, clientY: 200 }] });
    await fireEvent.click(reply);
    await tick();
    expect(txt(host)).toContain(t("message.replying"));
    await fireEvent.input(input(host)!, { target: { value: "给小安的话" } });
    expect(input(host)!.value).toBe("给小安的话");

    // 小李 is open now. 小安's message is not on this screen, so any occurrence of it
    // could only come from the reply bar — which names a message of another thread.
    await fireEvent.click(convTab("小李"));
    await tick();
    expect(txt(host)).not.toContain(t("message.replying"));
    expect(txt(host)).not.toContain(QUOTED);
    expect(input(host)!.value).toBe("");
  });

  test("switching the open device thread clears the composer addressed to the one just left (REQ-A1219)", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 2, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot")
          return [
            { id: "1", address: "18616091470", display_name: "推销", last_text: "优惠活动", last_ts_ms: 1_700_000_000_000, unread: 0 },
            { id: "2", address: "10086", display_name: "运营商", last_text: "流量提醒", last_ts_ms: 1_700_000_100_000, unread: 0 },
          ];
        if (cmd === "sms_messages")
          return [
            { thread_id: "1", id: "m1", from_me: false, text: "优惠活动", ts_ms: 1_700_000_000_000, read: true },
          ];
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const composer = () =>
      host.container.querySelector('input[data-testid="real-message-input"]') as HTMLInputElement;
    // 推销 is the thread the device opened first; type the reply to *it*.
    await fireEvent.input(composer(), { target: { value: "给推销回的" } });
    expect(composer().value).toBe("给推销回的");

    const other = Array.from(host.container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("运营商"),
    ) as HTMLButtonElement;
    await fireEvent.click(other);
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(composer().value).toBe("");
  });

  // The same rule, reached through the *other* way the open thread moves. REQ-A1219 fixed
  // the thread strip, and `openLocalThread` (the deep link) routes through `openLocal` —
  // but its sibling `confirmAdd`, which also moves the open thread, still assigned the id
  // by hand (`activeId = added.id`). Creating a conversation from the name box therefore
  // switched the pane to a thread nothing had been typed to while the reply target and the
  // text stayed behind: 小安's message, labelled 「回复」, sat above 小李's empty composer, and
  // one tap on 发送 appended that quote — and that text — to 小李. REQ-A1220 / F-SH-505.
  test("creating a conversation takes the reply target and its text with it (REQ-A1220)", async () => {
    const host = render(MessagesApp);
    const QUOTED = "你好！Amos 系统感觉怎么样？";
    expect(txt(host)).toContain("小安");
    expect(txt(host)).toContain(QUOTED);
    const reply = host.container.querySelector('button[data-testid="reply-msg-btn-0"]') as HTMLButtonElement;
    const row = reply.closest('[role="group"]') as HTMLElement;
    await fireEvent.touchStart(row, { touches: [{ clientX: 200, clientY: 200 }] });
    await fireEvent.touchEnd(row, { changedTouches: [{ clientX: 100, clientY: 200 }] });
    await fireEvent.click(reply);
    await tick();
    expect(txt(host)).toContain(t("message.replying"));
    await fireEvent.input(input(host)!, { target: { value: "给小安的话" } });
    expect(input(host)!.value).toBe("给小安的话");

    // A *new* conversation, created while 小安's reply is still armed.
    await fireEvent.input(
      host.container.querySelector('input[data-testid="new-contact"]') as HTMLInputElement,
      { target: { value: "小李" } },
    );
    await fireEvent.click(
      host.container.querySelector('button[data-testid="add-contact"]') as HTMLButtonElement,
    );
    await tick();

    // 小李 is open; 小安's message is not on this screen, so any occurrence of it could
    // only come from the reply bar.
    expect(txt(host)).toContain("小李");
    expect(txt(host)).not.toContain(t("message.replying"));
    expect(txt(host)).not.toContain(QUOTED);
    expect(input(host)!.value).toBe("");
  });

  // Tapping the thread that is already open is not a switch — but the device pane's
  // `openReal` had no such guard, while its local twin `openLocal` does (`if (id ===
  // activeId) return`). So a tap on the highlighted pill of the thread already on screen
  // re-ran the whole open path: it emptied `realMsgs` (an honest-empty flash before the
  // re-read landed) and, once REQ-A1219 gave it `realText = ""`, silently discarded the
  // half-typed message addressed to that very thread. A refresh is `refreshReal` (the
  // 刷新 button, a live receive), not a tap on the pill. REQ-A1221 / F-SH-506.
  test("tapping the thread that is already open keeps its composer and does not re-read it (REQ-A1221)", async () => {
    let messageReads = 0;
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 1, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot")
          return [
            { id: "1", address: "18616091470", display_name: "推销", last_text: "优惠活动", last_ts_ms: 1_700_000_000_000, unread: 0 },
          ];
        if (cmd === "sms_messages") {
          messageReads++;
          return [
            { thread_id: "1", id: "m1", from_me: false, text: "优惠活动", ts_ms: 1_700_000_000_000, read: true },
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
    const composer = () =>
      host.container.querySelector('input[data-testid="real-message-input"]') as HTMLInputElement;
    await fireEvent.input(composer(), { target: { value: "给推销回的" } });
    expect(composer().value).toBe("给推销回的");

    const same = Array.from(host.container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("推销"),
    ) as HTMLButtonElement;
    // The pill for the thread already on screen is the pressed one.
    expect(same.getAttribute("aria-pressed")).toBe("true");
    const readsBefore = messageReads;
    await fireEvent.click(same);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(composer().value).toBe("给推销回的");
    expect(messageReads).toBe(readsBefore);
  });

  // The block-sender note belongs to the thread it was made from — 「拦截该号码」is a button
  // drawn for the *open* thread. `setFolder` already clears it when the folder changes, but
  // the thread strip did not clear it on a thread switch, so a refused block in 推销 kept its
  // red `role="alert"` on screen above 运营商's composer: the user reads a failure for a tap
  // they never made in this thread. REQ-A1240 / F-SH-519.
  test("a refused block note does not follow the user to another thread (REQ-A1240)", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 2, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot")
          return [
            { id: "1", address: "18616091470", display_name: "推销", last_text: "优惠活动", last_ts_ms: 1_700_000_000_000, unread: 0 },
            { id: "2", address: "10086", display_name: "运营商", last_text: "流量提醒", last_ts_ms: 1_700_000_100_000, unread: 0 },
          ];
        if (cmd === "sms_messages")
          return [
            { thread_id: "1", id: "m1", from_me: false, text: "优惠活动", ts_ms: 1_700_000_000_000, read: true },
          ];
        if (cmd === "blocklist_add") return null; // the platform refuses the rule
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const note = () => host.container.querySelector('[data-testid="block-sender-msg"]');
    const pill = (name: string) =>
      Array.from(host.container.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").includes(name),
      ) as HTMLButtonElement;

    // 推销 is open first; its block attempt is refused, so the red note is shown for it.
    await fireEvent.click(
      host.container.querySelector('button[data-testid="block-sender-18616091470"]') as HTMLButtonElement,
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(note()).toBeTruthy();
    expect(note()!.getAttribute("data-ok")).toBe("false");

    // Switch to 运营商: the refusal was about 推销 and must not be drawn here.
    await fireEvent.click(pill("运营商"));
    await tick();
    expect(note()).toBeNull();
  });

  // …but the note must still *survive* the switch the app performs on its own: a successful
  // block filters the sender out of the inbox, and when other threads remain `refreshReal`
  // opens the fallback thread through `openReal`. Clearing the note there would erase the
  // success confirmation in the same tick it was written — which is why the clear lives in
  // `switchReal` (the user's tap) and not in `openReal`. REQ-A1240 / F-SH-519.
  test("a successful block note survives the fall back to another thread (REQ-A1240)", async () => {
    let blocked = false;
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: blocked ? 1 : 2, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot")
          return blocked
            ? [{ id: "2", address: "10086", display_name: "运营商", last_text: "流量提醒", last_ts_ms: 1_700_000_100_000, unread: 0 }]
            : [
                { id: "1", address: "18616091470", display_name: "推销", last_text: "优惠活动", last_ts_ms: 1_700_000_000_000, unread: 0 },
                { id: "2", address: "10086", display_name: "运营商", last_text: "流量提醒", last_ts_ms: 1_700_000_100_000, unread: 0 },
              ];
        if (cmd === "sms_messages")
          return [{ thread_id: "2", id: "m2", from_me: false, text: "流量提醒", ts_ms: 1_700_000_100_000, read: true }];
        if (cmd === "blocklist_add") {
          blocked = true; // the sender is filtered out of the inbox from here on
          return { id: "r1", pattern: "18616091470", kind: "exact", channel: "both", label: "", created_ms: 1 };
        }
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    await fireEvent.click(
      host.container.querySelector('button[data-testid="block-sender-18616091470"]') as HTMLButtonElement,
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const note = host.container.querySelector('[data-testid="block-sender-msg"]')!;
    expect(note.getAttribute("data-ok")).toBe("true");
    expect(note.textContent).toContain("已屏蔽 18616091470");
    // The app fell back to 运营商 — and the confirmation it just wrote is still on screen.
    const pill = Array.from(host.container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("运营商"),
    ) as HTMLButtonElement;
    expect(pill.getAttribute("aria-pressed")).toBe("true");
  });

  // A *read* in flight is not a *send* in flight. `smsBusy` is raised by `refreshReal` for the
  // whole duration of a device snapshot round trip — and the live `sms-received` refresh fires
  // exactly while the user sits in a thread typing a reply — yet both composers read that same
  // flag as their re-entrancy guard (REQ-A1152). So an incoming SMS silently swallowed the
  // answer: Enter did nothing at all, and the send button was greyed by a read. REQ-A1243 / F-SH-522.
  test("a read in flight does not swallow a device send (REQ-A1243)", async () => {
    let snapshotCalls = 0;
    let releaseSnapshot: (() => void) | null = null;
    const sends: string[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 1, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot") {
          snapshotCalls += 1;
          const threads = [
            { id: "1", address: "13800138000", display_name: "家人", last_text: "在吗", last_ts_ms: 1_700_000_000_000, unread: 0 },
          ];
          // Mount's read answers; every later read (the 刷新 button / a live receive)
          // stays in flight until the test releases it.
          if (snapshotCalls === 1) return threads;
          return new Promise((resolve) => {
            releaseSnapshot = () => resolve(threads);
          });
        }
        if (cmd === "sms_messages")
          return [{ thread_id: "1", id: "m1", from_me: false, text: "在吗", ts_ms: 1_700_000_000_000, read: true }];
        if (cmd === "sms_send") {
          sends.push(String(args?.text));
          return "sent";
        }
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    const input = host.container.querySelector('input[data-testid="real-message-input"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await fireEvent.input(input, { target: { value: "回你一条" } });

    // Hold the next read open, then answer the incoming message while it is still in flight.
    await fireEvent.click(
      host.container.querySelector('button[data-testid="refresh-sms"]') as HTMLButtonElement,
    );
    await tick();
    await fireEvent.keyDown(input, { key: "Enter" });
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(sends).toEqual(["回你一条"]);

    releaseSnapshot?.();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
  });

  // Two reads of the **same** folder can be in flight at once: the live `sms-received` refresh
  // fires while the user's own 刷新 — or a send's post-write refresh — is still out. The
  // stale-response guard keys on *folder identity* (`reqFolder !== folder`), which answers "is
  // this the folder on screen?" and not "is this still the newest read?" — so a response issued
  // *earlier* but landing *later* overwrote the fresher list, and the SMS the notification had
  // just named disappeared from the thread list until the next refresh. REQ-A1245 / F-SH-524.
  test("an older read of the same folder does not erase a newer one (REQ-A1245)", async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    const snaps: { resolve: (v: unknown) => void }[] = [];
    const one = {
      id: "1",
      address: "13800138000",
      display_name: "家人",
      last_text: "在吗",
      last_ts_ms: 1_700_000_000_000,
      unread: 0,
    };
    const two = {
      id: "2",
      address: "10086",
      display_name: "中国移动",
      last_text: "新消息",
      last_ts_ms: 1_700_000_100_000,
      unread: 1,
    };
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 1, sent: 0, draft: 0 };
        if (cmd === "sms_trash_list") return [];
        if (cmd === "sms_snapshot") return new Promise((resolve) => snaps.push({ resolve }));
        if (cmd === "sms_messages") return [];
        return null;
      },
      listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
        handlers[channel] = handler;
        return () => {};
      },
    };
    const flush = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      await tick();
    };
    const host = render(MessagesApp);
    await flush();
    snaps[0]!.resolve([one]);
    await flush();
    expect(txt(host)).toContain("家人");

    // Two pushes in quick succession — two 收件箱 reads, both in flight at once.
    handlers["sms-received"]?.({ payload: {} });
    handlers["sms-received"]?.({ payload: {} });
    await flush();
    const [, older, newer] = snaps;
    // The read issued *last* is the one that knows about the new SMS, and it lands first.
    newer!.resolve([one, two]);
    await flush();
    expect(txt(host)).toContain("中国移动");

    // The older read now lands, describing the inbox as it was *before* that SMS. The folder
    // still matches, so the guard lets it through — and the new thread vanishes again.
    older!.resolve([one]);
    await flush();
    expect(txt(host)).toContain("中国移动");
  });

  // The same guard one function over. `loadReal` decides "is this response still wanted?" by the
  // *thread* it was issued for, so two reads of the same thread that land out of order leave the
  // pane holding the older one: the message that just arrived is read into view and then erased
  // from the screen by the read that was issued before it existed. REQ-A1245 / F-SH-524.
  test("an older thread read does not erase a newer one (REQ-A1245)", async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    const snaps: { resolve: (v: unknown) => void }[] = [];
    const msgReads: { resolve: (v: unknown) => void }[] = [];
    const one = {
      id: "1",
      address: "13800138000",
      display_name: "家人",
      last_text: "在吗",
      last_ts_ms: 1_700_000_000_000,
      unread: 0,
    };
    const m1 = { thread_id: "1", id: "m1", from_me: false, text: "在吗", ts_ms: 1_700_000_000_000, read: true };
    const m2 = { thread_id: "1", id: "m2", from_me: false, text: "刚收到的新短信", ts_ms: 1_700_000_100_000, read: false };
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 1, sent: 0, draft: 0 };
        if (cmd === "sms_trash_list") return [];
        if (cmd === "sms_snapshot") return new Promise((resolve) => snaps.push({ resolve }));
        if (cmd === "sms_messages") return new Promise((resolve) => msgReads.push({ resolve }));
        return null;
      },
      listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
        handlers[channel] = handler;
        return () => {};
      },
    };
    const flush = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      await tick();
    };
    const host = render(MessagesApp);
    await flush();
    snaps[0]!.resolve([one]);
    await flush();
    msgReads[0]!.resolve([m1]);
    await flush();
    expect(txt(host)).toContain("在吗");

    // A push whose snapshot lands and starts the thread read — which stays in flight.
    handlers["sms-received"]?.({ payload: {} });
    await flush();
    snaps[1]!.resolve([one]);
    await flush();
    // A second push, its snapshot landing too: a *second* read of the same thread, issued
    // while the first is still out.
    handlers["sms-received"]?.({ payload: {} });
    await flush();
    snaps[2]!.resolve([one]);
    await flush();
    const [, olderRead, newerRead] = msgReads;
    // The newer read is the one that carries the SMS that just arrived.
    newerRead!.resolve([m1, m2]);
    await flush();
    expect(txt(host)).toContain("刚收到的新短信");

    // The older read lands last; the thread (and folder) still match, so it is applied.
    olderRead!.resolve([m1]);
    await flush();
    expect(txt(host)).toContain("刚收到的新短信");
  });

  // The block note belongs to the thread it was made from, so every door that changes what the
  // screen is about clears it: `setFolder` on a folder switch, `switchReal` on a thread switch
  // (REQ-A1240), `startNew` on opening the composer. The deep-link composer is the same kind of
  // door and was not in that sweep. The phone's call history ("回短信") or a number dropped on the
  // dock icon hands a number to this screen through `messagesChannel` — and the channel exists
  // precisely to reach the screen that is *already mounted*, so the note from the thread just left
  // was still standing above the new composer. Its failure copy names no sender, so it read as a
  // verdict on the hand-off that had just happened. REQ-A1282 / F-SH-556.
  test("a standing block note does not sit over a deep-linked composer (REQ-A1282)", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 1, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot")
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
        if (cmd === "sms_messages") return [];
        if (cmd === "blocklist_add") return null; // refused → the note stands on screen
        return null;
      },
      listen: async () => () => {},
    };
    const flush = async () => {
      await tick();
      await new Promise<void>((r) => setTimeout(r, 0));
      await tick();
    };
    const host = render(MessagesApp);
    await flush();
    // Block the open thread's sender: the refusal is reported, and the note stays.
    await fireEvent.click(
      host.container.querySelector('button[data-testid="block-sender-18616091470"]') as HTMLButtonElement,
    );
    await flush();
    const note = host.container.querySelector('[data-testid="block-sender-msg"]');
    expect(note).toBeTruthy();
    expect(note!.getAttribute("data-ok")).toBe("false");

    // 回短信 from the call history (or a number dropped on the Messages icon) prefills the
    // composer of the screen that is already open.
    messagesChannel().set({ composeTo: "10086", nonce: 1 });
    await flush();
    const to = host.container.querySelector('input[data-testid="new-sms-to"]') as HTMLInputElement;
    expect(to).toBeTruthy();
    expect(to.value).toBe("10086");
    // Entering that composer is a change of subject like any other: the note belongs to the
    // thread it was made from, and it must not be read as a verdict on the hand-off.
    expect(host.container.querySelector('[data-testid="block-sender-msg"]')).toBeNull();
  });

  // ---------------------------------------------------------------------------------------
  // REQ-A1301 — a send callback may only touch the composer it was issued from.
  //
  // `sms_send` round-trips to the device under the whole 8 s bridge timeout, and *nothing*
  // is disabled while it is out: the thread chips stay tappable, 新建 ∕ 取消 ∕ 编辑草稿 stay
  // tappable. So the composer can be a different composer by the time the answer lands, and
  // the two callbacks wrote into it unconditionally:
  //
  //   * `sendReal`'s success branch did `realText = ""` — after tapping another thread (which
  //     empties the box for the thread being opened so the user can start a reply there) it
  //     wiped that *new* half-typed reply. Its refusal branch raised 「发送失败」 under a thread
  //     that had sent nothing.
  //   * `sendNew`'s success branch emptied and closed the sheet, consuming whatever the user
  //     had typed into a reopened one (取消 then 新建 during the flight).
  //
  // The guard is already the file's own rule for a late *read* (`loadReal`, REQ-A1245): the
  // response may only apply while its subject is still the one on screen. This is the
  // write-side twin — the callback must find the *same open thread* and the *same text*.
  const twoDeviceThreads = (send: () => Promise<string | null>) => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_status") return { provider: "android-sms", device: true };
        if (cmd === "sms_counts") return { inbox: 2, sent: 0, draft: 0 };
        if (cmd === "sms_snapshot")
          return [
            { id: "1", address: "13800138000", display_name: "家人", last_text: "在吗", last_ts_ms: 1_700_000_000_000, unread: 0 },
            { id: "2", address: "13900139000", display_name: "同事", last_text: "忙吗", last_ts_ms: 1_700_000_001_000, unread: 0 },
          ];
        if (cmd === "sms_messages") return [];
        if (cmd === "sms_send") return send();
        return null;
      },
      listen: async () => () => {},
    };
  };
  const flushTick = async () => {
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
  };

  test("a late device send does not wipe the reply typed in the thread the user moved to (REQ-A1301)", async () => {
    let release: (() => void) | null = null;
    twoDeviceThreads(() => new Promise<string>((resolve) => { release = () => resolve("sent"); }));
    const host = render(MessagesApp);
    await flushTick();
    const box = () => host.container.querySelector('input[data-testid="real-message-input"]') as HTMLInputElement;
    const chip = (name: string) =>
      [...host.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(name)) as HTMLButtonElement;
    await fireEvent.input(box(), { target: { value: "回你一条" } });
    await fireEvent.keyDown(box(), { key: "Enter" });
    await flushTick();
    // The answer is still out. Tap another thread — that empties this box for the thread
    // being opened — and start the reply that belongs to *it*.
    await fireEvent.click(chip("同事"));
    await flushTick();
    await fireEvent.input(box(), { target: { value: "同事你好" } });
    release?.();
    await flushTick();
    // The send succeeded for 家人; it is not 同事's message to consume.
    expect(box().value).toBe("同事你好");
  });

  test("a device send leaves text the user typed after it into the same box (REQ-A1301)", async () => {
    let release: (() => void) | null = null;
    twoDeviceThreads(() => new Promise<string>((resolve) => { release = () => resolve("sent"); }));
    const host = render(MessagesApp);
    await flushTick();
    const box = () => host.container.querySelector('input[data-testid="real-message-input"]') as HTMLInputElement;
    await fireEvent.input(box(), { target: { value: "回你一条" } });
    await fireEvent.keyDown(box(), { key: "Enter" });
    await flushTick();
    // Same thread, same box — the user goes on to write the *next* message while this one
    // is out. It is a different message, so it is not this call's to erase either.
    await fireEvent.input(box(), { target: { value: "另外还有一句" } });
    release?.();
    await flushTick();
    expect(box().value).toBe("另外还有一句");
  });

  test("a refused device send is still reported on the thread it was sent from (REQ-A1301)", async () => {
    // The boundary twin: the guard must not degenerate into "never report a refusal". With
    // the thread unmoved, the composer is still the one the send was issued from, so the
    // refusal must reach the user exactly as before.
    let release: (() => void) | null = null;
    twoDeviceThreads(() => new Promise<string | null>((resolve) => { release = () => resolve(null); }));
    const host = render(MessagesApp);
    await flushTick();
    const box = () => host.container.querySelector('input[data-testid="real-message-input"]') as HTMLInputElement;
    await fireEvent.input(box(), { target: { value: "回你一条" } });
    await fireEvent.keyDown(box(), { key: "Enter" });
    await flushTick();
    release?.();
    await flushTick();
    expect(txt(host)).toContain(zh["message.sendFailed"]);
  });

  test("a late refusal is not reported under the thread the user moved to (REQ-A1301)", async () => {
    let release: (() => void) | null = null;
    twoDeviceThreads(() => new Promise<string | null>((resolve) => { release = () => resolve(null); }));
    const host = render(MessagesApp);
    await flushTick();
    const box = () => host.container.querySelector('input[data-testid="real-message-input"]') as HTMLInputElement;
    const chip = (name: string) =>
      [...host.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(name)) as HTMLButtonElement;
    await fireEvent.input(box(), { target: { value: "回你一条" } });
    await fireEvent.keyDown(box(), { key: "Enter" });
    await flushTick();
    // The refusal belongs to 家人's composer. Under 同事 it would read as a verdict on a send
    // nobody made — and 同事's own box is untouched by a failure that was not its.
    await fireEvent.click(chip("同事"));
    await flushTick();
    release?.();
    await flushTick();
    expect(txt(host)).not.toContain(zh["message.sendFailed"]);
  });

  test("a late send from the new-message sheet does not consume a reopened sheet's text (REQ-A1301)", async () => {
    let release: (() => void) | null = null;
    twoDeviceThreads(() => new Promise<string>((resolve) => { release = () => resolve("sent"); }));
    const host = render(MessagesApp);
    await flushTick();
    const newBtn = () => host.container.querySelector('button[data-testid="new-sms"]') as HTMLButtonElement;
    const toBox = () => host.container.querySelector('input[data-testid="new-sms-to"]') as HTMLInputElement | null;
    const textBox = () => host.container.querySelector('input[data-testid="new-sms-text"]') as HTMLInputElement | null;
    await fireEvent.click(newBtn());
    await flushTick();
    await fireEvent.input(toBox()!, { target: { value: "10086" } });
    await fireEvent.input(textBox()!, { target: { value: "第一条" } });
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms-send"]') as HTMLButtonElement);
    await flushTick();
    // Send is out; the user cancels the sheet and opens a fresh one for the same number
    // with a different message.
    await fireEvent.click(host.container.querySelector('button[data-testid="new-sms-cancel"]') as HTMLButtonElement);
    await flushTick();
    await fireEvent.click(newBtn());
    await flushTick();
    await fireEvent.input(toBox()!, { target: { value: "10086" } });
    await fireEvent.input(textBox()!, { target: { value: "重新写的" } });
    release?.();
    await flushTick();
    // "第一条" was sent; "重新写的" is not the message that was sent, so the sheet keeps it.
    expect(toBox()?.value).toBe("10086");
    expect(textBox()?.value).toBe("重新写的");
  });
});
