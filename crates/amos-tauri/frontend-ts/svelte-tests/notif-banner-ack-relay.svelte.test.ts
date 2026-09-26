/**
 * notif-banner-ack-relay.svelte.test.ts — 两条横幅的「✓」必须到达设备（REQ-A1260）。
 *
 * 一条推送行在这两条横幅里不是本地条目，而是设备推送历史的**投影**：`osPushWatcher`
 * 每 `PUSH_POLL_MS`（5 秒）重问一次 `push_get_history`，把存储里已经没有的记录原样写回
 * （`mergePushHistory` 的规则 1 读的是**当前列表里还持有的 id**，用户刚删掉的那一条因此
 * 不在其中）。
 *
 * 这一族的纪律本仓已经钉过两次，且逐字写在每个「删一行」的控件上：
 *   * `NotificationCenter.dismiss` / `DesktopNotificationCenter.dismiss` —— 删本地，
 *     `void deleteNotification(id)` 通知设备（REQ-A1202）；
 *   * 两块面板与「通知」设置页的「清空」—— 设备那半先跑，判决决定本地那半（REQ-A1251）。
 *
 * 两条横幅的 `ack` 是这条扫荡漏下的两个点：只 `writeStoreValue(NOTIF_KEY, removeAppNotifs(...))`，
 * 一点也没告诉设备。于是点下 ✓ 之后：行在本地消失 → 下一次轮询把它原样写回 → 横幅的
 * 「新到达」检测（`newestAddedNotif` 比 id 集合）把它又当成一次**新投递**播报 ——
 * 提示音（`shouldRingOnArrival` 只看长度有没有涨）与震动再来一遍。一次确认不生效，
 * 一次从未发生的到达被第二次报告。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationBanner from "../src/svelte/NotificationBanner.svelte";
import DesktopNotificationBanner from "../src/svelte/DesktopNotificationBanner.svelte";
import DesktopNotificationCenter from "../src/svelte/DesktopNotificationCenter.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY, type Notif } from "../src/lib/settings";
import { pushWatcherTick } from "../src/svelte/osPushWatcher";
import type { RustNotificationRecord } from "../src/lib/pushNotifications";
import { setLocale } from "../src/svelte/locale.svelte";

const tone = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock("../src/lib/notifyTone", () => ({ playNotifyTone: tone.play }));

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 一条真实的投递记录（`app` 是 APNs 自定义数据被 Rust 摊平到 payload 上的那个字段）。 */
const RECORD: RustNotificationRecord = {
  id: "push_1",
  payload: { aps: { alert: { title: "新邮件", body: "来自 Amos" } }, app: "邮件" },
  received_at: "2026-09-23T00:00:00.000Z",
  read: false,
};

/** 设备推送历史 —— `push_get_history` 的原件，删除命令**真的**会从中拿走一条。 */
let history: RustNotificationRecord[] = [];

/**
 * 一个**如实建模设备**的宿主：历史可读、可删。删命令未接上时（本轮的缺陷），历史原封不动，
 * 下一轮轮询就会把用户刚确认掉的那条写回来。
 */
function installDeviceHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "push_get_history") return history;
      if (cmd === "push_delete_notification") {
        const id = args?.id as string;
        const before = history.length;
        history = history.filter((r) => r.id !== id);
        return history.length < before;
      }
      if (cmd === "wm_open") return {};
      return null;
    },
    listen: async () => () => {},
  };
}

const held = (): Notif[] => readStoreValue<Notif[]>(NOTIF_KEY, []);
const bannerIn = (c: HTMLElement, testid: string): HTMLButtonElement | null =>
  c.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  window.localStorage.clear();
  history = [];
  tone.play.mockClear();
  setLocale("zh");
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setLocale("zh");
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

/** 让一次投递真的到达（观察者自己的动作），横幅应当把它当成新到达播报。 */
async function deliver(testid: string) {
  history = [RECORD];
  await pushWatcherTick();
  await settle();
  return bannerIn(document.body, testid);
}

describe("NotificationBanner —— 点「✓」确认一条推送（REQ-A1260）", () => {
  test("确认必须到达设备：下一次轮询不得把它写回来，也不得再响一次", async () => {
    installDeviceHost();
    render(NotificationBanner);
    await tick();

    const ack = await deliver("notif-ack");
    expect(ack).toBeTruthy();
    expect(tone.play).toHaveBeenCalledTimes(1); // 到达响一次，正确

    await fireEvent.click(ack!);
    await settle();
    expect(held()).toEqual([]); // 本地那一半，今天就是对的

    // ≈5 秒后的下一次轮询：设备历史里那条被删掉了才算「确认生效」。
    await pushWatcherTick();
    await settle();
    expect(held()).toEqual([]);
    expect(bannerIn(document.body, "notif-ack")).toBeFalsy();
    expect(tone.play).toHaveBeenCalledTimes(1);
  });
});

describe("DesktopNotificationBanner —— 点「✓」确认一条推送（REQ-A1260）", () => {
  test("确认必须到达设备：下一次轮询不得把它写回来，也不得再响一次", async () => {
    installDeviceHost();
    render(DesktopNotificationBanner);
    await tick();

    const ack = await deliver("desktop-notif-ack");
    expect(ack).toBeTruthy();
    expect(tone.play).toHaveBeenCalledTimes(1);

    await fireEvent.click(ack!);
    await settle();
    expect(held()).toEqual([]);

    await pushWatcherTick();
    await settle();
    expect(held()).toEqual([]);
    expect(bannerIn(document.body, "desktop-notif-ack")).toBeFalsy();
    expect(tone.play).toHaveBeenCalledTimes(1);
  });
});

describe("DesktopNotificationCenter —— 点一张卡片打开来源应用（REQ-A1260）", () => {
  test("「打开即已读」同样是删除：设备那一半欠不得", async () => {
    installDeviceHost();
    render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await settle();
    await deliver("desktop-notif-ack"); // 投递到达，存储里于是有这一行
    expect(held()).toHaveLength(1);

    // 行上的 `app`（"邮件"）能反查到内置应用 mail，所以整张卡片是一颗可点的按钮。
    const open = [...document.body.querySelectorAll('[data-testid="nc-open"]')][0] as
      | HTMLButtonElement
      | undefined;
    expect(open).toBeTruthy();
    await fireEvent.click(open!);
    await settle();
    expect(held()).toEqual([]);

    await pushWatcherTick();
    await settle();
    expect(held()).toEqual([]);
  });
});
