import { describe, expect, test } from "bun:test";
import {
  aiIsUnavailable,
  classifyAiAvailability,
  type AiAvailability,
} from "../lib/aiAvailability";
import { describeEngine, isRealEngine } from "../lib/aiEngine";

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

  // REQ-A1775 / F-AI-022. The daemon reports its **serving path**, not a bare kind: with the default
  // `AMOS_BACKEND=mock` and the circuit breaker on by default, `get_status.engine`
  // is literally `mock+breaker` (`crates/amos-ai/src/server.rs` appends `+breaker`
  // / `+cache`). A decorated mock is still a mock — the same rule
  // `lib/aiEngine.ts::isRealEngine` and `lib/netguard.ts::canEnforce` already keep.
  test("a decorated mock is still a mock", () => {
    for (const engine of ["mock+breaker", "mock+cache", "mock+cache+breaker", " mock+breaker "]) {
      expect(
        classifyAiAvailability({ bridged: true, status: { engine, degraded: false } }),
      ).toBe("mock");
      expect(aiIsUnavailable(classifyAiAvailability({ bridged: true, status: { engine } }))).toBe(
        true,
      );
    }
  });

  // The positive control: the fix must not be "call every decorated name a mock".
  test("a decorated real engine is still real", () => {
    for (const engine of ["ollama+cache", "ggml+breaker", "api+cache+breaker"]) {
      expect(
        classifyAiAvailability({ bridged: true, status: { engine, degraded: false } }),
      ).toBe("real");
    }
  });

  // The two faces of one question must give one answer: this classifier and the
  // `EngineView` it must agree with. A corpus with decorations is what
  // discriminates — the bare names both already handle.
  test("agrees with the engine view's one 'is it real' answer", () => {
    const corpus = [
      "mock",
      "mock+breaker",
      "mock+cache+breaker",
      "api",
      "ollama+cache",
      "ggml+breaker",
      "hermes",
      " sherpa +cache ",
    ];
    for (const engine of corpus) {
      const viaView = isRealEngine(describeEngine({ engine, degraded: false }));
      const viaClassifier =
        classifyAiAvailability({ bridged: true, status: { engine, degraded: false } }) === "real";
      expect(viaClassifier).toBe(viaView);
    }
  });
});
