/**
 * HealthApp.svelte — a refused history write must give the steps back on the next sample.
 *
 * `persistHealthTick` (lib/health.ts) writes the **counter baseline first, then the history**,
 * and says so: "If the history write is refused, the caller keeps its previous in-memory tick,
 * so the delta is recomputed and retried on the next sample — the failure direction is an
 * *under*-count, never a double-count." The order is what makes that true: with the baseline
 * still pointing at the last *stored* raw count, the next sample's delta spans both the refused
 * sample and the new one, so the retry lands the whole thing once.
 *
 * `applyVitals` adopted `next.counter` *before* reading the verdict — `counter = next.counter;`
 * on the line above the `if (persistHealthTick(next))`. On a store that refuses the history
 * write (a full localStorage) the baseline therefore advanced past steps the history never
 * received, and the next sample's delta started from the wrong place: those steps were dropped
 * for good. The screen would stay permanently short by the refused window, with the only
 * signal the write-error line (which the user can dismiss by reopening the app).
 *
 * The two leaves below are the discriminating pair: the refused-then-retried window lands in
 * full (this fails on the old shape, where it reads 100), and the ordinary path still adopts
 * the baseline (a control — the fix must not freeze the counter forever).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import HealthApp from "../src/svelte/HealthApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { dayKey, HEALTH_COUNTER_KEY, HEALTH_HISTORY_KEY, type HealthState } from "../src/lib/health";
import type { SensorDataEvent } from "../src/lib/sensorEvents";

/** The vitals event the host would push onto the `sensor-data` bus. */
function vitals(stepsTotal: number): { payload: SensorDataEvent } {
  const ts = Date.now();
  return {
    payload: {
      ts_ms: ts,
      kind: "vitals",
      backend: "sensor-glue",
      mode: "normal",
      imu: null,
      frame: null,
      vitals: { timestamp_ms: ts, steps_total: stepsTotal, heart_rate_bpm: null },
      prev_mode: null,
    },
  };
}

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = () => new Promise((r) => setTimeout(r, 30));

/** The stored history, read straight from the key the app writes. */
const storedSteps = (day: string): number | null => {
  const state = readStoreValue<unknown>(HEALTH_HISTORY_KEY, null) as HealthState | null;
  return state?.days.find((d) => d.day === day)?.steps ?? null;
};

/**
 * A bridge whose `listen` hands back the `sensor-data` handler so the test can push a sample,
 * and whose snapshot seeds the first reading.
 */
function installBridge(seedSteps: number): () => ((e: { payload: unknown }) => void) | null {
  let handler: ((e: { payload: unknown }) => void) | null = null;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd !== "sensor_host_snapshot") return null;
      const ts = Date.now();
      return { vitals: { timestamp_ms: ts, steps_total: seedSteps, heart_rate_bpm: null } };
    },
    listen: async (_channel: string, h: (e: { payload: unknown }) => void) => {
      handler = h;
      return () => {};
    },
  };
  return () => handler;
}

describe("HealthApp.svelte — a refused history write is retried, not dropped (REQ-A1454)", () => {
  test("steps from a refused write are recomputed into the next sample", async () => {
    const day = dayKey(Date.now());
    // A baseline the app already folded once: raw 1000 for today.
    window.localStorage.setItem(HEALTH_COUNTER_KEY, JSON.stringify({ day, raw: 1000 }));

    // Only the *history* write is refused — exactly the shape the counter-first order creates.
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    let refuseHistory = true;
    vi.spyOn(window.localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (refuseHistory && key === HEALTH_HISTORY_KEY) throw new Error("QuotaExceededError");
      return realSetItem(key, value);
    });

    const getHandler = installBridge(1100); // +100 since the baseline
    const h = render(HealthApp);
    await settle();

    // The seed sample was folded but its history write was refused: nothing was stored…
    expect(storedSteps(day)).toBeNull();
    expect(h.container.querySelector('[data-testid="store-write-error"]')).not.toBeNull();

    // …and now the store recovers and the next sample arrives at 1200.
    refuseHistory = false;
    getHandler()!(vitals(1200));
    await settle();

    // The retry must carry both deltas (+100 refused, +100 new) — 200, not 100.
    expect(storedSteps(day)).toBe(200);
    // The baseline moved with the history it belongs to, not ahead of it.
    expect(JSON.parse(window.localStorage.getItem(HEALTH_COUNTER_KEY)!).raw).toBe(1200);
  });

  test("an accepted write still adopts the baseline (control)", async () => {
    const day = dayKey(Date.now());
    window.localStorage.setItem(HEALTH_COUNTER_KEY, JSON.stringify({ day, raw: 1000 }));

    const getHandler = installBridge(1100);
    const h = render(HealthApp);
    await settle();

    expect(storedSteps(day)).toBe(100);
    expect(h.container.querySelector('[data-testid="store-write-error"]')).toBeNull();

    getHandler()!(vitals(1200));
    await settle();

    // Starting from the *stored* baseline (1100) the second delta is +100, not +200.
    expect(storedSteps(day)).toBe(200);
    expect(JSON.parse(window.localStorage.getItem(HEALTH_COUNTER_KEY)!).raw).toBe(1200);
  });
});
