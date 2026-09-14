/**
 * Component-level interaction tests for the REAL Settings sub pages added when we
 * de-placeholdered 通知 / 声音与触感 / 隐私与安全性:
 *   • 通知   — the Do-Not-Disturb switch persists through the shared quick-settings
 *              store (lib/settings dnd, same policy as the shell).
 *   • 声音   — the sound/haptic preferences persist through the durable amos.sound
 *              policy ledger (lib/sound, the single owner of that key).
 *   • 隐私   — revoking a granted capability from the local OS ledger (amos.permissions)
 *              actually removes it (lib/permissions revokeCap + saveLedger).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import RadioPage from "../src/svelte/settings/RadioPage.svelte";
import AiPage from "../src/svelte/settings/AiPage.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { readQuarantine } from "../src/lib/amosStore";
import { SETTINGS_KEY, type QuickSettings } from "../src/lib/settings";
import { BACKUP_KEY, BACKUP_VERSION } from "../src/lib/cloud";
import { NOTES_KEY } from "../src/lib/notes";
import { CONTACTS_KEY } from "../src/lib/contacts";
import { WIFI_KEY } from "../src/lib/wifi";
import { BT_KEY } from "../src/lib/bluetooth";
import { SOUND_KEY, type SoundPolicy } from "../src/lib/sound";
import { PERMISSIONS_KEY, type PermissionLedger } from "../src/lib/permissions";
import { CELLULAR_KEY, type CellularPrefs } from "../src/lib/cellular";
import {
  amosLog,
  amosWarn,
  clearDiag,
  diagStats,
  recentDiag,
  setDiagMinLevel,
} from "../src/lib/debugLog";
import { FOCUS_KEY, type FocusPrefs } from "../src/lib/focusPrefs";
import { LOCK_KEY } from "../src/lib/lock";
import { assertHold, clearAllHolds, releaseHold } from "../src/lib/keepAwakeCore";
import { AUTOOFF_STORE_KEY } from "../src/lib/display";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  clearAllHolds(); // module-singleton reason bus — never leak holds between tests
});

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

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. (`window.localStorage` is a per-access proxy, so the prototype
 * cannot be patched — the window property itself is replaced.)
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
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

describe("Settings real sub pages (interactions)", () => {
  test("通知: Do-Not-Disturb persists via the quick-settings store", async () => {
    const host = render(SettingsApp);
    await navigate(host, "通知");
    await fireEvent.click(switchByLabel(host, "勿扰模式") as HTMLButtonElement);
    const saved = readStoreValue<QuickSettings>(SETTINGS_KEY, {});
    expect(saved.dnd).toBe(true);
  });

  test("声音与触感: toggling sound/haptics persists via the amos.sound policy", async () => {
    const host = render(SettingsApp);
    await navigate(host, "声音与触感");
    await fireEvent.click(switchByLabel(host, "通知提示音") as HTMLButtonElement);
    await fireEvent.click(switchByLabel(host, "触感反馈") as HTMLButtonElement);
    // The same key/schema the status bar + notification-arrival path read.
    const saved = readStoreValue<SoundPolicy>(SOUND_KEY, { ring: true, vibrate: true, volume: 1 });
    expect(saved).toEqual({ ring: false, vibrate: false, volume: 1 });
  });

  test("声音与触感: the alert-volume slider persists the chime loudness (REQ-A205)", async () => {
    const host = render(SettingsApp);
    await navigate(host, "声音与触感");
    const slider = () =>
      host.container.querySelector('[data-testid="sound-volume"]') as HTMLInputElement | null;
    expect(slider()).toBeTruthy();
    // Default loudness: 100%.
    expect(slider()?.value).toBe("100");
    await fireEvent.input(slider() as HTMLInputElement, { target: { value: "50" } });
    // Persisted through the same amos.sound key the arrival path reads.
    const saved = readStoreValue<SoundPolicy>(SOUND_KEY, { ring: true, vibrate: true, volume: 1 });
    expect(saved.volume).toBeCloseTo(0.5);
    // The % readout mirrors the persisted policy.
    expect(txt(host)).toContain("50%");
    // A fresh page reads the loudness back from the store, not local state.
    host.unmount();
    const host2 = render(SettingsApp);
    await navigate(host2, "声音与触感");
    const slider2 = host2.container.querySelector(
      '[data-testid="sound-volume"]',
    ) as HTMLInputElement;
    expect(slider2.value).toBe("50");
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

  test("专注模式: 勿扰 is the REAL quick-settings bit; 工作/睡眠 stay in the amos.focus ledger (REQ-A206)", async () => {
    const host = render(SettingsApp);
    await navigate(host, "专注模式");
    await fireEvent.click(switchByLabel(host, "勿扰") as HTMLButtonElement);
    await fireEvent.click(switchByLabel(host, "工作") as HTMLButtonElement);
    // The DND switch must land in the store the shell honours
    // (lib/settings.dndActive reads amos.settings.dnd) — the same bit the 通知
    // page writes. It used to write a decorative amos.focus.dnd that muted nothing.
    const quick = readStoreValue<QuickSettings>(SETTINGS_KEY, {});
    expect(quick.dnd).toBe(true);
    // Intent scenarios keep their own ledger — without a decorative dnd field.
    const saved = readStoreValue<FocusPrefs>(FOCUS_KEY, { work: false, sleep: false });
    expect(saved).toEqual({ work: true, sleep: false });
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

  test("iCloud: 立即同步 writes a readable backup and 恢复本地备份 puts a content store back", async () => {
    writeStoreValue(NOTES_KEY, [{ id: "n1", text: "记一笔", ts: 1 }]);
    const host = render(SettingsApp);
    await navigate(host, "iCloud");
    await fireEvent.click(switchByLabel(host, "iCloud 同步") as HTMLButtonElement);
    // Nothing backed up yet ⇒ no restore offered (never pretend there is a backup).
    expect(buttonContaining(host, "恢复本地备份")).toBeUndefined();

    await fireEvent.click(buttonContaining(host, "立即同步") as HTMLButtonElement);
    // The snapshot is real and readable, and the page says what it holds: one of the
    // 17 stores carries content (the untouched ones are the `[]` default).
    const blob = readStoreValue<string>(BACKUP_KEY, "");
    expect(blob).toContain(`"${NOTES_KEY}"`);
    expect(txt(host)).toContain("本地备份：1/17 个存储有内容");

    // The user loses the notes; restoring the backup brings them back.
    writeStoreValue(NOTES_KEY, []);
    await fireEvent.click(buttonContaining(host, "恢复本地备份") as HTMLButtonElement);
    expect(readStoreValue<Array<{ id: string }>>(NOTES_KEY, [])).toEqual([
      { id: "n1", text: "记一笔", ts: 1 },
    ]);
    expect(txt(host)).toContain("已恢复 17 个存储");
  });

  test("iCloud restore refuses non-content keys (a forged backup cannot re-grant a capability)", async () => {
    writeStoreValue<PermissionLedger>(PERMISSIONS_KEY, {});
    // A hand-forged "backup" that tries to re-grant the camera capability, move the
    // Wi‑Fi radio, and inject a brand-new store — alongside one real note.
    writeStoreValue(
      BACKUP_KEY,
      JSON.stringify({
        [PERMISSIONS_KEY]: { camera: ["camera"] },
        [WIFI_KEY]: { on: true },
        "amos.evil": 1,
        [NOTES_KEY]: [{ id: "n1", text: "hi", ts: 1 }],
      }),
    );
    writeStoreValue(SETTINGS_KEY, { iCloudSync: true });

    const host = render(SettingsApp);
    await navigate(host, "iCloud");
    await fireEvent.click(buttonContaining(host, "恢复本地备份") as HTMLButtonElement);
    // Only the content store was written; the forged config/device keys were refused.
    expect(readStoreValue<PermissionLedger>(PERMISSIONS_KEY, {})).toEqual({});
    expect(readStoreValue<Record<string, unknown>>(WIFI_KEY, {})).toEqual({});
    expect(readStoreValue<unknown>(WIFI_KEY, "absent")).not.toEqual({ on: true });
    expect(readStoreValue<Array<{ id: string }>>(NOTES_KEY, [])).toEqual([
      { id: "n1", text: "hi", ts: 1 },
    ]);
    expect(txt(host)).toContain("已恢复 1 个存储");
  });

  test("iCloud restore is honest about a corrupt backup: no summary, no button, no writes", async () => {
    writeStoreValue(NOTES_KEY, [{ id: "keep", text: "keep", ts: 1 }]);
    writeStoreValue(BACKUP_KEY, "{not json");
    writeStoreValue(SETTINGS_KEY, { iCloudSync: true });

    const host = render(SettingsApp);
    await navigate(host, "iCloud");
    // A corrupt blob has no honest summary ⇒ no restore is offered at all.
    expect(txt(host)).not.toContain("本地备份：");
    expect(buttonContaining(host, "恢复本地备份")).toBeUndefined();
    expect(readStoreValue<Array<{ id: string }>>(NOTES_KEY, [])).toEqual([
      { id: "keep", text: "keep", ts: 1 },
    ]);
  });

  test("iCloud: 上次同步 describes the backup itself — and is not claimed without one", async () => {
    const AT = 1_700_000_000_000;
    // A *later* `cloudLast` pref must not be what the page shows: the label describes
    // the backup, and a pref can outlive the blob it was written alongside.
    writeStoreValue(SETTINGS_KEY, { iCloudSync: true, cloudLast: AT + 3_600_000 });
    writeStoreValue(BACKUP_KEY, JSON.stringify({ v: BACKUP_VERSION, at: AT, stores: {} }));

    const host = render(SettingsApp);
    await navigate(host, "iCloud");
    expect(txt(host)).toContain(`上次同步 ${new Date(AT).toLocaleTimeString()}`);
    expect(txt(host)).not.toContain(new Date(AT + 3_600_000).toLocaleTimeString());
  });

  test("iCloud: no restorable backup ⇒ no sync time is claimed (a pref is not a backup)", async () => {
    // The blob is gone (cleared/corrupt) but the settings pref survives. The old
    // build still rendered "上次同步 …", promising a backup that no longer exists.
    writeStoreValue(SETTINGS_KEY, { iCloudSync: true, cloudLast: 1_700_000_000_000 });

    const host = render(SettingsApp);
    await navigate(host, "iCloud");
    expect(txt(host)).toContain("已开启：数据将快照为本地备份");
    expect(txt(host)).not.toContain("上次同步");
    expect(buttonContaining(host, "恢复本地备份")).toBeUndefined();
  });

  test("iCloud: a backup from a newer AmOS is refused with an honest message, nothing guessed at", async () => {
    writeStoreValue(NOTES_KEY, [{ id: "keep", text: "keep", ts: 1 }]);
    writeStoreValue(
      BACKUP_KEY,
      JSON.stringify({
        v: BACKUP_VERSION + 1,
        at: 1_700_000_000_000,
        stores: { [NOTES_KEY]: [{ id: "future" }] },
      }),
    );
    writeStoreValue(SETTINGS_KEY, { iCloudSync: true });

    const host = render(SettingsApp);
    await navigate(host, "iCloud");
    await fireEvent.click(buttonContaining(host, "恢复本地备份") as HTMLButtonElement);
    expect(txt(host)).toContain("此备份由更新版本的 AmOS 创建，未做任何更改");
    expect(readStoreValue<Array<{ id: string }>>(NOTES_KEY, [])).toEqual([
      { id: "keep", text: "keep", ts: 1 },
    ]);
  });

  test("iCloud: a rejected backup write is reported, and the previous backup stays described", async () => {
    // A real backup already on disk (one store carries content).
    writeStoreValue(
      BACKUP_KEY,
      JSON.stringify({ v: BACKUP_VERSION, at: 1_700_000_000_000, stores: { [NOTES_KEY]: [{ id: "old" }] } }),
    );
    // Storage that rejects *only* the backup write, the way a full quota does.
    const restore = failWritesFor(BACKUP_KEY);
    try {
      writeStoreValue(NOTES_KEY, [{ id: "n1", text: "hi", ts: 1 }]);
      const host = render(SettingsApp);
      await navigate(host, "iCloud");
      await fireEvent.click(switchByLabel(host, "iCloud 同步") as HTMLButtonElement);
      await fireEvent.click(buttonContaining(host, "立即同步") as HTMLButtonElement);

      // The snapshot could not be stored, so the page must not summarise or date it.
      expect(txt(host)).toContain("备份写入失败（存储空间不足或不可用），未做任何更改");
      // The summary still describes what IS actually stored (the previous backup) —
      // not the attempt that failed.
      expect(txt(host)).toContain("本地备份：1/17 个存储有内容");
      const onDisk = JSON.parse(readStoreValue<string>(BACKUP_KEY, "{}")) as {
        stores?: Record<string, Array<{ id: string }>>;
      };
      expect(onDisk.stores?.[NOTES_KEY]).toEqual([{ id: "old" }]);
    } finally {
      restore();
    }
  });

  test("iCloud: a partially-rejected restore says so instead of counting every store", async () => {
    // A two-store backup; storage will refuse one of them during the restore.
    writeStoreValue(
      BACKUP_KEY,
      JSON.stringify({
        v: BACKUP_VERSION,
        at: 1_700_000_000_000,
        stores: {
          [NOTES_KEY]: [{ id: "n1", text: "hi", ts: 1 }],
          [CONTACTS_KEY]: [{ id: "c1" }],
        },
      }),
    );
    writeStoreValue(SETTINGS_KEY, { iCloudSync: true });
    const restore = failWritesFor(CONTACTS_KEY);
    try {
      const host = render(SettingsApp);
      await navigate(host, "iCloud");
      await fireEvent.click(buttonContaining(host, "恢复本地备份") as HTMLButtonElement);

      // One store could be written, one could not — the page must say exactly that
      // rather than reporting a clean "已恢复 N 个存储".
      expect(txt(host)).toContain("已恢复 1 个存储；1 个写入失败");
      expect(readStoreValue<Array<{ id: string }>>(NOTES_KEY, [])).toEqual([
        { id: "n1", text: "hi", ts: 1 },
      ]);
      // The refused store was never invented into existence.
      expect(readStoreValue<unknown>(CONTACTS_KEY, null)).toBeNull();
    } finally {
      restore();
    }
  });

  test("锁屏密码: a rejected write is reported, never \"已保存\"", async () => {
    // A passcode that only looks saved is a security claim, not a cosmetic one.
    const restore = failWritesFor(LOCK_KEY);
    try {
      const host = render(SettingsApp);
      await navigate(host, "锁屏密码");
      await fireEvent.click(switchByLabel(host, "启用锁屏密码") as HTMLButtonElement);
      await fireEvent.click(buttonContaining(host, "保存") as HTMLButtonElement);
      expect(txt(host)).toContain("写入失败");
      expect(txt(host)).not.toContain("已保存");
    } finally {
      restore();
    }
  });

  test("蓝牙: a rejected config write is reported instead of looking saved", async () => {
    const restore = failWritesFor(BT_KEY);
    try {
      const host = render(SettingsApp);
      await navigate(host, "蓝牙");
      // The Bluetooth section only renders with the radio on — turn the master on first.
      await fireEvent.click(switchByLabel(host, "蓝牙") as HTMLButtonElement);
      await fireEvent.click(switchByLabel(host, "可被发现") as HTMLButtonElement);
      // The page says the write failed rather than showing a device config it did not
      // store (and the switch state comes from the store on the next read).
      const err = host.container.querySelector('[data-testid="radio-store-error"]');
      expect(err?.textContent ?? "").toContain("保存失败");
    } finally {
      restore();
    }
  });

  test("诊断: preserved corrupt data is listed and copyable; absent when there is none", async () => {
    const host0 = render(SettingsApp);
    await navigate(host0, "系统监控与开发者");
    // Nothing quarantined ⇒ the panel renders nothing (the page's rule).
    expect(host0.container.querySelector('[data-testid="store-quarantine"]')).toBeNull();
    cleanup();

    // A corrupt store, read once ⇒ its bytes are quarantined…
    const KEY = "amos.notes";
    writeStoreValue(KEY, [{ id: "keep" }]);
    window.localStorage.setItem(KEY, "{ this is not json");
    readStoreValue<unknown>(KEY, []);

    const host = render(SettingsApp);
    await navigate(host, "系统监控与开发者");
    const panel = host.container.querySelector('[data-testid="store-quarantine"]');
    expect(panel).toBeTruthy();
    expect(panel?.textContent ?? "").toContain(KEY);
    expect(panel?.textContent ?? "").toContain("字节"); // the byte count is shown
    // …and the user can copy the raw text out (the app never rewrites it).
    await fireEvent.click(
      panel!.querySelector('button[data-testid="quarantine-copy"]') as HTMLButtonElement,
    );
    await Promise.resolve();
    expect(readQuarantine(KEY)).toBe("{ this is not json");
  });
});

describe("AiPage — daemon restart env readout", () => {
  test("shows the env lib/providers.envFor computes for the selected provider", () => {
    const host = render(AiPage);
    const env = host.container.querySelector('[data-testid="ai-env"]');
    expect(env).toBeTruthy();
    // Default provider is local Ollama → the daemon's local env.
    expect(env?.textContent ?? "").toContain("AMOS_BACKEND=ollama");
    expect(env?.textContent ?? "").toContain("AMOS_OLLAMA_HOST=http://localhost:11434");
  });

  test("a cloud provider's env names the api backend + endpoint, never the key", () => {
    writeStoreValue(SETTINGS_KEY, { aiProvider: "deepseek" });
    const host = render(AiPage);
    const env = host?.container.querySelector('[data-testid="ai-env"]');
    expect(env?.textContent ?? "").toContain("AMOS_BACKEND=api");
    expect(env?.textContent ?? "").toContain(
      "AMOS_API_ENDPOINT=https://api.deepseek.com/v1/chat/completions",
    );
    // No key typed → no AMOS_API_KEY line at all (never a blank secret).
    expect(env?.textContent ?? "").not.toContain("AMOS_API_KEY=");
  });

  test("renders the daemon's log-sink health — and says when the trail is incomplete (REQ-A87)", async () => {
    // A daemon that persists logs AND has already lost data: the page must show both
    // the persisted bytes and the loss, never a reassuring "logging is fine".
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "get_status"
          ? {
              engine: "ollama",
              engine_model: "llama3",
              degraded: false,
              log_sink: {
                enabled: true,
                path: "/home/u/.amos/logs/amos-ai.log",
                bytes_written: 2048,
                lost_bytes: 64,
                write_failures: 2,
                rotations: 1,
                active_bytes: 512,
              },
            }
          : null,
      listen: async () => () => {},
    };
    const host = render(AiPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="ai-log-sink"]')).toBeTruthy(),
    );
    expect(host.container.querySelector('[data-testid="ai-log-sink"]')?.textContent ?? "").toContain(
      "2048",
    );
    const loss = host.container.querySelector('[data-testid="ai-log-sink-loss"]');
    expect(loss).toBeTruthy();
    expect(loss?.textContent ?? "").toContain("64");
    expect(loss?.textContent ?? "").toContain("2");

    // …and a stdout-only daemon says so instead of showing a fake 0-byte file.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "get_status"
          ? {
              engine: "ollama",
              engine_model: "llama3",
              log_sink: { enabled: false, path: "" },
            }
          : null,
      listen: async () => () => {},
    };
    const host2 = render(AiPage);
    await vi.waitFor(() =>
      expect(host2.container.querySelector('[data-testid="ai-log-sink"]')).toBeTruthy(),
    );
    expect(host2.container.querySelector('[data-testid="ai-log-sink"]')?.textContent ?? "").toContain(
      "仅标准输出",
    );
    expect(host2.container.querySelector('[data-testid="ai-log-sink-loss"]')).toBeNull();
  });

  test("renders the breaker state — and that calls were skipped on purpose (REQ-A131)", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "get_status"
          ? {
              // A decorated mock: the page must NOT call this a real engine.
              engine: "mock+breaker",
              engine_model: "amos-mock",
              degraded: false,
              breaker: {
                enabled: true,
                state: "open",
                fail_threshold: 3,
                cooldown_seconds: 30,
                consecutive_failures: 3,
                openings: 1,
                rejections: 7,
                failures: 3,
                successes: 12,
              },
            }
          : null,
      listen: async () => () => {},
    };
    const host = render(AiPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="ai-breaker-state"]')).toBeTruthy(),
    );
    expect(
      host.container.querySelector('[data-testid="ai-breaker-state"]')?.textContent ?? "",
    ).toContain("断开");
    expect(
      host.container.querySelector('[data-testid="ai-breaker-skipped"]')?.textContent ?? "",
    ).toContain("7");
    // `mock+breaker` is a mock: the page must show the mock line, never the
    // "{engine} · {model}" line that would pass the decorated name off as real.
    const engineLine = host.container.querySelector('[data-testid="ai-engine-line"]');
    expect(engineLine?.textContent ?? "").toContain("模拟引擎");
    expect(engineLine?.textContent ?? "").not.toContain("mock+breaker");

    // A daemon with the breaker disabled says exactly that (never "closed").
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "get_status" ? { engine: "mock", breaker: { enabled: false } } : null,
      listen: async () => () => {},
    };
    const host2 = render(AiPage);
    await vi.waitFor(() =>
      expect(host2.container.querySelector('[data-testid="ai-breaker-state"]')).toBeTruthy(),
    );
    expect(
      host2.container.querySelector('[data-testid="ai-breaker-state"]')?.textContent ?? "",
    ).toContain("未启用");
    expect(host2.container.querySelector('[data-testid="ai-breaker-skipped"]')).toBeNull();
  });

  test("lists what the daemon says is wrong — and stays silent when nothing is (REQ-A133)", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "get_status"
          ? {
              engine: "mock",
              alerts: {
                alerts: [
                  {
                    id: "generations_rejected",
                    severity: "warn",
                    detail: "12 generation(s) were rejected by the admission gate since start",
                    active_for_seconds: 34,
                  },
                  {
                    id: "some_future_rule",
                    severity: "warn",
                    detail: "raw from the daemon",
                    active_for_seconds: 0,
                  },
                ],
              },
            }
          : null,
      listen: async () => () => {},
    };
    const host = render(AiPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="ai-alerts"]')).toBeTruthy(),
    );
    const row = host.container.querySelector('[data-testid="ai-alert-generations_rejected"]');
    // Localized rule name + the daemon's own numbers + how long *it* has seen it.
    expect(row?.textContent ?? "").toContain("生成请求被拒");
    expect(row?.textContent ?? "").toContain("12 generation(s)");
    expect(row?.textContent ?? "").toContain("已持续 34 秒");
    // A rule this build cannot name is shown by id, never hidden or renamed.
    expect(
      host.container.querySelector('[data-testid="ai-alert-some_future_rule"]')?.textContent ?? "",
    ).toContain("some_future_rule");

    // The daemon checked and found nothing ⇒ no alert UI at all (not even a banner
    // claiming everything is fine).
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => (cmd === "get_status" ? { engine: "mock", alerts: { alerts: [] } } : null),
      listen: async () => () => {},
    };
    const host2 = render(AiPage);
    // Wait for the status to land (the breaker/log blocks are absent in this reply).
    await vi.waitFor(() => expect(host2.container.querySelector('[data-testid="ai-env"]')).toBeTruthy());
    expect(host2.container.querySelector('[data-testid="ai-alerts"]')).toBeNull();
  });

  test("re-probes the daemon on a schedule while open (client-side probe)", async () => {
    // Only the interval is faked: Svelte flushes effects on a microtask, so faking
    // that too would stall the component before the first probe.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls: string[] = [];
    try {
      (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => {
          calls.push(cmd);
          return cmd === "get_status"
            ? { engine: "ollama", engine_model: "llama3", degraded: false }
            : null;
        },
        listen: async () => () => {},
      };
      const host = render(AiPage);
      await vi.advanceTimersByTimeAsync(0);
      const first = calls.filter((c) => c === "get_status").length;
      expect(first).toBeGreaterThan(0);
      expect(
        host.container.querySelector('[data-testid="ai-probe"]')?.textContent ?? "",
      ).toContain("上次探测");

      // The page is still open, so the next tick must ask again — the engine
      // snapshot can no longer go stale on screen.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls.filter((c) => c === "get_status").length).toBeGreaterThan(first);
    } finally {
      vi.useRealTimers();
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});

describe("RadioPage — remembered Wi‑Fi + Bluetooth device name", () => {
  const qs = (over: Partial<QuickSettings> = {}): QuickSettings => ({
    wifi: true,
    bluetooth: true,
    airplane: false,
    ...over,
  });

  test("a remembered network is marked Saved (lib/wifi.isSaved)", () => {
    writeStoreValue(WIFI_KEY, { current: null, saved: ["Home-2.4G"], passwords: {} });
    const host = render(RadioPage, { props: { which: "wifi", qs: qs(), onToggle: () => {} } });
    expect(txt(host)).toContain("Home-2.4G");
    expect(txt(host)).toContain("已保存");
  });

  test("renaming this device persists through lib/bluetooth.renameDevice", async () => {
    const host = render(RadioPage, {
      props: { which: "bluetooth", qs: qs(), onToggle: () => {} },
    });
    const input = [...host.container.querySelectorAll("input")].find(
      (i) => i.getAttribute("aria-label") === "重命名本机",
    ) as HTMLInputElement | undefined;
    expect(input).toBeTruthy();
    await fireEvent.change(input as HTMLInputElement, { target: { value: "  My Phone  " } });
    // Trimmed by the domain helper and persisted to amos.bluetooth.
    expect(readStoreValue<{ name?: string }>(BT_KEY, {}).name).toBe("My Phone");
  });
});

describe("RadioPage — Bluetooth device facts vs the offline preference (REQ-A199)", () => {
  const qs = (over: Partial<QuickSettings> = {}): QuickSettings => ({
    wifi: false,
    bluetooth: true,
    airplane: false,
    ...over,
  });
  const btNameInput = (host: { container: HTMLElement }) =>
    host.container.querySelector('[data-testid="bt-name"]') as HTMLInputElement;
  const btStore = () =>
    readStoreValue<{ name?: string; paired?: Array<{ id: string }> }>(BT_KEY, {});

  /** Fake Bluetooth bridge: adapter name + paired devices + a rename the platform may
   *  truncate, answer empty for anything else. */
  function installBtBridge(opts: {
    name: string | null;
    peers: Array<{ address: string; name: string }> | null;
    rename?: (n: string) => string | null;
  }) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "bluetooth_adapter_name") return opts.name;
        if (cmd === "bluetooth_paired_devices") return opts.peers;
        if (cmd === "bluetooth_rename_adapter") {
          const out = opts.rename ? opts.rename(String(args?.name ?? "")) : String(args?.name ?? "");
          if (out === null) throw new Error("the platform refused");
          return out;
        }
        if (cmd === "radio_status") {
          return { wifi: false, bluetooth: true, airplane: false, hotspot: false };
        }
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("offline: pairing a demo device is remembered, and unpairing forgets it", async () => {
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    // No bridge → the demo neighbourhood is offered, with the honest note.
    expect(txt(host)).toContain("AirPods Pro");
    expect(txt(host)).toContain("演示列表");
    expect(host.container.querySelector('[data-testid="bt-device-note"]')).toBeNull();

    await fireEvent.click(
      host.container.querySelector('button[aria-label="配对 AirPods Pro"]') as HTMLButtonElement,
    );
    expect(btStore().paired?.map((d) => d.id)).toEqual(["airpods"]);
    // The same row now offers unpairing.
    expect(host.container.querySelector('button[aria-label="取消配对 AirPods Pro"]')).toBeTruthy();

    await fireEvent.click(
      host.container.querySelector('button[aria-label="取消配对 AirPods Pro"]') as HTMLButtonElement,
    );
    expect(btStore().paired).toEqual([]);
  });

  test("device mode: the adapter's name and its paired devices win, read-only", async () => {
    const calls = installBtBridge({
      name: "S5-BT",
      peers: [
        { address: "AA:BB:CC:DD:EE:FF", name: "Buds" },
        { address: "AA:BB:CC:DD:EE:01", name: "" },
      ],
    });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });

    await vi.waitFor(() => expect(btNameInput(host).value).toBe("S5-BT"));
    expect(calls.map((c) => c.cmd)).toContain("bluetooth_paired_devices");
    // The adapter's rows replace the demo list — a real adapter must not be shown a
    // fabricated neighbourhood.
    expect(txt(host)).toContain("Buds");
    expect(txt(host)).toContain("AA:BB:CC:DD:EE:FF");
    // A device the platform never named is **labelled by its address**, not left blank
    // (the address also shows on the right of the row, so this checks the row's label).
    const labels = [...host.container.querySelectorAll('[data-testid="bt-peer-name"]')].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Buds", "AA:BB:CC:DD:EE:01"]);
    expect(txt(host)).not.toContain("AirPods Pro");
    // The adapter's rows replace the demo list — a real adapter must not be shown a
    // fabricated neighbourhood. (The 附近设备 *header* now belongs to the real scan
    // section, REQ-A200, so the check is on the demo rows and their note.)
    expect(txt(host)).not.toContain("AirPods Pro");
    expect(txt(host)).not.toContain("演示列表");
    expect(txt(host)).not.toContain("未配对");
    // Unpairing is a platform limit, not a hidden feature: the rows are read-only and
    // the screen says why.
    expect(host.container.querySelector('[data-testid="bt-device-note"]')).toBeTruthy();
    expect(host.container.querySelector('button[aria-label="取消配对 Buds"]')).toBeNull();
    // And the discoverability hint switches from "demo" to the real limitation.
    expect(txt(host)).not.toContain("演示列表");
  });

  test("device mode: a rename reaches the adapter and the store mirrors ITS answer", async () => {
    // The platform truncates to two characters — what it reports back is the truth.
    const calls = installBtBridge({ name: "S5-BT", peers: [], rename: (n) => n.slice(0, 2) });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("S5-BT"));

    await fireEvent.change(btNameInput(host), { target: { value: "Long Name" } });
    await vi.waitFor(() => {
      expect(
        calls.some(
          (c) => c.cmd === "bluetooth_rename_adapter" && c.args?.name === "Long Name",
        ),
      ).toBe(true);
    });
    // The input and the remembered name both show what the ADAPTER reports, not what we
    // asked for.
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("Lo"));
    expect(btStore().name).toBe("Lo");
  });

  test("device mode: a refused rename is visible and nothing claims it landed", async () => {
    installBtBridge({ name: "S5-BT", peers: [], rename: () => null });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("S5-BT"));

    await fireEvent.change(btNameInput(host), { target: { value: "New Name" } });
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="bt-rename-error"]')).toBeTruthy(),
    );
    // The field snaps back to the adapter's name and the store keeps no new name: the
    // rejected value cannot look applied anywhere.
    expect(btNameInput(host).value).toBe("S5-BT");
    expect(btStore().name).toBeUndefined();
  });
});

describe("RadioPage — Bluetooth discovery (REQ-A200)", () => {
  const qs = (over: Partial<QuickSettings> = {}): QuickSettings => ({
    wifi: false,
    bluetooth: true,
    airplane: false,
    ...over,
  });
  type Scan = {
    discovering: boolean;
    classic: boolean;
    le: boolean;
    capped: boolean;
    scan_allowed: boolean;
    devices: Array<{ address: string; name: string; rssi: number | null; bond: number; le: boolean }>;
    bonds: Array<{ address: string; state: number }>;
  };
  const emptyScan = (over: Partial<Scan> = {}): Scan => ({
    discovering: false,
    classic: false,
    le: false,
    capped: false,
    scan_allowed: true,
    devices: [],
    bonds: [],
    ...over,
  });

  /** Fake bridge: device facts + a scan the test drives step by step. */
  function installScanBridge(opts: {
    scan: () => Scan | "unavailable";
    startScan?: () => boolean;
    pair?: (address: string) => boolean;
  }) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "bluetooth_adapter_name":
            return "A17Pro";
          case "bluetooth_paired_devices":
            return [];
          case "bluetooth_start_scan":
            if (opts.startScan && !opts.startScan()) throw new Error("refused");
            return true;
          case "bluetooth_stop_scan":
            return true;
          case "bluetooth_scan_state": {
            const s = opts.scan();
            if (s === "unavailable") throw new Error("no glue");
            return s;
          }
          case "bluetooth_pair":
            if (opts.pair && !opts.pair(String(args?.address ?? ""))) {
              throw new Error("refused");
            }
            return true;
          case "radio_status":
            return { wifi: false, bluetooth: true, airplane: false, hotspot: false };
          default:
            return null;
        }
      },
      listen: async () => () => {},
    };
    return calls;
  }

  const btNameInput = (host: { container: HTMLElement }) =>
    host.container.querySelector('[data-testid="bt-name"]') as HTMLInputElement;
  const scanNames = (host: { container: HTMLElement }) =>
    [...host.container.querySelectorAll('[data-testid="bt-scan-name"]')].map((e) => e.textContent);

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("scan → result rows → pairing asks for the address, then says to confirm", async () => {
    // The device's state before/after the search — the button, the empty-state wording
    // and the rows all follow from it, so the test models it rather than assuming.
    const state: Scan = emptyScan();
    const calls = installScanBridge({
      scan: () => ({ ...state }),
      startScan: () => {
        state.discovering = true;
        state.classic = true;
        state.le = true;
        state.devices = [
          { address: "AA:BB:CC:DD:EE:FF", name: "Buds", rssi: -55, bond: 10, le: true },
        ];
        return true;
      },
    });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("A17Pro"));
    // Nothing has been searched yet: the hint — not "no devices found", and not
    // "searching", because no scan is running.
    expect(txt(host)).toContain("点击「搜索」查找附近设备");
    expect(txt(host)).not.toContain("未搜索到设备");

    await fireEvent.click(
      host.container.querySelector('button[aria-label="搜索"]') as HTMLButtonElement,
    );
    await vi.waitFor(() => expect(scanNames(host)).toEqual(["Buds"]));

    await fireEvent.click(
      host.container.querySelector('button[aria-label="配对 Buds"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="bt-pair-note"]')).toBeTruthy(),
    );
    // The pairing request carries the *address*, never the label.
    expect(calls.find((c) => c.cmd === "bluetooth_pair")?.args).toEqual({
      address: "AA:BB:CC:DD:EE:FF",
    });
  });

  test("a refused scan start is visible and no devices are claimed", async () => {
    installScanBridge({ scan: () => emptyScan(), startScan: () => false });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("A17Pro"));

    await fireEvent.click(
      host.container.querySelector('button[aria-label="搜索"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="bt-scan-error"]')?.textContent).toContain(
        "无法开始搜索",
      ),
    );
    expect(scanNames(host)).toEqual([]);
  });

  test("missing BLUETOOTH_SCAN is reported as 'may not scan', not as 'nothing found'", async () => {
    installScanBridge({ scan: () => emptyScan({ scan_allowed: false }) });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="bt-scan-denied"]')).toBeTruthy(),
    );
    expect(txt(host)).toContain("BLUETOOTH_SCAN");
    expect(txt(host)).not.toContain("未搜索到设备");
  });

  test("a capped result list is shown as incomplete", async () => {
    const state: Scan = emptyScan({ capped: true });
    installScanBridge({
      scan: () => ({ ...state }),
      // The scan ends (the platform caps it) but the results and the cap flag stay.
      startScan: () => {
        state.devices = [{ address: "AA:BB", name: "Root", rssi: -70, bond: 10, le: false }];
        return true;
      },
    });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("A17Pro"));
    await fireEvent.click(
      host.container.querySelector('button[aria-label="搜索"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="bt-scan-capped"]')).toBeTruthy(),
    );
    expect(txt(host)).toContain("可能不完整");
  });

  test("leaving the page cancels a running scan", async () => {
    const state: Scan = emptyScan();
    const calls = installScanBridge({
      scan: () => ({ ...state }),
      startScan: () => {
        state.discovering = true;
        return true;
      },
    });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("A17Pro"));
    await fireEvent.click(
      host.container.querySelector('button[aria-label="搜索"]') as HTMLButtonElement,
    );
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === "bluetooth_scan_state")).toBe(true));
    calls.length = 0;
    // Unmounting is what leaving the Bluetooth page does — the scan must not be left
    // running (it costs battery, and the platform would end it silently later).
    host.unmount();
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === "bluetooth_stop_scan")).toBe(true));
  });

  test("a start that is accepted keeps polling even if the first read still says 'not discovering'", async () => {
    // Device-observed race (REQ-A200, S5): starting discovery is asynchronous, so the
    // read taken right after an accepted start can still report `discovering: false`.
    // Believing it stopped the poll and the devices the scan DID find never rendered.
    let polls = 0;
    installScanBridge({
      scan: () => {
        polls += 1;
        // First read (right after the start): the platform has not caught up yet.
        if (polls === 1) return emptyScan({ discovering: false, devices: [] });
        return emptyScan({
          discovering: true,
          devices: [{ address: "43:20:81:5D:7B:C1", name: "midea", rssi: -57, bond: 10, le: false }],
        });
      },
    });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("A17Pro"));
    await fireEvent.click(
      host.container.querySelector('button[aria-label="搜索"]') as HTMLButtonElement,
    );
    // The list must arrive on a later poll even though the first read said "stopped".
    await vi.waitFor(() => expect(scanNames(host)).toEqual(["midea"]), { timeout: 5000 });
    expect(txt(host)).not.toContain("未搜索到设备");
  });

  test("the searched transports are stated, and LE rows carry a tag", async () => {
    // "No devices" on a channel nobody scanned is a different answer, so the screen says
    // which transports were searched — and marks the rows that answered over LE
    // (REQ-A201).
    const state: Scan = emptyScan();
    installScanBridge({
      scan: () => ({ ...state }),
      startScan: () => {
        state.discovering = true;
        state.classic = true;
        state.le = true;
        state.devices = [
          { address: "AA:BB", name: "Buds", rssi: -50, bond: 10, le: true },
          { address: "CC:DD", name: "Headset", rssi: -70, bond: 10, le: false },
        ];
        return true;
      },
    });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("A17Pro"));
    // Nothing searched yet: no claim about transports.
    expect(host.container.querySelector('[data-testid="bt-scan-transports"]')).toBeNull();

    await fireEvent.click(
      host.container.querySelector('button[aria-label="搜索"]') as HTMLButtonElement,
    );
    await vi.waitFor(() => expect(scanNames(host)).toEqual(["Buds", "Headset"]), { timeout: 5000 });
    expect(
      host.container.querySelector('[data-testid="bt-scan-transports"]')?.textContent,
    ).toContain("经典蓝牙 + 蓝牙 LE");
    // Only the LE-heard device carries the tag — the classic-only row must not.
    expect(host.container.querySelectorAll('[data-testid="bt-le-tag"]').length).toBe(1);
  });

  test("an LE scan that never started is reported as 'classic only', not as 'no devices'", async () => {
    const state: Scan = emptyScan();
    installScanBridge({
      scan: () => ({ ...state }),
      startScan: () => {
        state.discovering = true;
        state.classic = true;
        state.le = false; // the glue could not start the LE half
        return true;
      },
    });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("A17Pro"));
    await fireEvent.click(
      host.container.querySelector('button[aria-label="搜索"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(
        host.container.querySelector('[data-testid="bt-scan-transports"]')?.textContent,
      ).toContain("仅经典蓝牙"),
    );
  });

  test("pairing progress comes from the device's bond state, not from 'the request was sent'", async () => {
    // Device-observed sequence (REQ-A201): a pair request the framework accepts goes to
    // BOND_BONDING and then either to BOND_BONDED or back to BOND_NONE. The first version
    // of this screen said nothing at all, so a request in flight was indistinguishable
    // from a dead button.
    const state: Scan = emptyScan();
    const calls = installScanBridge({
      scan: () => ({ ...state }),
      startScan: () => {
        state.discovering = true;
        state.classic = true;
        state.devices = [{ address: "11:22", name: "Peer", rssi: -60, bond: 10, le: false }];
        return true;
      },
      pair: () => {
        // The platform accepted the request: it now runs the pairing flow. The first glue
        // read still has no transition (the framework has not broadcast yet)…
        state.bonds = [];
        return true;
      },
    });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("A17Pro"));
    await fireEvent.click(
      host.container.querySelector('button[aria-label="搜索"]') as HTMLButtonElement,
    );
    await vi.waitFor(() => expect(scanNames(host)).toEqual(["Peer"]), { timeout: 5000 });

    await fireEvent.click(
      host.container.querySelector('button[aria-label="配对 Peer"]') as HTMLButtonElement,
    );
    // …the note says exactly that: the request is out and the device decides the outcome.
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="bt-pair-note"]')?.textContent).toContain(
        "以设备为准",
      ),
    );

    // …then the device reports the transition, and the screen follows it.
    state.bonds = [{ address: "11:22", state: 11 }];
    state.devices = [{ address: "11:22", name: "Peer", rssi: -60, bond: 11, le: false }];
    await vi.waitFor(
      () =>
        expect(host.container.querySelector('[data-testid="bt-pair-note"]')?.textContent).toContain(
          "配对中",
        ),
      { timeout: 5000 },
    );
    // While pairing is in flight the row offers no "pair" button (the device state does
    // not allow it) and shows the progress tag instead.
    expect(host.container.querySelector('[data-testid="bt-bonding-tag"]')).toBeTruthy();
    expect(host.container.querySelector('button[aria-label="配对 Peer"]')).toBeNull();

    // The pairing completes: the note says so, and the authoritative paired list is
    // re-read so "My Devices" cannot keep showing the old (empty) answer.
    calls.length = 0;
    state.bonds = [{ address: "11:22", state: 12 }];
    state.devices = [{ address: "11:22", name: "Peer", rssi: -60, bond: 12, le: false }];
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="bt-pair-note"]')?.textContent).toContain(
        "配对完成",
      ),
      { timeout: 5000 },
    );
    expect(calls.some((c) => c.cmd === "bluetooth_paired_devices")).toBe(true);
  });

  test("the demo neighbourhood is not shown when a real adapter answers", async () => {
    installScanBridge({ scan: () => emptyScan() });
    const host = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() => expect(btNameInput(host).value).toBe("A17Pro"));
    expect(txt(host)).not.toContain("AirPods Pro");
    expect(txt(host)).not.toContain("演示列表");
  });
});

describe("PrivacyPage — system media access", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  /** Fake media bridge; `grants` is mutated in place by a revoke. */
  function installMediaBridge(opts: { grants: Array<{ access: string; collection: string }> }) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "media_provider_name") return "mock";
        if (cmd === "media_available_collections") return ["camera", "pictures", "download"];
        if (cmd === "media_grants") return opts.grants;
        if (cmd === "media_revoke") {
          const i = opts.grants.findIndex(
            (g) => g.access === args?.access && g.collection === args?.collection,
          );
          if (i >= 0) opts.grants.splice(i, 1);
          return null;
        }
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  test("shows the real grants + backend, and a revoke reaches the bridge", async () => {
    const grants = [{ access: "read", collection: "camera" }];
    const calls = installMediaBridge({ grants });
    const host = render(SettingsApp);
    await navigate(host, "隐私与安全性");
    await vi.waitFor(() => {
      expect(txt(host)).toContain("系统媒体访问");
    });
    // The canonical path is shown (not the raw wire key) and the backend is named.
    expect(txt(host)).toContain("DCIM/Camera");
    expect(txt(host)).toContain("mock");
    expect(txt(host)).toContain("可用集合 3");

    const chip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") ?? "").startsWith("DCIM/Camera"),
    );
    expect(chip).toBeTruthy();
    await fireEvent.click(chip as HTMLButtonElement);
    await vi.waitFor(() => {
      const revoke = calls.find((c) => c.cmd === "media_revoke");
      expect(revoke?.args).toEqual({ access: "read", collection: "camera" });
    });
    // The list re-reads the bridge instead of assuming the revoke took.
    await vi.waitFor(() => {
      expect(txt(host)).toContain("尚未授予任何媒体访问");
    });
  });

  test("an answered bridge with no grants says so (not 'unavailable')", async () => {
    installMediaBridge({ grants: [] });
    const host = render(SettingsApp);
    await navigate(host, "隐私与安全性");
    await vi.waitFor(() => {
      expect(txt(host)).toContain("尚未授予任何媒体访问");
    });
    expect(txt(host)).not.toContain("无法读取媒体访问状态");
  });

  test("no section at all when the media bridge cannot answer", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const host = render(SettingsApp);
    await navigate(host, "隐私与安全性");
    await new Promise<void>((r) => setTimeout(r, 0));
    // Never claim "no media access" when we simply could not ask.
    expect(txt(host)).not.toContain("系统媒体访问");
    expect(txt(host)).not.toContain("尚未授予任何媒体访问");
  });
});

describe("显示与亮度: why the screen is held awake (lib/keepAwakeCore)", () => {
  /** Seed an auto-off timeout and open the display page. */
  async function openDisplay(autoOffSec: number) {
    writeStoreValue(AUTOOFF_STORE_KEY, autoOffSec);
    const host = render(SettingsApp);
    await navigate(host, "显示与亮度");
    return host;
  }
  const readout = (h: { container: HTMLElement }) =>
    h.container.querySelector('[data-testid="keep-awake"]') as HTMLElement | null;

  test("with a timeout set and nothing holding, it says the screen will sleep", async () => {
    const host = await openDisplay(30);
    expect(readout(host)?.textContent ?? "").toContain("无 · 屏幕将按上方时间熄屏");
  });

  test("a live hold shows its localized reason and clears when released", async () => {
    const host = await openDisplay(30);
    assertHold("call");
    await vi.waitFor(() => expect(readout(host)?.textContent ?? "").toContain("通话中"));
    assertHold("video");
    await vi.waitFor(() => {
      const s = readout(host)?.textContent ?? "";
      expect(s).toContain("通话中");
      expect(s).toContain("视频播放中");
    });
    releaseHold("video");
    releaseHold("call");
    await vi.waitFor(() => expect(readout(host)?.textContent ?? "").toContain("无 ·"));
  });

  test("an unknown hold reason shows its raw key instead of vanishing", async () => {
    const host = await openDisplay(30);
    assertHold("nav");
    // A reason we have no translation for must never be silently dropped.
    await vi.waitFor(() => expect(readout(host)?.textContent ?? "").toContain("nav"));
  });

  test("nothing is rendered while auto screen-off is off", async () => {
    const host = await openDisplay(0);
    assertHold("call");
    await new Promise<void>((r) => setTimeout(r, 0));
    // No timeout ⇒ the readout would explain nothing.
    expect(readout(host)).toBeNull();
  });
});

describe("AiPage — client diagnostics ledger (audit P1-3)", () => {
  beforeEach(() => {
    clearDiag();
    setDiagMinLevel("info");
  });
  afterEach(() => {
    clearDiag();
    setDiagMinLevel("info");
  });

  test("shows recent client failures together with what the ring dropped", async () => {
    amosWarn("backend", "get_status failed");
    setDiagMinLevel("warn");
    amosLog("backend", "info-noise"); // info < warn ⇒ suppressed, never recorded
    const s = diagStats(); // captured after our emissions: counters are module-wide
    const host = render(AiPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="ai-diag-item"]')).toBeTruthy(),
    );

    const items = [...host.container.querySelectorAll('[data-testid="ai-diag-item"]')].map(
      (el) => el.textContent ?? "",
    );
    expect(items.some((t) => t.includes("get_status failed"))).toBe(true);
    expect(items.some((t) => t.includes("info-noise"))).toBe(false);

    // The counts line states the honest bookkeeping — a 1-row list is not "all of it".
    const counts = host.container.querySelector('[data-testid="ai-diag-counts"]')?.textContent ?? "";
    expect(counts).toContain(`保留 ${s.recorded}/${s.cap}`);
    expect(counts).toContain(`级别过滤 ${s.suppressed}`);
    expect(s.suppressed).toBeGreaterThan(0);
  });

  test("clearing empties the list but never hides the drop counters", async () => {
    amosWarn("backend", "something failed");
    setDiagMinLevel("warn");
    amosLog("backend", "suppressed-one"); // filtered by the level, not by the ring
    const s = diagStats();
    const host = render(AiPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="ai-diag-item"]')).toBeTruthy(),
    );

    await fireEvent.click(
      host.container.querySelector('[data-testid="ai-diag-clear"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="ai-diag-empty"]')).toBeTruthy(),
    );
    expect(host.container.querySelector('[data-testid="ai-diag-item"]')).toBeNull();
    // Clearing the list does not erase the fact that entries were filtered out.
    const counts = host.container.querySelector('[data-testid="ai-diag-counts"]')?.textContent ?? "";
    expect(counts).toContain("保留 0/" + s.cap);
    expect(counts).toContain(`级别过滤 ${s.suppressed}`);
  });

  test("the level selector really changes the policy (and persists it)", async () => {
    const host = render(AiPage);
    const select = (await vi.waitFor(() => {
      const el = host.container.querySelector(
        '[data-testid="ai-diag-level"]',
      ) as HTMLSelectElement | null;
      expect(el).toBeTruthy();
      return el!;
    })) as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: "warn" } });
    expect(diagStats().minLevel).toBe("warn");
    // The choice is persisted, so a reload keeps the quieter policy.
    expect(window.localStorage.getItem("amos.debug.level")).toBe("warn");

    // …and an info-level entry is now filtered out instead of recorded.
    amosLog("backend", "info-after-warn");
    expect(recentDiag(1).some((e) => e.msg === "info-after-warn")).toBe(false);
    expect(diagStats().suppressed).toBeGreaterThan(0);
  });
});

describe("RadioPage — a switch the platform owns (REQ-A202)", () => {
  const qs = (): QuickSettings => ({
    wifi: false,
    bluetooth: false,
    airplane: false,
    hotspot: false,
  });

  /** Fake bridge: `radio_control` says whether this app may switch the radio. */
  function installBridge(opts: { managed: boolean; openOk?: boolean }) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "radio_control":
            return {
              radio: String(args?.key ?? ""),
              app_controlled: !opts.managed,
              surface: opts.managed ? "wifi_panel" : null,
              reason: opts.managed ? "switch_removed" : null,
            };
          case "radio_open_settings":
            return opts.openOk ?? true;
          case "radio_status":
            return { wifi: false, bluetooth: false, airplane: false, hotspot: false };
          case "bluetooth_adapter_name":
            return "A17Pro";
          case "bluetooth_paired_devices":
            return [];
          default:
            return null;
        }
      },
      listen: async () => () => {},
    };
    return calls;
  }

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("the master switch states the platform's ownership and offers the system settings screen", async () => {
    const calls = installBridge({ managed: true });
    const host = render(RadioPage, { props: { which: "wifi", qs: qs(), onToggle: () => {} } });
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="radio-managed-note"]')).toBeTruthy(),
    );
    // The sentence names THIS radio's platform limit (they differ per radio).
    expect(txt(host)).toContain(zh["radio.managed.wifi"]);
    // The switch still shows the device's real state, but is not operable from here:
    // tapping it would be a write no app may make.
    const sw = switchByLabel(host, zh["settings.wifi"]) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);

    calls.length = 0;
    await fireEvent.click(
      host.container.querySelector('[data-testid="radio-open-settings"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(calls.find((c) => c.cmd === "radio_open_settings")?.args).toEqual({ key: "wifi" }),
    );
    expect(
      calls.some((c) => c.cmd === "radio_set"),
      "the page must not attempt a write the platform forbids",
    ).toBe(false);
  });

  test("a system surface that will not open is reported on the page", async () => {
    installBridge({ managed: true, openOk: false });
    const host = render(RadioPage, {
      props: { which: "bluetooth", qs: qs(), onToggle: () => {} },
    });
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="radio-open-settings"]')).toBeTruthy(),
    );
    await fireEvent.click(
      host.container.querySelector('[data-testid="radio-open-settings"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(
        host.container.querySelector('[data-testid="radio-open-failed"]')?.textContent,
      ).toContain(zh["radio.openSettingsFailed"]),
    );
  });

  test("an app-controlled switch is untouched: no note, and the toggle is the app's", async () => {
    const calls = installBridge({ managed: false });
    const toggled: string[] = [];
    const host = render(RadioPage, {
      props: { which: "wifi", qs: qs(), onToggle: (k) => toggled.push(k) },
    });
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === "radio_control")).toBe(true));
    expect(host.container.querySelector('[data-testid="radio-managed-note"]')).toBeNull();
    const sw = switchByLabel(host, zh["settings.wifi"]) as HTMLButtonElement;
    expect(sw.disabled).toBe(false);
    await fireEvent.click(sw);
    expect(toggled).toEqual(["wifi"]);
    expect(calls.some((c) => c.cmd === "radio_open_settings")).toBe(false);
  });

  test("a refused write is stated next to the switch (REQ-A203)", async () => {
    // The structured `radio_set` answer reached SettingsApp, which passes the coerced
    // refusal down: the sentence must sit by the switch that did not move.
    installBridge({ managed: false });
    const host = render(RadioPage, {
      props: {
        which: "wifi",
        qs: qs(),
        onToggle: () => {},
        refusal: { noteKey: "radio.refused.device", surface: null },
      },
    });
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="radio-refused"]')?.textContent).toContain(
        zh["radio.refused.device"],
      ),
    );
    // The refusal named no surface, so no way out is offered — none is invented.
    expect(host.container.querySelector('[data-testid="radio-refused-open-settings"]')).toBeNull();
  });

  test("a refusal that names a surface offers the real switch (REQ-A203)", async () => {
    const calls = installBridge({ managed: false });
    const host = render(RadioPage, {
      props: {
        which: "wifi",
        qs: qs(),
        onToggle: () => {},
        refusal: { noteKey: "radio.managed.wifi", surface: "wifi_panel" },
      },
    });
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="radio-refused"]')).toBeTruthy(),
    );
    await fireEvent.click(
      host.container.querySelector('[data-testid="radio-refused-open-settings"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(calls.find((c) => c.cmd === "radio_open_settings")?.args).toEqual({ key: "wifi" }),
    );
  });

  test("a refusal nobody understands still says something was refused (REQ-A203)", async () => {
    // The reason may not be invented, but "the tap did nothing" is itself a fact the
    // screen owes the user.
    const host = render(RadioPage, {
      props: {
        which: "bluetooth",
        qs: qs(),
        onToggle: () => {},
        refusal: { noteKey: "", surface: null },
      },
    });
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="radio-refused"]')?.textContent).toContain(
        zh["radio.refused.unknown"],
      ),
    );
  });
});

