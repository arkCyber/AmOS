/**
 * MonitorApp.svelte — dock app「系统监控」dashboard DOM tests.
 *
 * The dock app now has its own live overview strip (CPU/memory/battery) fed by
 * the amos-monitor `system_health` bridge, plus explicit empty states so the
 * page is never a blank wall: offline → "未连接系统服务" + Retry; bridged but no
 * readings → "暂无系统数据". The Settings-shared detail panels are covered by
 * monitor.svelte.test.ts.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MonitorApp from "../src/svelte/MonitorApp.svelte";
import { zh } from "../src/i18n/locales/zh";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function installBridge(systemHealth: unknown, taskmgrSnapshot: unknown) {
  const invoke = async (cmd: string) => {
    if (cmd === "system_health") return systemHealth;
    if (cmd === "taskmgr_snapshot") return taskmgrSnapshot;
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

const settle = () => new Promise((r) => setTimeout(r, 40));
const txt = (c: HTMLElement) => c.textContent ?? "";
const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

describe("MonitorApp.svelte — overview dashboard", () => {
  test("offline (no bridge): shows 'not connected' empty state, never a blank page", async () => {
    const { container } = render(MonitorApp);
    await settle();
    expect(byTest(container, "monitor-empty-offline")).toBeTruthy();
    expect(txt(container)).toContain(zh["monitor.unavailable"]);
    expect(byTest(container, "monitor-overview")).toBeNull();
  });

  test("bridged but no readings: shows 'no data' empty state (honest host)", async () => {
    installBridge({}, null);
    const { container } = render(MonitorApp);
    await settle();
    await settle();
    expect(byTest(container, "monitor-empty-nodata")).toBeTruthy();
    expect(txt(container)).toContain(zh["monitor.noData"]);
  });

  test("bridged with data: renders the big overview readouts + charging", async () => {
    installBridge(
      {
        cpu_busy_pct: 37,
        mem_total_bytes: 8_000_000_000,
        mem_available_bytes: 5_000_000_000,
        battery_level_pct: 80,
        battery_charging: true,
        live_power_mw: 1234,
        running: 3,
        cached: 1,
        stopped: 0,
        apps: [],
      },
      null,
    );
    const { container } = render(MonitorApp);
    await settle();
    await settle();
    const over = byTest(container, "monitor-overview");
    expect(over).toBeTruthy();
    expect(txt(over!)).toContain("37%"); // CPU
    expect(txt(over!)).toContain("80%"); // battery
    expect(txt(over!)).toContain(zh["monitor.cpu"]);
    expect(txt(over!)).toContain(zh["settings.systemCharging"]);

    // Accessible, live-value progress bars for each readout.
    const bars = over!.querySelectorAll('[role="progressbar"]');
    expect(bars.length).toBe(3);
    const nowOf = (labelKey: string) =>
      over!.querySelector(`[aria-label="${zh[labelKey as keyof typeof zh]}"]`)?.getAttribute(
        "aria-valuenow",
      );
    expect(nowOf("monitor.cpu")).toBe("37");
    expect(nowOf("monitor.battery")).toBe("80");
  });

  test("offline → daemon comes up: reconnect probe auto-recovers (no tap needed)", async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(MonitorApp);
      await vi.advanceTimersByTimeAsync(0);
      expect(byTest(container, "monitor-empty-offline")).toBeTruthy();

      // The daemon becomes reachable; the next reconnect probe (5 s) notices it
      // and fetches without any user action.
      installBridge(
        {
          cpu_busy_pct: 60,
          mem_total_bytes: 8_000_000_000,
          mem_available_bytes: 4_000_000_000,
          battery_level_pct: 55,
          battery_charging: false,
          live_power_mw: 900,
          running: 1,
          cached: 0,
          stopped: 0,
          apps: [],
        },
        null,
      );
      await vi.advanceTimersByTimeAsync(6000);
      await vi.advanceTimersByTimeAsync(0); // flush the fetch promise
      expect(byTest(container, "monitor-overview")).toBeTruthy();
      expect(txt(container)).toContain("60%");
    } finally {
      vi.useRealTimers();
    }
  });

  test("bridged but daemon down (system_health rejects) → offline, not 'no data'; auto-recovers", async () => {
    // A real Tauri WebView is always bridged, so the previous "no bridge ⇒ offline"
    // gate could never express "daemon unreachable" — a dead daemon wrongly showed
    // 📡「暂无系统数据」. Connected now means the daemon actually answered.
    vi.useFakeTimers();
    try {
      let up = false;
      const invoke = async (cmd: string) => {
        if (cmd === "system_health") {
          if (!up) throw new Error("daemon down");
          return {
            cpu_busy_pct: 44,
            mem_total_bytes: 8_000_000_000,
            mem_available_bytes: 4_000_000_000,
            battery_level_pct: 70,
            running: 1,
            cached: 0,
            stopped: 0,
            apps: [],
          };
        }
        return null;
      };
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        invoke,
        listen: async () => () => {},
      };
      const { container } = render(MonitorApp);
      await vi.advanceTimersByTimeAsync(0);
      expect(byTest(container, "monitor-empty-offline")).toBeTruthy();
      expect(byTest(container, "monitor-empty-nodata")).toBeNull();

      // The daemon comes up; the next reconnect probe (5 s) recovers automatically.
      up = true;
      await vi.advanceTimersByTimeAsync(6000);
      await vi.advanceTimersByTimeAsync(0); // flush the fetch promise
      expect(byTest(container, "monitor-overview")).toBeTruthy();
      expect(txt(container)).toContain("44%");
    } finally {
      vi.useRealTimers();
    }
  });

  test("offline → daemon comes up: pressing Retry recovers to the live overview", async () => {
    const { container } = render(MonitorApp);
    await settle();
    expect(byTest(container, "monitor-empty-offline")).toBeTruthy();

    // The daemon becomes reachable; user taps Retry in the empty state.
    installBridge(
      {
        cpu_busy_pct: 50,
        mem_total_bytes: 8_000_000_000,
        mem_available_bytes: 8_000_000_000,
        battery_level_pct: 99,
        battery_charging: false,
        live_power_mw: 500,
        running: 2,
        cached: 0,
        stopped: 0,
        apps: [],
      },
      null,
    );
    const retry = [...container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === zh["monitor.retry"],
    );
    expect(retry).toBeTruthy();
    await fireEvent.click(retry!);
    await tick();
    await settle();
    expect(byTest(container, "monitor-overview")).toBeTruthy();
    expect(txt(container)).toContain("50%");
  });

  test("emits [amos][monitor] lifecycle markers for on-device logcat diagnosis", async () => {
    const seen: string[] = [];
    const origInfo = console.info;
    const origWarn = console.warn;
    console.info = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
    try {
      render(MonitorApp); // offline in this test
      await settle();
      const joined = seen.join("\n");
      expect(joined).toContain("[amos][monitor] mounted");
      expect(joined).toContain("[amos][monitor] surface=offline");
    } finally {
      console.info = origInfo;
      console.warn = origWarn;
    }
  });
});
