/**
 * Component smoke test for LiveSensors — the small card that consumes the System
 * UI `SensorHost` real-time `sensor-data` feed (event-driven refresh logic itself
 * is unit-tested in src/__tests__/sensorLive.test.ts). Here we assert it mounts,
 * opens its listener and renders the localized waiting hint before any sample.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
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
/**
 * The same bridge, plus an answer for `sensor_host_snapshot` — the pull the location block makes.
 * Returns the command log so "a refresh really re-reads" is assertable.
 */
function installBridgeWithSnapshot(snapshot: unknown) {
  const callbacks = new Map<number, (payload: unknown) => void>();
  const calls: string[] = [];
  let nextId = 1;
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "plugin:event|listen") return 7;
      if (cmd === "sensor_host_snapshot") return snapshot;
      return null;
    },
    transformCallback: (cb: (payload: unknown) => void) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
  };
  return calls;
}

const SNAP_ANDROID_FIX = {
  backend: "android",
  mode: "balanced",
  cameras: [],
  gnss: { enabled: true, has_fix: true, latitude_deg: 39.9042, longitude_deg: 116.4074, accuracy_m: 4.2 },
  imu: null,
  stream_gate: null,
};

describe("LiveSensors — 「定位」把 lib/gps.ts 接进屏幕（REQ-A582）", () => {
  test("有定位：坐标 + 精度标签 + 设备徽标（数字来自宿主，不是自己编的）", async () => {
    setLocale("en");
    installBridgeWithSnapshot(SNAP_ANDROID_FIX);
    const { findByTestId, getByTestId } = render(LiveSensors);
    expect(((await findByTestId("gnss-state")).textContent ?? "").trim()).toBe("fix acquired");
    expect(((await findByTestId("gnss-coords")).textContent ?? "").trim()).toBe("39.904200, 116.407400");
    expect((await findByTestId("gnss-accuracy")).textContent ?? "").toContain("±5 m");
    expect(((await findByTestId("gnss-backend")).textContent ?? "").trim()).toBe("device GNSS");
  });

  test("宿主报告没有 GNSS 接收器 ⇒ 说\"本机没有 GNSS\"，不说\"定位未知\"", async () => {
    setLocale("en");
    installBridgeWithSnapshot({ ...SNAP_ANDROID_FIX, gnss: null, backend: "live" });
    const { findByTestId } = render(LiveSensors);
    expect(((await findByTestId("gnss-state")).textContent ?? "").trim()).toBe("this host has no GNSS");
    expect((await findByTestId("gnss-hint")).textContent ?? "").toContain("no GNSS receiver");
  });

  test("接收器开着但没锁星 ⇒ \"正在搜索卫星\"（与\"关闭\"分得开）", async () => {
    setLocale("en");
    installBridgeWithSnapshot({ ...SNAP_ANDROID_FIX, gnss: { ...SNAP_ANDROID_FIX.gnss, has_fix: false } });
    const { findByTestId } = render(LiveSensors);
    expect(((await findByTestId("gnss-state")).textContent ?? "").trim()).toBe("searching for satellites…");
  });

  test("接收器被关掉 ⇒ \"定位已关闭\"", async () => {
    setLocale("en");
    installBridgeWithSnapshot({
      ...SNAP_ANDROID_FIX,
      gnss: { ...SNAP_ANDROID_FIX.gnss, enabled: false, has_fix: false },
    });
    const { findByTestId } = render(LiveSensors);
    expect(((await findByTestId("gnss-state")).textContent ?? "").trim()).toBe("location is off");
  });

  test("没有桥 ⇒ \"未连接\"（不是\"本机没有 GNSS\"）", async () => {
    setLocale("en");
    const { findByTestId } = render(LiveSensors);
    expect(((await findByTestId("gnss-state")).textContent ?? "").trim()).toBe("not connected");
    expect((await findByTestId("gnss-hint")).textContent ?? "").toContain("did not answer");
  });

  test("「立即读取」真的再问一次宿主（不是只重画同一份旧读数）", async () => {
    setLocale("en");
    const calls = installBridgeWithSnapshot(SNAP_ANDROID_FIX);
    const { findByTestId, getByTestId } = render(LiveSensors);
    await findByTestId("gnss-coords");
    const reads = () => calls.filter((c) => c === "sensor_host_snapshot").length;
    const before = reads();
    await fireEvent.click(getByTestId("gnss-refresh"));
    await Promise.resolve();
    await tick();
    expect(reads()).toBeGreaterThan(before);
  });
});

