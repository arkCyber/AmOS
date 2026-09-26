/**
 * messages-notif-refusal.svelte.test.ts — 信息 App 镜像进通知 store 的那次写被拒时
 * 必须说出口，不能静默吞掉（REQ-A1954 / FMEA F-SH-947）。
 *
 * `MessagesApp.svelte` 的发布 `$effect` 把未读短信镜像成 App 通知（写 `NOTIF_KEY`），
 * 并在「真机模式」下**撤回**本 App 的旧通知。两处以前都逐字 `writeStoreValue(...)` ——
 * `writeStoreValue` 是 `void`，判决被**扔掉**。存储满 ∕ 不可用时：徽标停在旧的未读计数
 * 上、要撤回的旧通知也留在通知中心里继续声称一条本机找不到的短信，页面上却什么也不说。
 *
 * 本文件钉两件事：① 驳回写入报出 `t("common.storeWriteFailed")`（复用本文件已有的
 * `storeErr` ∕ `StoreErrorBar` 面，和 `CONV_KEY` ∕ `DRAFT_KEY` 的写同一条规则）；
 * ② 反向守卫 —— 存储正常时通知照旧落地，修法不许把正常路径判红。
 *
 * 悬念在**接线**上：纯规则无须再证；这里证明 `MessagesApp` 真的消费了判决 ——
 * 把任一处改回 `writeStoreValue` 会让对应用例转红（见台账里的 NC）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import MessagesApp from "../src/svelte/MessagesApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { CONV_KEY } from "../src/lib/messages";
import { DRAFT_KEY } from "../src/lib/smsDrafts";
import { NOTIF_KEY, type Notif } from "../src/lib/settings";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { zh } from "../src/i18n/locales/zh";

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const notifs = () => readStoreValue<Notif[]>(NOTIF_KEY, []);

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});
afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  resetPropsChannels();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return a
 * restore function. Same helper as the PhoneApp ∕ ContactsApp refusal tests.
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

/** Seed one read thread (the open one) and one unread thread — the mirror publishes the latter. */
function seedConversations(): void {
  const now = Date.now();
  writeStoreValue(CONV_KEY, [
    { id: "c:a", name: "小安", msgs: [{ from: "them", text: "在读的", ts: now - 8_000, read: true }] },
    { id: "c:b", name: "小李", msgs: [{ from: "them", text: "刚来的", ts: now - 5_000, read: false }] },
  ]);
  writeStoreValue(DRAFT_KEY, []);
}

describe("REQ-A1954 — 信息 App 的镜像通知被拒写要被报出来", () => {
  test("通知写被拒：页面说出口，通知没落地", async () => {
    seedConversations();
    const restore = failWritesFor(NOTIF_KEY);
    try {
      const host = render(MessagesApp);
      await settle();
      await settle();

      await vi.waitFor(() => expect(txt(host)).toContain(zh["common.storeWriteFailed"]));
      expect(notifs(), "通知被拒写了，就不该有通知落地").toEqual([]);
    } finally {
      restore();
    }
  });

  test("存储正常时照旧落地、不报错 —— 修法不许把正常路径判红", async () => {
    seedConversations();
    const host = render(MessagesApp);
    await settle();
    await settle();

    const out = notifs();
    expect(out.some((n) => (n.title ?? "").includes("刚来的")), "未读短信必须镜像成通知").toBe(true);
    expect(txt(host), "存储正常就不该报写入失败").not.toContain(zh["common.storeWriteFailed"]);
  });
});
