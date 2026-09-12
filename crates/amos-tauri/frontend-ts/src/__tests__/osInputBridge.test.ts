import { describe, expect, test } from "bun:test";
import { mapHardwareAction, mapKeyAction } from "../svelte/osInputBridge";

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

  test("mapKeyAction wires the H/V/A desktop shortcuts (lib/systemButtons)", () => {
    // Regression guard: keydown used to go through mapHardwareAction, which never
    // matched the single-letter shortcuts, so H/V/A silently did nothing.
    expect(mapKeyAction("h")).toBe("home");
    expect(mapKeyAction("H")).toBe("home");
    expect(mapKeyAction("v")).toBe("ai");
    expect(mapKeyAction("a")).toBe("ai");
    // Synthesized keydowns carrying a button name still navigate.
    expect(mapKeyAction("home")).toBe("home");
    expect(mapKeyAction("ai_assistant")).toBe("ai");
    expect(mapKeyAction("x")).toBeNull();
    expect(mapKeyAction(null)).toBeNull();
  });
});
