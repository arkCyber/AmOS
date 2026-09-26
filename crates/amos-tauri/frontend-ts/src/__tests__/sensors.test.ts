import { describe, expect, test } from "bun:test";
import {
  gnssAccuracyLabel,
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
    expect(s.imu!.rate_hz).toBe(200);
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
    expect(s.imu!.rate_hz).toBeNull();
    expect(s.imu!.temp_c).toBeNull();
    expect(s.imu!.accel_x).toBeNull();
    expect(s.imu!.accel_y).toBeNull();
    expect(s.imu!.accel_z).toBeCloseTo(0.2);
    expect(s.imu!.gyro_z).toBeCloseTo(-0.003);
    // …and the panel's formatting path never throws on any of it.
    expect(() => `${s.imu!.temp_c?.toFixed(1) ?? "-"}`).not.toThrow();
  });

  test("an un-negotiated IMU rate is unknown, not 0 Hz (REQ-A1612)", () => {
    // The wire's `uint32 rate_hz` has no field presence, and the producer writes `0` to
    // mean "not negotiated yet" (`amos-sensor`'s `LiveSensorProvider::set_imu_rate_hz`;
    // the domain core "treats 0 as unknown"). Left unfolded, the panel printed `@0 Hz` —
    // a fabricated rate measurement. `0` must read as **unknown**, exactly like an absent
    // field; a genuinely negotiated rate survives.
    const unnegotiated = normalizeSnapshot({ imu: { rate_hz: 0, temp_c: 36.5 } });
    expect(unnegotiated.imu!.rate_hz).toBeNull();
    // Positive control: a real rate is not coerced away.
    const negotiated = normalizeSnapshot({ imu: { rate_hz: 100 } });
    expect(negotiated.imu!.rate_hz).toBe(100);
  });

  test("an unreported accuracy / satellite count is unknown, not ±0m and 0sats (REQ-A1623)", () => {
    // Both GNSS wires are zero-sentinel: the proto's `double accuracy_m` / `uint32
    // sats_in_view` have no field presence, Android's `getAccuracy()` returns `0.0` for a
    // fix with no estimate, and `Location` carries no satellite count (the producer writes
    // `0` for "not reported"). `SensorPanel`'s `gnssFixLabel` gates `±…` / `…sats` on
    // `null`, so an unknown field has to arrive as `null` — otherwise it prints
    // `±0m · 0sats`, a precision and a count the receiver never gave (`gps.ts::accuracyLabel`
    // already renders that same `0` as `—`, one field over).
    const noEstimate = normalizeSnapshot({
      gnss: {
        enabled: true,
        has_fix: true,
        latitude_deg: 31.23,
        longitude_deg: 121.47,
        accuracy_m: 0,
        sats: 0,
      },
    });
    expect(noEstimate.gnss!.accuracy_m).toBeNull();
    expect(noEstimate.gnss!.sats).toBeNull();
    // Positive control: a real fix keeps both readings (the fold must not swallow them).
    const real = normalizeSnapshot({
      gnss: {
        enabled: true,
        has_fix: true,
        latitude_deg: 31.23,
        longitude_deg: 121.47,
        accuracy_m: 4.2,
        sats: 9,
      },
    });
    expect(real.gnss!.accuracy_m).toBe(4.2);
    expect(real.gnss!.sats).toBe(9);
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

describe("gnssAccuracyLabel (the fix line's ± accuracy clause)", () => {
  test("a real sub-metre accuracy is never rounded down to `±0m` (REQ-A1624)", () => {
    // `±0m` is the exact string the wire's zero sentinel produced before REQ-A1623 folded it
    // (that round's own render test asserts it must not appear). But folding the sentinel
    // only removes the `0` *value*: a genuine 0.4 m accuracy — a real high-precision fix —
    // still went through `acc.toFixed(0)` and printed `±0m`, a *perfect* precision claim
    // the receiver never made. A positive accuracy is a measurement; rounding it up to 1 m
    // is the conservative direction, and it is the rule `gps.ts::accuracyLabel` follows one
    // snapshot over.
    expect(gnssAccuracyLabel(0.4)).toBe("±1m");
    expect(gnssAccuracyLabel(0.4)).not.toBe("±0m");
    expect(gnssAccuracyLabel(0.0001)).toBe("±1m");
    // Positive control: a real accuracy keeps its (rounded) magnitude, so "always ±1m"
    // would fail here.
    expect(gnssAccuracyLabel(4.2)).toBe("±4m");
    expect(gnssAccuracyLabel(12.6)).toBe("±13m");
    expect(gnssAccuracyLabel(5)).toBe("±5m");
  });

  test("a `≤ 0` / non-finite accuracy is unknown, not a `±-1m` claim (REQ-A1624)", () => {
    // The platform's sentinel is `0` (already folded to `null` upstream), and a negative or
    // non-finite wire value is not a precision either — the sibling `gps.ts::accuracyLabel`
    // renders all three the same way. The clause is *dropped* (`null`), exactly as an absent
    // field is dropped from the fix line rather than invented.
    expect(gnssAccuracyLabel(0)).toBeNull();
    expect(gnssAccuracyLabel(-1)).toBeNull();
    expect(gnssAccuracyLabel(Number.NaN)).toBeNull();
    expect(gnssAccuracyLabel(Number.POSITIVE_INFINITY)).toBeNull();
    expect(gnssAccuracyLabel(null)).toBeNull();
  });
});
