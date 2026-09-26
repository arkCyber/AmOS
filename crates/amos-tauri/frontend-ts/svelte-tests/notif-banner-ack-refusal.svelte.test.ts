/**
 * notif-banner-ack-refusal.svelte.test.ts — 两条横幅的「✓」把 `amos.notifications` 的写入判决
 * 丢在地上（REQ-A1408 / FMEA F-SH-666）。
 *
 * 两处逐字都是：
 *
 *     deleteDeliveriesOnDevice(droppedAppNotifs(notifs, b.app));
 *     writeStoreValue(NOTIF_KEY, removeAppNotifs(notifs, b.app));   // 判决签 void，丢弃
 *
 * `writeStoreValue` 签 `void`（`writeJson` 在 `setItem` 抛错时只记一条 `store` 日志并回
 * `false`，且**不派发 `STORE_CHANGED_EVENT`**）。于是拒写时：本地每一行都还在（屏幕与盘一致），
 * 但横幅**照旧消失** —— 那一下点击成了「什么也没发生、也没有一句话」，而 ✓ 正是那句谎
 * （「我已确认并移除」）。这不是「行会被下一次轮询写回」：`osPushWatcher` 的
 * `mergePushHistory` 只**补进**设备仍持有的记录、**从不删**设备已经没有的行 —— 反方向才成立。
 *
 * 这一族 `amos.notifications` 的写入者，上一轮（REQ-A1391 ∕ F-SH-650）只补齐了手机那块
 * `NotificationCenter`；两条横幅是**同一个键的另两个写入者**，被「按形状扫」漏掉了
 * （memory `project_sweep_by_shape_misses_the_second_writer_of_a_key`）。
 *
 * 如实边界 (what this does NOT cover)：`deleteDeliveriesOnDevice` 那半仍签 `void`（它的判决由
 * REQ-A1260 的设备历史用例覆盖）；本文件钉的是**存储**那一半，以及「拒绝时不得先删设备」的顺序。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationBanner from "../src/svelte/NotificationBanner.svelte";
import DesktopNotificationBanner from "../src/svelte/DesktopNotificationBanner.svelte";
import { writeStoreValueChecked } from "../src/lib/amosStore";
import { NOTIF_KEY, type Notif } from "../src/lib/settings";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const REFUSED = zh["common.storeWriteFailed"];

const tone = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock("../src/lib/notifyTone", () => ({ playNotifyTone: tone.play }));

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

// 一行**推送**投递 —— 只有推送行才同时欠着设备那一半（`deleteDeliveriesOnDevice`
// 只对 `source === "push"` 的行发删除命令），对照用例因此能看见设备有没有被叫到。
const ROW: Notif = {
  id: "n1",
  app: "邮件",
  title: "新邮件",
  body: "来自 Amos",
  time: 1,
  source: "push",
  read: false,
};

/** 一个**照做**的宿主 —— 只用来观察设备那一半有没有被叫到（判决由 REQ-A1260 覆盖）。 */
let deviceCalls: string[] = [];
function installHost(): void {
  deviceCalls = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      deviceCalls.push(cmd);
      if (cmd === "push_delete_notification") return true;
      return null;
    },
    listen: async () => () => {},
  };
}

/** 只让**通知那个键**上的写入抛错 —— 存储拒写的真身（与 `notif-center-store-refusal` 同法）。 */
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

const held = (): Notif[] => JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as Notif[];
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const ackBtn = (c: HTMLElement, testid: string): HTMLButtonElement =>
  c.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement;
const stillShown = (c: HTMLElement, testid: string): boolean =>
  c.querySelector(`[data-testid="${testid}"]`) !== null;

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
  refuseNotifWrites = false;
  tone.play.mockClear();
  installRefusingStorage();
  installHost();
});

afterEach(() => {
  cleanup();
  setLocale("zh");
  refuseNotifWrites = false;
  restoreStorage?.();
  restoreStorage = null;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

/** 挂载横幅，再让一行真的「到达」（挂载前先落盘的行不会被当成到达）。 */
async function mountArrival(Component: typeof NotificationBanner) {
  const h = render(Component);
  await settle();
  writeStoreValueChecked(NOTIF_KEY, [ROW]);
  await settle();
  return h;
}

describe("NotificationBanner —— 「✓」被存储拒绝时必须说出口（REQ-A1408）", () => {
  test("拒写 ⇒ 说出口、横幅留下（✓ 没有生效）、行原样在盘上，且**没有**先删设备", async () => {
    const h = await mountArrival(NotificationBanner);
    expect(stillShown(h.container, "notif-ack")).toBe(true);

    refuseNotifWrites = true;
    await fireEvent.click(ackBtn(h.container, "notif-ack"));
    await settle();

    expect(txt(h), "一次没生效的确认必须说出口").toContain(REFUSED);
    expect(stillShown(h.container, "notif-ack"), "确认没生效，横幅不能装作成功而消失").toBe(true);
    expect(held(), "盘上原样（没写下去）").toHaveLength(1);
    // 顺序也是守卫：本地那半没落地，就**不能**把盘上仍然持有的行从设备删掉。
    expect(deviceCalls).not.toContain("push_delete_notification");
  });

  test("留在原地可重试 —— 存储恢复后同一次点击真的生效", async () => {
    const h = await mountArrival(NotificationBanner);
    refuseNotifWrites = true;
    await fireEvent.click(ackBtn(h.container, "notif-ack"));
    await settle();
    expect(txt(h)).toContain(REFUSED);

    refuseNotifWrites = false;
    await fireEvent.click(ackBtn(h.container, "notif-ack"));
    await settle();

    expect(held()).toEqual([]);
    expect(stillShown(h.container, "notif-ack")).toBe(false);
    expect(txt(h)).not.toContain(REFUSED);
    expect(deviceCalls).toContain("push_delete_notification");
  });

  test("对照：存储收下 ⇒ 行清了、横幅消失、设备那半照做，且**绝不**出现那句提示", async () => {
    const h = await mountArrival(NotificationBanner);

    await fireEvent.click(ackBtn(h.container, "notif-ack"));
    await settle();

    expect(txt(h)).not.toContain(REFUSED);
    expect(held()).toEqual([]);
    expect(stillShown(h.container, "notif-ack")).toBe(false);
    expect(deviceCalls).toContain("push_delete_notification");
  });
});

describe("DesktopNotificationBanner —— 「✓」被存储拒绝时必须说出口（REQ-A1408）", () => {
  test("拒写 ⇒ 说出口、横幅留下、行原样在盘上，且**没有**先删设备", async () => {
    const h = await mountArrival(DesktopNotificationBanner);
    expect(stillShown(h.container, "desktop-notif-ack")).toBe(true);

    refuseNotifWrites = true;
    await fireEvent.click(ackBtn(h.container, "desktop-notif-ack"));
    await settle();

    expect(txt(h)).toContain(REFUSED);
    expect(stillShown(h.container, "desktop-notif-ack")).toBe(true);
    expect(held()).toHaveLength(1);
    expect(deviceCalls).not.toContain("push_delete_notification");
  });

  test("对照：存储收下 ⇒ 行清了、横幅消失、设备那半照做", async () => {
    const h = await mountArrival(DesktopNotificationBanner);

    await fireEvent.click(ackBtn(h.container, "desktop-notif-ack"));
    await settle();

    expect(txt(h)).not.toContain(REFUSED);
    expect(held()).toEqual([]);
    expect(stillShown(h.container, "desktop-notif-ack")).toBe(false);
    expect(deviceCalls).toContain("push_delete_notification");
  });
});
