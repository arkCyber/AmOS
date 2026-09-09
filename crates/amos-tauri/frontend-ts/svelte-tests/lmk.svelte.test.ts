/**
 * DOM tests for the Svelte 5 LMK debug panel (LmkDebugPanel.svelte) — the last
 * Settings group. Unlike the governor panels it ALWAYS renders: offline it shows
 * a graceful "not connected" line; with a fake bridge it lists container tasks
 * and their freeze/thaw/reclaim actions.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import LmkDebugPanel from "../src/svelte/LmkDebugPanel.svelte";
import {
  RECONCILE_INTERVAL_MS,
  startPeriodicReconcile,
} from "../src/lib/lmk";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const settle = () => new Promise((r) => setTimeout(r, 40));

function installBridge(tasks: unknown) {
  const invoke = async (cmd: string) => {
    if (cmd === "android_lmk_tasks") return tasks;
    if (cmd === "android_lmk_debug") return { note: "ok", victims: [] };
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

describe("LmkDebugPanel.svelte", () => {
  test("always renders and shows a graceful offline line when the daemon is absent", async () => {
    const host = render(LmkDebugPanel);
    await settle();
    await settle();
    expect(txt(host)).toContain("LMK 调试");
    expect(txt(host)).toContain("daemon 未连接");
  });

  test("lists container tasks with thaw/reclaim actions from a bridged snapshot", async () => {
    installBridge([
      { window_id: "w1", package_name: "com.example.photo", state: "cached" },
    ]);
    const host = render(LmkDebugPanel);
    await settle();
    await settle();
    expect(txt(host)).toContain("com.example.photo");
    expect(txt(host)).toContain("解冻"); // cached → thaw
    expect(txt(host)).toContain("回收"); // cached → reclaim
  });
});

describe("startPeriodicReconcile (bridged, fake timers)", () => {
  function installReconcileBridge(closed: string[]) {
    const invoke = async (cmd: string, args?: { label?: string }) => {
      if (cmd === "android_lmk_tasks") {
        // Authoritative live container tasks: only `legacy:alive` is alive.
        return [{ window_id: "alive", package_name: "com.example.a", state: "foreground" }];
      }
      if (cmd === "wm_windows") {
        // Registered external surfaces: one stale, one matching the live task.
        return {
          windows: [{ label: "legacy:stale" }, { label: "legacy:alive" }],
        };
      }
      if (cmd === "wm_close") {
        closed.push(args?.label ?? "");
        return { windows: [] };
      }
      return null;
    };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };
  }

  // Flush the async reconcile chain (invoke -> await -> await) under fake timers.
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  test("closes the stale legacy surface on start and on each interval; stop clears it", async () => {
    vi.useFakeTimers();
    const closed: string[] = [];
    installReconcileBridge(closed);
    const stop = startPeriodicReconcile();
    // The periodic runner reconciles once immediately on start…
    await flush();
    expect(closed).toContain("legacy:stale");
    expect(closed).not.toContain("legacy:alive"); // live task is kept

    // …then again after each 30s cadence (proves the interval is really wired).
    closed.length = 0;
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    await flush();
    expect(closed).toContain("legacy:stale");

    // stop() clears the interval: advancing further must not reconcile again.
    stop();
    closed.length = 0;
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 2);
    await flush();
    expect(closed).toEqual([]);
  });

  test("never reconciles when the daemon snapshot is unavailable (daemon down ≠ app dead)", async () => {
    vi.useFakeTimers();
    const closed: string[] = [];
    // invoke returns null for android_lmk_tasks -> reconcileLegacySurfaces returns 0.
    const invoke = async (_cmd: string, args?: { label?: string }) => {
      if (args?.label) closed.push(args.label);
      return null;
    };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };
    const stop = startPeriodicReconcile();
    await flush();
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    await flush();
    expect(closed).toEqual([]);
    stop();
  });
});
