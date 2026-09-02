import { describe, expect, test } from "bun:test";
import { buttonActionOf, keyActionOf } from "../lib/systemButtons";

describe("systemButtons", () => {
  test("buttonActionOf maps hardware-button payload strings", () => {
    expect(buttonActionOf("home")).toBe("home");
    expect(buttonActionOf("voice")).toBe("voice");
    expect(buttonActionOf("ai_assistant")).toBe("ai");
    expect(buttonActionOf("AI")).toBe("ai");
    expect(buttonActionOf("assistant")).toBe("ai");
    // Unknown / non-string payloads are ignored.
    expect(buttonActionOf("volume")).toBeNull();
    expect(buttonActionOf("")).toBeNull();
    expect(buttonActionOf(42)).toBeNull();
    expect(buttonActionOf({})).toBeNull();
  });

  test("keyActionOf maps desktop shortcuts", () => {
    expect(keyActionOf("h")).toBe("home");
    expect(keyActionOf("H")).toBe("home");
    expect(keyActionOf("v")).toBe("voice");
    expect(keyActionOf("a")).toBe("ai");
    expect(keyActionOf("x")).toBeNull();
  });
});
