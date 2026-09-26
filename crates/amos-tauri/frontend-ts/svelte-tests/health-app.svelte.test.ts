/**
 * HealthApp.svelte — the reason the calories cell shows `—` (REQ-A1462).
 *
 * The cell has two ways to have no figure, and they are not the same fact: the user has not
 * recorded a weight, or there is no step reading to convert. `calories === null` is true for
 * **both**, so the old `{#if calories === null}` drew 「记录体重后可估算」 whenever either held —
 * telling a user who had already recorded a weight to record one, and promising a figure that
 * would still not appear (there were no steps to compute from). A rendered sentence asserting a
 * cause the code path never established, the shape F-SH-709 / REQ-A1419 record.
 *
 * The two cases below are that discriminating pair: the weight is recorded and there is still no
 * figure (the sentence must be absent), and there is a reading but no weight (it must be there).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import HealthApp from "../src/svelte/HealthApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { dayKey, HEALTH_HISTORY_KEY, HEALTH_PROFILE_KEY } from "../src/lib/health";
import { zh } from "../src/i18n/locales/zh";

/** The sentence under test, taken from the locale rather than re-typed. */
const NO_WEIGHT_HINT = zh["health.caloriesNoWeight"];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  setLocale("zh");
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/** One macrotask: `readHealthVitals()` is awaited inside the mount effect. */
const settle = () => new Promise((r) => setTimeout(r, 30));

/** A host whose sensor snapshot carries `vitals` (`null` = the device reported no wellness pair). */
function installBridge(vitals: unknown) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => (cmd === "sensor_host_snapshot" ? { vitals } : null),
    listen: async () => () => {},
  };
}

describe("HealthApp.svelte — the calories cell says why it has no figure (REQ-A1462)", () => {
  test("a recorded weight is not asked for again when there is no reading at all", async () => {
    writeStoreValue(HEALTH_PROFILE_KEY, { weightKg: 70 });
    installBridge(null); // no vitals block on the wire
    const h = render(HealthApp);
    await settle();

    // The weight really is recorded — so "add your weight to estimate" would be false.
    const input = h.container.querySelector("input#health-weight") as HTMLInputElement | null;
    expect(input?.value).toBe("70");
    expect(txt(h)).not.toContain(NO_WEIGHT_HINT);
  });

  test("with a step reading but no weight the hint is the established reason", async () => {
    // The hint's premise is a **daily figure** to convert (REQ-A1454: an unreported day is not
    // a 0-step day), so the day's row has to exist for the missing weight to be the cause.
    const today = dayKey(Date.now());
    writeStoreValue(HEALTH_HISTORY_KEY, {
      days: [{ day: today, steps: 120, steps_recorded: true, hr_min: null, hr_max: null }],
      workouts: [],
    });
    installBridge({ timestamp_ms: Date.now(), steps_total: 1234, heart_rate_bpm: null });
    const h = render(HealthApp);
    await settle();

    expect(txt(h)).toContain(NO_WEIGHT_HINT);
  });
});

/**
 * The no-reading banner names the cause it can actually see (REQ-A1886).
 *
 * The banner used to be one boolean over one sentence, so it told a user to 「连接真机并允许…权限」
 * whenever it had no sample — including on the S5, which **is** connected, **has** granted
 * `ACTIVITY_RECOGNITION`, and (verified on device) has registered its step counter: there is
 * simply no sample until the first step. The pair below is exactly what that collapsed: the same
 * rendered screen state ("no sample") now yields two different sentences by bridge.
 */
describe("HealthApp.svelte — the no-reading banner names its cause (REQ-A1886)", () => {
  test("a shell with no host at all asks for a phone and a permission", async () => {
    // No `__TAURI_INTERNALS__`: `invoke` degrades to `null`, the "not bridged" signal.
    const h = render(HealthApp);
    await settle();

    expect(txt(h)).toContain(zh["health.noSensor"]);
    expect(txt(h)).not.toContain(zh["health.noReadingYet"]);
  });

  test("a connected host with no sample yet does not tell the user to connect", async () => {
    // The S5 case: the snapshot answers (a device IS connected) and carries no vitals yet.
    installBridge(null);
    const h = render(HealthApp);
    await settle();

    expect(txt(h)).toContain(zh["health.noReadingYet"]);
    // The defect, pinned: this is the sentence that told a connected, granted phone to connect.
    expect(txt(h)).not.toContain(zh["health.noSensor"]);
  });
});
