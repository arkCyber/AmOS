import { describe, expect, test } from "bun:test";
import { isNativeMicBackend, parseDeviceMicStatus } from "../lib/deviceMic";

describe("lib/deviceMic (always-on native mic)", () => {
  test("parseDeviceMicStatus maps a well-formed status", () => {
    expect(parseDeviceMicStatus({ running: true, backend: "aaudio", submitted: 3 })).toEqual({
      running: true,
      backend: "aaudio",
      submitted: 3,
    });
    expect(parseDeviceMicStatus({ running: false, backend: "none", submitted: 0 })).toEqual({
      running: false,
      backend: "none",
      submitted: 0,
    });
  });

  test("parseDeviceMicStatus is null for anything not a valid status", () => {
    expect(parseDeviceMicStatus(null)).toBeNull();
    expect(parseDeviceMicStatus(undefined)).toBeNull();
    expect(parseDeviceMicStatus("aaudio")).toBeNull();
    expect(parseDeviceMicStatus({ running: "yes", backend: "aaudio" })).toBeNull();
    expect(parseDeviceMicStatus({ running: false })).toBeNull();
    // Missing/malformed submitted clamps to 0 rather than crashing the UI.
    expect(parseDeviceMicStatus({ running: true, backend: "mock" })).toEqual({
      running: true,
      backend: "mock",
      submitted: 0,
    });
  });

  test("only native backends (aaudio/tinyalsa) count as a real device mic", () => {
    expect(isNativeMicBackend("aaudio")).toBe(true);
    expect(isNativeMicBackend("tinyalsa")).toBe(true);
    expect(isNativeMicBackend("mock")).toBe(false);
    expect(isNativeMicBackend("none")).toBe(false);
    expect(isNativeMicBackend("")).toBe(false);
    expect(isNativeMicBackend(null)).toBe(false);
    expect(isNativeMicBackend(undefined)).toBe(false);
  });
});
