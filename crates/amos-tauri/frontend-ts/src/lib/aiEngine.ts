/**
 * Pure interpretation of the daemon's `get_status` engine fields, so any surface
 * (Settings card, AI chat header, …) renders the *same* truthful engine view.
 *
 * Contract with `amos-ai` (see `proto/ai_agent.proto` StatusReply):
 *  - engine:      mock | api | ollama | hermes | ggml
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

/** Build an [`EngineView`] from a (possibly stale/absent) `get_status` reply. */
export function describeEngine(s: StatusLike | null | undefined): EngineView {
  if (!s)
    return {
      engine: "",
      engine_model: "",
      degraded: false,
      asr: "",
      accelerator: "",
      profile: null,
    };
  // A present reply without an `engine` field means a pre-this-field daemon, which
  // only ever served mock — report mock (not "unknown") for backward-compat.
  const engine = s.engine?.trim() || "mock";
  return {
    engine,
    engine_model: s.engine_model?.trim() || "",
    degraded: Boolean(s.degraded),
    asr: s.asr?.trim() || "",
    accelerator: s.accelerator?.trim() || "",
    profile: parseProfile(s.profile),
  };
}

/** True when a real (non-mock) engine is actively serving. */
export function isRealEngine(v: EngineView): boolean {
  return v.engine !== "" && v.engine !== "mock";
}
