import { describe, it, expect, afterEach } from "vitest";
import {
  type SensorHostSnapshot,
  isAndroidBackend,
  readGnss,
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
    status: "fix",
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
    status: "searching",
    latitude_deg: 0,
    longitude_deg: 0,
    accuracy_m: -1,
  },
  imu: null,
  stream_gate: null,
};

describe("isAndroidBackend", () => {
  it("true when backend is android", () => {
    expect(isAndroidBackend(SNAP_WITH_FIX)).toBe(true);
  });
  it("false when backend is live", () => {
    expect(isAndroidBackend(SNAP_NO_FIX)).toBe(false);
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
  // REQ-A778 / F-SH-232: `0` is the platform's "no accuracy reported" sentinel
  // (`Location.getAccuracy()` returns 0.0 when the fix carries none), NOT a
  // sub-metre fix. Reading it as the first tier printed "±5 m" — a precision
  // claim the receiver never made and the user cannot tell from a real 5 m fix.
  it("— for 0 (the platform's 'no accuracy reported' sentinel), never ±5 m", () => {
    expect(accuracyLabel(0)).toBe("—");
    // The tiers above 0 keep their real readings (`0.5 m` IS a reported value).
    expect(accuracyLabel(0.5)).toBe("±5 m");
  });
  it("— for a non-finite accuracy (never the text ±NaN m / ±Infinity m)", () => {
    expect(accuracyLabel(Number.NaN)).toBe("—");
    expect(accuracyLabel(Number.POSITIVE_INFINITY)).toBe("—");
    expect(accuracyLabel(Number.NEGATIVE_INFINITY)).toBe("—");
  });
});

describe("describeLocation", () => {
  it("returns formatted lat,lon", () => {
    const d = describeLocation(39.9042, 116.4074);
    expect(d).toBe("39.904200, 116.407400");
  });
});

describe("readGnss —— 四种状态要分得开（REQ-A582）", () => {
  /** Point the bridge at a reply (or at a rejection), so each branch is reachable. */
  function bridgeWith(impl: (command: string) => unknown) {
    const calls: string[] = [];
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          calls.push(command);
          return impl(command);
        },
      },
    };
    return calls;
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("没有桥 ⇒ unavailable（不是\"本机没有 GNSS\"）", async () => {
    delete (globalThis as { window?: unknown }).window;
    expect(await readGnss()).toEqual({ kind: "unavailable" });
  });

  it("宿主答了但没有 gnss 字段 ⇒ absent，并带上快照", async () => {
    bridgeWith(() => ({ backend: "live", mode: "balanced", cameras: [], gnss: null, imu: null, stream_gate: null }));
    const r = await readGnss();
    expect(r.kind).toBe("absent");
    if (r.kind === "absent") expect(r.snap.backend).toBe("live");
  });

  it("接收器开着但没锁星 ⇒ no-fix/enabled=true（不是\"正在搜索\"以外的任何说法）", async () => {
    bridgeWith(() => ({ ...SNAP_WITH_FIX, gnss: { ...SNAP_WITH_FIX.gnss!, has_fix: false } }));
    expect(await readGnss()).toMatchObject({ kind: "no-fix", enabled: true });
  });

  it("接收器被人关掉 ⇒ no-fix/enabled=false（与\"搜索中\"分得开）", async () => {
    bridgeWith(() => ({ ...SNAP_WITH_FIX, gnss: { ...SNAP_WITH_FIX.gnss!, enabled: false, has_fix: false } }));
    expect(await readGnss()).toMatchObject({ kind: "no-fix", enabled: false });
  });

  it("有定位 ⇒ fix，带经纬度/精度，并且**最终真的发了那条命令**", async () => {
    const calls = bridgeWith(() => SNAP_WITH_FIX);
    const r = await readGnss();
    expect(calls).toEqual(["sensor_host_snapshot"]);
    expect(r.kind).toBe("fix");
    if (r.kind === "fix") {
      expect(r.location.latitude).toBeCloseTo(39.9042, 6);
      expect(r.location.longitude).toBeCloseTo(116.4074, 6);
      expect(r.location.accuracy).toBe(4.2);
      expect(r.snap.backend).toBe("android");
    }
  });
});

describe("readGnss —— 权限拒绝与读取失败各说各的（REQ-A772 / F-SH-228）", () => {
  function bridgeWith(impl: (command: string) => unknown) {
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: { invoke: async (command: string) => impl(command) },
    };
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  /** A snapshot whose receiver was not read at all, carrying the host's stated reason. */
  const withStatus = (status: string, over: Record<string, unknown> = {}) => ({
    ...SNAP_WITH_FIX,
    gnss: { ...SNAP_WITH_FIX.gnss!, has_fix: false, status, ...over },
  });

  it("读取因缺授权失败 ⇒ permission-required，绝不是 no-fix（旧说法是\"正在搜索\"）", async () => {
    bridgeWith(() => withStatus("permission-required"));
    const r = await readGnss();
    expect(r.kind).toBe("permission-required");
    expect(r.kind).not.toBe("no-fix");
  });

  it("读取因别的原因失败 ⇒ read-failed，且与 permission-required 分得开", async () => {
    bridgeWith(() => withStatus("read-failed"));
    const r = await readGnss();
    expect(r.kind).toBe("read-failed");
    expect(r.kind).not.toBe("permission-required");
  });

  it("两种失败态都带着快照，UI 才能顺带问同一个事实的其它问题", async () => {
    bridgeWith(() => withStatus("read-failed"));
    const r = await readGnss();
    if (r.kind === "read-failed") expect(r.snap.backend).toBe("android");
    else throw new Error("expected read-failed");
  });

  it("老载荷没带 status ⇒ 退回 has_fix/enabled 支持得起的那种说法，不编造失败原因", async () => {
    bridgeWith(() => ({
      ...SNAP_WITH_FIX,
      gnss: {
        enabled: true,
        has_fix: false,
        latitude_deg: 0,
        longitude_deg: 0,
        accuracy_m: -1,
      },
    }));
    expect(await readGnss()).toMatchObject({ kind: "no-fix", enabled: true });
  });

  it("status 说失败但真的有定位 ⇒ 仍报 fix（真定位不能被一个状态字藏起来）", async () => {
    bridgeWith(() => ({
      ...SNAP_WITH_FIX,
      gnss: { ...SNAP_WITH_FIX.gnss!, status: "read-failed" },
    }));
    expect((await readGnss()).kind).toBe("fix");
  });

  it("no-fix 的两种（接收器关掉 / 还在搜）仍由 enabled 分开", async () => {
    bridgeWith(() => withStatus("receiver-off", { enabled: false }));
    expect(await readGnss()).toMatchObject({ kind: "no-fix", enabled: false });
    bridgeWith(() => withStatus("searching", { enabled: true }));
    expect(await readGnss()).toMatchObject({ kind: "no-fix", enabled: true });
  });
});

