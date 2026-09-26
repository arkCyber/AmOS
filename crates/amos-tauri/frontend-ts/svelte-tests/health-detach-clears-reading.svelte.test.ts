/**
 * HealthApp.svelte — a `cleared` event must drop the live reading (REQ-A1804).
 *
 * `LiveSensorProvider::clear_samples` drops the bus's IMU / camera-frame / **vitals** stores
 * and announces `StreamChange::Cleared`; `SensorHost` fans that out as a `sensor-data` event
 * whose `kind` is `"cleared"`, and docs/sensors.md names glue detach as the producer
 * (「detach 清空防陈旧回读」). The event has a consumer on the other surface already:
 * `lib/sensorLive.applySensorLive` nulls its `lastImu` / `lastFrame` on that arm (REQ-A1800).
 *
 * The Health screen read only the `vitals` arm, so on a detach its `latest` sample survived:
 * the heart-rate tile kept drawing the pre-detach bpm as the **current** reading and the
 * "no sensor" line stayed hidden — the app asserting a measurement no sensor is producing any
 * more, exactly the stale-as-current outcome the bus clearing exists to prevent. (Today's step
 * figure is unaffected by design: it comes from `history.days`, a record of what was observed,
 * not from the live counter.)
 *
 * The pair below is discriminating: the value the detach must remove is on screen before the
 * event and gone after it.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import HealthApp from "../src/svelte/HealthApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { dayKey, HEALTH_COUNTER_KEY } from "../src/lib/health";
import type { SensorDataEvent } from "../src/lib/sensorEvents";
import { zh } from "../src/i18n/locales/zh";

/** A heart rate that cannot collide with a step count or an identifier on the screen. */
const DISTINCT_BPM = 137;
/**
 * The sentence a **bridged** screen shows once its producer detaches (REQ-A1886).
 *
 * It used to be `health.noSensor` — 「此设备没有提供健康读数 / 连接真机并允许…」 — which is false
 * here: a host answered, so the app is talking to a device, and the permission is beside the
 * point. The detach has its own sentence; the no-host copy is pinned in
 * `health-app.svelte.test.ts` for the case it is actually true of.
 */
const SENSOR_STOPPED = zh["health.sensorStopped"];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  setLocale("zh");
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/** One macrotask: `readHealthVitals()` is awaited inside the mount effect. */
const settle = () => new Promise((r) => setTimeout(r, 30));

function event(kind: SensorDataEvent["kind"], vitals: SensorDataEvent["vitals"]) {
  const ts = Date.now();
  const payload: SensorDataEvent = {
    ts_ms: ts,
    kind,
    backend: "sensor-glue",
    mode: "balanced",
    imu: null,
    frame: null,
    vitals,
    prev_mode: null,
  };
  return { payload };
}

/**
 * A bridge whose `listen` hands back the `sensor-data` handler so the test can push events
 * through the same normalizer the real listener uses.
 */
function installBridge(): () => ((e: { payload: unknown }) => void) {
  let handler: ((e: { payload: unknown }) => void) | null = null;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) =>
      cmd === "sensor_host_snapshot"
        ? { vitals: { timestamp_ms: Date.now(), steps_total: 1000, heart_rate_bpm: null } }
        : null,
    listen: async (_channel: string, h: (e: { payload: unknown }) => void) => {
      handler = h;
      return () => {};
    },
  };
  return () => handler!;
}

describe("HealthApp.svelte — a glue detach drops the live reading (REQ-A1804)", () => {
  test("the pre-detach heart rate is not drawn as the current one after `cleared`", async () => {
    const day = dayKey(Date.now());
    // A baseline already folded today, so the seed sample folds no delta and the tile's
    // step figure is stable while we watch the heart-rate cell alone.
    window.localStorage.setItem(HEALTH_COUNTER_KEY, JSON.stringify({ day, raw: 1000 }));

    const getHandler = installBridge();
    const h = render(HealthApp);
    await settle();

    getHandler()(event("vitals", { timestamp_ms: Date.now(), steps_total: 1000, heart_rate_bpm: DISTINCT_BPM }));
    await settle();
    expect(txt(h)).toContain(String(DISTINCT_BPM));

    // The producer detached: the bus dropped its vitals store and announced `Cleared`.
    getHandler()(event("cleared", null));
    await settle();

    expect(txt(h)).not.toContain(String(DISTINCT_BPM));
    // And the screen says why it has no reading, rather than silently blanking.
    expect(txt(h)).toContain(SENSOR_STOPPED);
    // The no-host sentence would be a false cause here: a host answered this snapshot.
    expect(txt(h)).not.toContain(zh["health.noSensor"]);
  });
});
