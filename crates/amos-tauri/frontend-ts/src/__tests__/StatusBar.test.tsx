import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import StatusBar from "../components/StatusBar";
import { writeStoreValue } from "../lib/amosStore";
import { FLASHLIGHT_KEY, SETTINGS_KEY } from "../lib/settings";
import { SOUND_KEY } from "../lib/sound";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function installBridge(systemHealth: unknown, hostBatteryPayload?: unknown) {
  const invoke = async (cmd: string) => {
    if (cmd === "system_health") return systemHealth;
    if (cmd === "system_host_battery") return hostBatteryPayload ?? null;
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}


function mount() {
  window.localStorage.clear();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<StatusBar />);
  mounted.push({ root, host });
  return host;
}

const icon = (host: HTMLElement, name: string): HTMLElement | null =>
  host.querySelector(`[data-icon="${name}"]`);

describe("StatusBar vector icons (SF-style, no emoji)", () => {
  test("default (no settings): shows wifi + bluetooth icons, no DND moon", async () => {
    const host = mount();
    await act(async () => {});
    expect(icon(host, "wifi")).not.toBeNull();
    expect(icon(host, "bluetooth")).not.toBeNull();
    expect(icon(host, "moon")).toBeNull();
    // Vector swap regression guard: no emoji / text-bar battery remain.
    expect(host.textContent).not.toContain("▮▮▮");
    expect(host.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  test("airplane mode replaces wifi/bluetooth with the airplane icon", async () => {
    const host = mount();
    await act(async () => {});
    await act(async () => {
      writeStoreValue(SETTINGS_KEY, { wifi: true, bluetooth: true, airplane: true });
    });
    expect(icon(host, "airplane")).not.toBeNull();
    expect(icon(host, "wifi")).toBeNull();
    expect(icon(host, "bluetooth")).toBeNull();
  });

  test("Do-Not-Disturb shows the persistent moon icon", async () => {
    const host = mount();
    await act(async () => {});
    expect(icon(host, "moon")).toBeNull();
    await act(async () => {
      writeStoreValue(SETTINGS_KEY, { dnd: true });
    });
    expect(icon(host, "moon")).not.toBeNull();
    expect(icon(host, "moon")?.getAttribute("aria-label")).toBe("do not disturb");
  });

  test("muted ring/vibrate policy shows the muted-bell icon", async () => {
    const host = mount();
    await act(async () => {});
    await act(async () => {
      writeStoreValue(SOUND_KEY, { ring: false, vibrate: false, noise: false });
    });
    expect(icon(host, "mutedBell")).not.toBeNull();
    expect(icon(host, "mutedBell")?.getAttribute("aria-label")).toBe("alerts muted");
  });

  test("battery shows an honest glyph + — when no real source reports a level", async () => {
    // No daemon bridge and (in happy-dom) no host Battery API → honest unknown.
    const host = mount();
    await act(async () => {});
    const batt = host.querySelector('[aria-label="battery level"]');
    expect(batt).not.toBeNull();
    expect(batt?.querySelector("svg")).not.toBeNull();
    expect(batt?.textContent ?? "").toContain("—"); // never a fabricated %
  });

  test("battery shows a REAL percentage when the daemon reports a level", async () => {
    installBridge({ battery_level_pct: 80, battery_charging: false });
    const host = mount();
    await act(async () => {});
    await new Promise((r) => setTimeout(r, 5)); // let the async poll resolve
    await act(async () => {});
    const batt = host.querySelector('[aria-label="battery level"]');
    expect(batt?.textContent ?? "").toContain("80%");
  });

  test("host battery fills the bar when the daemon has no /proc reading (desktop)", async () => {
    // macOS desktop: daemon system_health has no battery; the Tauri host command
    // reads the real laptop battery → the bar is NOT an empty "—".
    installBridge({}, { level_pct: 75, charging: false });
    const host = mount();
    await act(async () => {});
    await new Promise((r) => setTimeout(r, 5)); // let the async poll resolve
    await act(async () => {});
    const batt = host.querySelector('[aria-label="battery level"]');
    expect(batt?.textContent ?? "").toContain("75%");
  });

  test("flashlight indicator appears only while the torch is lit", async () => {
    const host = mount();
    await act(async () => {});
    expect(icon(host, "flashlight")).toBeNull();

    // Torch present but off → no indicator.
    await act(async () => {
      writeStoreValue(FLASHLIGHT_KEY, { on: false, torch_present: true });
    });
    expect(icon(host, "flashlight")).toBeNull();

    // Lit → indicator.
    await act(async () => {
      writeStoreValue(FLASHLIGHT_KEY, { on: true, torch_present: true });
    });
    expect(icon(host, "flashlight")).not.toBeNull();

    // OS turns it off (external note) → indicator disappears.
    await act(async () => {
      writeStoreValue(FLASHLIGHT_KEY, { on: false, torch_present: true });
    });
    expect(icon(host, "flashlight")).toBeNull();
  });
});
