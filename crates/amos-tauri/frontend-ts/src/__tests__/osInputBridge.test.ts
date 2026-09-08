import { describe, expect, test } from "bun:test";
import { mapHardwareAction, mapTelephonyPhase } from "../svelte/osInputBridge";

describe("osInputBridge — React-free shell event mapping", () => {
  test("mapHardwareAction maps home/back → home, ai/voice → ai", () => {
    expect(mapHardwareAction("home")).toBe("home");
    expect(mapHardwareAction("HOME")).toBe("home");
    expect(mapHardwareAction("back")).toBe("home");
    expect(mapHardwareAction("ai")).toBe("ai");
    expect(mapHardwareAction("voice")).toBe("ai");
    expect(mapHardwareAction("assistant")).toBe("ai");
    // Rust serializes the AiAssistant button as "ai_assistant" (see buttons.rs).
    expect(mapHardwareAction("ai_assistant")).toBe("ai");
    expect(mapHardwareAction("")).toBeNull();
    expect(mapHardwareAction(null)).toBeNull();
    expect(mapHardwareAction("settings")).toBeNull();
  });

  test("mapTelephonyPhase classifies phases and rejects others", () => {
    expect(mapTelephonyPhase({ phase: "Ringing" })).toBe("ringing");
    expect(mapTelephonyPhase({ phase: "active" })).toBe("active");
    expect(mapTelephonyPhase({ phase: "ended" })).toBe("ended");
    expect(mapTelephonyPhase({ phase: "hold" })).toBeNull();
    expect(mapTelephonyPhase(null)).toBeNull();
    expect(mapTelephonyPhase("nope")).toBeNull();
  });
});
