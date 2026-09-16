/**
 * Component smoke test for LiveSensors — the small card that consumes the System
 * UI `SensorHost` real-time `sensor-data` feed (event-driven refresh logic itself
 * is unit-tested in src/__tests__/sensorLive.test.ts). Here we assert it mounts,
 * opens its listener and renders the localized waiting hint before any sample.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import LiveSensors from "../src/svelte/LiveSensors.svelte";
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

/**
 * Install a minimal Tauri event bridge and return the registered callbacks, so a test can
 * dispatch a real `sensor-data` payload at the component (same shape `wm.test.ts` uses).
 */
function installEventBridge() {
  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextId = 1;
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => (cmd === "plugin:event|listen" ? 7 : null),
    transformCallback: (cb: (payload: unknown) => void) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
  };
  return callbacks;
}

describe("LiveSensors (System UI live sensor feed card)", () => {
  test("mounts, starts its feed listener and shows a waiting hint", () => {
    setLocale("en");
    const { container } = render(LiveSensors);
    const text = container.textContent ?? "";
    expect(text).toContain("Sensor live feed");
    // No sample has been pushed in this harness → the honest waiting hint.
    expect(text).toContain("Waiting for live samples");
  });

  test("an axis the daemon did not report renders as unknown, never as 0.00 (REQ-A294)", async () => {
    setLocale("en");
    const callbacks = installEventBridge();
    const { container } = render(LiveSensors);
    await tick();
    // One real axis; every other field is absent from the payload.
    callbacks.forEach((cb) =>
      cb({
        event: "sensor-data",
        id: 7,
        payload: {
          ts_ms: 1,
          kind: "imu",
          backend: "live",
          mode: "balanced",
          imu: { timestamp_ms: 1, accel_y: -9.8 },
          frame: null,
          prev_mode: null,
        },
      }),
    );
    await tick();
    const text = container.textContent ?? "";
    expect(text).toContain("-9.80");
    expect(text).toContain("—");
    // The fabricated reading the old `?? 0` produced: a "perfectly still" device.
    expect(text).not.toContain("0.00");
  });
});
