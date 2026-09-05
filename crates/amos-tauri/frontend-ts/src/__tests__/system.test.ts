import { describe, expect, test } from "bun:test";
import {
  fmtBytes,
  liveProcesses,
  memUsedBytes,
  memUsedPct,
  normalizeSystemHealth,
  systemHealth,
  type SystemStatus,
} from "../lib/system";

const full: SystemStatus = {
  sampler: "linux-proc",
  cpu_busy_pct: 43.5,
  mem_total_bytes: 8_000_000_000,
  mem_available_bytes: 2_000_000_000,
  battery_level_pct: 60,
  battery_charging: true,
  live_power_mw: 1234.5,
  running: 5,
  cached: 2,
  stopped: 1,
  apps: [{ id: "com.amos.photos", state: "foreground" }],
  governor: {
    mode: "power_save",
    reason: "battery_low",
    cap_inference: true,
    throttle_background: true,
    ticks: 12,
    dvfs_applied: 7,
    dvfs_failed: 1,
    dropped: 2,
  },
};

describe("normalizeSystemHealth (daemon system_health -> typed view)", () => {
  test("passes a complete payload through", () => {
    const s = normalizeSystemHealth(full);
    expect(s.sampler).toBe("linux-proc");
    expect(s.cpu_busy_pct).toBe(43.5);
    expect(s.running).toBe(5);
    expect(s.stopped).toBe(1);
    expect(s.apps).toEqual([{ id: "com.amos.photos", state: "foreground" }]);
    expect(s.governor?.mode).toBe("power_save");
    expect(s.governor?.dvfs_failed).toBe(1);
    expect(s.governor?.dropped).toBe(2);
  });

  test("governor block is optional and tolerated", () => {
    expect(normalizeSystemHealth(null).governor).toBeNull();
    // A malformed / partial governor block is dropped, never crashes.
    expect(normalizeSystemHealth({ governor: {} }).governor).toBeNull();
    expect(normalizeSystemHealth({ governor: null }).governor).toBeNull();
    const partial = normalizeSystemHealth({ governor: { mode: "balanced" } });
    expect(partial.governor).toEqual({
      mode: "balanced",
      reason: "",
      cap_inference: false,
      throttle_background: false,
      ticks: 0,
      dvfs_applied: 0,
      dvfs_failed: 0,
      dropped: 0,
    });
  });

  test("normalizes the per-app list and drops malformed entries", () => {
    const raw = {
      apps: [
        { id: "com.amos.a", state: "foreground" },
        { id: "com.amos.b" }, // no state
        { state: "cached" }, // no id → dropped
        { id: "" }, // empty id → dropped
        {},
        null,
        "not-an-object",
      ],
    };
    expect(normalizeSystemHealth(raw).apps).toEqual([
      { id: "com.amos.a", state: "foreground" },
      { id: "com.amos.b", state: "" },
    ]);
  });

  test("null/absent payload yields a safe view (never throws)", () => {
    const s = normalizeSystemHealth(null);
    expect(s.sampler).toBe("");
    expect(s.cpu_busy_pct).toBeNull();
    expect(s.mem_total_bytes).toBeNull();
    expect(s.battery_level_pct).toBeNull();
    expect(s.running).toBe(0);
    expect(s.cached).toBe(0);
  });

  test("tolerates partial payloads (missing optionals stay null, counts default 0)", () => {
    const s = normalizeSystemHealth({ running: 3 });
    expect(s.running).toBe(3);
    expect(s.cpu_busy_pct).toBeNull();
    expect(s.mem_available_bytes).toBeNull();
    // Bogus / NaN numbers are treated as unknown, never NaN.
    const t = normalizeSystemHealth({ mem_total_bytes: NaN });
    expect(t.mem_total_bytes).toBeNull();
  });
});

describe("memory derive helpers", () => {
  test("used bytes = total - available", () => {
    expect(memUsedBytes(full)).toBe(6_000_000_000);
    expect(memUsedPct(full)).toBe(75);
  });

  test("unknown halves yield null, never a fabricated number", () => {
    const noAvail = { ...full, mem_available_bytes: null };
    expect(memUsedBytes(noAvail)).toBeNull();
    expect(memUsedPct(noAvail)).toBeNull();
    expect(memUsedPct(normalizeSystemHealth(null))).toBeNull();
  });

  test("guard against total <= 0", () => {
    expect(memUsedPct({ ...full, mem_total_bytes: 0 })).toBeNull();
  });
});

describe("fmtBytes", () => {
  test("formats with units", () => {
    expect(fmtBytes(2_000_000_000)).toBe("1.9 GB");
    expect(fmtBytes(512 * 1024 * 1024)).toBe("512 MB");
    expect(fmtBytes(null)).toBe("n/a");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(12)).toBe("12 B");
  });
});

describe("liveProcesses", () => {
  test("running + cached are live; stopped is not", () => {
    expect(liveProcesses(full)).toBe(7);
    expect(liveProcesses(normalizeSystemHealth(null))).toBe(0);
  });
});

describe("systemHealth() guarded bridge", () => {
  test("resolves null when not bridged (no __TAURI_INTERNALS__)", async () => {
    // Pure test process has no `window`; install a shim with no Tauri internals.
    const g = globalThis as Record<string, unknown>;
    const prev = g.window;
    g.window = {};
    try {
      expect(await systemHealth()).toBeNull();
    } finally {
      if (prev === undefined) delete g.window;
      else g.window = prev;
    }
  });
});
