/**
 * DOM tests for the four Settings sub pages that had no direct test (REQ-A149):
 * 专注模式 (FocusPage), 锁屏密码 (LockPage), 系统监控 (DiagnosticsPage) and 壁纸
 * (WallpaperPage).
 *
 * Reading LockPage in order to test it found the page reporting "Saved" for an enable the
 * passcode policy had just *refused*: its condition was `lockOn && !next.enabled` **after**
 * `lockOn = next.enabled`, so the `lock.pin` branch was dead code. These tests pin the
 * honest message (a refused enable is not a save) instead of the old behaviour.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import FocusPage from "../src/svelte/settings/FocusPage.svelte";
import LockPage from "../src/svelte/settings/LockPage.svelte";
import DiagnosticsPage from "../src/svelte/settings/DiagnosticsPage.svelte";
import SensorPanel from "../src/svelte/SensorPanel.svelte";
import WallpaperPage from "../src/svelte/settings/WallpaperPage.svelte";
import { t } from "../src/svelte/locale.svelte";
import { FOCUS_KEY } from "../src/lib/focusPrefs";
import { SETTINGS_KEY } from "../src/lib/settings";
import { LOCK_KEY } from "../src/lib/lock";
import { CORRUPT_SUFFIX } from "../src/lib/amosStore";
import { controlByName } from "./a11y-name";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/** The label of the mode button the panel currently marks `aria-pressed` — the only place
 *  the live `snap.mode` reaches the screen (the three labels themselves are static). */
const pressedMode = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-pressed") === "true",
  )?.textContent?.trim() ?? "";
/** Read the raw stored JSON (not through the module under test). */
const stored = (key: string) => JSON.parse(window.localStorage.getItem(key) ?? "null");
const saveButton = (h: { getByRole: (r: string, o?: unknown) => HTMLElement }) =>
  h.getByRole("button", { name: t("lock.save") });

describe("FocusPage.svelte", () => {
  test("shows the real DND switch plus one per intent scenario, all off by default, and states its honest scope", () => {
    const host = render(FocusPage);
    // Select the intent page's switches by **name**, not by index/count: the schedule
    // editor rendered below it (REQ-A684) adds its own, distinctly-named switches for
    // the same scenarios — a count would make this test a false alarm on that change.
    const byName = (n: string) =>
      controlByName<HTMLElement>(host.container, '[role="switch"]', n);
    const intent = [
      byName(t("settings.focusDnd")),
      byName(t("settings.focusWork")),
      byName(t("settings.focusSleep")),
    ];
    expect(intent.every(Boolean)).toBe(true);
    expect(intent.map((s) => s?.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "false",
    ]);
    expect(txt(host)).toContain(t("settings.focusDnd"));
    expect(txt(host)).toContain(t("settings.focusWork"));
    expect(txt(host)).toContain(t("settings.focusSleep"));
    // The page says which switch is real and that the intents silence nothing.
    expect(txt(host)).toContain(t("settings.focusHint"));
  });

  test("the 勿扰 switch writes the quick-settings bit the shell honours — NOT the intent ledger (REQ-A206)", async () => {
    const host = render(FocusPage);
    await fireEvent.click(host.getAllByRole("switch")[0]); // 勿扰

    expect(host.getAllByRole("switch")[0].getAttribute("aria-checked")).toBe("true");
    // The same amos.settings.dnd key `lib/settings.dndActive` (banner, control
    // center, 通知 page) reads — the write path IS the silencing path.
    expect(stored(SETTINGS_KEY)).toMatchObject({ dnd: true });
    // And the intent ledger is untouched by the DND switch.
    expect(stored(FOCUS_KEY)).toBeNull();
  });

  test("a pre-existing real DND bit renders the switch on", () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ dnd: true }));
    const host = render(FocusPage);
    expect(host.getAllByRole("switch")[0].getAttribute("aria-checked")).toBe("true");
  });

  test("toggling an intent scenario flips the switch and persists durably", async () => {
    const host = render(FocusPage);
    await fireEvent.click(host.getAllByRole("switch")[1]); // work

    expect(host.getAllByRole("switch")[1].getAttribute("aria-checked")).toBe("true");
    expect(stored(FOCUS_KEY)).toMatchObject({ work: true, sleep: false });
    // The intent switch must not touch the real DND bit.
    expect(stored(SETTINGS_KEY)?.dnd).toBeUndefined();
  });

  test("garbage in the store is normalized instead of rendered as truth", () => {
    window.localStorage.setItem(FOCUS_KEY, JSON.stringify({ dnd: "yes", work: 1, sleep: true }));
    const host = render(FocusPage);
    const intent = [
      t("settings.focusDnd"),
      t("settings.focusWork"),
      t("settings.focusSleep"),
    ].map((n) => controlByName<HTMLElement>(host.container, '[role="switch"]', n));
    expect(intent.map((s) => s?.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);
  });
});


describe("LockPage.svelte", () => {
  test("enabling without a passcode is refused and does NOT claim a save", async () => {
    const host = render(LockPage);
    await fireEvent.click(host.getByRole("switch")); // ask to enable
    await tick();
    await fireEvent.click(saveButton(host)); // …with an empty passcode
    await tick();

    // The message the user must see is the policy, not "Saved" (the pre-REQ-A149 bug).
    expect(txt(host)).toContain(t("lock.pin"));
    expect(txt(host)).not.toContain(t("lock.saved"));
    // …and nothing was enabled: not in the store, not on the switch.
    expect(stored(LOCK_KEY)).toMatchObject({ enabled: false });
    expect(host.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  test("a valid passcode enables the lock and is persisted", async () => {
    const host = render(LockPage);
    await fireEvent.click(host.getByRole("switch"));
    await tick();
    const input = host.getByPlaceholderText(t("lock.pin")) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "1234" } });
    await fireEvent.click(saveButton(host));
    await tick();

    expect(stored(LOCK_KEY)).toMatchObject({ enabled: true, pin: "1234" });
    expect(txt(host)).toContain(t("lock.saved"));
    expect(txt(host)).toContain(t("lock.stateOn"));
    expect(host.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  test("the passcode field keeps digits only, capped at 6", async () => {
    const host = render(LockPage);
    await fireEvent.click(host.getByRole("switch"));
    await tick();
    const input = host.getByPlaceholderText(t("lock.pin")) as HTMLInputElement;

    await fireEvent.input(input, { target: { value: "12ab-345678" } });
    await tick();
    await tick();
    expect(input.value).toBe("123456");
  });

  test("a changed passcode that breaks the policy is refused, and says so", async () => {
    window.localStorage.setItem(LOCK_KEY, JSON.stringify({ enabled: true, pin: "1234" }));
    const host = render(LockPage);
    await tick();
    const input = host.getByPlaceholderText(t("lock.pin")) as HTMLInputElement;

    await fireEvent.input(input, { target: { value: "12" } }); // too short
    await fireEvent.click(saveButton(host));
    await tick();

    expect(txt(host)).toContain(t("lock.pin"));
    expect(txt(host)).not.toContain(t("lock.saved"));
    // The previous passcode is kept — the page must not imply the new digits took.
    expect(stored(LOCK_KEY)).toMatchObject({ enabled: true, pin: "1234" });
  });

  test("a rejected store write is reported as a failure, never as saved", async () => {
    const host = render(LockPage);
    await fireEvent.click(host.getByRole("switch"));
    await tick();
    const input = host.getByPlaceholderText(t("lock.pin")) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "1234" } });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    await fireEvent.click(saveButton(host));
    await tick();

    expect(txt(host)).toContain(t("lock.saveFailed"));
    expect(txt(host)).not.toContain(t("lock.saved"));
  });
});

describe("DiagnosticsPage.svelte", () => {
  const settle = () => new Promise((r) => setTimeout(r, 60));

  test("offline it is still a usable page (the panels that need no daemon render)", async () => {
    const host = render(DiagnosticsPage);
    await settle(); // the panels probe the (absent) bridge
    // LmkDebugPanel always renders, with a graceful offline line …
    expect(txt(host)).toContain(t("lmk.title"));
    // …and QuarantinePanel's contract is to be *absent* while nothing was preserved
    // (asserted here so the stack is understood, not just present).
    expect(host.container.querySelector('[data-testid="store-quarantine"]')).toBeNull();
  });

  test("a partial sensor snapshot renders unknowns as `—` instead of throwing (REQ-A294)", async () => {
    // `normalizeSnapshot` promises "tolerating absent / partial fields … Never throws", and
    // this page's SensorPanel formats the blocks it returns (`temp_c.toFixed(1)`,
    // `latitude_deg.toFixed(5)`, …). A daemon that sends an imu/gnss block *without* those
    // numbers used to reach the component with `undefined` and throw during render — the
    // promise was in the doc comment, not in the code.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sensor_snapshot") {
          return {
            mode: "balanced",
            cameras: [],
            gnss: { enabled: true, has_fix: true }, // fix claimed, coordinates absent
            imu: { rate_hz: 200 }, // sample rate only: no axes, no temperature
          };
        }
        return null;
      },
      listen: async () => () => {},
    };
    try {
      const host = render(DiagnosticsPage);
      await settle();
      const text = txt(host);
      // Rendered at all (the throw would have failed the mount) …
      expect(text).toContain(t("settings.sensor"));
      // … and every missing reading shows as unknown, never as a fabricated number.
      expect(text).toMatch(/[—]/);
      expect(text).not.toContain("0.0°C");
      expect(text).not.toContain("0.00000");
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  test("an un-negotiated IMU rate renders `@— Hz`, never `@0 Hz` (REQ-A1612)", async () => {
    // The wire's `uint32 rate_hz` writes `0` for "not negotiated yet" (it has no field
    // presence). The panel used to format that as `@0 Hz` — a fabricated rate measurement.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sensor_snapshot") {
          return {
            mode: "balanced",
            cameras: [],
            gnss: null,
            // temp_c present so the sentence renders; rate un-negotiated.
            imu: { rate_hz: 0, temp_c: 36.5 },
          };
        }
        return null;
      },
      listen: async () => () => {},
    };
    try {
      const host = render(DiagnosticsPage);
      await settle();
      const text = txt(host);
      expect(text).not.toContain("@0 Hz");
      expect(text).toContain("@— Hz");
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  test("an unreported accuracy / satellite count renders no `±0m` / `0sats` (REQ-A1623)", async () => {
    // Both GNSS wires are zero-sentinel (`double accuracy_m` / `uint32 sats_in_view` have
    // no field presence): Android's `getAccuracy()` returns `0.0` for a fix with no
    // estimate, and `Location` carries no satellite count, so the producer writes `0` for
    // "not reported". Left unfolded, the fix line read `… · ±0m · 0sats` — a precision and
    // a satellite count the receiver never gave.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sensor_snapshot") {
          return {
            mode: "balanced",
            cameras: [],
            gnss: {
              enabled: true,
              has_fix: true,
              latitude_deg: 31.23,
              longitude_deg: 121.47,
              accuracy_m: 0,
              sats: 0,
              fix_mode: "3d",
            },
            imu: null,
          };
        }
        return null;
      },
      listen: async () => () => {},
    };
    try {
      const host = render(DiagnosticsPage);
      await settle();
      const text = txt(host);
      // The coordinates are real, so the fix line renders — but without the two invented
      // readings the zero-sentinel would have produced.
      expect(text).toContain("31.23000");
      expect(text).not.toContain("±0m");
      expect(text).not.toContain("0sats");
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  test("a real fix keeps its accuracy and satellite count (REQ-A1623, positive control)", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sensor_snapshot") {
          return {
            mode: "balanced",
            cameras: [],
            gnss: {
              enabled: true,
              has_fix: true,
              latitude_deg: 31.23,
              longitude_deg: 121.47,
              accuracy_m: 4.2,
              sats: 9,
              fix_mode: "3d",
            },
            imu: null,
          };
        }
        return null;
      },
      listen: async () => () => {},
    };
    try {
      const host = render(DiagnosticsPage);
      await settle();
      const text = txt(host);
      expect(text).toContain("±4m");
      expect(text).toContain("9sats");
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  test("a preserved corrupt value makes the quarantine panel appear in the stack", async () => {
    window.localStorage.setItem(`amos.notes${CORRUPT_SUFFIX}`, "{ not json");
    const host = render(DiagnosticsPage);
    await settle();
    expect(txt(host)).toContain(t("settings.quarantineTitle"));
    expect(txt(host)).toContain("amos.notes");
  });
});

describe("WallpaperPage.svelte", () => {
  test("stacks both wallpaper pickers", () => {
    const host = render(WallpaperPage);
    expect(txt(host)).toContain(t("wp.label"));
    expect(txt(host)).toContain(t("wp.lockLabel"));
  });
});

/**
 * REQ-A1365 / F-SH-629 — the third leaf of the family fixed on this very page.
 *
 * `SensorPanel` self-hides while it has no data (`{#if visible}`, no `{:else}`) and read the
 * daemon **exactly once**, from the mount-time `$effect`. It had no poll at all, so a refused
 * first read was terminal: `sensor_snapshot` rejecting (`invoke` rejects on a daemon `Err`)
 * left `snap` empty, `visible` false, the card gone — and its 刷新 button is drawn *inside*
 * the hidden branch, so there was nothing left on screen to press. `DiagnosticsPage` stacks
 * it next to `SystemPanel` and `TaskManager`, both of which now keep a reconnect probe armed
 * (REQ-A1356 / REQ-A1364); the sibling one row above it recovers and this one never did.
 */
describe("SensorPanel — a daemon that appears after the first refusal (REQ-A1365)", () => {
  test("the panel comes back while it is still on screen", async () => {
    vi.useFakeTimers();
    try {
      let reply: unknown = null;
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => {
          if (cmd === "sensor_snapshot") {
            if (reply === null) throw new Error("sensor snapshot request failed: connect");
            return reply;
          }
          return null;
        },
        listen: async () => () => {},
      };

      const host = render(SensorPanel);
      await vi.advanceTimersByTimeAsync(0);
      // Refused at mount: the panel hides itself — the documented behaviour, kept.
      expect(host.container.textContent ?? "").toBe("");

      reply = { mode: "performance", cameras: [], gnss: null, imu: null };

      // A hidden panel probes at the *slower* reconnect cadence: still nothing past 3 s…
      await vi.advanceTimersByTimeAsync(3_500);
      await vi.advanceTimersByTimeAsync(0);
      expect(host.container.textContent ?? "").toBe("");

      // …and the probe at 5 s finds the daemon: the card is on screen with no reopen.
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(0);
      expect(txt(host)).toContain(t("settings.sensor"));
      // The three mode labels are static button text, so a `toContain` on them would be
      // unfailable — the `aria-pressed` one is the live `snap.mode` reading.
      expect(pressedMode(host)).toBe(t("settings.sensorPerformance"));

      // The other polarity: once there *is* a card it polls at the live cadence, so a new
      // reading lands within 3 s. Swapping the two periods would leave the visible card on
      // the slow probe — the reverse of the design, invisible to the assertions above.
      reply = { mode: "power_save", cameras: [], gnss: null, imu: null };
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(pressedMode(host)).toBe(t("settings.sensorPowerSave"));
    } finally {
      vi.useRealTimers();
    }
  });
});
