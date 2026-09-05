import { describe, expect, test } from "bun:test";
import {
  appIsRunning,
  normalizeTaskSnapshot,
  taskmgrSnapshot,
  type TaskSnapshot,
} from "../lib/taskmgr";

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
