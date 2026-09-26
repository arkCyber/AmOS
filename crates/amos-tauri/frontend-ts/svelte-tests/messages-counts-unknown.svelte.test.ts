/**
 * messages-counts-unknown.svelte.test.ts — REQ-A1788 / audit PH-P2-09 —
 * 「宿主没答」被画成了「量出来的 0」。
 *
 * `sms_counts` 与 `sms_trash_list` 的返回类型都是可空的（`… | null`），而这两个刷新器
 * 逐字写的是 `if (c) counts = c;` ∕ `if (l) trash = l;` —— 一个 `null`（桥没接上，
 * 或命令 `Err` 了）被**静默丢掉**，于是：
 *   · 页签角标停在**上一次成功读数**上（一次过期的测量被当作当前值），初值 `{0,0,0}`
 *     更把它画成「一条未读也没有」；
 *   · 回收站面板逐字落进 `trash.length === 0` 分支，把「没读到」说成「回收站是空的」。
 * 同文件早已用 `—` 表示「没读到」（`DeviceCareApp.svelte:65` 逐字把这条规则写进注释：
 * `v === null || undefined ? "—" : fmtBytes(v)` —— 「never the `0 B` a `?? 0` invents」）。
 *
 * 既有套件看不到这个缺陷：它们的桥对 `sms_counts` 恒给一个**对象**，对
 * `sms_trash_list` 恒给一个**数组**（多数用例根本不给，落到 `undefined`→`null` 也
 * 从不检查角标），即「宿主总会答」的世界 —— 在那里丢与不丢是同一个形状。
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

const thread = (id: string, name: string): Thread => ({
  id,
  address: `1380013800${id}`,
  display_name: name,
  last_text: "在吗",
  last_ts_ms: 1_700_000_000_000,
  unread: 0,
});

/**
 * A device bridge whose two *count* reads are configurable — the one axis this spec is
 * about. `"unreadable"` mirrors `backend.ts`: the `invoke` never answers (`null`).
 */
function installHost(opts: { counts: "unreadable" | { inbox: number; sent: number; draft: number }; trash: "unreadable" | unknown[] }) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "sms_status") return { provider: "android-sms", device: true };
      if (cmd === "sms_snapshot") return [thread("1", "小安")];
      if (cmd === "sms_messages") return [{ thread_id: "1", id: "1m1", from_me: false, text: "在吗", ts_ms: 1_700_000_000_000, read: true }];
      if (cmd === "sms_counts") return opts.counts === "unreadable" ? null : opts.counts;
      if (cmd === "sms_trash_list") return opts.trash === "unreadable" ? null : opts.trash;
      return null;
    },
    listen: async () => () => {},
  };
}

const settle = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

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

describe("MessagesApp — 宿主没答不是 0（REQ-A1788 / PH-P2-09）", () => {
  test("计数读不到时，页签角标说「—」而不是停在 0 或上一次的数", async () => {
    installHost({ counts: "unreadable", trash: [] });
    const view = render(MessagesApp);
    await settle();
    // The read really was attempted and really got nothing: the inbox thread is drawn
    // (so the screen is in real mode), yet the count read answered `null`.
    expect(view.container.textContent).toContain("小安");
    const unknown = view.container.querySelector('[data-testid="counts-unknown"]');
    expect(unknown, "a count the host never gave must render 「—」, not nothing (which reads as 0)").not.toBeNull();
    expect(unknown!.textContent).toBe("—");
  });

  test("回收站读不到时，角标与面板都说「读不到」，绝不说「回收站是空的」", async () => {
    installHost({ counts: { inbox: 1, sent: 0, draft: 0 }, trash: "unreadable" });
    const view = render(MessagesApp);
    await settle();
    expect(view.container.querySelector('[data-testid="trash-unknown"]'), "an unread trash must not draw as an empty one").not.toBeNull();

    const toggle = view.container.querySelector('[data-testid="trash-toggle"]') as HTMLButtonElement;
    toggle.click();
    await settle();
    const panel = view.container.querySelector('[data-testid="trash-unreadable"]');
    expect(panel, "the open panel must say the trash is unreadable").not.toBeNull();
    expect(panel!.textContent).not.toContain("回收站是空的");
  });

  test("正控：两个读取都答了数字时，画的是数字、不是「—」", async () => {
    installHost({ counts: { inbox: 2, sent: 1, draft: 0 }, trash: [{ thread_id: "1", message_id: "m1", trashed_ms: 1_700_000_000_000 }] });
    const view = render(MessagesApp);
    await settle();
    expect(view.container.querySelector('[data-testid="counts-unknown"]'), "a real answer must not be drawn as unknown").toBeNull();
    expect(view.container.querySelector('[data-testid="trash-unknown"]')).toBeNull();
    const inboxTab = view.container.querySelector('[data-folder="inbox"]') as HTMLButtonElement;
    expect(inboxTab.textContent, "the badge must show the count the host gave").toContain("2");
  });
});
