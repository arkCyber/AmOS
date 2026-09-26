/**
 * about-page.svelte.test.ts — 「关于本机」honesty: battery shows a real host
 * reading on a `/proc`-less desktop, and the Cellular row states the honest "no
 * cellular service" (no SIM/modem) instead of faking bars or leaving a blank.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AboutPage from "../src/svelte/settings/AboutPage.svelte";
import { clearCellularRadio, setCellularRadio } from "../src/svelte/cellularRadio";
import { zh } from "../src/i18n/locales/zh";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  clearCellularRadio();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = () => new Promise((r) => setTimeout(r, 40));
const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

/** Bridge that records every invoke and answers the OTA probe. */
function installUpdateBridge() {
  const calls: { cmd: string; args: unknown }[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: unknown) => {
      calls.push({ cmd, args });
      if (cmd === "system_health") return { battery_level_pct: 75, battery_charging: false };
      if (cmd === "ota_status") {
        return { current_version: "0.1.0", channel: "stable", configured: true, source: "/tmp/m.json" };
      }
      if (cmd === "ota_check") {
        return {
          kind: "eligible", current_version: "0.1.0", channel: "stable", version: "1.1.0",
          package_uri: "https://example.invalid/os.img", package_bytes: 10,
          reason_code: null, detail: null,
        };
      }
      return null;
    },
    listen: async () => () => {},
  };
  return calls;
}

/** The `on_wifi` fact the page handed the host on its last check. */
function onWifiFact(calls: { cmd: string; args: unknown }[]): unknown {
  const check = calls.find((c) => c.cmd === "ota_check");
  return (check?.args as { onWifi?: unknown } | undefined)?.onWifi;
}

function installBridge(systemHealth: unknown, hostBatteryPayload?: unknown) {
  const invoke = async (cmd: string) => {
    if (cmd === "system_health") return systemHealth;
    if (cmd === "system_host_battery") return hostBatteryPayload ?? null;
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

describe("AboutPage.svelte", () => {
  test("no bridge: honest battery '—' and an explicit 'could not tell' cellular row", async () => {
    clearCellularRadio(); // nothing has read this device — see REQ-A1539
    const { container } = render(AboutPage);
    await tick();
    await settle();
    expect(container.textContent ?? "").toContain(zh["settings.aboutDevice"]);
    const batt = byTest(container, "about-battery");
    expect(batt?.textContent ?? "").toContain("—"); // no real source → not fabricated
    const cell = byTest(container, "about-cellular");
    // No host was asked, so the row must NOT state 「本机无 SIM / 调制解调器」.
    expect(cell?.textContent ?? "").toContain(zh["settings.cellularUnknown"]);
    expect(cell?.textContent ?? "").not.toContain(zh["settings.cellularNone"]);
    // Not bridged → the probe never runs → no probe stamp is claimed either.
    expect(byTest(container, "about-probe")).toBeNull();
  });

  test("the host answered 'no modem': the row says so (positive control)", async () => {
    setCellularRadio({ present: false, signal: null });
    const { container } = render(AboutPage);
    await tick();
    await settle();
    const cell = byTest(container, "about-cellular");
    expect(cell?.textContent ?? "").toContain(zh["settings.cellularNone"]);
  });

  test("host battery fills the About page on a /proc-less desktop", async () => {
    // Daemon answers but has no battery (macOS, no /proc); the Tauri host command
    // reports the real laptop battery → About shows a real %, not '—'.
    installBridge({}, { level_pct: 75, charging: false });
    const { container } = render(AboutPage);
    await tick();
    await settle();
    const batt = byTest(container, "about-battery");
    expect(batt?.textContent ?? "").toContain("75%");
  });

  test("re-probes the daemon every 10 s while open — the readout cannot go stale (REQ-A204)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let calls = 0;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "system_health") {
          calls += 1;
          return { battery_level_pct: 50 + calls, battery_charging: false };
        }
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(AboutPage);
    await tick();
    await vi.advanceTimersByTimeAsync(0); // flush the initial probe
    expect(calls).toBe(1);
    // The probe stamp is claimed next to the battery row.
    const stamp = byTest(container, "about-probe");
    expect(stamp?.textContent ?? "").toContain("上次探测");
    expect(byTest(container, "about-battery")?.textContent ?? "").toContain("51%");

    // One interval later the page asks again — a drain/refill shows up.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(2);
    expect(byTest(container, "about-battery")?.textContent ?? "").toContain("52%");
  });

  test("the update check is user-driven, hands over live facts, and reports the host's verdict", async () => {
    // The check must NOT run on mount (an offer the user never solicited), must hand
    // the host the facts only this UI can observe (battery/charging, Wi-Fi), and must
    // render the host's decision verbatim — here an eligible 1.1.0.
    const calls: { cmd: string; args: unknown }[] = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: unknown) => {
        calls.push({ cmd, args });
        if (cmd === "system_health") return { battery_level_pct: 75, battery_charging: false };
        if (cmd === "ota_status") {
          return { current_version: "0.1.0", channel: "stable", configured: true, source: "/tmp/m.json" };
        }
        if (cmd === "ota_check") {
          return {
            kind: "eligible",
            current_version: "0.1.0",
            channel: "stable",
            version: "1.1.0",
            package_uri: "https://example.invalid/os.img",
            package_bytes: 10,
            reason_code: null,
            detail: null,
          };
        }
        return null;
      },
      listen: async () => () => {},
    };
    const { container, getByRole } = render(AboutPage);
    await tick();
    await settle();
    expect(calls.some((c) => c.cmd === "ota_check")).toBe(false);

    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();

    const check = calls.find((c) => c.cmd === "ota_check");
    expect(check?.args).toEqual({
      batteryPercent: 75,
      charging: false,
      onWifi: false,
      inWindow: true,
    });
    expect(byTest(container, "update-outcome")?.textContent ?? "").toContain("1.1.0");
  });

  test("the source row quotes the host's configured source before any check (no gesture needed)", async () => {
    // `ota_status` states whether a source exists without running a check, so the
    // section can answer "what will this even read?" up front. The cell is the
    // host's own path, verbatim — not a re-derivation and not a blank.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "system_health") return { battery_level_pct: 75, battery_charging: false };
        if (cmd === "ota_status") {
          return {
            current_version: "0.1.0",
            channel: "stable",
            configured: true,
            source: "/etc/amos/manifest.json",
          };
        }
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(AboutPage);
    await tick();
    await settle();
    expect(byTest(container, "update-source")?.textContent ?? "").toContain("/etc/amos/manifest.json");
  });

  test("an unconfigured host says so up front — the honest sentence, not a blank cell", async () => {
    // The negative control for the row above: `configured:false` with an empty
    // `source` must render the sentence. A row that showed the (empty) path would
    // read as a blank cell, and "no source" is exactly the fact the user needs.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "system_health") return { battery_level_pct: 75, battery_charging: false };
        if (cmd === "ota_status") {
          return { current_version: "0.1.0", channel: "stable", configured: false, source: "" };
        }
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(AboutPage);
    await tick();
    await settle();
    const cell = byTest(container, "update-source");
    expect(cell?.textContent ?? "").toContain(zh["settings.updateSourceUnconfigured"]);
  });

  test("an unusable channel env var is surfaced verbatim, not folded into the fallback lane", async () => {
    // The host refuses to answer for a lane nobody selected when `AMOS_OTA_CHANNEL`
    // is not a channel, and reports the typo in `channel_error`. Without this row
    // the page showed only the `stable` fallback the host fell back to — the
    // operator's actual mistake was invisible on the very screen that reports it.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "system_health") return { battery_level_pct: 75, battery_charging: false };
        if (cmd === "ota_status") {
          return {
            current_version: "0.1.0",
            channel: "stable",
            configured: true,
            source: "/etc/amos/manifest.json",
            channel_error: 'AMOS_OTA_CHANNEL="betta" is not a channel (expected `stable` or `beta`)',
          };
        }
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(AboutPage);
    await tick();
    await settle();
    const row = byTest(container, "update-channel-error");
    expect(row).not.toBeNull();
    // The host's own words, verbatim — the variable and the offending value.
    expect(row?.textContent ?? "").toContain("AMOS_OTA_CHANNEL");
    expect(row?.textContent ?? "").toContain("betta");
  });

  test("a well-formed channel shows no error row (the negative control)", async () => {
    // Without this, a row that always rendered would pass the test above while
    // claiming a misconfiguration on every device. `channel_error` absent ⇒ no row.
    installUpdateBridge();
    const { container } = render(AboutPage);
    await tick();
    await settle();
    expect(byTest(container, "update-channel-error")).toBeNull();
  });

  test("on_wifi is false when the Wi-Fi radio is off, even with a remembered SSID (REQ-A1120)", async () => {
    // The SSID we *joined* outlives the radio being switched off, so reading only
    // `amos.wifi.current` told the host "on Wi-Fi" with Wi-Fi off — its `wifi_only`
    // policy stopped deferring and offered the update over the cell radio.
    window.localStorage.setItem("amos.wifi", JSON.stringify({ current: "Cafe_Free", saved: ["Cafe_Free"], passwords: {} }));
    window.localStorage.setItem("amos.settings", JSON.stringify({ wifi: false }));
    const calls = installUpdateBridge();
    const { getByRole } = render(AboutPage);
    await tick();
    await settle();
    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();
    expect(onWifiFact(calls)).toBe(false);
  });

  test("on_wifi is true when the radio is on and an AP is joined (positive control)", async () => {
    window.localStorage.setItem("amos.wifi", JSON.stringify({ current: "Cafe_Free", saved: ["Cafe_Free"], passwords: {} }));
    window.localStorage.setItem("amos.settings", JSON.stringify({ wifi: true }));
    const calls = installUpdateBridge();
    const { getByRole } = render(AboutPage);
    await tick();
    await settle();
    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();
    expect(onWifiFact(calls)).toBe(true);
  });

  test("on_wifi is false when the radio is on but no AP is joined (the host is online over cellular)", async () => {
    // The positive control above is satisfied by `navigator.onLine` alone (happy-dom
    // reports `true`), so it never reached this cell: radio on, *nothing joined*, and
    // the internet arriving over the cell radio. `wifiConnState` is the status bar's
    // glyph rule — where being online lights the Wi-Fi glyph — so it answers
    // `connected: true` here too; a fresh device on LTE thus handed the host
    // `on_wifi: true` and its `wifi_only` policy offered the update over metered
    // cellular (REQ-A1173 / F-SH-468).
    window.localStorage.setItem("amos.wifi", JSON.stringify({ current: null, saved: [], passwords: {} }));
    window.localStorage.setItem("amos.settings", JSON.stringify({ wifi: true }));
    const calls = installUpdateBridge();
    const { getByRole } = render(AboutPage);
    await tick();
    await settle();
    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();
    expect(onWifiFact(calls)).toBe(false);
  });

  test("a failed probe resets the row to the honest '—' (no stale percentage)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let online = true;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "system_health") return online ? { battery_level_pct: 80 } : null;
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(AboutPage);
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(byTest(container, "about-battery")?.textContent ?? "").toContain("80%");
    // The daemon drops mid-view: the next probe answers null → back to '—'.
    online = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(byTest(container, "about-battery")?.textContent ?? "").toContain("—");
  });
});
