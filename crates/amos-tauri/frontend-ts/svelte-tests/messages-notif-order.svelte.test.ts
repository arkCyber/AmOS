/**
 * REQ-A1949 / F-SH-945 — 生产者重发的整批通知必须落在 store 的**头部**。
 *
 * `MessagesApp.svelte` 的发布 `$effect` 每次把本 App 的整批行重新推导一遍；它以前逐字
 * `writeStoreValue(NOTIF_KEY, [...others, ...fresh])`，把信息 App 的行追加在**尾部**，于是
 * 新来的短信通知在通知中心里排在**所有其它 App 的行之后**（通知中心按数组顺序渲染）。这条轴由
 * REQ-A1940 的边界逐字点名（「那两个写入者『把最新行追加在尾部』……本轮**未**按其约定改为前置」）。
 *
 * 这条用例钉的是**接线**：纯规则 `replaceAppNotifs` 的头部语义由
 * `src/__tests__/notifAppOrder.test.ts` 单独钉；本文件证明 `MessagesApp` 真的走它 —— 把调用点
 * 改回 `[...others, ...fresh]` 会让这一条转红（见台账里的 NC-1）。
 *
 * 反过来，第二条用例是**反向守卫**：本 App 的旧行仍必须被整批替换掉，且其它 App 的行一条不丢。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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

const notifs = () => readStoreValue<Notif[]>(NOTIF_KEY, []);

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});
afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  resetPropsChannels();
  window.localStorage.clear();
});

describe("REQ-A1949 — 信息 App 的整批通知落在头部", () => {
  test("新短信通知排在更旧的时钟通知之前（红先）", async () => {
    const now = Date.now();
    // 第一条是被打开的那个会话（在读的线程不算通知），未读那条在第二条。
    writeStoreValue(CONV_KEY, [
      { id: "c:a", name: "小安", msgs: [{ from: "them", text: "在读的", ts: now - 8_000, read: true }] },
      { id: "c:b", name: "小李", msgs: [{ from: "them", text: "刚来的", ts: now - 5_000, read: false }] },
    ]);
    writeStoreValue(DRAFT_KEY, []);
    // 一条**更旧**的、别的 App 的通知，已经在 store 里。
    writeStoreValue(NOTIF_KEY, [
      { id: "clock:1", app: zh["app.clock"], icon: "⏰", title: "旧闹钟", time: now - 60_000 },
    ]);

    render(MessagesApp);
    await settle();

    const out = notifs();
    const msg = out.find((n) => (n.title ?? "").includes("刚来的"));
    expect(msg).toBeTruthy();
    // 头部是本 App 刚发布的行，而不是那条更旧的时钟行。
    expect(out[0]?.id).toBe(msg!.id);
    // 其它 App 的行一条不丢，只是排在后面。
    expect(out.some((n) => n.id === "clock:1")).toBe(true);
  });

  test("本 App 的旧行被整批替换、其它 App 的行保留（反向守卫）", async () => {
    const now = Date.now();
    writeStoreValue(CONV_KEY, [
      { id: "c:a", name: "小安", msgs: [{ from: "them", text: "在读的", ts: now - 8_000, read: true }] },
      { id: "c:b", name: "小李", msgs: [{ from: "them", text: "新的", ts: now - 1_000, read: false }] },
    ]);
    writeStoreValue(DRAFT_KEY, []);
    writeStoreValue(NOTIF_KEY, [
      { id: "clock:1", app: zh["app.clock"], icon: "⏰", title: "旧闹钟", time: now - 60_000 },
      { id: "msg:stale", app: zh["app.messages"], icon: "💬", title: "早已读过的旧短信", time: now - 90_000 },
    ]);

    render(MessagesApp);
    await settle();

    const out = notifs();
    expect(out.some((n) => n.id === "msg:stale")).toBe(false); // 旧行被整批替换
    expect(out.some((n) => n.id === "clock:1")).toBe(true); // 别的 App 不受影响
  });
});
