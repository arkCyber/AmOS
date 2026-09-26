/**
 * DOM tests for the Svelte 5 Settings screen (SettingsApp.svelte), restructured as
 * an iOS-style "grouped list + drill-down pages" screen.
 *
 * These verify the new information architecture and its interactions against the
 * same shared pure libs + stores as before:
 *   • the index renders the account card + grouped rows (network / display / …);
 *   • the flight-mode switch persists through the shared quick-settings store
 *     (lib/settings flipRadio + airplane cascade — same policy as control center);
 *   • sub pages are reachable by tapping their row and still persist for real:
 *     显示与亮度 → auto screen-off timeout; 锁屏密码 → passcode gating; 语言 → locale.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { setLocale } from "../src/svelte/locale.svelte";
import { AMOS_LOCALE_CHANGED_EVENT } from "../src/svelte/ui-events";
import { AUTOOFF_STORE_KEY } from "../src/lib/display";
import { LOCK_KEY, type LockCfg } from "../src/lib/lock";
import { controlByName } from "./a11y-name";
import { SETTINGS_KEY, type QuickSettings } from "../src/lib/settings";
import { settingsChannel } from "../src/svelte/appLinks";
import { WIFI_KEY } from "../src/lib/wifi";
import { BT_KEY } from "../src/lib/bluetooth";
import { FOCUS_KEY } from "../src/lib/focusPrefs";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  setLocale("zh"); // restore shared locale so later tests stay deterministic
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const inputByPlaceholder = (h: { container: HTMLElement }, ph: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === ph) as
    HTMLInputElement | undefined;
/** The switch whose accessible name is `aria` (REQ-A283 — see svelte-tests/a11y-name.ts). */
const switchByLabel = (h: { container: HTMLElement }, aria: string) =>
  controlByName<HTMLButtonElement>(h.container, '[role="switch"]', aria);

/** Tap the index row whose text contains `label` to push its sub page. */
const navigate = async (h: { container: HTMLElement }, label: string) => {
  const row = buttonContaining(h, label);
  expect(row, `row "${label}"`).toBeTruthy();
  await fireEvent.click(row as HTMLButtonElement);
};

/** Make every write of `key` fail (storage unavailable/full), as other suites do. */
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

describe("SettingsApp.svelte (iOS-style grouped index)", () => {
  test("renders the account card + grouped rows", () => {
    const host = render(SettingsApp);
    const text = txt(host);
    expect(text).toContain("设置");
    expect(text).toContain("AmOS 用户"); // account card on top
    for (const row of [
      "飞行模式",
      "无线局域网",
      "蓝牙",
      "蜂窝网络",
      "通知",
      "声音与触感",
      "专注模式",
      "显示与亮度",
      "壁纸",
      "锁屏密码",
      "语言",
      "iCloud",
      "AI 与智能",
      "隐私与安全性",
      "关于本机",
      "系统监控与开发者",
    ]) {
      expect(text, `index should surface row "${row}"`).toContain(row);
    }
  });

  test("flight-mode switch persists through the shared quick-settings store", async () => {
    const host = render(SettingsApp);
    const ap = switchByLabel(host, "飞行模式");
    expect(ap).toBeTruthy();
    await fireEvent.click(ap as HTMLButtonElement);

    const saved = readStoreValue<QuickSettings>(SETTINGS_KEY, {});
    expect(saved.airplane).toBe(true);
    // Airplane cascade: turning it on forces Wi-Fi + Bluetooth off (same as the
    // control center's flipRadio policy).
    expect(saved.wifi).toBe(false);
    expect(saved.bluetooth).toBe(false);

    // Flipping it back off restores a clean state.
    await fireEvent.click(switchByLabel(host, "飞行模式") as HTMLButtonElement);
    expect(readStoreValue<QuickSettings>(SETTINGS_KEY, {}).airplane).toBeFalsy();
  });

  test("drilling into 显示与亮度 lets you pick an auto screen-off timeout", async () => {
    const host = render(SettingsApp);
    await navigate(host, "显示与亮度");
    expect(txt(host)).toContain("外观");
    expect(txt(host)).toContain("自动息屏");
    await fireEvent.click(buttonContaining(host, "15 秒") as HTMLButtonElement);
    expect(readStoreValue<number>(AUTOOFF_STORE_KEY, 0)).toBe(15);
  });

  test("auto screen-off reflects an existing value and can be turned back off", async () => {
    writeStoreValue(AUTOOFF_STORE_KEY, 60); // seed a previously chosen timeout
    const host = render(SettingsApp);
    await navigate(host, "显示与亮度");

    const radioChecked = (label: string) =>
      [...host.container.querySelectorAll('[role="radio"]')].find(
        (b) => (b.textContent ?? "").trim() === label,
      )?.getAttribute("aria-checked");

    expect(radioChecked("60 秒")).toBe("true"); // existing value reflected on open
    await fireEvent.click(buttonContaining(host, "关闭") as HTMLButtonElement);
    expect(readStoreValue<number>(AUTOOFF_STORE_KEY, 0)).toBe(0); // back to off
    expect(radioChecked("关闭")).toBe("true");
  });

  test("cellular is now a real preference page", async () => {
    const host = render(SettingsApp);
    await navigate(host, "蜂窝网络");
    expect(txt(host)).toContain("蜂窝数据");
    expect(txt(host)).toContain("数据漫游");
  });

  test("Bluetooth page shows this-device + discoverable toggle + nearby (demo)", async () => {
    writeStoreValue(SETTINGS_KEY, { bluetooth: true, airplane: false });
    const host = render(SettingsApp);
    await navigate(host, "蓝牙");
    const flush = () => new Promise<void>((r) => setTimeout(r, 10));
    await flush();
    // this-device name + discoverable switch + demo device list
    expect(txt(host)).toContain("名称");
    expect(txt(host)).toContain("可被发现");
    expect(txt(host)).toContain("AirPods Pro");
    // the Wi‑Fi-only "current network" row is NOT shown on the Bluetooth page
    expect(txt(host)).not.toContain("当前网络");
    // default discoverable = on; toggle persists it off
    const disc = controlByName<HTMLButtonElement>(
      host.container,
      '[role="switch"]',
      "可被发现",
    );
    expect(disc).toBeTruthy();
    expect(disc?.getAttribute("aria-checked")).toBe("true");
    await fireEvent.click(disc as HTMLButtonElement);
    await flush();
    expect(readStoreValue<{ discoverable?: boolean }>(BT_KEY, {}).discoverable).toBe(false);
  });

  test("Wi-Fi page lists a demo neighbourhood; open joins, secure is disabled", async () => {
    // Turn Wi‑Fi ON (radio) so the networks list renders.
    writeStoreValue(SETTINGS_KEY, { wifi: true, airplane: false });
    const host = render(SettingsApp);
    await navigate(host, "无线局域网");
    const flush = () => new Promise<void>((r) => setTimeout(r, 10));
    await flush();
    // nearby-networks header + honest demo note + scan button are present
    expect(txt(host)).toContain("附近网络");
    expect(txt(host)).toContain("演示列表");
    const cafe = host.container.querySelector('button[aria-label="Cafe_Free"]') as HTMLButtonElement | null;
    expect(cafe).toBeTruthy();
    // a secure, not-current AP shows "需密码" and opens a password sheet on tap
    const secure = host.container.querySelector('button[aria-label="AmOS-5G"]') as HTMLButtonElement | null;
    expect(secure).toBeTruthy();
    expect(secure?.disabled).toBe(false);
    expect(txt(host)).toContain("需密码");
    await fireEvent.click(secure as HTMLButtonElement);
    await flush();
    const pw = host.container.querySelector('input[aria-label="Wi-Fi 密码"]') as HTMLInputElement | null;
    expect(pw).toBeTruthy();
    await fireEvent.input(pw, { target: { value: "secret5g" } });
    await fireEvent.click(host.container.querySelector('button[aria-label="连接"]') as HTMLButtonElement);
    await flush();
    // joined + password remembered for next time
    expect(readStoreValue<Record<string, unknown>>(WIFI_KEY, {}).current).toBe("AmOS-5G");
    expect((readStoreValue<Record<string, unknown>>(WIFI_KEY, {}).passwords as Record<string, string>)["AmOS-5G"]).toBe("secret5g");
    // joining the open network makes it the current one and shows 已连接
    await fireEvent.click(cafe as HTMLButtonElement);
    await flush();
    expect(txt(host)).toContain("已连接");
    expect(readStoreValue<{ current?: string; saved?: string[] }>(WIFI_KEY, {}).current).toBe("Cafe_Free");
    // forgetting it auto-rejoins to the strongest remembered+passworded net (AmOS-5G)
    const forget = host.container.querySelector('button[aria-label="忘记此网络"]') as HTMLButtonElement | null;
    expect(forget).toBeTruthy();
    await fireEvent.click(forget as HTMLButtonElement);
    await flush();
    expect(readStoreValue<{ current?: string }>(WIFI_KEY, {}).current).toBe("AmOS-5G"); // auto-rejoin
    // now forget AmOS-5G too → nothing remembered/passworded remains → disconnected
    await fireEvent.click(host.container.querySelector('button[aria-label="忘记此网络"]') as HTMLButtonElement);
    await flush();
    const after = readStoreValue<{
      current?: string | null;
      saved?: string[];
      passwords?: Record<string, string>;
    }>(WIFI_KEY, {});
    expect(after.current).toBeNull();
    expect(after.saved ?? []).toEqual([]);
    expect(after.passwords ?? {}).not.toHaveProperty("AmOS-5G");
    expect(txt(host)).not.toContain("已连接");
  });

  test("the Wi-Fi password sheet's 连接 cannot be pressed with an empty field — and pressing it does not silently close (REQ-A1127)", async () => {
    // A secure AP with no stored password opens the sheet. The 连接 button used to be
    // live with an empty field: pressing it (or Enter) closed the sheet while
    // `connectWithPassword` returned the config unchanged — a "success" that never
    // happened, with no verdict anywhere. Now the empty field leaves the button
    // disabled and the submit a no-op, so the sheet stays put.
    writeStoreValue(SETTINGS_KEY, { wifi: true, airplane: false });
    const host = render(SettingsApp);
    await navigate(host, "无线局域网");
    const flush = () => new Promise<void>((r) => setTimeout(r, 10));
    await flush();
    const secure = host.container.querySelector('button[aria-label="AmOS-5G"]') as HTMLButtonElement;
    expect(secure).toBeTruthy();
    await fireEvent.click(secure);
    await flush();
    const pw = host.container.querySelector('input[aria-label="Wi-Fi 密码"]') as HTMLInputElement | null;
    expect(pw, "password sheet").toBeTruthy();
    const connect = host.container.querySelector('button[aria-label="连接"]') as HTMLButtonElement | null;
    expect(connect, "连接 button").toBeTruthy();
    expect(connect?.disabled).toBe(true); // nothing typed → nothing to submit
    // Whitespace is not a password either.
    await fireEvent.input(pw as HTMLInputElement, { target: { value: "   " } });
    await flush();
    expect(connect?.disabled).toBe(true);
    // Pressing the disabled control must not close the sheet pretending it joined.
    await fireEvent.click(connect as HTMLButtonElement);
    await flush();
    expect(host.container.querySelector('input[aria-label="Wi-Fi 密码"]')).toBeTruthy();
    // Enter is the second entry point to `submitPassword` and must honour the same gate.
    await fireEvent.keyDown(pw as HTMLInputElement, { key: "Enter" });
    await flush();
    expect(host.container.querySelector('input[aria-label="Wi-Fi 密码"]')).toBeTruthy();
    expect(readStoreValue<{ current?: string | null }>(WIFI_KEY, {}).current ?? null).toBeNull();
    // A real password enables it, and submitting joins + remembers (positive control).
    await fireEvent.input(pw as HTMLInputElement, { target: { value: "secret5g" } });
    await flush();
    expect(connect?.disabled).toBe(false);
    await fireEvent.click(connect as HTMLButtonElement);
    await flush();
    expect(readStoreValue<{ current?: string | null }>(WIFI_KEY, {}).current).toBe("AmOS-5G");
    expect(host.container.querySelector('input[aria-label="Wi-Fi 密码"]')).toBeNull(); // sheet closed
  });

  test("the password sheet belongs to the network it asks about — joining another one closes it (REQ-A1223)", async () => {
    // A tap on a network is a new question, and the sheet answers exactly one: it opens
    // for the *secure, password-less* AP you tapped. Joining a different network (here
    // the open one) is that question being walked away from — but nothing cleared the
    // sheet, so 「为「AmOS-5G」输入密码」 stayed on screen for a network the user had
    // already left, with 连接 — the only control it still has enabled — one press from
    // moving the connection silently back to it. The Bluetooth half of the same page
    // states the rule for its own pending question (`btPairTarget = ""` at the top of
    // `startBtScan`: "a new search is a new question"); the Wi-Fi half had no such reset.
    writeStoreValue(SETTINGS_KEY, { wifi: true, airplane: false });
    const host = render(SettingsApp);
    await navigate(host, "无线局域网");
    const flush = () => new Promise<void>((r) => setTimeout(r, 10));
    await flush();
    await fireEvent.click(host.container.querySelector('button[aria-label="AmOS-5G"]') as HTMLButtonElement);
    await flush();
    const pw = host.container.querySelector('input[aria-label="Wi-Fi 密码"]');
    expect(pw, "password sheet for AmOS-5G").toBeTruthy();

    // The user changes their mind and joins the open network instead.
    await fireEvent.click(host.container.querySelector('button[aria-label="Cafe_Free"]') as HTMLButtonElement);
    await flush();
    expect(readStoreValue<{ current?: string | null }>(WIFI_KEY, {}).current).toBe("Cafe_Free");
    // The abandoned network's sheet must be gone: the question on screen is the network
    // the user just joined, not the one they walked away from.
    expect(host.container.querySelector('input[aria-label="Wi-Fi 密码"]'), "stale sheet").toBeNull();
  });

  test("a refused password write does not close the sheet as if the join had happened (REQ-A1241)", async () => {
    // `saveCfg` returns nothing, so its caller cannot tell "stored" from "refused" — and
    // `submitPassword` cleared `pwFor` / `pwVal` either way. When the store refuses the
    // write (unavailable/full) nothing was joined, so the sheet's disappearance is the
    // app reporting a join that never happened — and the typed password is discarded with
    // it. The rule is written three lines above, for the empty-field case (REQ-A1127:
    // "closing the sheet here would read as 'the join happened' while nothing did"); the
    // refused-write case is the same false verdict, so the sheet stays and the banner says why.
    writeStoreValue(SETTINGS_KEY, { wifi: true, airplane: false });
    const restore = failWritesFor(WIFI_KEY);
    try {
      const host = render(SettingsApp);
      await navigate(host, "无线局域网");
      const flush = () => new Promise<void>((r) => setTimeout(r, 10));
      await flush();
      await fireEvent.click(host.container.querySelector('button[aria-label="AmOS-5G"]') as HTMLButtonElement);
      await flush();
      const pw = host.container.querySelector('input[aria-label="Wi-Fi 密码"]') as HTMLInputElement;
      expect(pw, "password sheet for AmOS-5G").toBeTruthy();
      await fireEvent.input(pw, { target: { value: "secret5g" } });
      await flush();
      await fireEvent.click(host.container.querySelector('button[aria-label="连接"]') as HTMLButtonElement);
      await flush();
      // The store refused it, so nothing was joined…
      expect(readStoreValue<{ current?: string | null }>(WIFI_KEY, {}).current ?? null).toBeNull();
      // …and the write failure is reported rather than swallowed…
      expect(txt(host)).toContain("保存失败");
      // …so the sheet — the only place that join could have come from — must still be up.
      expect(host.container.querySelector('input[aria-label="Wi-Fi 密码"]'), "sheet closed on a refused write").toBeTruthy();
    } finally {
      restore();
    }
  });

  test("the Wi-Fi index row names the joined network, not 「未连接」 (REQ-A1123)", () => {
    // The row used to answer a two-state question and never read `amos.wifi`, so it
    // said 「未连接」 while the status bar and this very page named the joined network.
    writeStoreValue(SETTINGS_KEY, { wifi: true, airplane: false });
    writeStoreValue(WIFI_KEY, { current: "Cafe_Free", saved: ["Cafe_Free"], passwords: {} });
    const host = render(SettingsApp);
    const row = buttonContaining(host, "无线局域网");
    expect(row?.textContent ?? "").toContain("Cafe_Free");
    expect(row?.textContent ?? "").not.toContain("未连接");
  });

  test("the Wi-Fi index row still says 「未连接」 when the radio is on but nothing is joined (REQ-A1123)", () => {
    writeStoreValue(SETTINGS_KEY, { wifi: true, airplane: false });
    writeStoreValue(WIFI_KEY, { current: null, saved: [], passwords: {} });
    const host = render(SettingsApp);
    const row = buttonContaining(host, "无线局域网");
    expect(row?.textContent ?? "").toContain("未连接");
  });

  test("the Wi-Fi index row shows 「关」 when the radio is off, even with a remembered SSID (REQ-A1123)", () => {
    // The joined SSID outlives the radio; reading only `current` would name a network
    // this device is not on.
    writeStoreValue(SETTINGS_KEY, { wifi: false, airplane: false });
    writeStoreValue(WIFI_KEY, { current: "Cafe_Free", saved: ["Cafe_Free"], passwords: {} });
    const host = render(SettingsApp);
    const row = buttonContaining(host, "无线局域网");
    expect(row?.textContent ?? "").not.toContain("Cafe_Free");
    expect(row?.textContent ?? "").toContain("关");
  });

  test("the Wi-Fi page's 「当前网络」 row answers with the link, not the radio (REQ-A1123)", async () => {
    writeStoreValue(SETTINGS_KEY, { wifi: true, airplane: false });
    writeStoreValue(WIFI_KEY, { current: "Cafe_Free", saved: ["Cafe_Free"], passwords: {} });
    const host = render(SettingsApp);
    await navigate(host, "无线局域网");
    await new Promise<void>((r) => setTimeout(r, 10));
    const cell = host.container.querySelector('[data-testid="wifi-current-network"]');
    expect(cell?.textContent?.trim()).toBe("Cafe_Free");
  });

  test("the Wi-Fi page's 「当前网络」 row says 「未连接」 when on but not joined (REQ-A1123)", async () => {
    writeStoreValue(SETTINGS_KEY, { wifi: true, airplane: false });
    writeStoreValue(WIFI_KEY, { current: null, saved: [], passwords: {} });
    const host = render(SettingsApp);
    await navigate(host, "无线局域网");
    await new Promise<void>((r) => setTimeout(r, 10));
    const cell = host.container.querySelector('[data-testid="wifi-current-network"]');
    expect(cell?.textContent?.trim()).toBe("未连接");
  });

  test("now-real sub pages render their real controls", async () => {
    // notifications → real Do-Not-Disturb switch
    let host = render(SettingsApp);
    await navigate(host, "通知");
    expect(txt(host)).toContain("勿扰模式");
    // sound → preview button
    host = render(SettingsApp);
    await navigate(host, "声音与触感");
    expect(txt(host)).toContain("试听");
    // about → device/version rows (constant identity)
    host = render(SettingsApp);
    await navigate(host, "关于本机");
    expect(txt(host)).toContain("AmOS");
    // privacy → empty-ledger state (ledger cleared each test)
    host = render(SettingsApp);
    await navigate(host, "隐私与安全性");
    expect(txt(host)).toContain("暂无授权");
  });
  test("lock page refuses a too-short passcode", async () => {
    const host = render(SettingsApp);
    await navigate(host, "锁屏密码");
    await fireEvent.click(switchByLabel(host, "启用锁屏密码") as HTMLButtonElement);
    const pin = inputByPlaceholder(host, "4-6 位数字密码");
    expect(pin).toBeTruthy();
    await fireEvent.input(pin as HTMLInputElement, { target: { value: "12" } });
    await fireEvent.click(buttonContaining(host, "保存") as HTMLButtonElement);
    expect(readStoreValue<LockCfg>(LOCK_KEY, { enabled: false }).enabled).toBe(false);
  });

  test("lock page enables and persists a valid 6-digit passcode", async () => {
    const host = render(SettingsApp);
    await navigate(host, "锁屏密码");
    await fireEvent.click(switchByLabel(host, "启用锁屏密码") as HTMLButtonElement);
    const pin = inputByPlaceholder(host, "4-6 位数字密码");
    expect(pin).toBeTruthy();
    await fireEvent.input(pin as HTMLInputElement, { target: { value: "123456" } });
    await fireEvent.click(buttonContaining(host, "保存") as HTMLButtonElement);
    const saved = readStoreValue<LockCfg>(LOCK_KEY, { enabled: false });
    expect(saved.enabled).toBe(true);
    expect(saved.pin).toBe("123456");
  });

  test("switching the language on the 语言 page broadcasts the sync event", async () => {
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(AMOS_LOCALE_CHANGED_EVENT, on);
    try {
      const host = render(SettingsApp);
      await navigate(host, "语言");
      await fireEvent.click(buttonContaining(host, "English") as HTMLButtonElement);
      expect(seen).toContain("en");
    } finally {
      window.removeEventListener(AMOS_LOCALE_CHANGED_EVENT, on);
    }
  });

  test("the index search field live-filters rows and drills into a match", async () => {
    const host = render(SettingsApp);
    const input = [...host.container.querySelectorAll("input")].find(
      (i) => i.getAttribute("aria-label") === "搜索设置",
    ) as HTMLInputElement | undefined;
    expect(input).toBeTruthy();

    // Searching hides the account card + grouped view and shows only matches.
    await fireEvent.input(input as HTMLInputElement, { target: { value: "亮度" } });
    expect(txt(host)).toContain("显示与亮度");
    expect(txt(host)).not.toContain("AmOS 用户"); // account card hidden while searching

    // Tapping a result opens that sub page (and clears the search).
    await fireEvent.click(buttonContaining(host, "显示与亮度") as HTMLButtonElement);
    expect(txt(host)).toContain("外观");
  });

  test("index rows surface persisted state (focus subtitle)", async () => {
    // REQ-A206: the 专注模式 subtitle lists the REAL DND bit (amos.settings.dnd)
    // first, then the saved intent scenarios from amos.focus.
    writeStoreValue(FOCUS_KEY, { work: true, sleep: false });
    writeStoreValue(SETTINGS_KEY, { dnd: true });
    const host = render(SettingsApp);
    expect(txt(host)).toContain("专注模式");
    expect(txt(host)).toContain("勿扰"); // the real DND bit is listed
    expect(txt(host)).toContain("工作"); // enabled intent scenario
  });

  test("index search also matches alias/sub-page keywords", async () => {
    const host = render(SettingsApp);
    const input = [...host.container.querySelectorAll("input")].find(
      (i) => i.getAttribute("aria-label") === "搜索设置",
    ) as HTMLInputElement | undefined;
    expect(input).toBeTruthy();

    // English alias finds the page even while the UI is in Chinese.
    await fireEvent.input(input as HTMLInputElement, { target: { value: "brightness" } });
    expect(txt(host)).toContain("显示与亮度");

    // Alias shared by two pages surfaces BOTH (通知 has 勿扰 in its sub page).
    await fireEvent.input(input as HTMLInputElement, { target: { value: "勿扰" } });
    expect(txt(host)).toContain("通知");
    expect(txt(host)).toContain("专注模式");

    // An unmatched term shows the empty state.
    await fireEvent.input(input as HTMLInputElement, { target: { value: "zzzqqq" } });
    expect(txt(host)).toContain("没有找到匹配的设置项。");
  });

  test("a search link prefills the index search, then is consumed", async () => {
    const host = render(SettingsApp);
    const find = () =>
      [...host.container.querySelectorAll("input")].find(
        (i) => i.getAttribute("aria-label") === "搜索设置",
      ) as HTMLInputElement | undefined;

    // Start on a sub page so the link has to bring us back to the index.
    await fireEvent.click(buttonContaining(host, "显示与亮度") as HTMLButtonElement);
    expect(txt(host)).toContain("自动息屏");

    settingsChannel().set({ query: "brightness", nonce: 7 });
    await Promise.resolve();
    expect(find()?.value).toBe("brightness");
    // We are back on the *index* (the search field only exists there) and the sub page
    // we had opened is gone — the link navigates, it does not leave the user mid-page.
    expect(txt(host)).not.toContain("自动息屏");
    // The index's own alias search decides what that matches (we picked no page).
    expect(txt(host)).toContain("显示与亮度");
    // Consumed once: a remount starts clean (nothing pending).
    expect(settingsChannel().get()?.query).toBe("");

    // Asking a second time with the same text and a new nonce re-triggers it.
    await fireEvent.input(find() as HTMLInputElement, { target: { value: "" } });
    settingsChannel().set({ query: "brightness", nonce: 8 });
    await Promise.resolve();
    expect(find()?.value).toBe("brightness");
  });

  test("a search link whose text begins with '#' is a search, not a page jump (REQ-A1092)", async () => {
    const host = render(SettingsApp);
    const find = () =>
      [...host.container.querySelectorAll("input")].find(
        (i) => i.getAttribute("aria-label") === "搜索设置",
      ) as HTMLInputElement | undefined;

    // The channel is fed by Spotlight's 「在设置中搜索」 action, which hands over the
    // raw query — so "#…" is ordinary text a user can type. A page-name-shaped one
    // must land in the box like any other term, not steer the screen.
    settingsChannel().set({ query: "#dock", nonce: 21 });
    await Promise.resolve();
    expect(find(), "the index search field").toBeTruthy();
    expect(find()?.value).toBe("#dock");

    // …and a leading '#' that names no page must not be silently swallowed into an
    // empty box either: the query the user asked for is what they must see.
    await fireEvent.input(find() as HTMLInputElement, { target: { value: "" } });
    settingsChannel().set({ query: "#1 号", nonce: 22 });
    await Promise.resolve();
    expect(find()?.value).toBe("#1 号");
  });
});
