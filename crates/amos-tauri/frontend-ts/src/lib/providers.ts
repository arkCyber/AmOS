/**
 * AI provider presets for the System UI — lets a user pick between local
 * inference (Ollama) and any OpenAI-compatible cloud model (OpenAI / DeepSeek /
 * custom endpoint) in the Settings screen. Pure + headless so the switch is
 * unit-testable.
 *
 * NOTE: applying a provider requires restarting the `amos-ai` daemon with the
 * env returned by `envFor` (the daemon reads its backend from env at startup);
 * this module owns the "what the env should be" mapping so UI and launcher agree.
 *
 * The daemon's cloud backend is a *generic* OpenAI-compatible `chat/completions`
 * client (`AMOS_BACKEND=api` + `AMOS_API_ENDPOINT`/`AMOS_MODEL`/`AMOS_API_KEY`),
 * so OpenAI / DeepSeek / a self-hosted gateway / any `…/v1/chat/completions`
 * endpoint all use the same path — a preset is only a convenience default for
 * endpoint + model, never a different engine.
 */

export type AiProviderId =
  | "local"
  | "openai"
  | "deepseek"
  | "moonshot"
  | "qwen"
  | "zhipu"
  | "groq"
  | "mistral"
  | "anthropic"
  | "gemini"
  | "custom";

/** Every non-"local" provider talks to an OpenAI-compatible cloud endpoint. */
export type CloudProviderId = Exclude<AiProviderId, "local">;

/** Ordered for the Settings selector; "custom" (arbitrary endpoint) stays last. */
export const CLOUD_PROVIDERS: readonly CloudProviderId[] = [
  "openai",
  "deepseek",
  "moonshot",
  "qwen",
  "zhipu",
  "groq",
  "mistral",
  "anthropic",
  "gemini",
  "custom",
];

const CLOUD_SET: ReadonlySet<string> = new Set<string>(CLOUD_PROVIDERS);

/** Providers speaking their **native** (non-OpenAI) protocol; the daemon has a
 * dedicated backend for each. Everything else in [`CLOUD_PROVIDERS`] is an
 * OpenAI-compatible endpoint the generic `api` backend serves. */
const NATIVE_BACKENDS: ReadonlySet<string> = new Set<string>(["anthropic", "gemini"]);

export interface AiConfig {
  provider: AiProviderId;
  /** Cloud model id (deepseek-chat / gpt-4o-mini / etc). */
  model?: string;
  /** Cloud API key (OpenAI-compatible bearer). */
  apiKey?: string;
  /** Cloud full chat-completions endpoint. */
  endpoint?: string;
}

export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
export const DEEPSEEK_MODEL = "deepseek-chat";
export const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
export const OPENAI_MODEL = "gpt-4o-mini";
/** Base URL of the local Ollama engine the "Local" provider prefers. */
export const LOCAL_OLLAMA_HOST = "http://localhost:11434";

/** Convenience endpoint/model defaults for the named cloud presets. "custom" has
 * none on purpose — the user must supply both for an arbitrary endpoint. All the
 * preset endpoints speak the OpenAI `chat/completions` shape the daemon's `api`
 * backend already understands. */
const CLOUD_PRESETS: Record<CloudProviderId, { endpoint: string; model: string }> = {
  deepseek: { endpoint: DEEPSEEK_ENDPOINT, model: DEEPSEEK_MODEL },
  openai: { endpoint: OPENAI_ENDPOINT, model: OPENAI_MODEL },
  moonshot: {
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-8k",
  },
  qwen: {
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus",
  },
  zhipu: {
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash",
  },
  groq: {
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
  },
  mistral: {
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    model: "open-mistral-7b",
  },
  // Native (non-OpenAI) backends: endpoint stays empty so the daemon uses its
  // official default; only the model (and API key) are configured.
  anthropic: { endpoint: "", model: "claude-3-5-sonnet-latest" },
  gemini: { endpoint: "", model: "gemini-2.0-flash" },
  custom: { endpoint: "", model: "" },
};

export function isCloudProvider(p: AiProviderId): p is CloudProviderId {
  return p !== "local";
}

/** Default endpoint for a cloud preset ("" for "custom" = user must fill it). */
export function cloudDefaultEndpoint(p: CloudProviderId): string {
  return CLOUD_PRESETS[p].endpoint;
}

/** Default model for a cloud preset ("" for "custom"). */
export function cloudDefaultModel(p: CloudProviderId): string {
  return CLOUD_PRESETS[p].model;
}

/** Read an AiConfig out of a settings blob (tolerant of garbage/absence).
 * Unrecognised / missing provider falls back to "local" so a corrupt blob never
 * sends a request to an unintended endpoint. */
export function readAiConfig(prefs: Record<string, unknown> | null | undefined): AiConfig {
  const o = (prefs ?? {}) as Record<string, unknown>;
  const raw = typeof o.aiProvider === "string" ? (o.aiProvider as string) : "";
  const provider: AiProviderId = CLOUD_SET.has(raw) ? (raw as AiProviderId) : "local";
  const str = (k: string): string | undefined =>
    typeof o[k] === "string" && (o[k] as string) ? (o[k] as string) : undefined;
  if (provider === "local") return { provider };
  return {
    provider,
    // Prefer the persisted value, else the preset default. For "custom" the
    // preset default is empty so a never-filled custom provider comes back
    // ready to be completed rather than pointing at a wrong default endpoint.
    model: (str("aiModel") ?? cloudDefaultModel(provider)) || undefined,
    apiKey: str("aiApiKey"),
    endpoint: (str("aiEndpoint") ?? cloudDefaultEndpoint(provider)) || undefined,
  };
}

/** Persist an AiConfig onto a settings blob (fresh object).
 *
 * The API key is intentionally NOT persisted here — it lives only in transient
 * UI state and is handed once to the Tauri `ai_backend_switch` command, which
 * stores it in a 0600-permission key file on disk (see amos-tauri ai_bridge).
 * This keeps secrets out of localStorage / shared store / snapshots. */
export function setAiConfig(
  prefs: Record<string, unknown>,
  cfg: AiConfig,
): Record<string, unknown> {
  const base =
    prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : {};
  const next = { ...base };
  // Never leave a key in the settings blob, whatever the previous value.
  delete next.aiApiKey;
  if (cfg.provider === "local") {
    next.aiProvider = "local";
    delete next.aiModel;
    delete next.aiEndpoint;
  } else {
    next.aiProvider = cfg.provider;
    if (cfg.model) next.aiModel = cfg.model;
    else delete next.aiModel;
    if (cfg.endpoint) next.aiEndpoint = cfg.endpoint;
    else delete next.aiEndpoint;
  }
  return next;
}

/** Env vars to (re)launch `amos-ai` with for the selected provider. */
export function envFor(cfg: AiConfig): Record<string, string> {
  if (cfg.provider !== "local") {
    // Native backends (Claude / Gemini) have a dedicated daemon engine and use
    // the provider's official endpoint by default; an explicit override is
    // honoured (the daemon reads AMOS_API_ENDPOINT for both).
    if (NATIVE_BACKENDS.has(cfg.provider)) {
      const env: Record<string, string> = {
        AMOS_BACKEND: cfg.provider,
        AMOS_MODEL: cfg.model ?? cloudDefaultModel(cfg.provider),
        ...(cfg.apiKey ? { AMOS_API_KEY: cfg.apiKey } : {}),
      };
      if (cfg.endpoint) env.AMOS_API_ENDPOINT = cfg.endpoint;
      return env;
    }
    // Any other OpenAI-compatible cloud provider maps to the daemon's generic
    // `api` backend; endpoint/model/key fully describe which one.
    return {
      AMOS_BACKEND: "api",
      AMOS_API_ENDPOINT: cfg.endpoint ?? cloudDefaultEndpoint(cfg.provider),
      AMOS_MODEL: cfg.model ?? cloudDefaultModel(cfg.provider),
      ...(cfg.apiKey ? { AMOS_API_KEY: cfg.apiKey } : {}),
    };
  }
  // Local = real on-device inference via a local Ollama. We intentionally do NOT
  // hard-code AMOS_BACKEND=mock here: the daemon auto-selects the first installed
  // *chat* model, and `scripts/ai-backend.sh local` (which this UI drives via
  // `ai_backend_switch`) probes Ollama first and only falls back to the
  // deterministic mock when no Ollama is reachable. If the daemon itself is
  // started with this env and Ollama is down, it reports `degraded=true` in
  // get_status so the UI is never mistaken about what is serving.
  return {
    AMOS_BACKEND: "ollama",
    AMOS_OLLAMA_HOST: LOCAL_OLLAMA_HOST,
  };
}
