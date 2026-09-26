/**
 * The 诊断页 sensor card's GNSS fix line must not print `±0m` for a **real** fix.
 *
 * REQ-A1623 / F-SH-825 folded the two zero-sentinel wires (`accuracy_m` / `sats`) so the
 * wire's "not reported" `0` no longer becomes a measurement, and its render test asserts
 * `±0m` never appears. That test only feeds the sentinel `0` — the fold removes the *value*,
 * but the card's own formatter (`SensorPanel.gnssFixLabel`) still rounded the number with a
 * bare `acc.toFixed(0)`, so a genuine sub-metre accuracy (a real high-precision fix) printed
 * `±0m`: the very "perfect precision" string the round set out to end, and one the sibling
 * `gps.ts::accuracyLabel` never emits (it tiers a positive accuracy). These tests feed the
 * *real* value the sentinel test cannot, and pin the honest reading.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import SensorPanel from "../src/svelte/SensorPanel.svelte";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = () => new Promise((r) => setTimeout(r, 60));
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

/** Render the panel over one GNSS fix snapshot and return its text. */
async function renderFix(gnss: Record<string, unknown>): Promise<string> {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "sensor_snapshot") {
        return { mode: "balanced", cameras: [], gnss, imu: null };
      }
      return null;
    },
    listen: async () => () => {},
  };
  const host = render(SensorPanel);
  await settle();
  return txt(host);
}

describe("SensorPanel GNSS fix line — the ± accuracy clause (REQ-A1624)", () => {
  test("a real sub-metre accuracy is not printed as `±0m`", async () => {
    // A 0.4 m accuracy is a measurement — a *good* fix — and `±0m` would claim a precision
    // the receiver never made (the string the sentinel test already forbids for `0`).
    const text = await renderFix({
      enabled: true,
      has_fix: true,
      latitude_deg: 31.23,
      longitude_deg: 121.47,
      accuracy_m: 0.4,
      sats: 9,
      fix_mode: "3d",
    });
    expect(text).toContain("31.23000");
    expect(text).not.toContain("±0m");
    // …it is stated, rounded up to the honest 1 m, not dropped.
    expect(text).toContain("±1m");
    expect(text).toContain("9sats");
  });

  test("a non-positive accuracy is dropped, never printed as `±-1m`", async () => {
    // A negative accuracy is not a precision; the sibling `gps.ts::accuracyLabel` renders it
    // as unknown too. The clause drops out of the fix line rather than being invented.
    const text = await renderFix({
      enabled: true,
      has_fix: true,
      latitude_deg: 31.23,
      longitude_deg: 121.47,
      accuracy_m: -1,
      sats: 9,
      fix_mode: "3d",
    });
    expect(text).toContain("31.23000");
    expect(text).not.toContain("±-1m");
    // The real satellite count beside it is untouched (positive control on the sibling field).
    expect(text).toContain("9sats");
  });

  test("a real accuracy keeps its magnitude (positive control)", async () => {
    // Guards against "always ±1m" passing the test above.
    const text = await renderFix({
      enabled: true,
      has_fix: true,
      latitude_deg: 31.23,
      longitude_deg: 121.47,
      accuracy_m: 4.2,
      sats: 9,
      fix_mode: "3d",
    });
    expect(text).toContain("±4m");
    expect(text).toContain("9sats");
  });
});
