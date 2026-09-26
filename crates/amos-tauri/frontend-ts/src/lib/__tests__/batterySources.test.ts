/**
 * batterySources.test.ts — the shared battery subscription's wire→view mapping
 * (`src/lib/batterySources.svelte.ts`, REQ-A519 / FMEA F-SH-056).
 *
 * The module's *lifecycle* is a rune initialiser (`$effect` + `setInterval`) and cannot run
 * outside the Svelte compiler — the same boundary `keyboardConfigHook.test.ts` records. What
 * **can** and **must** run here are the two pure adapters the poll calls: they are the only
 * place the daemon's snake_case wire fields (`battery_level_pct` / `battery_charging`) and the
 * host command's (`level_pct` / `charging`) are read, and a rename on either side is invisible
 * to every type checker across IPC. These cases pin that mapping, the honest `null` (never a
 * fabricated 0), and the resolution order the module documents (daemon → host OS → unknown) —
 * composed from the module's own adapters, so the order cannot drift from them.
 */
import { describe, test as it, expect } from "bun:test";
import {
  BATTERY_POLL_MS,
  sampleFromHostBattery,
  sampleFromSystemHealth,
} from "../batterySources.svelte";
import { EMPTY_BATTERY, firstBattery, type BatterySample } from "../batteryStatus";

describe("batterySources.svelte.ts — cadence", () => {
  it("re-polls the daemon/host reading every 5 s (the cadence both surfaces shared)", () => {
    expect(BATTERY_POLL_MS).toBe(5000);
  });
});

describe("sampleFromSystemHealth — the daemon's wire fields", () => {
  it("reads battery_level_pct / battery_charging onto levelPct / charging", () => {
    expect(sampleFromSystemHealth({ battery_level_pct: 80, battery_charging: true })).toEqual({
      levelPct: 80,
      charging: true,
    });
  });

  it("keeps an absent reading as null — never a fabricated 0", () => {
    // A daemon with no battery (a desktop base) answers null; a `?? 0` here would draw an
    // empty battery as "0%" (critical red) instead of the honest "—".
    expect(sampleFromSystemHealth({ battery_level_pct: null, battery_charging: null })).toEqual({
      levelPct: null,
      charging: null,
    });
  });
});

describe("sampleFromHostBattery — the host command's wire fields", () => {
  it("reads level_pct / charging onto levelPct / charging", () => {
    expect(sampleFromHostBattery({ level_pct: 42, charging: false })).toEqual({
      levelPct: 42,
      charging: false,
    });
  });

  it("keeps an absent host reading as null", () => {
    expect(sampleFromHostBattery({ level_pct: null, charging: null })).toEqual(EMPTY_BATTERY);
  });
});

describe("resolution order (daemon → host OS → unknown), via the module's adapters", () => {
  const daemon = (pct: number | null): BatterySample =>
    sampleFromSystemHealth({ battery_level_pct: pct, battery_charging: false });
  const host = (pct: number | null): BatterySample =>
    sampleFromHostBattery({ level_pct: pct, charging: true });

  it("prefers the daemon reading when it carries a level", () => {
    expect(firstBattery([daemon(70), host(20)])).toEqual({ levelPct: 70, charging: false });
  });

  it("falls back to the host OS battery when the daemon has none", () => {
    // The desktop-dev case the extraction was written for: the daemon cannot see the
    // laptop battery, but `system_host_battery` can — so it must be shown, not "—".
    expect(firstBattery([daemon(null), host(20)])).toEqual({ levelPct: 20, charging: true });
  });

  it("is unknown (—) when neither source has a level", () => {
    expect(firstBattery([daemon(null), host(null)])).toEqual(EMPTY_BATTERY);
  });
});
