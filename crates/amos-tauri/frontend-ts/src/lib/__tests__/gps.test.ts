import { describe, it, expect } from "vitest";
import {
  type SensorHostSnapshot,
  gnssEnabled,
  gnssHasFix,
  gnssStatus,
  isAndroidBackend,
  sensorMode,
  accuracyLabel,
  describeLocation,
} from "../gps";

const SNAP_WITH_FIX: SensorHostSnapshot = {
  backend: "android",
  mode: "balanced",
  cameras: [],
  gnss: {
    enabled: true,
    has_fix: true,
    latitude_deg: 39.9042,
    longitude_deg: 116.4074,
    accuracy_m: 4.2,
  },
  imu: null,
  stream_gate: null,
};

const SNAP_NO_FIX: SensorHostSnapshot = {
  backend: "live",
  mode: "balanced",
  cameras: [],
  gnss: {
    enabled: true,
    has_fix: false,
    latitude_deg: 0,
    longitude_deg: 0,
    accuracy_m: -1,
  },
  imu: null,
  stream_gate: null,
};

const SNAP_NO_GNSS: SensorHostSnapshot = {
  backend: "live",
  mode: "balanced",
  cameras: [],
  gnss: null,
  imu: null,
  stream_gate: null,
};

const SNAP_DISABLED: SensorHostSnapshot = {
  backend: "android",
  mode: "balanced",
  cameras: [],
  gnss: {
    enabled: false,
    has_fix: false,
    latitude_deg: 0,
    longitude_deg: 0,
    accuracy_m: -1,
  },
  imu: null,
  stream_gate: null,
};

describe("gnssEnabled", () => {
  it("true when gnss.enabled is true", () => {
    expect(gnssEnabled(SNAP_WITH_FIX)).toBe(true);
  });
  it("false when gnss is null", () => {
    expect(gnssEnabled(SNAP_NO_GNSS)).toBe(false);
  });
  it("false when gnss.enabled is false", () => {
    expect(gnssEnabled(SNAP_DISABLED)).toBe(false);
  });
});

describe("gnssHasFix", () => {
  it("true when has_fix is true", () => {
    expect(gnssHasFix(SNAP_WITH_FIX)).toBe(true);
  });
  it("false when has_fix is false", () => {
    expect(gnssHasFix(SNAP_NO_FIX)).toBe(false);
  });
  it("false when gnss is null", () => {
    expect(gnssHasFix(SNAP_NO_GNSS)).toBe(false);
  });
});

describe("gnssStatus", () => {
  it("returns full location when fix exists", () => {
    const s = gnssStatus(SNAP_WITH_FIX)!;
    expect(s.enabled).toBe(true);
    expect(s.has_fix).toBe(true);
    expect(s.location).toEqual({
      latitude: 39.9042,
      longitude: 116.4074,
      accuracy: 4.2,
      timestamp: expect.any(Number),
    });
  });
  it("returns null location when has_fix is false", () => {
    const s = gnssStatus(SNAP_NO_FIX)!;
    expect(s.enabled).toBe(true);
    expect(s.has_fix).toBe(false);
    expect(s.location).toBe(null);
  });
  it("returns null when gnss is null (desktop / unbound)", () => {
    expect(gnssStatus(SNAP_NO_GNSS)).toBe(null);
  });
});

describe("isAndroidBackend", () => {
  it("true when backend is android", () => {
    expect(isAndroidBackend(SNAP_WITH_FIX)).toBe(true);
  });
  it("false when backend is live", () => {
    expect(isAndroidBackend(SNAP_NO_FIX)).toBe(false);
  });
});

describe("sensorMode", () => {
  it("returns the mode string", () => {
    expect(sensorMode(SNAP_WITH_FIX)).toBe("balanced");
  });
  it("returns 'unknown' when snap is null", () => {
    expect(sensorMode(null as any)).toBe("unknown");
  });
  it("returns 'unknown' when snap.mode is missing", () => {
    // Mode is read from snap.mode; missing/empty → 'unknown'
    const noMode = { ...SNAP_WITH_FIX, mode: "" as any };
    expect((noMode as any).mode).toBe("");
    // sensorMode should fall back to 'unknown' for empty/missing mode
    expect(sensorMode(noMode)).toBe("unknown");
  });
});

describe("accuracyLabel", () => {
  it("±5 m for ≤5 m", () => {
    expect(accuracyLabel(3)).toBe("±5 m");
    expect(accuracyLabel(5)).toBe("±5 m");
  });
  it("±15 m for ≤15 m", () => {
    expect(accuracyLabel(6)).toBe("±15 m");
    expect(accuracyLabel(15)).toBe("±15 m");
  });
  it("±50 m for ≤50 m", () => {
    expect(accuracyLabel(16)).toBe("±50 m");
    expect(accuracyLabel(50)).toBe("±50 m");
  });
  it("rounded for >50 m", () => {
    expect(accuracyLabel(100)).toBe("±100 m");
  });
  it("— for negative", () => {
    expect(accuracyLabel(-1)).toBe("—");
  });
});

describe("describeLocation", () => {
  it("returns formatted lat,lon", () => {
    const d = describeLocation(39.9042, 116.4074);
    expect(d).toBe("39.904200, 116.407400");
  });
});
