import { describe, expect, test } from "bun:test";
import {
  aiIsUnavailable,
  classifyAiAvailability,
  type AiAvailability,
} from "../lib/aiAvailability";

describe("AI availability classifier", () => {
  test("outside Tauri is offline (even with a fake status)", () => {
    expect(classifyAiAvailability({ bridged: false, status: null })).toBe("offline");
    expect(
      classifyAiAvailability({ bridged: false, status: { engine: "api", degraded: false } }),
    ).toBe("offline");
  });

  test("bridged but not yet probed is unknown", () => {
    expect(classifyAiAvailability({ bridged: true, status: null })).toBe("unknown");
  });

  test("mock engine (or empty) / degraded is mock", () => {
    expect(classifyAiAvailability({ bridged: true, status: { engine: "mock" } })).toBe("mock");
    expect(classifyAiAvailability({ bridged: true, status: {} })).toBe("mock");
    // degraded = a real engine was requested but the daemon serves mock.
    expect(
      classifyAiAvailability({ bridged: true, status: { engine: "api", degraded: true } }),
    ).toBe("mock");
  });

  test("a real engine is real", () => {
    for (const engine of ["api", "ollama", "hermes", "anthropic", "gemini"]) {
      expect(
        classifyAiAvailability({ bridged: true, status: { engine, degraded: false } }),
      ).toBe("real");
    }
  });

  test("aiIsUnavailable reflects offline/mock", () => {
    for (const a of ["offline", "mock"] as AiAvailability[]) {
      expect(aiIsUnavailable(a)).toBe(true);
    }
    for (const a of ["unknown", "real"] as AiAvailability[]) {
      expect(aiIsUnavailable(a)).toBe(false);
    }
  });
});
