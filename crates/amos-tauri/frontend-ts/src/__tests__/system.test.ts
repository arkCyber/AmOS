import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  fmtBytes,
  hostBattery,
  liveProcesses,
  memUsedBytes,
  memUsedPct,
  normalizeSystemHealth,
  systemHealth,
  type SystemStatus,
} from "../lib/system";
import { bridgeDiag } from "../lib/backend";

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

describe("system.ts wire mirrors == the Rust structs that serialize them", () => {
  // WHY: `system.ts`'s `SystemStatus` / `AppProc` / `SystemGovernor` / `HostBatteryStatus`
  // are declared mirrors of `crates/amos-tauri/src/system.rs` and `host_battery.rs`. Both
  // are plain `Serialize` structs whose field *names* are the wire contract, so a rename on
  // either side is invisible to every type checker across the IPC boundary: the TS reader
  // would quietly read `undefined`, `normalizeSystemHealth` turns that into `null`, and the
  // battery/memory/governor surfaces degrade to an honest-looking "—" / "n/a" with the whole
  // suite green. Nothing in the repo read these two Rust files (unlike, say, `privacy.rs`),
  // so until now the pairing was self-proving: the local literal in `full` below matches the
  // interface because a human typed both. These tests read the Rust source directly.
  const readSrc = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  /** The `pub` field names of a Rust struct, sorted. */
  function rustStructFields(src: string, name: string): string[] {
    const at = src.indexOf(`pub struct ${name} {`);
    expect(at, `pub struct ${name} not found`).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n}", at));
    return [...body.matchAll(/^\s+pub (\w+):/gm)].map((m) => m[1] ?? "").sort();
  }
  /** The field names of a TS interface, sorted. */
  function tsInterfaceFields(src: string, name: string): string[] {
    const at = src.indexOf(`interface ${name} {`);
    expect(at, `interface ${name} not found`).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n}", at));
    return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1] ?? "").sort();
  }

  const systemRs = readSrc("../../../../amos-tauri/src/system.rs");
  const hostRs = readSrc("../../../../amos-tauri/src/host_battery.rs");
  const lib = readSrc("../lib/system.ts");

  test("SystemStatus fields == system.rs (rename on either side goes red)", () => {
    const rust = rustStructFields(systemRs, "SystemStatus");
    expect(rust).toContain("battery_level_pct");
    expect(tsInterfaceFields(lib, "SystemStatus")).toEqual(rust);
  });

  test("AppProc fields == system.rs", () => {
    expect(tsInterfaceFields(lib, "AppProc")).toEqual(rustStructFields(systemRs, "AppProc"));
  });

  test("SystemGovernor fields == system.rs", () => {
    const rust = rustStructFields(systemRs, "SystemGovernor");
    expect(rust).toContain("cap_inference");
    expect(tsInterfaceFields(lib, "SystemGovernor")).toEqual(rust);
  });

  test("HostBatteryStatus fields == host_battery.rs's HostBattery", () => {
    const rust = rustStructFields(hostRs, "HostBattery");
    expect(rust).toEqual(["charging", "level_pct"]);
    expect(tsInterfaceFields(lib, "HostBatteryStatus")).toEqual(rust);
  });

  test("the battery consumer reads the same two keys system.rs writes", () => {
    // `sampleFromSystemHealth` is the one place the daemon block becomes a sample; its
    // literal keys must be the Rust field names (the interface above is only a claim).
    const consumer = readSrc("../lib/batterySources.svelte.ts");
    expect(consumer).toContain("raw.battery_level_pct");
    expect(consumer).toContain("raw.battery_charging");
    const rust = rustStructFields(systemRs, "SystemStatus");
    expect(rust).toContain("battery_level_pct");
    expect(rust).toContain("battery_charging");
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

describe("systemHealth() refusal is a recorded verdict, not just a null", () => {
  /**
   * The writer half of REQ-A297's `SystemPanel` read. `SystemPanel.svelte` branches on
   * `bridgeDiag("system_health")` to log a *typed* reason — but that branch was dead,
   * because `lib/system.ts` carried its own `bridge()`/`call<T>` with a bare
   * `catch { return null }`: the refusal was swallowed **before** anything wrote the
   * ledger, so `bridgeDiag("system_health")` always answered the default `{ ok: true }`
   * and could never be `command-failed`. A diagnosis must survive its render point.
   */
  test("a rejected system_health resolves null AND records command-failed + the reason", async () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.window;
    g.window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          if (cmd === "system_health") throw new Error("system status request failed: connect");
          return null;
        },
      },
    };
    try {
      // The value is still the honest "nothing to show" …
      expect(await systemHealth()).toBeNull();
      // … and the *reason* is recoverable — which it was not before the fix.
      const diag = bridgeDiag("system_health");
      expect(diag.ok).toBe(false);
      if (!diag.ok && diag.kind === "command-failed") {
        expect(String(diag.detail)).toContain("system status request failed");
      } else {
        throw new Error(`expected command-failed, got ${JSON.stringify(diag)}`);
      }
    } finally {
      if (prev === undefined) delete g.window;
      else g.window = prev;
    }
  });

  test("hostBattery() records its own refusal under its own command", async () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.window;
    g.window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          if (cmd === "system_host_battery") throw new Error("pmset unavailable");
          return null;
        },
      },
    };
    try {
      expect(await hostBattery()).toBeNull();
      const diag = bridgeDiag("system_host_battery");
      expect(diag.ok).toBe(false);
      if (!diag.ok) expect(diag.kind).toBe("command-failed");
    } finally {
      if (prev === undefined) delete g.window;
      else g.window = prev;
    }
  });
});
