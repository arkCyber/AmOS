import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (ev: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();
type Mode = "balanced" | "performance" | "power_save";
let mode: Mode = "balanced";

const invoke = async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "sensor_set_mode") {
    const m = args?.mode;
    if (m === "performance" || m === "power_save" || m === "balanced") mode = m;
  }
  if (cmd === "sensor_snapshot") {
    return {
      mode,
      cameras: [{ id: 0, width: 640, height: 480, fps: 30, format: "rgba8" }],
      gnss: {
        enabled: true,
        has_fix: true,
        latitude_deg: 31.23,
        longitude_deg: 121.47,
        accuracy_m: 5,
        sats: 11,
        fix_mode: "3d",
      },
      imu: { rate_hz: 200, accel_x: 0, accel_y: -9.8, accel_z: 0, temp_c: 36.5 },
    };
  }
  return "ok";
};

beforeEach(() => {
  mode = "balanced";
  window.localStorage.setItem("amos-ui.locale", "en"); // deterministic UI language
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: (channel: string, cb: Listener) => {
      listeners.set(channel, cb);
      return () => {
        listeners.delete(channel);
      };
    },
  };
});

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  listeners.clear();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const wait = () => new Promise((r) => setTimeout(r, 0));
async function flush() {
  await act(async () => {
    await wait();
    await wait();
  });
}

async function mountPanel() {
  const Panel = (await import("../components/SensorPanel")).default;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <Panel />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

describe("SensorPanel (fake __TAURI_INTERNALS__, DOM)", () => {
  test("renders the snapshot readout rows from sensor_snapshot", async () => {
    const host = await mountPanel();
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("Device sensors");
    expect(text).toContain("Cameras:");
    expect(text).toContain("GNSS:");
    expect(text).toContain("IMU @200 Hz");
  });

  test("switching the energy mode calls sensor_set_mode and reflects the result", async () => {
    const host = await mountPanel();
    await flush();

    const powerBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Power save",
    );
    expect(powerBtn).toBeTruthy();
    await act(async () => {
      powerBtn!.click();
    });
    await flush();

    const pressed = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Power save",
    );
    expect(pressed?.getAttribute("aria-pressed")).toBe("true");
  });

  test("renders nothing when the daemon is not bridged (no broken card)", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const host = await mountPanel();
    await flush();
    expect(host.childNodes.length).toBe(0);
  });
});
