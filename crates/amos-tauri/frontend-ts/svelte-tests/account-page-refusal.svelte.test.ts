/**
 * account-page-refusal.svelte.test.ts — 「iCloud ∕ 账户」那一枚开关的写入判决。
 *
 * `AccountPage.persistCloud` wrote `amos.settings` with the **void** `writeStoreValue` and
 * then moved the page's own `cloud` reading: inside that page "the store took it" and "the
 * store refused it" were byte-identical. A refused write therefore lit the iCloud switch
 * (and revealed the sync panel under it) while `amos.settings` held nothing — and on reload
 * 同步 was simply off. `lib/cloud.readCloud` is what the Settings index row's 账户 subtitle
 * reads, so the two surfaces said opposite things.
 *
 * The rule this file pins is written verbatim **two functions below** the defect, in the
 * same file — `syncNow`: 「a full/unavailable localStorage rejects it silently, and showing a
 * summary + "last synced" for bytes that were never stored would be a lie about the user's
 * data」. `syncNow` reads the verdict; `persistCloud` did not. That is why these tests
 * refuse the write from *outside* the component (a localStorage proxy whose `setItem`
 * throws for the one key) and then assert what the screen shows.
 *
 * The existing suite could not see it: every other AccountPage test runs inside the landed
 * world, where the two shapes are the same shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { screen } from "@testing-library/dom";
import { tick } from "svelte";
import AccountPage from "../src/svelte/settings/AccountPage.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { BACKUP_KEY, readCloud, summarizeBackup } from "../src/lib/cloud";
import { SETTINGS_KEY } from "../src/lib/settings";
import { t } from "../src/svelte/locale.svelte";

/**
 * Make every `localStorage.setItem` for `key` throw — a full (or unavailable) store. The
 * reads still work, so the component sees the store's *real* contents; only the write is
 * refused. `window.localStorage` has to be replaced as a property: the accessor proxy
 * vitest installs cannot be patched in place.
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

const storedCloud = () => readCloud(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {}));
// 共用 `StoreErrorBar` 的那一枚 testid（REQ-A1369）：同一个事实只有一种说法、一个靶子。
const cloudError = () => document.querySelector('[data-testid="store-write-error"]');
const syncNowButton = () => screen.queryByRole("button", { name: t("settings.syncNow") });
const icloudSwitch = () => screen.getByRole("switch", { name: t("settings.icloud") });

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("AccountPage — 写入被存储拒绝时，iCloud 开关不替它作证", () => {
  test("拒写：开关不亮、同步面板不出现、存储里没有这一位、原地给出拒绝", async () => {
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      render(AccountPage);
      const sw = icloudSwitch();
      expect(sw.getAttribute("aria-checked")).toBe("false");

      await fireEvent.click(sw);
      await tick();

      // The lit switch (and the panel it reveals) is this row's *entire* success report.
      expect(icloudSwitch().getAttribute("aria-checked")).toBe("false");
      expect(syncNowButton()).toBeNull();
      expect(storedCloud().enabled).toBe(false);
      expect(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {}).iCloudSync).toBeUndefined();
      // 拒绝渲染在它自己那一行上（这里就是 iCloud 开关所在的那一块），不是页面别处。
      expect(cloudError()).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("落盘：开关亮、面板出现、存储里有这一位、没有拒绝", async () => {
    render(AccountPage);
    const sw = icloudSwitch();
    await fireEvent.click(sw);
    await tick();

    expect(icloudSwitch().getAttribute("aria-checked")).toBe("true");
    expect(syncNowButton()).toBeTruthy();
    expect(storedCloud().enabled).toBe(true);
    expect(cloudError()).toBeNull();
  });

  test("「立即同步」的偏好位被拒：备份本身照旧如实汇报，被拒的是那一句偏好", async () => {
    // The pref is already on (a previous session stored it); only the *next* pref write
    // will be refused, so the sync path runs with iCloud enabled.
    writeStoreValue(SETTINGS_KEY, { iCloudSync: true });
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      render(AccountPage);
      expect(syncNowButton()).toBeTruthy();
      await fireEvent.click(screen.getByRole("button", { name: t("settings.syncNow") }));
      await tick();

      // 备份那一半是**另一条判决**（`writeStoreValueChecked(BACKUP_KEY, …)`）：它落盘了，
      // 所以摘要照旧。把两者混为一谈就会让备份的成功被偏好的失败掩盖，或反过来。
      expect(summarizeBackup(readStoreValue<unknown>(BACKUP_KEY, ""))).not.toBeNull();
      // 而被拒的那一位（`cloudLast`）没有落盘 —— 页面必须说出来。
      expect(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {}).cloudLast).toBeUndefined();
      expect(cloudError()).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("拒绝只属于它自己那一次：存储恢复后再点，开关亮、错误消失", async () => {
    const restore = failWritesFor(SETTINGS_KEY);
    render(AccountPage);
    const sw = icloudSwitch();
    await fireEvent.click(sw);
    await tick();
    expect(cloudError()).toBeTruthy();
    expect(storedCloud().enabled).toBe(false);

    restore();
    await fireEvent.click(icloudSwitch());
    await tick();

    expect(icloudSwitch().getAttribute("aria-checked")).toBe("true");
    expect(storedCloud().enabled).toBe(true);
    expect(cloudError()).toBeNull();
  });
});
