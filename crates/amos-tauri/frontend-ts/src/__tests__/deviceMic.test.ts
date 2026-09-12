import { describe, expect, test } from "bun:test";
import { isNativeMicBackend } from "../lib/deviceMic";

describe("lib/deviceMic (always-on native mic)", () => {
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
