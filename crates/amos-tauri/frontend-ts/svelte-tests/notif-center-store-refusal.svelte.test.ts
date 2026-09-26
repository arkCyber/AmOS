/**
 * notif-center-store-refusal.svelte.test.ts — 手机那块通知面板的三枚动词把 `NOTIF_KEY`
 * 的写入判决丢在地上（REQ-A1391 / FMEA F-SH-650）。
 *
 * `NotificationCenter.svelte` 里三处逐字都是裸的 `writeStoreValue`：
 *
 *     clear     →  writeStoreValue(NOTIF_KEY, []);
 *     dismiss   →  writeStoreValue(NOTIF_KEY, removeNotif(notifs, id));
 *     markRead  →  writeStoreValue(NOTIF_KEY, markNotifRead(notifs, id));
 *
 * `writeStoreValue` 签 `void`（`writeJson` 在 `setItem` 抛错时只记一条 `store` 日志并回
 * `false`）。拒写时 `writeJson` **不派发 `STORE_CHANGED_EVENT`**，镜像订阅因此不会把列表拉
 * 回来 —— 屏幕与盘仍然一致，但那一下点击成了「什么也没发生、也没有一句话」。
 *
 * 这里比别处更重，因为**设备那一半已经做完了**：`osPushWatcher` 的
 * `mergePushHistory(held, records, …)` 只会把设备仍然持有的记录**补进**存储，**从不删除设备
 * 已经没有的行**（`osPushWatcher.ts:55`，且 `records.length === 0` 时第一步就 `return 0`）——
 * 于是一次「设备删了、盘上没删」的移除**永久**留在屏幕上。上一轮（REQ-A1385 ∕ F-SH-648）的
 * 如实边界把这三处留给单独一轮，理由是「行会被下一次轮询写回」；那只对**反方向**成立：
 * *本地*删了、设备没删才会被写回。
 *
 * 桌面的孪生面板早就门住了 —— `DesktopNotificationCenter.svelte::persist` 逐字
 * `storeError = writeStoreValueChecked(NOTIF_KEY, next) ? "" : t("common.storeWriteFailed")`，
 * 四枚动词全走它，且 `storeError`（存储）与 `pushErr`（设备）是两个槽。本文件钉的是手机那一块
 * 补上同一条纪律：**说出口**，且**不是**靠改本地列表来假装成功。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { writeStoreValueChecked } from "../src/lib/amosStore";
import { NOTIF_KEY, type Notif } from "../src/lib/settings";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const REFUSED = zh["common.storeWriteFailed"];

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 两条记录，其中一条是未读的推送投递（所以三枚动词都够得着它）。 */
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

/** 一个**照做**的宿主 —— 设备那一半成功，于是只剩存储那一半的判决可读。 */
let deviceCalls: string[] = [];
function installHost(): void {
  deviceCalls = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      deviceCalls.push(cmd);
      if (cmd === "push_clear_history") return null; // 成功（unit 回复，靠诊断账本判）
      if (cmd === "push_delete_notification") return true; // 「设备确实持有过，已删」
      if (cmd === "push_mark_read") return true;
      return null;
    },
    listen: async () => () => {},
  };
}

/** 只让**通知那个键**上的写入抛错 —— 存储拒写的真身（同 `launchpad-layout-refusal`）。 */
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
const btn = (c: HTMLElement, label: string): HTMLButtonElement =>
  [...c.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent ?? "") === label,
  ) as HTMLButtonElement;
/** `n2` 那一行（唯一的推送行）里的某颗按钮 —— 设备那一半只对推送行欠着。 */
const rowBtn = (c: HTMLElement, id: string, label: string): HTMLButtonElement =>
  c.querySelector<HTMLElement>(`[data-testid="nc-notif-${id}"]`)!.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  setLocale("zh");
  refuseNotifWrites = false;
  installRefusingStorage();
  installHost();
  writeStoreValueChecked(NOTIF_KEY, RECORDS);
  propsChannel<{ open: boolean }>("nc").set({ open: true });
});

afterEach(() => {
  cleanup();
  resetPropsChannels();
  setLocale("zh");
  refuseNotifWrites = false;
  restoreStorage?.();
  restoreStorage = null;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

describe("NotificationCenter — 通知写入被存储拒绝时，必须说出口（REQ-A1391）", () => {
  test("「清空」：设备照做了、盘没写下去 ⇒ 说出口，且行**永久**留在盘上（轮询只会补、不会删）", async () => {
    const h = render(NotificationCenter);
    await settle();
    refuseNotifWrites = true;

    await fireEvent.click(btn(h.container, zh["nc.clear"]));
    await settle();

    expect(txt(h), "一次没生效的清空必须说出口").toContain(REFUSED);
    // 设备那一半确实做完了 —— 所以这不是「设备没做」，是「盘没写下去」。
    expect(deviceCalls).toContain("push_clear_history");
    // 而 `osPushWatcher` 只把设备仍持有的记录补进存储、从不删设备已经没有的行，
    // 所以这两行没有任何东西会来收回 —— 这就是那一句必须存在的原因。
    expect(held(), "盘上原样（没写下去）").toHaveLength(2);
    expect(txt(h), "行还在屏幕上（屏幕与盘一致）").toContain(zh["nc.clear"]);
  });

  test("「忽略」一条推送：设备照做了、盘没写下去 ⇒ 说出口，行仍在", async () => {
    const h = render(NotificationCenter);
    await settle();
    refuseNotifWrites = true;

    await fireEvent.click(rowBtn(h.container, "n2", zh["a11y.dismiss"]));
    await settle();

    expect(txt(h)).toContain(REFUSED);
    expect(deviceCalls).toContain("push_delete_notification");
    expect(held().map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  test("「标记已读」：盘没写下去 ⇒ 说出口，未读仍是未读", async () => {
    const h = render(NotificationCenter);
    await settle();
    refuseNotifWrites = true;

    await fireEvent.click(btn(h.container, zh["nc.markRead"]));
    await settle();

    expect(txt(h)).toContain(REFUSED);
    expect(held().find((n) => n.id === "n2")?.read, "盘上还是未读").toBe(false);
  });

  test("对照：存储收下 ⇒ 顺序真的变了，且**绝不**出现那句提示", async () => {
    const h = render(NotificationCenter);
    await settle();

    await fireEvent.click(rowBtn(h.container, "n2", zh["a11y.dismiss"]));
    await settle();

    expect(txt(h)).not.toContain(REFUSED);
    expect(held().map((n) => n.id)).toEqual(["n1"]);
  });
});
