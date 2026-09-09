/**
 * Component-level interaction tests for the REAL Settings sub pages added when we
 * de-placeholdered 通知 / 声音与触感 / 隐私与安全性:
 *   • 通知   — the Do-Not-Disturb switch persists through the shared quick-settings
 *              store (lib/settings dnd, same policy as the shell).
 *   • 声音   — the sound/haptic preferences persist through the durable amos.sound
 *              ledger (lib/soundPrefs).
 *   • 隐私   — revoking a granted capability from the local OS ledger (amos.permissions)
 *              actually removes it (lib/permissions revokeCap + saveLedger).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_KEY, type QuickSettings } from "../src/lib/settings";
import { SOUND_KEY, type SoundPrefs } from "../src/lib/soundPrefs";
import { PERMISSIONS_KEY, type PermissionLedger } from "../src/lib/permissions";
import { CELLULAR_KEY, type CellularPrefs } from "../src/lib/cellular";
import { FOCUS_KEY, type FocusPrefs } from "../src/lib/focusPrefs";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const switchByLabel = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll('[role="switch"]')].find(
    (b) => b.getAttribute("aria-label") === aria,
  ) as HTMLButtonElement | undefined;

/** Push the index row whose text contains `label`. */
const navigate = async (h: { container: HTMLElement }, label: string) => {
  const row = buttonContaining(h, label);
  expect(row, `index row "${label}"`).toBeTruthy();
  await fireEvent.click(row as HTMLButtonElement);
};

describe("Settings real sub pages (interactions)", () => {
  test("通知: Do-Not-Disturb persists via the quick-settings store", async () => {
    const host = render(SettingsApp);
    await navigate(host, "通知");
    await fireEvent.click(switchByLabel(host, "勿扰模式") as HTMLButtonElement);
    const saved = readStoreValue<QuickSettings>(SETTINGS_KEY, {});
    expect(saved.dnd).toBe(true);
  });

  test("声音与触感: toggling sound/haptics persists via the amos.sound ledger", async () => {
    const host = render(SettingsApp);
    await navigate(host, "声音与触感");
    await fireEvent.click(switchByLabel(host, "通知提示音") as HTMLButtonElement);
    await fireEvent.click(switchByLabel(host, "触感反馈") as HTMLButtonElement);
    const saved = readStoreValue<SoundPrefs>(SOUND_KEY, { notify: true, haptics: true });
    expect(saved).toEqual({ notify: false, haptics: false });
  });

  test("隐私与安全性: revoking a granted capability removes it from the ledger", async () => {
    // Seed one real grant: the camera app holds the camera capability.
    writeStoreValue<PermissionLedger>(PERMISSIONS_KEY, { camera: ["camera"] });

    const host = render(SettingsApp);
    await navigate(host, "隐私与安全性");
    expect(txt(host)).toContain("相机");

    // The holder chip carries a "✕"; tapping it revokes the grant.
    const chip = [...host.container.querySelectorAll("button")].find((b) =>
      b.querySelector('[data-icon="x"]'),
    );
    expect(chip).toBeTruthy();
    await fireEvent.click(chip as HTMLButtonElement);

    const ledger = readStoreValue<PermissionLedger>(PERMISSIONS_KEY, {});
    expect(Object.keys(ledger).length).toBe(0);
    expect(txt(host)).toContain("暂无授权");
  });

  test("蜂窝网络: cellular data & roaming persist via the amos.cellular ledger", async () => {
    const host = render(SettingsApp);
    await navigate(host, "蜂窝网络");
    // Cellular Data is on by default; turn Roaming on, then Data off.
    await fireEvent.click(switchByLabel(host, "数据漫游") as HTMLButtonElement);
    await fireEvent.click(switchByLabel(host, "蜂窝数据") as HTMLButtonElement);
    const saved = readStoreValue<CellularPrefs>(CELLULAR_KEY, { data: true, roaming: false });
    expect(saved).toEqual({ data: false, roaming: true });
    // Data Roaming is disabled while Cellular Data is off.
    expect(switchByLabel(host, "数据漫游")?.disabled).toBe(true);
  });

  test("专注模式: scenario toggles persist via the amos.focus ledger", async () => {
    const host = render(SettingsApp);
    await navigate(host, "专注模式");
    await fireEvent.click(switchByLabel(host, "勿扰") as HTMLButtonElement);
    await fireEvent.click(switchByLabel(host, "工作") as HTMLButtonElement);
    const saved = readStoreValue<FocusPrefs>(FOCUS_KEY, { dnd: false, work: false, sleep: false });
    expect(saved).toEqual({ dnd: true, work: true, sleep: false });
  });

  test("外发网闸: honest offline state renders (no bridge → not connected, switch disabled)", async () => {
    const host = render(SettingsApp);
    await navigate(host, "外发网闸");
    expect(txt(host)).toContain("外发网闸");
    // No Tauri bridge in this harness → the daemon is unreachable, so the guard
    // UI reports the honest "not connected" state and disables the switch rather
    // than pretending to arm a firewall it cannot reach.
    expect(txt(host)).toContain("守护进程未连接");
    expect(switchByLabel(host, "外发网闸")?.disabled).toBe(true);
  });

  test("飞行模式 disables the Wi‑Fi master switch on its radio page", async () => {
    const host = render(SettingsApp);
    // Turn airplane mode on from the index (forces Wi‑Fi/蓝牙 off).
    await fireEvent.click(switchByLabel(host, "飞行模式") as HTMLButtonElement);
    await navigate(host, "无线局域网");
    // Wi‑Fi master is now gated: the switch is disabled (toggling is a no-op).
    expect(switchByLabel(host, "无线局域网")?.disabled).toBe(true);
  });
});
