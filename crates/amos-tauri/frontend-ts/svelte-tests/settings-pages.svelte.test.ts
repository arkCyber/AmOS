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
    const saved = readStoreValue<SoundPolicy>(SOUND_KEY, { ring: true, vibrate: true });
    expect(saved).toEqual({ ring: false, vibrate: false });
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
      panel!.querySelector('button[aria-label="quarantine-copy"]') as HTMLButtonElement,
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

