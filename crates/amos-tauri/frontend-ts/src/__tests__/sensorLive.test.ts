import { afterEach, describe, expect, test } from "bun:test";
import {
  applySensorLive,
  createSensorLive,
  initialSensorLive,
  toHostSeed,
  type SensorLiveState,
} from "../lib/sensorLive";
import type { SensorDataEvent } from "../lib/sensorEvents";

function imuEv(ts: number): SensorDataEvent {
  return {
    ts_ms: ts,
    kind: "imu",
    backend: "live",
    mode: "balanced",
    imu: { timestamp_ms: ts, accel_x: 0.1, accel_y: -9.8, accel_z: 0.2, gyro_x: 0, gyro_y: 0, gyro_z: 0, temperature_c: 36.5 },
    frame: null,
    vitals: null,
    prev_mode: null,
  };
}
function frameEv(ts: number): SensorDataEvent {
  return {
    ts_ms: ts,
    kind: "camera_frame",
    backend: "live",
    mode: "balanced",
    imu: null,
    frame: { id: 0, width: 640, height: 480, format: "nv21", seq: ts },
    vitals: null,
    prev_mode: null,
  };
}

describe("lib/sensorLive (real-time System-UI sensor feed accumulator)", () => {
  test("initial state is empty and not listening", () => {
    const s = initialSensorLive();
    expect(s.listening).toBe(false);
    expect(s.mode).toBe("unknown");
    expect(s.imuCount).toBe(0);
    expect(s.lastImu).toBeNull();
    expect(s.totalEvents).toBe(0);
  });

  test("applySensorLive folds an imu event (event-driven refresh)", () => {
    let s = initialSensorLive();
    s = applySensorLive(s, imuEv(10));
    expect(s.imuCount).toBe(1);
    expect(s.totalEvents).toBe(1);
    expect(s.mode).toBe("balanced");
    expect(s.backend).toBe("live");
    expect(s.lastImu?.accel_y).toBeCloseTo(-9.8);
    expect(s.lastFrame).toBeNull();
  });

  test("applySensorLive keeps per-family counters and last payloads", () => {
    let s = initialSensorLive();
    s = applySensorLive(s, imuEv(1));
    s = applySensorLive(s, frameEv(2));
    s = applySensorLive(s, imuEv(3));
    expect(s.imuCount).toBe(2);
    expect(s.frameCount).toBe(1);
    expect(s.lastImu?.timestamp_ms).toBe(3);
    expect(s.lastFrame?.seq).toBe(2);
    // an imu event never clears the last frame
    expect(s.lastFrame?.id).toBe(0);
  });

  test("applySensorLive tracks mode changes with prev_mode and clears", () => {
    let s = initialSensorLive();
    s = applySensorLive(s, { ts_ms: 1, kind: "mode", backend: "live", mode: "power_save", imu: null, frame: null, vitals: null, prev_mode: "balanced" });
    expect(s.mode).toBe("power_save");
    expect(s.modeCount).toBe(1);
    expect(s.prevMode).toBe("balanced");
    s = applySensorLive(s, { ts_ms: 2, kind: "cleared", backend: "live", mode: "power_save", imu: null, frame: null, vitals: null, prev_mode: null });
    expect(s.clearCount).toBe(1);
    expect(s.totalEvents).toBe(2);
  });

  test("a cleared event drops the retained samples, not just bumps a counter", () => {
    let s = initialSensorLive();
    s = applySensorLive(s, imuEv(1));
    s = applySensorLive(s, frameEv(2));
    expect(s.lastImu).not.toBeNull();
    expect(s.lastFrame).not.toBeNull();

    // A producer cleared every stored sample (glue detach). The Rust bus really dropped
    // its IMU/frame stores (`amos_sensor::LiveSensorProvider::clear_samples`), so the live
    // view must stop presenting the pre-detach sample as the *current* one — the card
    // renders `lastImu`/`lastFrame` as "the latest", and a detach is not a reading.
    s = applySensorLive(s, { ts_ms: 3, kind: "cleared", backend: "live", mode: "balanced", imu: null, frame: null, vitals: null, prev_mode: null });
    expect(s.lastImu).toBeNull();
    expect(s.lastFrame).toBeNull();
    // The clear is still counted, the identity survives, and the counters stay history.
    expect(s.clearCount).toBe(1);
    expect(s.imuCount).toBe(1);
    expect(s.frameCount).toBe(1);
    expect(s.mode).toBe("balanced");

    // Positive control: a sample pushed *after* the clear is shown again, so the two
    // `toBeNull()` assertions cannot be satisfied by an "always null" regression.
    s = applySensorLive(s, imuEv(4));
    expect(s.lastImu?.timestamp_ms).toBe(4);
    expect(s.lastFrame).toBeNull();
  });

  test("createSensorLive notifies subscribers and resets", () => {
    const live = createSensorLive();
    const seen: SensorLiveState[] = [];
    const unsub = live.subscribe((s) => seen.push(s));

    live.pushRaw(imuEv(5));
    expect(live.snapshot().imuCount).toBe(1);
    expect(seen[seen.length - 1]?.imuCount).toBe(1);

    // Garbage is never folded in.
    live.pushRaw(null);
    live.pushRaw({ ts_ms: 1, kind: "nope" });
    expect(live.snapshot().totalEvents).toBe(1);

    live.reset();
    expect(live.snapshot().imuCount).toBe(0);
    expect(live.snapshot().backend).toBe("live"); // kept after reset

    unsub();
    live.pushRaw(imuEv(6));
    expect(seen.length).toBe(2); // unchanged after unsubscribe (2 sets before it)
  });

  test("toHostSeed pulls backend/mode from a host snapshot and tolerates junk", () => {
    expect(toHostSeed({ backend: "live", mode: "balanced", cameras: [] })).toEqual({ backend: "live", mode: "balanced" });
    expect(toHostSeed({ backend: "live" })).toEqual({ backend: "live", mode: "" });
    expect(toHostSeed(null)).toBeNull();
    expect(toHostSeed({ cameras: [] })).toBeNull();
  });
});

describe("createSensorLive().start(): `listening` is a claim about the wire, not an intention", () => {
  const setWin = (v: unknown) => {
    (globalThis as { window?: unknown }).window = v;
  };
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("no bridge ⇒ start() resolves but `listening` stays false (REQ-A838 / F-SH-267)", async () => {
    // `listening` is documented as "whether the `sensor-data` listener is open" and the settings
    // card renders it as a live pulse. The old `start()` set it `true` *before* awaiting the
    // subscription — so off-device (or on a refused listen) the card asserted that samples were
    // flowing while nothing was on the wire, and the honest "等待实时样本…" state was unreachable.
    const live = createSensorLive();
    const stop = await live.start();
    expect(live.snapshot().listening).toBe(false);
    expect(() => stop()).not.toThrow(); // nothing to release, and that must not throw
  });

  test("refused listen ⇒ `listening` stays false, even though the bridge exists", async () => {
    setWin({
      __TAURI_INTERNALS__: {
        invoke: async () => null,
        listen: async () => {
          throw new Error("event plugin refused the registration");
        },
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    });
    const live = createSensorLive();
    await live.start();
    expect(live.snapshot().listening).toBe(false);
  });

  test("established listen ⇒ `listening` is true, and the cleanup closes it", async () => {
    setWin({
      __TAURI_INTERNALS__: {
        invoke: async () => null,
        listen: async () => () => {},
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    });
    const live = createSensorLive();
    const stop = await live.start();
    expect(live.snapshot().listening).toBe(true);
    stop();
    expect(live.snapshot().listening).toBe(false);
  });
});
