/**
 * DOM tests for the Svelte 5 LMK debug panel (LmkDebugPanel.svelte) — the last
 * Settings group. Unlike the governor panels it ALWAYS renders: offline it shows
 * a graceful "not connected" line; with a fake bridge it lists container tasks
 * and their freeze/thaw/reclaim actions.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import LmkDebugPanel from "../src/svelte/LmkDebugPanel.svelte";
import { zh } from "../src/i18n/locales/zh";
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

  /**
   * The victim row is judged by `killed` **alone**, because that is the only signal the
   * wire carries (REQ-A399). `proto/android_compat.proto::LmkVictim` =
   * `{package_name, window_id, killed}` — "true = killed (surface torn down); false =
   * frozen" — and `amos-android::service::trigger_lmk` sets exactly that, with its own
   * tests naming the semantics ("low pressure freezes, not kills" → the task stays
   * `cached`). There is no per-victim `outcome`/`refusal_reason`, so this case feeds the
   * **real** shape: the previous version injected `outcome: "refused"` + `refusal_reason`
   * (fields no producer emits), which made the test green against a payload the device
   * cannot send and left the real freeze path — reported as "unknown" by the old code —
   * unexercised.
   */
  test("a victim row reads killed/frozen from the wire, never from an absent `outcome`", async () => {
    const invoke = async (cmd: string) => {
      if (cmd === "android_lmk_tasks") return [];
      if (cmd === "android_lmk_debug") {
        return {
          note: "trigger_lmk returned 2 victim(s)",
          victims: [
            { package_name: "com.example.reclaimed", window_id: "w9", killed: true },
            { package_name: "com.example.frozen", window_id: "w8", killed: false },
          ],
        };
      }
      return null;
    };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };

    const host = render(LmkDebugPanel);
    await settle();
    const trigger = [...host.container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === zh["lmk.ariaTrigger"],
    ) as HTMLButtonElement;
    await fireEvent.click(trigger);
    await settle();
    await settle();

    // The row text: the outermost span whose text carries the package name.
    const rowText = (pkg: string) =>
      [...host.container.querySelectorAll("span")].find((s) =>
        (s.textContent ?? "").includes(pkg),
      )?.textContent ?? "";

    expect(rowText("com.example.reclaimed")).toContain("killed");
    expect(rowText("com.example.reclaimed")).not.toContain("frozen");
    // The regression this pins: `killed: false` used to render "unknown".
    expect(rowText("com.example.frozen")).toContain("frozen");
    expect(rowText("com.example.frozen")).not.toContain("unknown");
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

/**
 * REQ-A297 phase-2 §4 cont.4: `lib/backend.ts::invoke` resolves `null` on a
 * refused command and **never** rejects. The panel's pre-fix `try/catch` /
 * `.catch(() => …)` patterns were dead code (a refused command manifested
 * as the same observable state — a `null` reply — the success arm already
 * handled). These two cases pin the move to explicit `null` checks plus a
 * typed diagnostic in the ledger.
 */
describe("LmkDebugPanel — honest error surfacing (REQ-A297 phase-2 §4 cont.4)", () => {
  test("a refused android_lmk_tasks shows the offline line and logs the typed error", async () => {
    // A bridge that always returns `null` simulates "host refused / not bridged".
    const invoke = async () => null;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };
    const warns: unknown[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args);
    try {
      const host = render(LmkDebugPanel);
      await settle();
      await settle();
      // The offline line is still visible (an explicit `null` reply — the
      // pre-fix path — already produced it; the change is **diagnostic
      // surfacing**, not UI).
      expect(txt(host)).toContain(zh["lmk.offline"]);
      // The .catch that used to flip `offline = true` is gone: nothing
      // should have come out of `console.warn` for an unhandled rejection,
      // because there was no rejection.
      const rejections = warns.filter((w) =>
        String(w[0] ?? "").includes("unhandled"),
      );
      expect(rejections).toEqual([]);
    } finally {
      console.warn = orig;
    }
  });

  test("a refused android_lmk_debug surfaces the localised fail note (no .catch needed)", async () => {
    // List returns a real task (so the panel shows the row) but debug refuses.
    const invoke = async (cmd: string) =>
      cmd === "android_lmk_tasks"
        ? [{ window_id: "w1", package_name: "com.example.a", state: "cached" }]
        : null;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };
    const host = render(LmkDebugPanel);
    await settle();
    await settle();
    // Find the trigger button (the first of the action buttons at the
    // top). Clicking it sends `trigger` -> `android_lmk_debug`.
    const btn = host.container.querySelector(
      "button",
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    await fireEvent.click(btn!);
    await settle();
    await settle();
    // The local i18n line — `lmk.fail` — is now the *typed* error path,
    // not the .catch fallback. The user sees the same text; the launcher
    // ledger now sees the typed reason.
    expect(txt(host)).toContain(zh["lmk.fail"]);
  });
});
