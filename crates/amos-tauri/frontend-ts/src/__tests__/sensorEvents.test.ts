import { describe, expect, test } from "bun:test";
import {
  isKind,
  SENSOR_DATA_EVENT,
  subscribeSensorData,
  toSensorData,
  type SensorDataEvent,
} from "../lib/sensorEvents";

const IMU = {
  timestamp_ms: 123,
  accel_x: 0.1,
  accel_y: -9.8,
  accel_z: 0.2,
  gyro_x: 0,
  gyro_y: 0,
  gyro_z: 0,
  temperature_c: 36.5,
};

const FRAME = { id: 0, width: 640, height: 480, format: "nv21", seq: 4 };

describe("real-time sensor-data events (System UI SensorHost broadcast)", () => {
  test("event name matches the Rust bridge const", () => {
    expect(SENSOR_DATA_EVENT).toBe("sensor-data");
  });

  test("toSensorData accepts an imu event", () => {
    const raw = { ts_ms: 1, kind: "imu", backend: "live", mode: "balanced", imu: IMU, frame: null, prev_mode: null };
    const ev = toSensorData(raw);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe("imu");
    expect(ev!.backend).toBe("live");
    expect(ev!.imu!.accel_y).toBeCloseTo(-9.8);
    expect(ev!.frame).toBeNull();
  });

  test("toSensorData accepts a camera_frame metadata event", () => {
    const ev = toSensorData({ ts_ms: 2, kind: "camera_frame", backend: "live", mode: "balanced", imu: null, frame: FRAME, prev_mode: null });
    expect(ev).not.toBeNull();
    expect(ev!.frame!.format).toBe("nv21");
    expect(ev!.frame!.seq).toBe(4);
  });

  test("toSensorData accepts a mode change carrying prev_mode", () => {
    const ev = toSensorData({ ts_ms: 3, kind: "mode", backend: "live", mode: "power_save", imu: null, frame: null, prev_mode: "balanced" });
    expect(ev).not.toBeNull();
    expect(ev!.prev_mode).toBe("balanced");
    expect(ev!.mode).toBe("power_save");
    expect(isKind(ev!, "mode")).toBe(true);
  });

  test("toSensorData rejects garbage and family-kind payload gaps", () => {
    expect(toSensorData(null)).toBeNull();
    expect(toSensorData("nope")).toBeNull();
    expect(toSensorData({ kind: "imu" })).toBeNull(); // missing ts_ms
    expect(toSensorData({ ts_ms: 1, kind: "nope", imu: IMU, frame: null })).toBeNull();
    // A family kind demands its payload be present & well-shaped.
    expect(toSensorData({ ts_ms: 1, kind: "imu", imu: null, frame: null })).toBeNull();
    expect(toSensorData({ ts_ms: 1, kind: "imu", imu: { timestamp_ms: "x" }, frame: null })).toBeNull();
    expect(toSensorData({ ts_ms: 1, kind: "camera_frame", imu: null, frame: { id: "x" } })).toBeNull();
  });

  test("subscribeSensorData returns a no-op unsubscribe outside Tauri", async () => {
    // No window.__TAURI_INTERNALS__ bridge in the test env → no-op, never throws.
    const unsub = await subscribeSensorData(() => {});
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
  });

  test("isKind narrows correctly", () => {
    const ev: SensorDataEvent = { ts_ms: 1, kind: "cleared", backend: "live", mode: "balanced", imu: null, frame: null, prev_mode: null };
    expect(isKind(ev, "cleared")).toBe(true);
    expect(isKind(ev, "imu")).toBe(false);
  });
});
