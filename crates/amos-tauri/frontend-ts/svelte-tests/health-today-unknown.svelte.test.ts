/**
 * HealthApp.svelte — a day with no history row is "no reading" in the headline too, not "0 steps".
 *
 * `todaySteps` reads the day's total out of the history and folded a **missing row** through
 * `?? 0`, so the moment the device reported *any* cumulative count the top tile printed
 * 「今日步数 0」 — even though the app has no baseline for the day and therefore no daily figure.
 * The device's `steps_total` is cumulative since boot; on the first sample of a day the delta is
 * unknowable, so `applyVitalsTick` deliberately re-baselines **without** creating a day row.
 *
 * The tell is the sibling on the same screen: the seven-day strip already carries
 * `RecentDay.recorded` and draws 「无读数」 for exactly that day (REQ-A1454, pinned in
 * health-week-unknown.svelte.test.ts). The headline contradicted it — one screen, two answers
 * for the same day, and the loud one was a fabricated measurement.
 *
 * The pair below is the discriminator: no row → the headline claims nothing; a row genuinely
 * sampled at 7 steps → the headline still reports the real figure (the fix must not erase a
 * real reading).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import HealthApp from "../src/svelte/HealthApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { dayKey, HEALTH_HISTORY_KEY, type HealthState } from "../src/lib/health";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS;
});

const settle = () => new Promise((r) => setTimeout(r, 30));

/** A host whose sensor snapshot carries one cumulative step reading. */
function installBridge(stepsTotal: number) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) =>
      cmd === "sensor_host_snapshot"
        ? { vitals: { timestamp_ms: Date.now(), steps_total: stepsTotal, heart_rate_bpm: null } }
        : null,
    listen: async () => () => {},
  };
}

/** The value printed under the tile whose label is `label` (the big number's div). */
function tileValue(container: HTMLElement, label: string): string | null {
  const labelEl = [...container.querySelectorAll("div")].find(
    (d) => d.children.length === 0 && (d.textContent ?? "").trim() === label,
  );
  return labelEl?.nextElementSibling?.textContent?.trim() ?? null;
}

describe("HealthApp.svelte — 没有今天的记录就不报「0 步」(REQ-A1454)", () => {
  test("首次观测：设备给了累计读数，但今天没有记录 → 印「—」，不是 0", async () => {
    installBridge(5000); // a real cumulative reading, but no baseline for today yet
    const h = render(HealthApp);
    await settle();

    // The reading is on the wire (so the "no sensor" banner is not the case)…
    expect(h.container.textContent).not.toContain(zh["health.noSensor"]);
    // …but the day's total is unknowable: no row was ever folded in.
    expect(tileValue(h.container, zh["health.stepsToday"])).toBe("—");
    // The sibling the strip already draws for that same day must agree.
    expect(h.container.textContent).toContain(zh["health.noReading"]);
  });

  test("今天真有一条 7 步的记录 → 标题照常报 7（对照）", async () => {
    const today = dayKey(Date.now());
    const state: HealthState = {
      days: [{ day: today, steps: 7, steps_recorded: true, hr_min: null, hr_max: null }],
      workouts: [],
    };
    writeStoreValue(HEALTH_HISTORY_KEY, state);
    installBridge(999);
    const h = render(HealthApp);
    await settle();

    expect(tileValue(h.container, zh["health.stepsToday"])).toBe("7");
  });
});
