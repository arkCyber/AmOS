import { describe, expect, test } from "bun:test";
import { describeEngine, isRealEngine, type EngineView } from "../lib/aiEngine";

const blank: EngineView = {
  engine: "",
  engine_model: "",
  degraded: false,
  asr: "",
  accelerator: "",
  profile: null,
};

describe("describeEngine (daemon get_status -> truthful engine view)", () => {
  test("unreachable daemon (null) reports an empty/unknown view, never 'mock'", () => {
    expect(describeEngine(null)).toEqual(blank);
    expect(describeEngine(undefined)).toEqual(blank);
  });

  test("a present reply without engine fields back-compat to mock", () => {
    const v = describeEngine({ model: "amos-infer@0.1.0" });
    expect(v.engine).toBe("mock");
    expect(v.degraded).toBe(false);
  });

  test("surfaces the real engine + model + asr", () => {
    const v = describeEngine({
      model: "amos-infer@0.1.0",
      engine: "ollama",
      engine_model: "qwen2.5",
      degraded: false,
      asr: "sherpa",
    });
    expect(v.engine).toBe("ollama");
    expect(v.engine_model).toBe("qwen2.5");
    expect(v.degraded).toBe(false);
    expect(v.asr).toBe("sherpa");
    expect(isRealEngine(v)).toBe(true);
  });

  test("flags degraded when a real engine was requested but mock is serving", () => {
    const v = describeEngine({
      engine: "mock",
      engine_model: "amos-mock",
      degraded: true,
      asr: "mock",
    });
    expect(v.degraded).toBe(true);
    expect(isRealEngine(v)).toBe(false);
  });

  test("trims whitespace and tolerates missing optional fields", () => {
    const v = describeEngine({
      engine: "  ollama  ",
      degraded: true,
    });
    expect(v.engine).toBe("ollama");
    expect(v.engine_model).toBe("");
    expect(v.asr).toBe("");
    expect(v.accelerator).toBe("");
    expect(v.degraded).toBe(true);
    expect(v.profile).toBeNull();
  });

  test("surfaces the resolved accelerator for a local engine, empty otherwise", () => {
    // A local GGML engine reports the concrete target the daemon resolved.
    const local = describeEngine({
      engine: "ggml",
      engine_model: "qwen2.5:0.5b.gguf",
      degraded: false,
      accelerator: "android/nnapi",
    });
    expect(local.accelerator).toBe("android/nnapi");
    // Remote/managed backends carry no accelerator (never "auto", never fabricated).
    const remote = describeEngine({ engine: "ollama", accelerator: "" });
    expect(remote.accelerator).toBe("");
  });

  test("parses the daemon profile when present", () => {
    const v = describeEngine({
      engine: "ollama",
      profile: { decode_tokens_per_sec: 12.5, ttft_ms: 240.1, decode_tokens_total: 200, decode_runs: 16 },
    });
    expect(v.profile).toEqual({
      decode_tokens_per_sec: 12.5,
      ttft_ms: 240.1,
      decode_tokens_total: 200,
      decode_runs: 16,
    });
  });

  test("a present profile with zero runs still yields a profile (not null)", () => {
    const v = describeEngine({ engine: "mock", profile: { decode_runs: 0 } });
    expect(v.profile?.decode_runs).toBe(0);
    expect(v.profile?.decode_tokens_total).toBe(0);
  });
});
