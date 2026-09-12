/**
 * Pure interpretation of the daemon's `get_status` engine fields, so any surface
 * (Settings card, AI chat header, …) renders the *same* truthful engine view.
 *
 * Contract with `amos-ai` (see `proto/ai_agent.proto` StatusReply):
 *  - engine:      mock | api | ollama | hermes | ggml | anthropic | gemini
 *  - engine_model: concrete model behind `engine` (empty when mock)
 *  - degraded:    a real engine was requested but the daemon serves mock
 *  - asr:         mock | sherpa | off
 *
 * When the daemon is unreachable (`null`) the view is empty (unknown), so a UI
 * never claims "mock" for a daemon that isn't there.
 */
export interface EngineProfile {
  /** Generated tokens streamed to the client per second (0 when no runs). */
  decode_tokens_per_sec: number;
  /** Mean first-token latency, ms (0 when no runs). */
  ttft_ms: number;
  /** Generated tokens since daemon start. */
  decode_tokens_total: number;
  /** Completed decode turns (>0 ⇒ data present). */
  decode_runs: number;
}

export interface EngineView {
  /** Active inference engine kind; "" when the daemon is unreachable. */
  engine: string;
  /**
   * The engine **kind** with decorator suffixes stripped — the value that answers
   * "is a real engine serving?". The daemon reports its serving *path* in `engine`
   * (e.g. `mock+breaker`, `ollama+cache`), so comparing the raw name against "mock"
   * would call a decorated mock a real engine. `""` when unreachable.
   */
  kind: string;
  /** Concrete model behind the engine ("" when mock / unknown). */
  engine_model: string;
  /** True when a real engine was requested but the daemon serves mock. */
  degraded: boolean;
  /** Voice ASR backend in effect ("" when unknown). */
  asr: string;
  /** Resolved device-acceleration target of a *local* engine, e.g. "android/nnapi"
   * or "qualcomm/qnn"; "" when not applicable (remote/mock) or unknown. */
  accelerator: string;
  /** Rolling decode-profile (tokens/s + TTFT); null when not reported. */
  profile: EngineProfile | null;
  /** Generation admission pool live state (REQ-A43); null when the daemon did
   * not report it (older daemon / unreachable). */
  pool: GenerationPoolView | null;
  /** Inference-response cache counters (REQ-A44); null when not reported.
   * `enabled=false` is the honest default-off state, not "unknown". */
  cache: ResponseCacheView | null;
  /** On-disk log sink health (REQ-A87); null when the daemon did not report it
   * (older daemon / unreachable). `enabled=false` = stdout-only, not "unknown". */
  logSink: LogSinkView | null;
  /** Backend circuit breaker (REQ-A131); null when the daemon did not report it.
   * `enabled=false` = not in the serving path, which is also why `state` is then
   * empty rather than a fabricated "closed". */
  breaker: BreakerView | null;
  /** Active threshold alerts (REQ-A133); null when the daemon did not report the
   * block at all. An **empty array** is the honest healthy state (no rule fired) and
   * is deliberately different from null ("we were not told"). */
  alerts: AlertView[] | null;
}

/** One active threshold alert, derived by the daemon from counters it already
 * reports (REQ-A133). `active_for_seconds` counts from when *that daemon process*
 * first saw the condition — a restart resets it, so it is not "how long the problem
 * has existed". */
export interface AlertView {
  /** Stable rule id, e.g. "breaker_open" — localized in the UI, matched in tests. */
  id: string;
  /** "warn" | "error" (an unknown value is surfaced as-is, never guessed). */
  severity: string;
  /** The numbers behind it, e.g. "12 generation(s) were rejected…". */
  detail: string;
  active_for_seconds: number;
}

/** Live state + honest decision counters of the backend circuit breaker
 * (REQ-A131). While `state` is "open" the daemon skips the backend on purpose:
 * `rejections` counts those skips, so a UI can say "skipped, not lost". */
export interface BreakerView {
  enabled: boolean;
  /** "closed" | "open" | "half_open"; "" when the breaker is not in the path. */
  state: string;
  fail_threshold: number;
  cooldown_seconds: number;
  consecutive_failures: number;
  openings: number;
  rejections: number;
  failures: number;
  successes: number;
}

/** Whether the daemon's persisted log trail exists — and how much of it went
 * missing (REQ-A87). `lost_bytes`/`write_failures` > 0 means the trail is
 * incomplete: the UI must say so rather than imply the log is intact. */
export interface LogSinkView {
  enabled: boolean;
  path: string;
  bytes_written: number;
  lost_bytes: number;
  write_failures: number;
  rotations: number;
  active_bytes: number;
}

/** Live state + counters of the daemon's generation admission pool. */
export interface GenerationPoolView {
  capacity: number;
  in_flight: number;
  available: number;
  acquired_total: number;
  rejected_saturated: number;
  rejected_timeout: number;
  wait_ms: number;
}

/** Honest counters of the daemon's inference-response cache. */
export interface ResponseCacheView {
  enabled: boolean;
  capacity: number;
  ttl_seconds: number;
  entries: number;
  hits: number;
  misses: number;
  stores: number;
  evicted: number;
  expired: number;
  oversized: number;
}

type StatusLike = {
  model?: string;
  active_sessions?: number;
  engine?: string;
  engine_model?: string;
  degraded?: boolean;
  asr?: string;
  accelerator?: string;
  profile?: Partial<EngineProfile> | null;
  generation_pool?: Partial<GenerationPoolView> | null;
  response_cache?: Partial<ResponseCacheView> | null;
  log_sink?: Partial<LogSinkView> | null;
  breaker?: Partial<BreakerView> | null;
  alerts?: { alerts?: Partial<AlertView>[] } | null;
};

function parseProfile(p: StatusLike["profile"]): EngineProfile | null {
  if (!p) return null;
  return {
    decode_tokens_per_sec: p.decode_tokens_per_sec ?? 0,
    ttft_ms: p.ttft_ms ?? 0,
    decode_tokens_total: p.decode_tokens_total ?? 0,
    decode_runs: p.decode_runs ?? 0,
  };
}

function parsePool(p: StatusLike["generation_pool"]): GenerationPoolView | null {
  if (!p) return null;
  const capacity = p.capacity ?? 0;
  return {
    capacity,
    in_flight: p.in_flight ?? 0,
    available: p.available ?? capacity,
    acquired_total: p.acquired_total ?? 0,
    rejected_saturated: p.rejected_saturated ?? 0,
    rejected_timeout: p.rejected_timeout ?? 0,
    wait_ms: p.wait_ms ?? 0,
  };
}

function parseCache(c: StatusLike["response_cache"]): ResponseCacheView | null {
  if (!c) return null;
  return {
    enabled: Boolean(c.enabled),
    capacity: c.capacity ?? 0,
    ttl_seconds: c.ttl_seconds ?? 0,
    entries: c.entries ?? 0,
    hits: c.hits ?? 0,
    misses: c.misses ?? 0,
    stores: c.stores ?? 0,
    evicted: c.evicted ?? 0,
    expired: c.expired ?? 0,
    oversized: c.oversized ?? 0,
  };
}

function parseLogSink(l: StatusLike["log_sink"]): LogSinkView | null {
  if (!l) return null;
  return {
    enabled: Boolean(l.enabled),
    path: l.path ?? "",
    bytes_written: l.bytes_written ?? 0,
    lost_bytes: l.lost_bytes ?? 0,
    write_failures: l.write_failures ?? 0,
    rotations: l.rotations ?? 0,
    active_bytes: l.active_bytes ?? 0,
  };
}

function parseBreaker(b: StatusLike["breaker"]): BreakerView | null {
  if (!b) return null;
  return {
    enabled: Boolean(b.enabled),
    state: (b.state ?? "").trim(),
    fail_threshold: b.fail_threshold ?? 0,
    cooldown_seconds: b.cooldown_seconds ?? 0,
    consecutive_failures: b.consecutive_failures ?? 0,
    openings: b.openings ?? 0,
    rejections: b.rejections ?? 0,
    failures: b.failures ?? 0,
    successes: b.successes ?? 0,
  };
}

function parseAlerts(a: StatusLike["alerts"]): AlertView[] | null {
  // `null`/absent = the daemon did not report the block; `{alerts: []}` = it did, and
  // nothing is wrong. Collapsing the two would invent a healthy report.
  if (!a) return null;
  return (a.alerts ?? []).map((x) => ({
    id: (x.id ?? "").trim(),
    severity: (x.severity ?? "").trim(),
    detail: (x.detail ?? "").trim(),
    active_for_seconds: x.active_for_seconds ?? 0,
  }));
}

/** Build an [`EngineView`] from a (possibly stale/absent) `get_status` reply. */
export function describeEngine(s: StatusLike | null | undefined): EngineView {
  if (!s)
    return {
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
  // A present reply without an `engine` field means a pre-this-field daemon, which
  // only ever served mock — report mock (not "unknown") for backward-compat.
  const engine = s.engine?.trim() || "mock";
  return {
    engine,
    // Decorators are part of the reported *name*, never of the kind: `mock+breaker`
    // is a mock engine, whatever else is in the serving path.
    kind: engine.split("+")[0] ?? "",
    engine_model: s.engine_model?.trim() || "",
    degraded: Boolean(s.degraded),
    asr: s.asr?.trim() || "",
    accelerator: s.accelerator?.trim() || "",
    profile: parseProfile(s.profile),
    pool: parsePool(s.generation_pool),
    cache: parseCache(s.response_cache),
    logSink: parseLogSink(s.log_sink),
    breaker: parseBreaker(s.breaker),
    alerts: parseAlerts(s.alerts),
  };
}

/** True when a real (non-mock) engine is actively serving. Compares the decorator-
 * stripped `kind`, so a decorated mock (`mock+breaker`) is never called real. */
export function isRealEngine(v: EngineView): boolean {
  return v.kind !== "" && v.kind !== "mock";
}
