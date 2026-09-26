/**
 * notif-readers-corrupt-shape.svelte.test.ts — `amos.notifications` 的**读取侧**有一半绕过
 * `normalizeNotifs`。REQ-A1414 ∕ FMEA F-SH-672。核实如下（对工作树，逐字）：
 *
 *   • 这个键有一条自己的守卫：`src/lib/settings.ts:241` `export function normalizeNotifs(v: unknown): Notif[] { if (!Array.isArray(v)) return []; … }`。
 *   • **九个读者**走它（`normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []))` 或订阅里包一层）：
 *     `DesktopNotificationCenter`（种子 `:75` + 订阅 `:79`）、`NotificationCenter:208`、
 *     `NotificationsPage:64/70`、`PushManagementPage:19/25`、`PushSettings:148`、
 *     `osPushWatcher:54`、`osTimerWatcher:39`、`alarmCore:268`、`reminderCore:144`、`calendarCore:188`。
 *   • **其余读者逐字不归一化**，且把值直接喂给数组方法：
 *     `HomeDock.svelte:121` `const un = notifStore.subscribe((v) => (notifs = v));`
 *     `Dock.svelte:329` 同上；两处随后进 `appUnread(notifs, …)` ∕ `dockBadgeTotal(notifs, …)`，
 *     而 `lib/dockBadge.ts:82` `return countNotifsOfApp(list.filter(stillUnread), …)` ∕
 *     `:117` `return notifs.filter(stillUnread).length;` —— 非数组即 `… .filter is not a function`。
 *     `NotificationBanner.svelte:64-67` ∕ `DesktopNotificationBanner.svelte:85-88` 同样 `prev = v; notifs = v;`，
 *     随后 `newestAddedNotif(prev, notifs)`；`MessagesApp:755` ∕ `PhoneApp:585` ∕ `ContactsApp:698` ∕
 *     `MailApp:227` ∕ `telemetrySpy:186` 把裸读交给 `addNotif` ∕ `withoutAppNotifs` ∕ `hasNotifsOfApp`
 *     （`addNotif` 是 `[n, ...list]`）。`shortcuts.ts:2153` 另有一枚**手写的**同义守卫
 *     （`Array.isArray(existing) ? … : [n]`）—— 它不抛错，改成 `normalizeNotifs` 只为同形。
 *   • `readJson` 只隔离**解析不了的**字节：合法 JSON 的 `{}` ∕ `5` ∕ `null` ∕ `"x"` 原样返回，
 *     `fallback` 仅在**字符串缺席**时生效（`lib/amosStore.ts:52` `if (raw == null) return fallback;`）。
 *     这个键又是跨窗口共享键：`hydrateFromSystemStore`（`amosStore.ts:237`）把宿主系统存储的每一对
 *     原样 `setItem` 进 localStorage，`createStoreValue` 的 `store-updated` 分支也 `JSON.parse` 后直接 `set`。
 *   • 同键的**写入侧**已被两轮判为缺陷并修好：F-SH-658（`alarmCore`）、F-SH-663（`osTimerWatcher`）。
 *     那两轮修的是**生产者**；从不归一化的**消费者**是同一族的另一半，且 `Dock` ∕ `HomeDock` 在
 *     每个屏幕的**渲染路径**上 —— 失败不是「徽记数字不对」，而是整条 Dock ∕ 主屏画不出来。
 *
 * 修法：这十个读者全部改成与九个姊妹同形 —— 读侧归一化（`normalizeNotifs`）。
 * （上文行号是**修前**的行号，逐字核对过工作树。）
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Dock from "../src/svelte/Dock.svelte";
import HomeDock from "../src/svelte/HomeDock.svelte";
import NotificationBanner from "../src/svelte/NotificationBanner.svelte";
import DesktopNotificationBanner from "../src/svelte/DesktopNotificationBanner.svelte";
import MessagesApp from "../src/svelte/MessagesApp.svelte";
import { recordSpyHit, type SpyHitPayload } from "../src/lib/telemetrySpy";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { LAYOUT_KEY, writeStoreValue, type HomeLayout } from "../src/lib/amosStore";
import { CONV_KEY, seedConversations } from "../src/lib/messages";
import { DRAFT_KEY } from "../src/lib/smsDrafts";
import { NOTIF_KEY, type Notif } from "../src/lib/settings";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

// The banner chime is a synthesized tone; asserted elsewhere, silenced here.
vi.mock("../src/lib/notifyTone", () => ({ playNotifyTone: () => {} }));

/** Valid JSON that is **not** an array — the shape `readJson` hands back verbatim. */
const CORRUPT = "{}";

const SEEDED: HomeLayout = { page: [], dock: ["messages", "mail", "files"], hidden: [] };
const MESSAGES = zh["app.messages"];

const notif = (id: string, app: string): Notif => ({ id, app, time: 1 });
const settle = () => new Promise((r) => setTimeout(r, 25));

/** Seed the raw *bytes*: `writeStoreValue` would JSON.stringify the string itself. */
const corrupt = () => window.localStorage.setItem(NOTIF_KEY, CORRUPT);

const badge = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLElement>(`[data-testid="dock-app-${id}-badge"]`);

const channel = () => propsChannel<{
  layout: HomeLayout;
  ext: unknown[];
  pulseId: string | null;
}>("home");

const HIT: SpyHitPayload = {
  ts_ms: 123,
  iface: "rmnet_data0",
  src_ip: "10.0.0.2",
  src_port: 53000,
  dst_ip: "203.0.113.9",
  dst_port: 53,
  protocol: "udp",
  hits: [{ kind: "imei", occurrences: 1, confidence: "high" }],
  payload_bytes: 40,
  severity: "high",
  confidence: "high",
};

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
  resetPropsChannels();
  writeStoreValue(LAYOUT_KEY, SEEDED);
  writeStoreValue(CONV_KEY, seedConversations(Date.now()));
  writeStoreValue(DRAFT_KEY, []);
});

afterEach(() => {
  cleanup();
  setLocale("zh");
  resetPropsChannels();
});

describe("amos.notifications 的读取侧必须归一化（REQ-A1414 ∕ F-SH-672）", () => {
  test("Dock：盘上是一个合法的非数组时仍然画得出来（不抛错，也不画徽记）", async () => {
    corrupt();
    const { container } = render(Dock);
    await tick();
    await settle();

    // 修前：`notifs = {}` 进 `appUnread` ∕ `dockBadgeTotal` 的 `.filter` ⇒ TypeError。
    expect(badge(container, "messages")).toBeNull();
    expect(badge(container, "mail")).toBeNull();
  });

  test("HomeDock：盘上是一个合法的非数组时主屏仍然画得出来", async () => {
    corrupt();
    channel().set({ layout: SEEDED, ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();
    await settle();

    // 修前：渲染路径上的 `unreadOf(id)` 直接抛错，主屏根本没有输出。
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
    expect(container.querySelector(`button[aria-label="${MESSAGES}"]`)).toBeTruthy();
  });

  test("两条 banner：盘上是一个合法的非数组时不得让到达提示抛错", async () => {
    corrupt();
    const a = render(NotificationBanner);
    await tick();
    await settle();
    expect(a.container.querySelector('[data-testid="notif-ack"]')).toBeFalsy();

    cleanup();
    const b = render(DesktopNotificationBanner);
    await tick();
    await settle();
    expect(b.container.querySelector('[data-testid="notif-ack"]')).toBeFalsy();
  });

  test("recordSpyHit：盘上是一个合法的非数组时不抛错，并把新行写成一个真数组", () => {
    corrupt();
    // 它的注释逐字写着 "Best-effort: **never throws**" —— 而 `addNotif` 是 `[n, ...list]`。
    expect(() => recordSpyHit(HIT)).not.toThrow();
    const stored = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "null");
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(1);
  });

  test("MessagesApp：盘上是一个合法的非数组时挂载期的那条 $effect 不得让整个应用抛错", async () => {
    corrupt();
    // 修前：`existing = {}` 进 `hasNotifsOfApp` ∕ `withoutAppNotifs` 的 `.filter` ⇒ TypeError，
    // 而这枚 effect 的读发生在 `smsMode` 分支**之前**（无条件），所以离线也照样炸。
    const { container } = render(MessagesApp);
    await tick();
    await settle();
    expect(container.textContent).toBeTruthy();
  });

  test("对照（守卫）：归一化不等于画零 —— 完好的一列仍然数得对", async () => {
    writeStoreValue(NOTIF_KEY, [notif("a", MESSAGES), notif("b", MESSAGES)]);
    const { container } = render(Dock);
    await tick();
    await settle();
    expect(badge(container, "messages")?.textContent).toBe("2");
  });
});
