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
});

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

  test("battery shows a glyph + live percentage text", async () => {
    const host = mount();
    await act(async () => {});
    expect(host.querySelector('[aria-label="battery level"]')).not.toBeNull();
    expect(host.textContent).toMatch(/%$/);
    expect(host.querySelector('[aria-label="battery level"]')?.querySelector("svg")).not.toBeNull();
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
