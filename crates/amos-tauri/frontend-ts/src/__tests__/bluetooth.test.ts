/**
 * Pure unit tests for the Bluetooth view model (lib/bluetooth.ts).
 */
import { describe, expect, test } from "bun:test";
import {
  MY_DEVICE_NAME,
  btGlyph,
  btInit,
  normalizeBt,
  renameDevice,
  setDiscoverable,
  DEMO_DEVICES,
} from "../lib/bluetooth";

describe("bluetooth config", () => {
  test("defaults to the device name and discoverable-on", () => {
    expect(btInit()).toEqual({ name: "AmOS", discoverable: true });
    expect(MY_DEVICE_NAME).toBe("AmOS");
  });

  test("setDiscoverable toggles the flag", () => {
    const off = setDiscoverable(btInit(), false);
    expect(off.discoverable).toBe(false);
    expect(setDiscoverable(off, true).discoverable).toBe(true);
  });

  test("renameDevice trims; blank falls back to the default", () => {
    expect(renameDevice(btInit(), "  MyPhone  ").name).toBe("MyPhone");
    expect(renameDevice(btInit(), "   ").name).toBe(MY_DEVICE_NAME);
  });

  test("normalizeBt coerces junk and keeps valid values", () => {
    expect(normalizeBt(null)).toEqual({ name: "AmOS", discoverable: true });
    expect(normalizeBt("x")).toEqual({ name: "AmOS", discoverable: true });
    expect(normalizeBt({ name: "Phone", discoverable: false })).toEqual({
      name: "Phone",
      discoverable: false,
    });
    expect(normalizeBt({ name: "  ", discoverable: 1 }).name).toBe("AmOS");
  });
});

describe("bluetooth demo device list", () => {
  test("glyph maps each kind", () => {
    expect(btGlyph("audio")).toBe("🎧");
    expect(btGlyph("watch")).toBe("⌚");
    expect(btGlyph("keyboard")).toBe("⌨️");
    expect(btGlyph("phone")).toBe("📱");
    expect(btGlyph("other")).toBe("🔌");
  });

  test("demo list is non-empty and has unique ids", () => {
    expect(DEMO_DEVICES.length).toBeGreaterThan(0);
    expect(new Set(DEMO_DEVICES.map((d) => d.id)).size).toBe(DEMO_DEVICES.length);
  });
});
