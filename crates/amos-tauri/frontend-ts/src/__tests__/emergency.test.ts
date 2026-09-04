import { describe, expect, test } from "bun:test";
import { EMERGENCY_QUICK_NUMBER, quickEmergencyNumber } from "../lib/emergency";

describe("emergency quick-dial source", () => {
  test("product default is the CN police code 110", () => {
    expect(EMERGENCY_QUICK_NUMBER).toBe("110");
  });

  test("region selection mirrors the Rust EmergencyMap::quick_dial", () => {
    expect(quickEmergencyNumber("CN")).toBe("110");
    expect(quickEmergencyNumber(" cn ")).toBe("110"); // case/space-insensitive
    expect(quickEmergencyNumber("JP")).toBe("110");
    expect(quickEmergencyNumber("US")).toBe("911");
    expect(quickEmergencyNumber("AU")).toBe("911");
    expect(quickEmergencyNumber("GB")).toBe("112");
    expect(quickEmergencyNumber("DE")).toBe("112");
    expect(quickEmergencyNumber("XX")).toBe("112"); // universal default
    expect(quickEmergencyNumber("")).toBe("112");
  });

  test("recognized codes are always within the platform emergency family", () => {
    // The lock-screen one-tap number must itself classify as emergency so the
    // daemon routes it on the privileged path, never as a regular SIM call.
    const known = new Set(["110", "112", "911", "119", "120", "122", "999", "000"]);
    expect(known.has(EMERGENCY_QUICK_NUMBER)).toBe(true);
    expect(known.has(quickEmergencyNumber("US"))).toBe(true);
    expect(known.has(quickEmergencyNumber("GB"))).toBe(true);
  });
});
