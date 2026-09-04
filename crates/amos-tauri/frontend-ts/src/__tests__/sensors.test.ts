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
  imu: { rate_hz: 200, accel_x: 0.1, accel_y: -9.8, accel_z: 0.2, temp_c: 36.5 },
};

describe("normalizeSnapshot (daemon sensor_snapshot -> typed view)", () => {
  test("passes a complete payload through", () => {
    const s = normalizeSnapshot(full);
    expect(sensorCameraCount(s)).toBe(2);
    expect(s.mode).toBe("balanced");
    expect(s.gnss?.has_fix).toBe(true);
    expect(s.imu?.rate_hz).toBe(200);
  });

  test("null/absent payload yields an empty, safe view (never throws)", () => {
    const s = normalizeSnapshot(null);
    expect(sensorCameraCount(s)).toBe(0);
    expect(s.mode).toBe("unknown");
    expect(s.gnss).toBeNull();
    expect(s.imu).toBeNull();
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
