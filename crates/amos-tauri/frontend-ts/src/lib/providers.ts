/**
 * AI provider presets for the System UI — lets a user pick between local
 * inference (mock / Ollama) and a cloud OpenAI-compatible model such as DeepSeek
 * in the Settings screen. Pure + headless so the switch is unit-testable.
 *
 * NOTE: applying a provider requires restarting the `amos-ai` daemon with the
 * env returned by `envFor` (the daemon reads its backend from env at startup);
 * this module owns the "what the env should be" mapping so UI and launcher agree.
 */

export type AiProviderId = "local" | "deepseek";

export interface AiConfig {
  provider: AiProviderId;
  /** Cloud model id (deepseek-chat / etc). */
  model?: string;
  /** Cloud API key (OpenAI-compatible bearer). */
  apiKey?: string;
  /** Cloud full chat-completions endpoint. */
  endpoint?: string;
}

export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
export const DEEPSEEK_MODEL = "deepseek-chat";
/** Base URL of the local Ollama engine the "Local" provider prefers. */
export const LOCAL_OLLAMA_HOST = "http://localhost:11434";

/** Read an AiConfig out of a settings blob (tolerant of garbage/absence). */
export function readAiConfig(prefs: Record<string, unknown> | null | undefined): AiConfig {
  const o = (prefs ?? {}) as Record<string, unknown>;
  const provider: AiProviderId = o.aiProvider === "deepseek" ? "deepseek" : "local";
  const str = (k: string): string | undefined =>
    typeof o[k] === "string" && (o[k] as string) ? (o[k] as string) : undefined;
  if (provider === "deepseek") {
    return {
      provider,
      model: str("aiModel") ?? DEEPSEEK_MODEL,
      apiKey: str("aiApiKey"),
      endpoint: str("aiEndpoint") ?? DEEPSEEK_ENDPOINT,
    };
  }
  return { provider };
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
  if (cfg.provider === "deepseek") {
    next.aiProvider = "deepseek";
    if (cfg.model) next.aiModel = cfg.model;
    if (cfg.endpoint) next.aiEndpoint = cfg.endpoint;
  } else {
    next.aiProvider = "local";
    delete next.aiModel;
    delete next.aiEndpoint;
  }
  return next;
}

/** Env vars to (re)launch `amos-ai` with for the selected provider. */
export function envFor(cfg: AiConfig): Record<string, string> {
  if (cfg.provider === "deepseek") {
    return {
      AMOS_BACKEND: "api",
      AMOS_API_ENDPOINT: cfg.endpoint ?? DEEPSEEK_ENDPOINT,
      AMOS_MODEL: cfg.model ?? DEEPSEEK_MODEL,
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
