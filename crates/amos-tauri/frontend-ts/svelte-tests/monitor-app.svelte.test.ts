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

  // REQ-A985 / F-SH-312: the overview's refresh control must not carry an accessible
  // name that contradicts the word printed on it. WCAG 2.5.3 (Label in Name, AA): the
  // name has to *contain* the visible label, or a voice-control user who says the word
  // they can see cannot activate the button — and a screen-reader user hears a word
  // ("Retry") that is nowhere on screen.
  test("the overview refresh button's accessible name is the label printed on it", async () => {
    installBridge(
      {
        cpu_busy_pct: 12,
        mem_total_bytes: 8_000_000_000,
        mem_available_bytes: 4_000_000_000,
        battery_level_pct: 50,
        battery_charging: false,
        live_power_mw: 100,
        running: 1,
        cached: 0,
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

    const visible = zh["settings.systemRefresh"]; // "刷新" — the word on the button
    const btn = [...over!.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === visible,
    );
    expect(btn).toBeTruthy();
    // An explicit `aria-label` overrides the content for the accessible name, so it is
    // the one that must be checked first.
    const name = btn!.getAttribute("aria-label") ?? (btn!.textContent ?? "").trim();
    expect(name).toContain(visible);
    // …and it must not be the stale "Retry" it used to carry while printing "Refresh".
    expect(name).not.toBe(zh["monitor.retry"]);
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

/**
 * REQ-A1481 / F-SH-731 — a progressbar is a **reading**; an unreported metric draws none.
 *
 * `overviewAny` is an OR across the fields, so a daemon answer that carries some metrics
 * and not others (a host without `/proc` for one of them) reaches the overview. The big
 * readout already printed 「—」 for the missing ones via `pctLabel`, but the bar right below
 * it folded the same `null` through `?? 0` → an empty bar with `aria-valuenow="0"`, i.e.
 * "0% CPU"/「内存 0%」 claimed to the eye and to a screen reader for a reading nobody took.
 */
describe("REQ-A1481 — 没上报的读数画不出进度条，而不是画成 0%", () => {
  const barFor = (over: Element, labelKey: keyof typeof zh) =>
    over.querySelector(`[role="progressbar"][aria-label="${zh[labelKey]}"]`);
  const nowOf = (over: Element, labelKey: keyof typeof zh) =>
    barFor(over, labelKey)?.getAttribute("aria-valuenow") ?? null;
  /** A full reading with exactly one metric blanked out. */
  const partial = (over: Partial<Record<string, unknown>>) => ({
    cpu_busy_pct: 42,
    mem_total_bytes: 8_000_000_000,
    mem_available_bytes: 4_000_000_000,
    battery_level_pct: 65,
    battery_charging: false,
    live_power_mw: 100,
    running: 1,
    cached: 0,
    stopped: 0,
    apps: [],
    ...over,
  });
  async function overviewOf(health: unknown) {
    installBridge(health, null);
    const { container } = render(MonitorApp);
    await settle();
    await settle();
    const over = byTest(container, "monitor-overview");
    expect(over).toBeTruthy();
    return over!;
  }

  // One null metric per test, so each metric's gate is pinned on its own.

  test("CPU 没上报：读数印「—」，那一格没有进度条（另两根照画）", async () => {
    const over = await overviewOf(partial({ cpu_busy_pct: null }));
    expect(txt(over)).toContain("—");
    // The tile is there (its label is drawn) — the **bar** is what must be absent.
    expect(txt(over)).toContain(zh["monitor.cpu"]);
    expect(barFor(over, "monitor.cpu")).toBeNull();
    // …and the two metrics that did come in still draw theirs. The old fold drew CPU at
    // `aria-valuenow="0"` — "0% CPU" for a reading nobody took.
    expect(nowOf(over, "monitor.memory")).toBe("50");
    expect(nowOf(over, "monitor.battery")).toBe("65");
  });

  test("内存没上报：读数印「—」，那一格没有进度条（另两根照画）", async () => {
    const over = await overviewOf(
      partial({ mem_total_bytes: null, mem_available_bytes: null }),
    );
    expect(txt(over)).toContain("—");
    expect(txt(over)).toContain(zh["monitor.memory"]);
    expect(barFor(over, "monitor.memory")).toBeNull();
    expect(nowOf(over, "monitor.cpu")).toBe("42");
    expect(nowOf(over, "monitor.battery")).toBe("65");
  });

  test("电量没上报：读数印「—」，那一格没有进度条（另两根照画）", async () => {
    const over = await overviewOf(partial({ battery_level_pct: null }));
    expect(txt(over)).toContain("—");
    expect(txt(over)).toContain(zh["monitor.battery"]);
    expect(barFor(over, "monitor.battery")).toBeNull();
    expect(nowOf(over, "monitor.cpu")).toBe("42");
    expect(nowOf(over, "monitor.memory")).toBe("50");
  });

  test("正控 · 三项都上报了：三根进度条都在，值各自正确", async () => {
    const over = await overviewOf(partial({}));
    const bars = over.querySelectorAll('[role="progressbar"]');
    expect(bars.length).toBe(3);
    expect(nowOf(over, "monitor.cpu")).toBe("42");
    expect(nowOf(over, "monitor.battery")).toBe("65");
    expect(nowOf(over, "monitor.memory")).toBe("50"); // (8e9 - 4e9) / 8e9
  });
});
