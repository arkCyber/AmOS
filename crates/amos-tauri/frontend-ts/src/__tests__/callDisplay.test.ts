import { describe, expect, it } from "bun:test";
import { callerDisplayLabel, hasPeerNumber } from "../lib/callDisplay";

describe("callerDisplayLabel", () => {
  it("prefers a contact name, then the number, then unknown", () => {
    expect(callerDisplayLabel("+8613800000000", "Alice", "Unknown")).toBe("Alice");
    expect(callerDisplayLabel("+8613800000000", undefined, "Unknown")).toBe("+8613800000000");
    expect(callerDisplayLabel("", "", "Unknown")).toBe("Unknown");
    expect(callerDisplayLabel(undefined, undefined, "Unknown")).toBe("Unknown");
  });

  it("treats whitespace-only peers as unknown", () => {
    expect(callerDisplayLabel("   ", undefined, "未知")).toBe("未知");
    expect(callerDisplayLabel(" 123 ", undefined, "未知")).toBe("123");
  });

  it("falls through when the contact name is whitespace-only, and keeps a real one", () => {
    expect(callerDisplayLabel("+86 1", "   ", "Unknown")).toBe("+86 1");
    expect(callerDisplayLabel(undefined, "   ", "Unknown")).toBe("Unknown");
    // A non-blank contact name wins as provided (trimming is the resolver's job).
    expect(callerDisplayLabel("", "  Alice  ", "Unknown")).toBe("  Alice  ");
  });
});

describe("hasPeerNumber", () => {
  it("true only for a non-blank peer", () => {
    expect(hasPeerNumber("123")).toBe(true);
    expect(hasPeerNumber("  ")).toBe(false);
    expect(hasPeerNumber(undefined)).toBe(false);
  });
});
