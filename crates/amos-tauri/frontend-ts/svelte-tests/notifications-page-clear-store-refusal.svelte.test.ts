/**
 * notifications-page-clear-store-refusal.svelte.test.ts — 「通知」设置页与它内嵌的
 * `PushSettings` 把 `amos.notifications` **本地那一半**的写入判决丢在地上
 * （REQ-A1423 / FMEA F-SH-681）。
 *
 * 上一轮（REQ-A1391 ∕ F-SH-650）修的是 `NotificationCenter`，并把「本地清空」的判决
 * 门在 `writeStoreValueChecked` 上、与设备拒绝分两个槽。那一脚漏掉了**同一个键的另外两个
 * 写入者**：`settings/NotificationsPage.svelte::clearAll` 与它内嵌的共享组件
 * `settings/PushSettings.svelte::clearPushHistory`，两处逐字都是裸的：
 *
 *     notifs = [];                      // clearAll
 *     writeStoreValue(NOTIF_KEY, []);
 *
 *     writeStoreValue(NOTIF_KEY, remaining);   // clearPushHistory
 *     onhistorycleared?.(remaining);
 *
 * `writeJson` 在 `setItem` 抛错（配额满 ∕ 私有模式无存储）时回 `false`，且**不派发
 * `STORE_CHANGED_EVENT`** —— 所以订阅者不会被拉回，屏幕与盘仍然一致，但那一下点击成了
 * 「屏幕先清空、什么也没说」：Dock 的徽记（订阅同一个键）照旧计数，下一次任何成功的写入
 * 又把行拉回来。这正是本文件旁边那段注释自己写下的形状（「屏幕先清空又复活，而用户什么也
 * 没被告知」）。
 *
 * 归法：与同一键的另外两个姊妹面同形 —— `writeStoreValueChecked` + `t("common.storeWriteFailed")`，
 * 且这句话与设备拒绝 `t("pushSettings.clearFailed")` **分开两个槽**。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationsPage from "../src/svelte/settings/NotificationsPage.svelte";
import PushSettings from "../src/svelte/settings/PushSettings.svelte";
import { writeStoreValueChecked } from "../src/lib/amosStore";
import { NOTIF_KEY, type Notif } from "../src/lib/settings";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const REFUSED = zh["common.storeWriteFailed"];
const DEVICE_REFUSED = zh["pushSettings.clearFailed"];

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 两条本地通知（都不是推送），外加一条推送投递 —— 「有推送行要清吗」问的就是后者。 */
const LOCAL_ONLY: Notif[] = [
  { id: "n1", app: "时钟", title: "计时结束", body: "5 分钟已到", time: 1_700_000_000_000 },
  { id: "n2", app: "邮件", title: "新邮件", body: "来自 Amos", time: 1_700_000_600_000 },
];
const WITH_PUSH: Notif[] = [
  ...LOCAL_ONLY,
  {
    id: "p1",
    app: "邮件",
    title: "推送",
    body: "来自设备",
    time: 1_700_000_900_000,
    source: "push",
    read: false,
  },
];

/** 只让**通知那个键**上的写入抛错 —— 存储拒写的真身（同 `notif-center-store-refusal`）。 */
let refuseNotifWrites = false;
let restoreStorage: (() => void) | null = null;

function installRefusingStorage(): void {
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
      if (refuseNotifWrites && k === NOTIF_KEY) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  restoreStorage = () => {
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
  };
}

/** 一个**照做**的宿主：设备那一半成功，于是只剩存储那一半的判决可读。 */
let deviceCalls: string[] = [];
function installHost(): void {
  deviceCalls = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      deviceCalls.push(cmd);
      if (cmd === "push_get_status") {
        return {
          available: true,
          permission_backend: "UNUserNotificationCenter",
          device_token: null,
          permission: "authorized",
          badge_count: 0,
          statistics: { total_received: 0, with_badge: 0, with_sound: 0, silent: 0, last_received: null },
        };
      }
      if (cmd === "push_clear_history") return null; // 成功（unit 回复，靠诊断账本判）
      return null;
    },
    listen: async () => () => {},
  };
}

const held = (): Notif[] => JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as Notif[];
const txt = (c: HTMLElement) => c.textContent ?? "";
const byText = (c: HTMLElement, label: string): HTMLButtonElement =>
  [...c.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) as
    HTMLButtonElement;

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
  refuseNotifWrites = false;
  installRefusingStorage();
});

afterEach(() => {
  cleanup();
  setLocale("zh");
  refuseNotifWrites = false;
  restoreStorage?.();
  restoreStorage = null;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("「通知」页的「清空」—— 本地写入被存储拒绝时必须说出口（REQ-A1423）", () => {
  test("没有桥、全是本地通知：盘没写下去 ⇒ 说出口，行仍在屏幕上、仍在盘上", async () => {
    writeStoreValueChecked(NOTIF_KEY, LOCAL_ONLY);
    const h = render(NotificationsPage);
    await settle();
    const before = txt(h.container);
    refuseNotifWrites = true;

    await fireEvent.click(byText(h.container, zh["settings.notifClear"]));
    await settle();

    expect(txt(h.container), "一次没生效的清空必须说出口").toContain(REFUSED);
    expect(txt(h.container), "说的不是设备那句 —— 没有宿主可问").not.toContain(DEVICE_REFUSED);
    expect(held().map((n) => n.id), "盘上原样（没写下去）").toEqual(["n1", "n2"]);
    expect(txt(h.container), "屏幕与盘一致：行还在").toContain("计时结束");
    // 那句「无通知」是这一次拒绝**不许**出现的东西。
    expect(txt(h.container)).not.toContain(zh["settings.notifEmpty"]);
    expect(before).toContain("计时结束");
  });

  test("桥在、有推送行：设备照做了、盘没写下去 ⇒ 说出口（且说的是存储那句，不是设备那句）", async () => {
    writeStoreValueChecked(NOTIF_KEY, WITH_PUSH);
    installHost();
    const h = render(NotificationsPage);
    await settle();
    refuseNotifWrites = true;

    await fireEvent.click(byText(h.container, zh["settings.notifClear"]));
    await settle();

    expect(txt(h.container), "一次没生效的清空必须说出口").toContain(REFUSED);
    expect(txt(h.container), "两个拒绝分两个槽").not.toContain(DEVICE_REFUSED);
    expect(deviceCalls, "设备那一半确实做完了").toContain("push_clear_history");
    expect(held(), "盘上三条原样").toHaveLength(3);
  });

  test("对照：存储收下 ⇒ 盘上清空、屏幕说「无通知」，且绝不出现那句拒绝", async () => {
    writeStoreValueChecked(NOTIF_KEY, LOCAL_ONLY);
    const h = render(NotificationsPage);
    await settle();

    await fireEvent.click(byText(h.container, zh["settings.notifClear"]));
    await settle();

    expect(txt(h.container)).not.toContain(REFUSED);
    expect(held()).toEqual([]);
    expect(txt(h.container)).toContain(zh["settings.notifEmpty"]);
  });
});

describe("内嵌的 PushSettings「清除推送历史」—— 本地写入被存储拒绝（REQ-A1423）", () => {
  test("宿主照做、盘没写下去 ⇒ 说出口，且**不**把一份盘上不存在的列表交给宿主页面", async () => {
    writeStoreValueChecked(NOTIF_KEY, WITH_PUSH);
    installHost();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onhistorycleared = vi.fn();
    const h = render(PushSettings, { props: { onhistorycleared } });
    await settle();
    refuseNotifWrites = true;

    await fireEvent.click(byText(h.container, zh["pushSettings.clearAll"]));
    await settle();

    expect(txt(h.container), "一次没生效的清除必须说出口").toContain(REFUSED);
    expect(txt(h.container), "说的不是设备那句").not.toContain(DEVICE_REFUSED);
    expect(deviceCalls).toContain("push_clear_history");
    expect(held().map((n) => n.id), "盘上三条原样").toEqual(["n1", "n2", "p1"]);
    expect(onhistorycleared, "屏幕不许跑在盘前面").not.toHaveBeenCalled();
  });

  test("对照：存储收下 ⇒ 推送行被删、本地行保留，宿主页面拿到剩下的那份", async () => {
    writeStoreValueChecked(NOTIF_KEY, WITH_PUSH);
    installHost();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onhistorycleared = vi.fn();
    const h = render(PushSettings, { props: { onhistorycleared } });
    await settle();

    await fireEvent.click(byText(h.container, zh["pushSettings.clearAll"]));
    await settle();

    expect(txt(h.container)).not.toContain(REFUSED);
    expect(held().map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(onhistorycleared).toHaveBeenCalledTimes(1);
    expect((onhistorycleared.mock.calls[0][0] as Notif[]).map((n) => n.id)).toEqual(["n1", "n2"]);
  });
});
