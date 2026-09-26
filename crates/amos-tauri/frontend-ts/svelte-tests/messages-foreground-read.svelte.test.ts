/**
 * messages-foreground-read.svelte.test.ts — REQ-A1395 / F-SH-654 —
 * 「读取收件箱是前景窗口才有的权利，而这条推送常常在用户看着别的窗口时到达」。
 *
 * 宿主侧的三条读取（`sms_snapshot` ∕ `sms_counts` ∕ `sms_messages`）现在都走
 * `require_sms_foreground`（与 `clipboard_read`、录音开关、`device_mic_start` 同一条规则）；
 * 而这一屏的 `refreshReal` **在拒读时会把列表清空**（失败分支逐字 `realThreads = []`）——
 * 所以后台到达若照旧发出读取，用户回到这一屏时会发现刚才还在的会话没了。
 * 本轮因此先给出**本窗口的聚焦信号**（blur ∕ focus），把后台到达记成「欠一次读」，
 * 回到前台时补上：既不拒掉一条合法的到达刷新，也不让它在屏幕上清空任何东西。
 *
 * 从**组件之外**派发 `window` 的 blur ∕ focus（真实用户在窗口之间切换时浏览器做的事），
 * 然后数宿主被问了几次、屏幕画了什么 —— 既有套件看不到这个缺陷，因为那些用例都跑在
 * 「窗口一直有焦点」的世界里，那里的两种写法是同一个形状。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MessagesApp from "../src/svelte/MessagesApp.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { CONV_KEY, seedConversations } from "../src/lib/messages";
import { DRAFT_KEY } from "../src/lib/smsDrafts";
import { resetPropsChannels } from "../src/svelte/propsBus";

interface Thread {
  id: string;
  address: string;
  display_name: string;
  last_text: string;
  last_ts_ms: number;
  unread: number;
}

/** One inbox thread, shaped like `SmsThreadOut`. */
function thread(id: string, name: string, text: string, ts: number): Thread {
  return {
    id,
    address: `1380013800${id}`,
    display_name: name,
    last_text: text,
    last_ts_ms: ts,
    unread: 0,
  };
}

const seeded = thread("1", "小安", "在吗", 1_700_000_000_000);
const arrived = thread("2", "中国移动", "刚收到的新短信", 1_700_000_100_000);

const threadMsgs = (id: string) => [
  { thread_id: id, id: `${id}m1`, from_me: false, text: "在吗", ts_ms: 1_700_000_000_000, read: true },
];

/** Install a device bridge that reports one inbox and counts every read the screen makes. */
function installHost(inbox: Thread[]) {
  const calls: string[] = [];
  const handlers: Record<string, (e: { payload: unknown }) => void> = {};
  let snapshot = inbox;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "sms_status") return { provider: "android-sms", device: true };
      if (cmd === "sms_snapshot") return snapshot;
      if (cmd === "sms_counts") return { inbox: snapshot.length, sent: 0, draft: 0 };
      if (cmd === "sms_messages") return threadMsgs("1");
      return null;
    },
    listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
      handlers[channel] = handler;
      return () => {};
    },
  };
  return {
    calls,
    reads: () => calls.filter((c) => c === "sms_snapshot").length,
    setSnapshot: (next: Thread[]) => {
      snapshot = next;
    },
    push: () => handlers["sms-received"]?.({ payload: { address: "13800138002" } }),
  };
}

const settle = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const blur = () => window.dispatchEvent(new Event("blur"));
const focus = () => window.dispatchEvent(new Event("focus"));

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

describe("MessagesApp — 读取收件箱要用户正在看着这个窗口", () => {
  test("后台到达：不发读取、屏幕不清空；回到前台才补上这一次读", async () => {
    const host = installHost([seeded]);
    const view = render(MessagesApp);
    await settle();
    expect(txt(view)).toContain("小安");
    const readsWhileFocused = host.reads();

    // The user switches to another window; the device then pushes an arrival.
    blur();
    await tick();
    host.setSnapshot([seeded, arrived]);
    host.push();
    await settle();

    // The read this window is not entitled to was not attempted…
    expect(host.reads()).toBe(readsWhileFocused);
    // …and nothing was blanked: the conversation the user left is still drawn, and
    // the arrival is honestly absent (it has not been read, so it cannot be claimed).
    expect(txt(view)).toContain("小安");
    expect(txt(view)).not.toContain("中国移动");

    // Looking at this window again pays the owed read — the arrival appears.
    focus();
    await settle();
    expect(host.reads()).toBeGreaterThan(readsWhileFocused);
    expect(txt(view)).toContain("中国移动");
  });

  test("前台到达：照旧立刻读到（对照组 —— 推迟不是「不读」）", async () => {
    const host = installHost([seeded]);
    const view = render(MessagesApp);
    await settle();
    const readsWhileFocused = host.reads();

    host.setSnapshot([seeded, arrived]);
    host.push();
    await settle();

    expect(host.reads()).toBeGreaterThan(readsWhileFocused);
    expect(txt(view)).toContain("中国移动");
  });

  test("只是在窗口之间停留：没有欠下的读，聚焦本身不多问宿主一次", async () => {
    const host = installHost([seeded]);
    render(MessagesApp);
    await settle();
    blur();
    await tick();
    const reads = host.reads();

    // No arrival happened while we were away, so coming back owes nothing.
    focus();
    await settle();
    expect(host.reads()).toBe(reads);
  });
});
