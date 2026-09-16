import { describe, expect, test } from "bun:test";
import {
  normalizeSnapshot,
  sensorCameraCount,
  sensorPixels,
  type SensorSnapshot,
} from "../lib/sensors";

const full: SensorSnapshot = {
  mode: "balanced",
  cameras: [
    { id: 0, width: 640, height: 480, fps: 30, format: "rgba8" },
    { id: 1, width: 320, height: 240, fps: 30, format: "rgba8" },
  ],
  gnss: {
    enabled: true,
    has_fix: true,
    latitude_deg: 31.23,
    longitude_deg: 121.47,
    accuracy_m: 5,
    sats: 11,
    fix_mode: "3d",
  },
  imu: {
    rate_hz: 200,
    accel_x: 0.1,
    accel_y: -9.8,
    accel_z: 0.2,
    gyro_x: 0.005,
    gyro_y: 0.001,
    gyro_z: -0.003,
    temp_c: 36.5,
  },
};

describe("normalizeSnapshot (daemon sensor_snapshot -> typed view)", () => {
  test("passes a complete payload through", () => {
    const s = normalizeSnapshot(full);
    expect(sensorCameraCount(s)).toBe(2);
    expect(s.mode).toBe("balanced");
    expect(s.gnss?.has_fix).toBe(true);
    expect(s.imu?.rate_hz).toBe(200);
    // Gyro fields are passed through (they appear on the snapshot from the daemon's
    // SensorService — this mirrors the live-path SensorImuDatum which already had them).
    expect(s.imu?.gyro_x).toBeCloseTo(0.005);
    expect(s.imu?.gyro_y).toBeCloseTo(0.001);
    expect(s.imu?.gyro_z).toBeCloseTo(-0.003);
  });

  test("null/absent payload yields an empty, safe view (never throws)", () => {
    const s = normalizeSnapshot(null);
    expect(sensorCameraCount(s)).toBe(0);
    expect(s.mode).toBe("unknown");
    expect(s.gnss).toBeNull();
    expect(s.imu).toBeNull();
  });

  test("a partial IMU block is normalized, not passed through raw (REQ-A294)", () => {
    // `normalizeSnapshot` documents "tolerating absent / partial fields … Never throws",
    // and `SensorPanel` formats the block (`snap.imu.temp_c.toFixed(1)` + `rate_hz` in the
    // sentence). A daemon that sends an imu block *without* temp_c therefore used to reach
    // the component with `undefined` and throw during render — the promise was in the doc
    // comment, not in the code.
    const s = normalizeSnapshot({ imu: { rate_hz: 200 } });
    expect(s.imu).not.toBeNull();
    expect(typeof s.imu!.rate_hz).toBe("number");
    // An absent reading is **unknown**, never a fabricated 0 (AEROSPACE P0-3).
    expect(s.imu!.temp_c).toBeNull();
    expect(s.imu!.accel_x).toBeNull();
    expect(s.imu!.gyro_z).toBeNull();
  });

  test("a malformed numeric field is unknown, not a plausible zero (REQ-A294)", () => {
    // `NaN`/strings/booleans out of a wire payload must not become 0.00 on screen: a
    // fabricated zero reads as "the device is perfectly still", which is a measurement.
    const s = normalizeSnapshot({
      imu: {
        rate_hz: "200",
        temp_c: Number.NaN,
        accel_x: Number.POSITIVE_INFINITY,
        accel_y: true,
        accel_z: 0.2,
        gyro_x: null,
        gyro_y: null,
        gyro_z: -0.003,
      },
    });
    expect(s.imu!.rate_hz).toBe(0);
    expect(s.imu!.temp_c).toBeNull();
    expect(s.imu!.accel_x).toBeNull();
    expect(s.imu!.accel_y).toBeNull();
    expect(s.imu!.accel_z).toBeCloseTo(0.2);
    expect(s.imu!.gyro_z).toBeCloseTo(-0.003);
    // …and the panel's formatting path never throws on any of it.
    expect(() => `${s.imu!.temp_c?.toFixed(1) ?? "-"}`).not.toThrow();
  });

  test("tolerates a partial / older payload and clamps the mode", () => {
    const s = normalizeSnapshot({ cameras: [{ id: 0, width: 4, height: 4 }], mode: "bogus" });
    expect(s.mode).toBe("unknown");
    expect(sensorPixels(s.cameras[0]!)).toBe(16);
    expect(s.gnss).toBeNull();
  });

  test("mode keys are stable for i18n", () => {
    expect(normalizeSnapshot({ mode: "power_save" }).mode).toBe("power_save");
    expect(normalizeSnapshot({ mode: "performance" }).mode).toBe("performance");
  });
});
