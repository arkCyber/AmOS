/**
 * quick-settings-refusal.svelte.test.ts — REQ-A1381 / F-SH-644 —
 * 「飞行模式 ∕ Wi‑Fi ∕ 个人热点」这几枚开关的写入判决。
 *
 * `SettingsApp.svelte::persistQuick` 曾经逐字 `qs = next; writeStoreValue(SETTINGS_KEY, next);`
 * —— 本地那一位在存储被问**之前**就动了，而 `writeStoreValue` 是 `void`。于是"存储收下了"与
 * "存储拒收了"在这块屏幕上字节相同：拒写时开关亮着、`amos.settings` 里什么都没有，重启后它又跳回去。
 * 同一个键的另外几个写者早就门住了裁决（`FocusPage` ∕ `NotificationsPage` 的勿扰位，REQ-A1368；
 * `AccountPage::persistCloud`，REQ-A1367），只有这一条汇入点没有 —— 而它之所以被留到这一轮，是因为
 * 它还背着**挂载期的设备真相**（`syncQuickRadios`，REQ-A185）：一刀切地门住它会把设备真实的射频状态丢掉。
 * 所以修法是把它拆成「采纳」与「持久化」两件事，这个文件把两件事都钉住。
 *
 * 从**组件之外**拒写（一个 `setItem` 对指定键抛错的 localStorage 代理），然后断言屏幕显示了什么 ——
 * 既有套件看不到这个缺陷，因为其它每条用例都跑在"写成功"的世界里，那里两种写法是同一个形状。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_KEY, type QuickSettings } from "../src/lib/settings";
import { HOTSPOT_KEY, hotspotInit } from "../src/lib/hotspot";
import { t } from "../src/svelte/locale.svelte";
import { controlByName } from "./a11y-name";

/** Make every `localStorage.setItem` for `key` throw — a full (or unavailable) store. The
 * reads still work, so the component sees the store's *real* contents; only the write is
 * refused. `window.localStorage` has to be replaced as a property: the accessor proxy vitest
 * installs cannot be patched in place. */
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
  Object.defineProperty(window, "localStorage", {
    value: fake,
    configurable: true,
    writable: true,
  });
  return () =>
    Object.defineProperty(window, "localStorage", {
      value: real,
      configurable: true,
      writable: true,
    });
}

/** A host that answers the radio questions — enough to exercise the mount-time device read. */
function installHost(status: { wifi: boolean; bluetooth: boolean; airplane: boolean; hotspot: boolean }): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      switch (cmd) {
        case "radio_status":
          return status;
        case "radio_control":
          return { radio: "wifi", app_controlled: true, surface: null, reason: null };
        default:
          return null;
      }
    },
    listen: async () => () => {},
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const stored = () => readStoreValue<QuickSettings>(SETTINGS_KEY, {} as QuickSettings);
// 共用 `StoreErrorBar` 的那一枚 testid：同一个事实只有一种说法、一个靶子。
const refusal = () => document.querySelector('[data-testid="store-write-error"]');
const switchNamed = (host: { container: HTMLElement }, name: string) =>
  controlByName<HTMLElement>(host.container, '[role="switch"]', name);
const navRow = (host: { container: HTMLElement }, label: string) =>
  [...host.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  ) as HTMLButtonElement;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("SettingsApp — 快速开关的写入被存储拒绝时，开关不替它作证", () => {
  test("飞行模式被拒：开关不亮、存储里没有这一位、原地给出拒绝", async () => {
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      const host = render(SettingsApp);
      const ap = switchNamed(host, "飞行模式");
      expect(ap.getAttribute("aria-checked")).toBe("false");

      await fireEvent.click(ap);
      await tick();

      // The lit switch *is* this row's entire success report.
      expect(switchNamed(host, "飞行模式").getAttribute("aria-checked")).toBe("false");
      expect(stored()).toEqual({});
      expect(refusal()).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("飞行模式落盘：开关亮、存储里有这一位、没有拒绝", async () => {
    const host = render(SettingsApp);
    await fireEvent.click(switchNamed(host, "飞行模式"));
    await tick();

    expect(switchNamed(host, "飞行模式").getAttribute("aria-checked")).toBe("true");
    expect(stored().airplane).toBe(true);
    expect(refusal()).toBeNull();
  });

  test("Wi‑Fi（无线局域网页）被拒：开关不亮、原地给出拒绝", async () => {
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      const host = render(SettingsApp);
      await fireEvent.click(navRow(host, "无线局域网"));
      await tick();
      const wifi = switchNamed(host, t("settings.wifi"));
      expect(wifi.getAttribute("aria-checked")).toBe("false");

      await fireEvent.click(wifi);
      await tick();

      expect(switchNamed(host, t("settings.wifi")).getAttribute("aria-checked")).toBe("false");
      expect(stored().wifi).toBeFalsy();
      expect(refusal()).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("个人热点被拒：开关不亮、原地给出拒绝", async () => {
    // A valid AP config is a precondition for turning the switch **on** at all (a hotspot
    // that cannot exist must not be claimable), so seed one; only `amos.settings` is refused.
    writeStoreValue(HOTSPOT_KEY, { ...hotspotInit(), password: "amos-hotspot" });
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      const host = render(SettingsApp);
      await fireEvent.click(navRow(host, "个人热点"));
      await tick();
      const ap = switchNamed(host, t("settings.hotspot"));
      expect(ap.getAttribute("aria-checked")).toBe("false");

      await fireEvent.click(ap);
      await tick();

      expect(switchNamed(host, t("settings.hotspot")).getAttribute("aria-checked")).toBe("false");
      expect(stored().hotspot).toBeFalsy();
      expect(refusal()).toBeTruthy();
    } finally {
      restore();
    }
  });

  /**
   * 这一条是这一轮存在的理由：挂载期的**设备真相**（REQ-A185）与存储裁决是两件事。
   * 存储拒写时屏幕仍必须显示设备真正的射频状态 —— 一刀切地把 `persistQuick` 门住会把这半丢回
   * 用户的旧意图；被拒的只是「把这份真相存下来」，而存储说了什么必须照说。
   */
  test("挂载期读到设备真相而存储拒写：屏幕照设备显示，而被拒的那一句照说", async () => {
    // The device says airplane mode is **on**; the store holds no intent at all. Gating the
    // shared writer outright would leave the switch off — hiding the device's real state —
    // which is exactly why `adoptQuick` and `persistQuick` had to be split.
    installHost({ wifi: false, bluetooth: false, airplane: true, hotspot: false });
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      const host = render(SettingsApp);
      await settle();
      await tick();

      expect(switchNamed(host, "飞行模式").getAttribute("aria-checked")).toBe("true");
      // …and the store really was refused, so the line says so rather than the screen lying.
      expect(stored()).toEqual({});
      expect(refusal()).toBeTruthy();
    } finally {
      restore();
    }
  });
});
