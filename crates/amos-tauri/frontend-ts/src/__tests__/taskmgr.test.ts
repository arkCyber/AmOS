import { describe, expect, test } from "bun:test";
import {
  appIsRunning,
  normalizeTaskSnapshot,
  taskmgrAppAction,
  taskmgrSnapshot,
  type TaskSnapshot,
} from "../lib/taskmgr";
import { bridgeDiag } from "../lib/backend";

const full: TaskSnapshot = {
  apps: [
    { id: "com.amos.photos", state: "foreground" },
    { id: "com.amos.maps", state: "background" },
    { id: "com.amos.mail", state: "cached" },
  ],
  jobs: [{ id: "bg.sync", kind: "deferred", earliest: 0, latest: 200 }],
  background_count: 1,
  decision: {
    mode: "power_save",
    reason: "battery_low",
    cap_inference: true,
    throttle_background: true,
    ticks: 3,
  },
};

describe("normalizeTaskSnapshot", () => {
  test("passes a complete payload through", () => {
    const s = normalizeTaskSnapshot(full);
    expect(s.apps).toHaveLength(3);
    expect(s.apps[0]!.state).toBe("foreground");
    expect(s.jobs[0]!.kind).toBe("deferred");
    expect(s.background_count).toBe(1);
    expect(s.decision?.mode).toBe("power_save");
  });

  test("absent / partial payload yields a safe empty view", () => {
    const s = normalizeTaskSnapshot(null);
    expect(s.apps).toEqual([]);
    expect(s.jobs).toEqual([]);
    expect(s.background_count).toBe(0);
    expect(s.decision).toBeNull();
    // Unknown states + kinds coerce to sentinels; malformed entries dropped.
    const messy = normalizeTaskSnapshot({
      apps: [{ id: "a", state: "bogus" }, { state: "foreground" }, {}],
      jobs: [{ id: "j", kind: "weird" }],
    });
    expect(messy.apps).toEqual([{ id: "a", state: "unknown" }]);
    expect(messy.jobs).toEqual([{ id: "j", kind: "unknown", earliest: 0, latest: 0 }]);
  });
});

describe("appIsRunning", () => {
  test("live tiers are running; cached/stopped/unknown are not", () => {
    expect(appIsRunning({ id: "a", state: "foreground" })).toBe(true);
    expect(appIsRunning({ id: "a", state: "foreground_service" })).toBe(true);
    expect(appIsRunning({ id: "a", state: "background" })).toBe(true);
    expect(appIsRunning({ id: "a", state: "cached" })).toBe(false);
    expect(appIsRunning({ id: "a", state: "stopped" })).toBe(false);
    expect(appIsRunning({ id: "a", state: "unknown" })).toBe(false);
  });
});

describe("taskmgrSnapshot() guarded bridge", () => {
  test("resolves null when not bridged", async () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.window;
    g.window = {};
    try {
      expect(await taskmgrSnapshot()).toBeNull();
    } finally {
      if (prev === undefined) delete g.window;
      else g.window = prev;
    }
  });
});

describe("a refused lifecycle action is a recorded verdict, not a silent null", () => {
  /**
   * The daemon is **up** and answers a refused action with its own words
   * (`taskmgr.rs::taskmgr_app_action` — `unregister_app '…' failed`, or
   * `"unknown task-manager action '…'"`). The private `call<T>` this module used to carry
   * folded that rejection into `null` **before** anything wrote it down, so the caller's
   * `.catch("daemon offline")` was unreachable and the button simply did nothing. Routing
   * through `backend.invoke` makes the reason recoverable — which is what lets the panel
   * say it (the reader is `TaskManager.svelte::reportRefusal`).
   */
  test("a rejected taskmgr_app_action resolves null AND records command-failed + the reason", async () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.window;
    g.window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          if (cmd === "taskmgr_app_action") {
            throw new Error("unregister_app 'com.x' failed: not registered");
          }
          return null;
        },
      },
    };
    try {
      expect(await taskmgrAppAction("com.x", "kill")).toBeNull();
      const diag = bridgeDiag("taskmgr_app_action");
      expect(diag.ok).toBe(false);
      if (!diag.ok && diag.kind === "command-failed") {
        expect(String(diag.detail)).toContain("unregister_app");
      } else {
        throw new Error(`expected command-failed, got ${JSON.stringify(diag)}`);
      }
      // A *different* command's slot is not polluted by this failure.
      expect(bridgeDiag("taskmgr_job_action").ok).toBe(true);
    } finally {
      if (prev === undefined) delete g.window;
      else g.window = prev;
    }
  });
});
