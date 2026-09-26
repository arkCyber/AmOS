/**
 * settings-blob-preservation.svelte.test.ts — REQ-A1397 / FMEA F-SH-656.
 *
 * `amos.settings` is a **union blob**, not "the quick settings". Besides the seven quick
 * booleans, other modules keep their own keys in it: `lib/providers.ts` writes
 * `aiProvider` ∕ `aiModel` ∕ `aiEndpoint` and `lib/cloud.ts` writes `iCloudSync` ∕
 * `cloudLast`. Both of those take a *raw* settings object and **spread** it, so they
 * preserve each other's keys — that is the established idiom in this repo.
 *
 * Every quick-toggle writer did the opposite: it spread `normalizeQuick`'s result, which is
 * a narrowing that keeps only `QUICK_KEYS`. So one tap anywhere in the OS — a control-centre
 * tile, a notification-centre tile, a settings index row, the 勿扰 switch on either of the
 * two pages that render it, or the focus-schedule watcher flipping the bit on its own twice
 * a day — wrote a settings blob with the AI provider and the cloud prefs silently deleted.
 * Nothing said so, and the next launch came up with the backend reset to local.
 *
 * The fix is `saveQuick` (lib/settings.ts): carry the narrowed flip **onto** the raw blob.
 * A leaf per writer is the point of this file — a fix that only covers the surface it was
 * found on is the F-SH-639 ∕ F-SH-649 shape, where the second writer of the same key keeps
 * the defect.
 *
 * The second half is the watcher's **ordering**: `focusWatcherTick` writes both the DND bit
 * (`amos.settings.dnd`) and the ownership record (`amos.focus.auto`), and `advanceDnd` reads
 * the record first — a `false` record means "not ours, hands off forever". Clearing it before
 * the bit it owns has landed therefore strands a scheduled DND **on** with no window active,
 * permanently and silently. A claim may precede the bit; a release may not.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ControlCenter from "../src/svelte/ControlCenter.svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import FocusPage from "../src/svelte/settings/FocusPage.svelte";
import NotificationsPage from "../src/svelte/settings/NotificationsPage.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import {
  SETTINGS_KEY,
  dndActive,
  mergeSettings,
  normalizeQuick,
  type QuickSettings,
} from "../src/lib/settings";
import {
  FOCUS_AUTO_KEY,
  FOCUS_SCHEDULE_KEY,
  normalizeFocusAuto,
} from "../src/lib/focusSchedule";
import { focusWatcherTick } from "../src/svelte/osFocusWatcher";
import { t } from "../src/svelte/locale.svelte";
import { controlByName } from "./a11y-name";

const MON = (h: number, m = 0) => new Date(2024, 0, 8, h, m);

/** A settings blob with the quick bits **and** the keys other modules own. */
const BLOB = {
  wifi: true,
  dnd: false,
  aiProvider: "claude",
  aiModel: "claude-sonnet-4-6",
  aiEndpoint: "https://api.invalid/v1/messages",
  iCloudSync: true,
  cloudLast: 1_700_000_000_000,
};

/** The keys this round is about: what `lib/providers.ts` ∕ `lib/cloud.ts` keep in the blob. */
const foreign = (o: Record<string, unknown>) => ({
  aiProvider: o.aiProvider,
  aiModel: o.aiModel,
  aiEndpoint: o.aiEndpoint,
  iCloudSync: o.iCloudSync,
  cloudLast: o.cloudLast,
});
const FOREIGN = foreign(BLOB);

const blob = () => readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {});
const readDnd = () => dndActive(normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {})));
const readAuto = () => normalizeFocusAuto(readStoreValue<unknown>(FOCUS_AUTO_KEY, {}));

/** Mon 09:00–11:00 — a window that covers `MON(10, 0)` and not `MON(12, 0)`. */
const putWindow = () =>
  writeStoreValue(FOCUS_SCHEDULE_KEY, {
    work: { days: [1], start: 540, end: 660, enabled: true },
  });

/** Make every `localStorage.setItem` for `key` throw; reads still work. */
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

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 20));
  await tick();
};
const switchNamed = (host: { container: HTMLElement }, name: string) =>
  controlByName<HTMLElement>(host.container, '[role="switch"]', name);
const tileByIcon = (c: HTMLElement, dataIcon: string) =>
  [...c.querySelectorAll("button[aria-pressed]")].find((b) =>
    b.querySelector(`[data-icon="${dataIcon}"]`),
  ) as HTMLButtonElement | undefined;

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  resetPropsChannels();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

describe("mergeSettings — 只动自己那些键", () => {
  test("它不拥有的键原样带过；非对象、空值当作空 blob", () => {
    expect(mergeSettings(BLOB, { dnd: true })).toEqual({ ...BLOB, dnd: true });
    expect(mergeSettings(null, { wifi: true })).toEqual({ wifi: true });
    expect(mergeSettings([1, 2], { wifi: true })).toEqual({ wifi: true });
    expect(mergeSettings("nope", { wifi: true })).toEqual({ wifi: true });
  });
});

describe("osFocusWatcher — 日程翻 DND 不得抹掉 blob 的其余部分", () => {
  test("窗口内翻 DND 开：AI 与云同步偏好都还在", () => {
    writeStoreValue(SETTINGS_KEY, BLOB);
    putWindow();
    expect(focusWatcherTick(MON(10, 0))).toBe(true);
    expect(readDnd()).toBe(true);
    expect(blob()).toEqual({ ...BLOB, dnd: true });
  });

  test("窗口结束释放 DND：同样只动那一位", () => {
    writeStoreValue(SETTINGS_KEY, BLOB);
    putWindow();
    focusWatcherTick(MON(10, 0));
    expect(focusWatcherTick(MON(12, 0))).toBe(true);
    expect(readDnd()).toBe(false);
    expect(blob()).toEqual({ ...BLOB, dnd: false });
  });
});

describe("每一个快速开关的写入者都走同一条路（REQ-A1397）", () => {
  test("控制中心 · 勿扰", async () => {
    writeStoreValue(SETTINGS_KEY, BLOB);
    const { container } = render(ControlCenter);
    await settle();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-testid="cc-dnd"]')!);
    await settle();
    expect(foreign(blob())).toEqual(FOREIGN);
    expect(blob().dnd).toBe(true);
  });

  test("通知中心 · 勿扰", async () => {
    writeStoreValue(SETTINGS_KEY, BLOB);
    propsChannel<{ open: boolean }>("nc").set({ open: true });
    const { container } = render(NotificationCenter);
    await settle();
    await fireEvent.click(tileByIcon(container, "dnd")!);
    await settle();
    expect(foreign(blob())).toEqual(FOREIGN);
    expect(blob().dnd).toBe(true);
  });

  test("设置 App · 快速开关行（未桥接 ⇒ 走离线分支，仍然落地写入）", async () => {
    writeStoreValue(SETTINGS_KEY, BLOB);
    const host = render(SettingsApp);
    await settle();
    await fireEvent.click(switchNamed(host, t("settings.airplane")));
    await settle();
    expect(foreign(blob())).toEqual(FOREIGN);
    expect(blob().airplane).toBe(true);
  });

  test("专注模式页 · 勿扰开关", async () => {
    writeStoreValue(SETTINGS_KEY, BLOB);
    const host = render(FocusPage);
    await settle();
    await fireEvent.click(switchNamed(host, t("settings.focusDnd")));
    await settle();
    expect(foreign(blob())).toEqual(FOREIGN);
    expect(blob().dnd).toBe(true);
  });

  test("通知页 · 勿扰开关", async () => {
    writeStoreValue(SETTINGS_KEY, BLOB);
    const host = render(NotificationsPage);
    await settle();
    await fireEvent.click(switchNamed(host, t("settings.dnd")));
    await settle();
    expect(foreign(blob())).toEqual(FOREIGN);
    expect(blob().dnd).toBe(true);
  });
});

describe("osFocusWatcher — 所有权记录不得在 bit 之前被清掉（顺序即守卫）", () => {
  test("释放那一笔被拒 ⇒ 记录留着、DND 不动、tick 如实报 false；存储恢复后补上释放", () => {
    putWindow();
    expect(focusWatcherTick(MON(10, 0))).toBe(true); // 窗口内：DND 开，日程声明所有权
    expect(readDnd()).toBe(true);
    expect(readAuto()).toEqual({ auto: true });

    const restore = failWritesFor(SETTINGS_KEY);
    try {
      expect(focusWatcherTick(MON(12, 0))).toBe(false); // 释放被拒
      // 记录是唯一授权释放那一位的东西 —— 它必须先于 bit 的落盘而**不动**。
      expect(readAuto()).toEqual({ auto: true });
      expect(readDnd()).toBe(true);
    } finally {
      restore();
    }

    // 存储恢复：下一次 tick 把那一笔补上，DND 真的被释放（不是「永远开着」）。
    expect(focusWatcherTick(MON(12, 1))).toBe(true);
    expect(readDnd()).toBe(false);
    expect(readAuto()).toEqual({ auto: false });
  });

  test("声明所有权那一笔被拒 ⇒ 报告 false；恢复后补上，bit 才开", () => {
    putWindow();
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      expect(focusWatcherTick(MON(10, 0))).toBe(false);
      // 声明可以先行：bit 还没开，但谁拥有它已经记下了。
      expect(readAuto()).toEqual({ auto: true });
      expect(readDnd()).toBe(false);
    } finally {
      restore();
    }
    expect(focusWatcherTick(MON(10, 1))).toBe(true); // 窗口还在，补上
    expect(readDnd()).toBe(true);
    expect(readAuto()).toEqual({ auto: true });
  });

  test("正控：收下时一次 tick 就释放，记录与 bit 一致", () => {
    putWindow();
    expect(focusWatcherTick(MON(10, 0))).toBe(true);
    expect(focusWatcherTick(MON(12, 0))).toBe(true);
    expect(readDnd()).toBe(false);
    expect(readAuto()).toEqual({ auto: false });
  });
});
