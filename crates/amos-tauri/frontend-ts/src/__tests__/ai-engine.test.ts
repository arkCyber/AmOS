import { describe, expect, test } from "bun:test";
import { describeEngine, isRealEngine, type EngineView } from "../lib/aiEngine";

const blank: EngineView = {
  engine: "",
  kind: "",
  engine_model: "",
  degraded: false,
  asr: "",
  accelerator: "",
  profile: null,
  pool: null,
  cache: null,
  logSink: null,
  breaker: null,
  alerts: null,
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

  test("a decorator never turns a mock into a 'real engine'", () => {
    // The daemon reports its serving *path*: with the circuit breaker on by default
    // (REQ-A131) a mock daemon reports `mock+breaker`. Calling that "real" would be
    // exactly the overstatement this view exists to prevent.
    const v = describeEngine({
      engine: "mock+breaker",
      engine_model: "amos-mock",
      degraded: false,
      asr: "mock",
    });
    expect(v.engine).toBe("mock+breaker");
    expect(v.kind).toBe("mock");
    expect(isRealEngine(v)).toBe(false);

    // …and a genuinely real engine stays real with decorators attached.
    const real = describeEngine({ engine: "ollama+breaker+cache", engine_model: "qwen2.5" });
    expect(real.kind).toBe("ollama");
    expect(isRealEngine(real)).toBe(true);

    // An unreachable daemon is unknown, not real.
    expect(isRealEngine(describeEngine(null))).toBe(false);
  });

  test("surfaces the breaker block, including 'not in the path'", () => {
    const on = describeEngine({
      engine: "mock+breaker",
      breaker: {
        enabled: true,
        state: "open",
        fail_threshold: 3,
        cooldown_seconds: 30,
        consecutive_failures: 3,
        openings: 1,
        rejections: 7,
        failures: 3,
        successes: 12,
      },
    });
    expect(on.breaker?.enabled).toBe(true);
    expect(on.breaker?.state).toBe("open");
    expect(on.breaker?.rejections).toBe(7);
    expect(on.breaker?.fail_threshold).toBe(3);

    // Disabled ⇒ an empty state, i.e. "not in the serving path" — never "closed".
    const off = describeEngine({ engine: "mock", breaker: { enabled: false } });
    expect(off.breaker?.enabled).toBe(false);
    expect(off.breaker?.state).toBe("");

    // A daemon that does not report the block at all ⇒ null (unknown), not zeros.
    expect(describeEngine({ engine: "mock" }).breaker).toBeNull();
    expect(describeEngine(null).breaker).toBeNull();
  });

  test("keeps 'no alerts' and 'not told' apart (REQ-A133)", () => {
    // An empty list is the daemon telling us it checked and nothing fired.
    expect(describeEngine({ engine: "mock", alerts: { alerts: [] } }).alerts).toEqual([]);
    // Absent block = an older daemon ⇒ unknown, NOT "all clear".
    expect(describeEngine({ engine: "mock" }).alerts).toBeNull();
    expect(describeEngine(null).alerts).toBeNull();
  });

  test("surfaces each alert with its numbers intact", () => {
    const v = describeEngine({
      engine: "mock+breaker",
      alerts: {
        alerts: [
          {
            id: "breaker_open",
            severity: "error",
            detail: "the circuit breaker is open: generations are being skipped",
            active_for_seconds: 12,
          },
          { id: "power_throttled", severity: "warn", active_for_seconds: 0 },
        ],
      },
    });
    expect(v.alerts).toHaveLength(2);
    expect(v.alerts?.[0]?.id).toBe("breaker_open");
    expect(v.alerts?.[0]?.severity).toBe("error");
    expect(v.alerts?.[0]?.active_for_seconds).toBe(12);
    // A missing detail/severity is empty, never invented.
    expect(v.alerts?.[1]?.detail).toBe("");
    expect(v.alerts?.[1]?.severity).toBe("warn");
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

  test("parses the generation admission pool block (REQ-A43)", () => {
    const v = describeEngine({
      engine: "ollama",
      generation_pool: {
        capacity: 16,
        in_flight: 3,
        available: 13,
        acquired_total: 42,
        rejected_saturated: 2,
        rejected_timeout: 1,
        wait_ms: 250,
      },
    });
    expect(v.pool).toEqual({
      capacity: 16,
      in_flight: 3,
      available: 13,
      acquired_total: 42,
      rejected_saturated: 2,
      rejected_timeout: 1,
      wait_ms: 250,
    });
  });

  test("a pool block absent => pool null (unknown, never fabricated)", () => {
    expect(describeEngine({ engine: "ollama" }).pool).toBeNull();
    expect(describeEngine(null).pool).toBeNull();
  });

  test("derives available from capacity when the daemon omits it", () => {
    const v = describeEngine({ engine: "ollama", generation_pool: { capacity: 8 } });
    expect(v.pool?.available).toBe(8);
    expect(v.pool?.in_flight).toBe(0);
  });

  test("parses the response cache block, including the honest default-off state (REQ-A44)", () => {
    const off = describeEngine({
      engine: "ollama",
      response_cache: { enabled: false },
    });
    expect(off.cache).toEqual({
      enabled: false,
      capacity: 0,
      ttl_seconds: 0,
      entries: 0,
      hits: 0,
      misses: 0,
      stores: 0,
      evicted: 0,
      expired: 0,
      oversized: 0,
    });
    const on = describeEngine({
      engine: "ollama",
      response_cache: {
        enabled: true,
        capacity: 32,
        ttl_seconds: 300,
        entries: 5,
        hits: 9,
        misses: 4,
        stores: 5,
        evicted: 1,
        expired: 2,
        oversized: 3,
      },
    });
    expect(on.cache?.enabled).toBe(true);
    expect(on.cache?.hits).toBe(9);
    expect(on.cache?.capacity).toBe(32);
  });

  test("a cache block absent => cache null (older daemon, unknown)", () => {
    expect(describeEngine({ engine: "ollama" }).cache).toBeNull();
    expect(describeEngine(null).cache).toBeNull();
  });

  test("parses the on-disk log sink block, incl. the honest stdout-only state (REQ-A87)", () => {
    // Off: no file sink ⇒ enabled=false with zeros — "stdout only", not "unknown".
    const off = describeEngine({
      engine: "ollama",
      log_sink: { enabled: false, path: "" },
    });
    expect(off.logSink).toEqual({
      enabled: false,
      path: "",
      bytes_written: 0,
      lost_bytes: 0,
      write_failures: 0,
      rotations: 0,
      active_bytes: 0,
    });
    // On, and *incomplete*: the counters that mean "the trail lost data" survive.
    const lossy = describeEngine({
      engine: "ollama",
      log_sink: {
        enabled: true,
        path: "/home/u/.amos/logs/amos-ai.log",
        bytes_written: 4096,
        lost_bytes: 128,
        write_failures: 3,
        rotations: 2,
        active_bytes: 512,
      },
    });
    expect(lossy.logSink?.enabled).toBe(true);
    expect(lossy.logSink?.path).toBe("/home/u/.amos/logs/amos-ai.log");
    expect(lossy.logSink?.lost_bytes).toBe(128);
    expect(lossy.logSink?.write_failures).toBe(3);
    expect(lossy.logSink?.rotations).toBe(2);
  });

  test("a log_sink block absent => logSink null (never a fabricated sink)", () => {
    expect(describeEngine({ engine: "ollama" }).logSink).toBeNull();
    expect(describeEngine(null).logSink).toBeNull();
  });
});
