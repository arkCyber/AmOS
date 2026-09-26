/**
 * notif-center-clear-refusal.svelte.test.ts — 「清空」的两块面板不得先清本地、再问设备（REQ-A1251）。
 *
 * 一条推送行在这两块面板里是设备历史的**投影** —— `osPushWatcher` 每几秒重问一次
 * `push_get_history`，把存储里已经没有的记录原样写回。所以「清空」必须到达设备，否则
 * 用户点的那一下会在下一次轮询（≈5 秒）之后**复活**。
 *
 * 这条纪律本仓已经写过一次，且逐字写在同一族的 `NotificationsPage.clearAll`（REQ-A1238）里：
 *
 * ```ts
 * if (hadDeliveries && bridged() && !(await clearNotificationHistory())) {
 *   clearErr = t("pushSettings.clearFailed");   // 设备没做 ⇒ 本地一条也不许删
 *   return;
 * }
 * notifs = []; writeStoreValue(NOTIF_KEY, []);
 * ```
 *
 * 两块浮层面板做的是反面：`writeStoreValue(NOTIF_KEY, [])` ∕ `persist([])` 在前，
 * `void clearNotificationHistory()` 在后，把判决丢掉；注释里还断言了一个**假前提** ——
 * 「a device that refuses leaves the rows on screen (the failure is visible, not hidden)」。
 * 屏幕上的行恰恰在判决之前就被删掉了，而下一轮轮询会把它们写回来：一次被拒的「清空」，
 * 屏幕上先清空又复活，用户什么也没被告知。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import DesktopNotificationCenter from "../src/svelte/DesktopNotificationCenter.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY, type Notif } from "../src/lib/settings";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const REFUSED = zh["pushSettings.clearFailed"];

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 两条记录，其中一条是推送投递（所以设备那一半是欠着的）。 */
const RECORDS: Notif[] = [
  { id: "n1", app: "时钟", title: "计时结束", body: "5 分钟已到", icon: "⏱️", time: 1_700_000_000_000 },
  {
    id: "n2",
    app: "邮件",
    title: "新邮件",
    body: "来自 Amos",
    icon: "✉️",
    time: 1_700_000_600_000,
    source: "push",
    read: false,
  },
];

/**
 * 一个拒了 `push_clear_history` 的宿主 —— Tauri 2 把 Rust 的 `Err` 送到错误回调，JS 的
 * promise 于是 reject，`invoke` 把它折成 `null`、判决只落在诊断账本里（REQ-A845 ∕ F-SH-270）。
 */
function installRefusingHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "push_clear_history") throw new Error("device store is locked");
      return null;
    },
    listen: async () => () => {},
  };
}

const held = (): Notif[] => JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as Notif[];
const clearButton = (c: HTMLElement): HTMLButtonElement =>
  [...c.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent ?? "") === zh["nc.clear"],
  ) as HTMLButtonElement;

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  setLocale("zh");
  writeStoreValue(NOTIF_KEY, RECORDS);
});
afterEach(() => {
  cleanup();
  resetPropsChannels();
  setLocale("zh");
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("NotificationCenter —— 设备拒绝清历史时（REQ-A1251）", () => {
  test("本地一条也不许删，并且要说出来", async () => {
    installRefusingHost();
    propsChannel<{ open: boolean }>("nc").set({ open: true });
    const { container } = render(NotificationCenter);
    await settle();

    await fireEvent.click(clearButton(container));
    await settle();

    // 下一轮轮询写回时，屏幕才不会先清空又复活 —— 所以本地那一半必须原样留着。
    expect(held()).toHaveLength(2);
    expect(container.textContent ?? "").toContain(REFUSED);
  });
});

describe("DesktopNotificationCenter —— 设备拒绝清历史时（REQ-A1251）", () => {
  test("本地一条也不许删，并且要说出来", async () => {
    installRefusingHost();
    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await settle();

    await fireEvent.click(clearButton(container));
    await settle();

    expect(held()).toHaveLength(2);
    expect(container.textContent ?? "").toContain(REFUSED);
  });
});

// 门的范围必须与理由同宽：没有宿主时既没有设备历史可清、也没有轮询会写回（`osPushWatcher`
// 第一步就 `if (!bridged()) return 0`），那一下本来就是纯本地动作，不该被一句问不到的判决拦住。
describe("没有宿主桥时（手机 ∕ 平板形态）", () => {
  test("NotificationCenter 的「清空」照常生效，且不报一句问不到的失败", async () => {
    propsChannel<{ open: boolean }>("nc").set({ open: true });
    const { container } = render(NotificationCenter);
    await settle();

    await fireEvent.click(clearButton(container));
    await settle();

    expect(held()).toEqual([]);
    expect(container.textContent ?? "").not.toContain(REFUSED);
  });
});
