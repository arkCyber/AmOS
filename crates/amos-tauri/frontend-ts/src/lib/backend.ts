/**
 * Typed bridge to the Tauri Rust core (window.__TAURI_INTERNALS__), mirroring the
 * legacy vanilla UI's commands. Outside Tauri every call degrades to null/false so
 * the UI can show a localized "daemon not connected" state instead of crashing.
 */
import type { AiProviderId } from "./providers";
import { amosWarn } from "./debugLog";

interface TauriBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(channel: string, handler: (e: { payload: unknown }) => void): Promise<() => void>;
}

/**
 * What the host actually injects into `window.__TAURI_INTERNALS__`.
 *
 * Tauri v2 exposes `invoke` + `transformCallback`/`unregisterCallback` — but **no
 * `listen`**. Code that assumed `internals.listen(...)` existed therefore threw
 * and (behind a `try/catch`) silently disabled every event-driven feature.
 */
interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen?(channel: string, handler: (e: { payload: unknown }) => void): Promise<() => void>;
  transformCallback?(cb: (payload: unknown) => void, once?: boolean): number;
  unregisterCallback?(id: number): void;
}

function bridge(): TauriBridge | null {
  // `typeof window === "undefined"` covers a non-DOM runtime; the `window === null`
  // half covers a test double or an embedder that nulls the global. Without the
  // second check this **threw** (`null.__TAURI_INTERNALS__`) instead of returning
  // null, breaking the "null when not bridged" contract this module documents —
  // found when `lib/wm.ts` stopped re-implementing the bridge and delegated here
  // (REQ-A220). `typeof null === "object"`, so the undefined check alone is not
  // enough.
  if (typeof window !== "object" || window === null) return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals })
    .__TAURI_INTERNALS__;
  if (!internals || typeof internals !== "object" || typeof internals.invoke !== "function") {
    return null;
  }
  const invoke = internals.invoke.bind(internals);
  return {
    invoke: (command, args) => invoke(command, args),
    listen: (channel, handler) => listenEvent(internals, invoke, channel, handler),
  };
}

/**
 * Subscribe to a host event, honestly.
 *
 * Uses a host-provided `listen` when present; otherwise registers through the
 * event plugin exactly like `@tauri-apps/api` does
 * (`plugin:event|listen` + a `transformCallback` id), because the internal
 * `listen` helper does not exist. Returns an unsubscribe function; a no-op when
 * the host cannot subscribe at all (offline / test double).
 */
async function listenEvent(
  internals: TauriInternals,
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  channel: string,
  handler: (e: { payload: unknown }) => void,
): Promise<() => void> {
  if (typeof internals.listen === "function") {
    return internals.listen(channel, handler);
  }
  const transform = internals.transformCallback?.bind(internals);
  if (typeof transform !== "function") return () => {};
  const handlerId = transform((raw: unknown) => {
    handler({ payload: (raw as { payload?: unknown } | null)?.payload });
  });
  const target = { kind: "Any" };
  try {
    const eventId = await invoke("plugin:event|listen", {
      event: channel,
      target,
      handler: handlerId,
    });
    return () => {
      internals.unregisterCallback?.(handlerId);
      void invoke("plugin:event|unlisten", { event: channel, eventId, target }).catch(() => {});
    };
  } catch {
    internals.unregisterCallback?.(handlerId);
    return () => {};
  }
}

export function bridged(): boolean {
  return bridge() !== null;
}

/**
 * Last bridge outcome, structured so the root cause of a `null` return is never
 * lost. Callers keep the simple `T | null` contract; when debugging you can read
 * *why* a call failed instead of guessing between "not bridged" and "command
 * rejected". Reset to `{ ok: true }` on every successful command.
 */
export type BridgeDiag =
  | { ok: true }
  | { ok: false; kind: "not-bridged"; command: string }
  | { ok: false; kind: "command-failed"; command: string; detail?: unknown };

let lastDiag: BridgeDiag = { ok: true };

export function bridgeDiag(): BridgeDiag {
  return lastDiag;
}

/** Call a Tauri command; returns null when not running inside Tauri. */
export async function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const b = bridge();
  if (!b) {
    lastDiag = { ok: false, kind: "not-bridged", command };
    return null;
  }
  try {
    const result = (await b.invoke(command, args)) as T;
    lastDiag = { ok: true };
    return result;
  } catch (err) {
    lastDiag = { ok: false, kind: "command-failed", command, detail: err };
    // Routed through the diagnostic ledger (P1-3) so a failed bridge call is
    // retrievable from the UI, not just visible in logcat while it scrolls away.
    amosWarn("backend", `${command} failed`, err);
    return null;
  }
}

/** Subscribe to a backend event channel; returns an unsubscribe (noop outside Tauri). */
export async function subscribe(channel: string, onEvent: (payload: unknown) => void): Promise<() => void> {
  const b = bridge();
  if (!b) return () => {};
  try {
    const un = await b.listen(channel, (e) => onEvent(e.payload));
    return () => {
      try {
        un();
      } catch {
        /* ignore */
      }
    };
  } catch {
    return () => {};
  }
}

export type AiStatus = {
  model?: string;
  active_sessions?: number;
  /** Active inference engine kind: mock|api|ollama|hermes|ggml|anthropic|gemini. */
  engine?: string;
  /** Concrete model behind `engine` (empty when mock). */
  engine_model?: string;
  /** True when a real engine was requested but the daemon is serving mock. */
  degraded?: boolean;
  /** Voice ASR backend in effect: mock|sherpa|off. */
  asr?: string;
  /** Resolved device-acceleration target of a local engine ("" when remote/mock). */
  accelerator?: string;
  /** Generation admission pool live state (REQ-A43); absent on an older daemon. */
  generation_pool?: {
    capacity: number;
    in_flight: number;
    available: number;
    acquired_total: number;
    rejected_saturated: number;
    rejected_timeout: number;
    wait_ms: number;
  } | null;
  /** Inference-response cache counters (REQ-A44); absent on an older daemon.
   * `enabled=false` is the honest default-off state. */
  response_cache?: {
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
  } | null;
  /** On-disk log sink health (REQ-A87); absent on an older daemon.
   * `enabled=false` = stdout only; non-zero `lost_bytes`/`write_failures` means the
   * persisted trail is incomplete. */
  log_sink?: {
    enabled: boolean;
    path: string;
    bytes_written: number;
    lost_bytes: number;
    write_failures: number;
    rotations: number;
    active_bytes: number;
  } | null;
  /** Backend circuit breaker (REQ-A131); absent on an older daemon.
   * `enabled=false` = not in the serving path (and then `state` is ""). */
  breaker?: {
    enabled: boolean;
    state: string;
    fail_threshold: number;
    cooldown_seconds: number;
    consecutive_failures: number;
    openings: number;
    rejections: number;
    failures: number;
    successes: number;
  } | null;
  /** Active threshold alerts (REQ-A133); absent on an older daemon. An empty array is
   * the healthy state; `null`/absent means "not reported". */
  alerts?: { alerts: { id: string; severity: string; detail: string; active_for_seconds: number }[] } | null;
} | null;

/** Probe the AI daemon via the same get_status the legacy AI app uses. */
export async function getAiStatus(): Promise<AiStatus> {
  return invoke<AiStatus>("get_status");
}

/** One tracked daemon session (mirrors the daemon `SessionInfo`). */
export interface AiSessionInfo {
  session_id: string;
  model: string;
  tokens_generated: number;
  cancelled: boolean;
  age_seconds: number;
}

/** List the daemon's tracked sessions (most recently active first). */
export async function listSessions(): Promise<AiSessionInfo[] | null> {
  return invoke<AiSessionInfo[]>("get_ai_sessions");
}

/** Clear all tracked daemon sessions; returns how many were removed. */
export async function clearSessions(): Promise<number | null> {
  return invoke<number>("clear_ai_sessions");
}

/** Remove a single daemon session by id; true when it was found+removed. */
export async function removeSession(sessionId: string): Promise<boolean | null> {
  return invoke<boolean>("remove_ai_session", { sessionId });
}

/** One completed conversation turn on a daemon session. */
export interface HistoryTurn {
  role: string;
  text: string;
}
/** A session's completed conversation history. */
export interface SessionHistory {
  session_id: string;
  model: string;
  tokens_generated: number;
  cancelled: boolean;
  turns: HistoryTurn[];
}

/** Fetch one session's completed conversation history. */
export async function getSessionHistory(sessionId: string): Promise<SessionHistory | null> {
  return invoke<SessionHistory>("get_ai_session_history", { sessionId });
}

/** Optional cloud fields for `switchAiBackend`. */
export interface AiBackendSwitchOpts {
  /** Cloud model id. Empty/omitted → the daemon/preset default is used. */
  model?: string;
  /** OpenAI-compatible chat/completions endpoint. Empty → preset default. */
  endpoint?: string;
  /** API key (kept out of settings; handed once to the Rust command). */
  apiKey?: string;
}

/** One-click backend switch (local Ollama | OpenAI | DeepSeek | custom cloud).
 * Returns the daemon launch report. No-op (null) when not running inside Tauri. */
export async function switchAiBackend(
  provider: AiProviderId,
  opts: AiBackendSwitchOpts = {},
): Promise<string | null> {
  return invoke<string>("ai_backend_switch", {
    provider,
    apiKey: opts.apiKey ?? "",
    model: opts.model ?? "",
    endpoint: opts.endpoint ?? "",
  });
}

/** Stable conversation id persisted for multi-turn memory. */
export function conversationId(): string {
  const KEY = "amos.ai.session";
  const existing = readStored(KEY, "");
  if (existing) return existing;
  const id = `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  writeStored(KEY, id);
  return id;
}

/** Rotate to a brand-new conversation (clears the persisted multi-turn id so the
 * next `conversationId()` call generates a fresh one). */
export function newConversation(): void {
  writeStored("amos.ai.session", "");
}

function readStored(key: string, fb: string): string {
  try {
    return window.localStorage.getItem(key) ?? fb;
  } catch {
    return fb;
  }
}
function writeStored(key: string, v: string): void {
  try {
    window.localStorage.setItem(key, v);
    // Mirror to the Rust shared store, exactly like `lib/themeCore` and the locale do:
    // the session pointer is a raw string (read before the JSON layer exists), but it
    // still gets the durable copy + cross-window bus.
    void systemStoreSet(key, v);
  } catch {
    /* ignore */
  }
}

/** Send a chat prompt to the daemon (streams tokens via `ai-token-received`). */
export function sendChat(prompt: string, sessionId: string): Promise<unknown> {
  return invoke("chat_agent", { prompt, sessionId, targetWindow: "ai" });
}

/** Cancel the active bidirectional `Chat` stream so generation halts. */
export async function cancelAiSession(): Promise<unknown> {
  return invoke("cancel_ai_session");
}

/* ---- AI assistant resident-voice (always-on mic → Payload::Audio) ---- */

/** Begin resident listening: open the daemon `Chat` stream (no prompt). */
export async function assistantVoiceStart(sessionId: string): Promise<unknown> {
  return invoke("assistant_voice_start", { sessionId });
}

/** Push one 16 kHz mono little-endian f32 audio frame to the recognizer. */
export async function assistantVoiceFeed(bytes: number[]): Promise<unknown> {
  return invoke("assistant_voice_feed", { frame: bytes });
}

/** Stop the resident voice listener (sends Cancel, stream winds down). */
export async function assistantVoiceStop(): Promise<unknown> {
  return invoke("assistant_voice_stop");
}

/** End the current utterance (push-to-talk release): force-finalize speech. */
export async function assistantVoiceEnd(): Promise<unknown> {
  return invoke("assistant_voice_end");
}

/* ---- Device always-on native mic (AAudio seam) ---- */

/**
 * Status of the always-on **native** device-mic listen — the mirror of the Rust
 * `DeviceMicStatus` (`crates/amos-tauri/src/assistant_voice.rs`). Unlike the
 * WebView push-to-talk path above, the device mic runs a resident capture thread
 * over `amos_audio::PlatformMic` (Android + aaudio → real AAudio); it streams
 * `Payload::Audio` and auto-finalizes each utterance on trailing silence. Its
 * replies arrive on the same `assistant-voice-event` channel the push-to-talk
 * path uses.
 */
export interface DeviceMicStatus {
  running: boolean;
  /** Capture backend in effect: `aaudio` / `tinyalsa` / `mock` / `none`. */
  backend: string;
  /** Utterances submitted (`AudioEnd`) so far by the running worker. */
  submitted: number;
}

/**
 * Start the always-on native mic listen. Resolves to the backend label
 * (`"aaudio"` / `"tinyalsa"`) on success; `null` when not bridged or when the
 * platform mic is unavailable (host build / RECORD_AUDIO not granted) — read
 * [`bridgeDiag`] to tell those apart, and never pretend a device mic exists.
 */
export async function deviceMicStart(sessionId?: string): Promise<string | null> {
  return invoke<string>("device_mic_start", { sessionId });
}

/** Stop the always-on native mic listen (joins the resident capture thread). */
export async function deviceMicStop(): Promise<null> {
  return invoke<null>("device_mic_stop");
}

/** Poll the always-on native mic listen (`null` when not bridged). */
export async function deviceMicStatus(): Promise<DeviceMicStatus | null> {
  return invoke<DeviceMicStatus>("device_mic_status");
}

/* ---- OS RECORD_AUDIO grant (native AAudio needs it; not the WebView path) ---- */

/**
 * State of the OS `RECORD_AUDIO` grant for the native mic.
 * `native` is true only inside the Android System UI where the Kotlin
 * `MicPermissionGlue` is bound; `granted` is true only when the permission is held.
 */
export interface MicPermissionState {
  native: boolean;
  granted: boolean;
}

/** Dialog-free snapshot of the OS `RECORD_AUDIO` grant. Host → `native:false`. */
export async function micPermissionState(): Promise<MicPermissionState | null> {
  return invoke<MicPermissionState>("mic_permission_state");
}

/**
 * JS-awaitable: ensure `RECORD_AUDIO` for the native AAudio mic, posting the OS
 * dialog only when it is not already held. Host → `{ native:false, granted:false }`
 * (no dialog, no fabricated grant).
 */
export async function micPermissionRequest(): Promise<MicPermissionState | null> {
  return invoke<MicPermissionState>("mic_permission_request");
}

/* ---- 同传 / interpret RPC (degrade to null outside Tauri) ----
 * The session id is a **number** on the wire: `interpret_start` answers `u64` and
 * the `interpret_*` commands take `session_id: Option<u64>`. Typing it `string`
 * here (as an earlier revision did) is a type lie — the value is a JS number, and a
 * comparison written against the declared type (`sid === "7"`, `String(sid)`)
 * would silently never match. See scripts/tauri-reply-scan.mjs. */
export interface InterpOpts {
  source?: string;
  target?: string;
}

export async function interpretStart(opts: InterpOpts = {}): Promise<number | null> {
  // Wire keys must be the Rust parameter names in lowerCamelCase — Tauri looks
  // each argument up by that exact key (`CommandItem::deserialize_json` does a
  // plain `get`). `source_lang`/`target_lang` therefore matched nothing and, since
  // both parameters are `Option<String>`, the interpreter **silently** ran its
  // `auto`/`zh` defaults no matter what the user picked. Pinned by
  // `scripts/tauri-args-scan.mjs` + `backend.test.ts`.
  return invoke<number>("interpret_start", {
    sourceLang: opts.source ?? "auto",
    targetLang: opts.target ?? "zh",
  });
}

export async function interpretAudio(sessionId: number, chunk: ArrayLike<number>): Promise<unknown> {
  return invoke("interpret_audio", { sessionId, chunk: Array.from(chunk) });
}

export async function interpretText(sessionId: number, text: string): Promise<unknown> {
  return invoke("interpret_text", { sessionId, text });
}

export async function interpretStop(sessionId: number): Promise<unknown> {
  return invoke("interpret_stop", { sessionId });
}

export async function interpretPause(sessionId: number): Promise<unknown> {
  return invoke("interpret_pause", { sessionId });
}

export async function interpretResume(sessionId: number): Promise<unknown> {
  return invoke("interpret_resume", { sessionId });
}

/* ---- Cross-window system context (wm.rs `SystemContext`) --------------------
 * A per-window entry that `chat_agent` merges into the next AI request as
 * `system_selection` (consuming it). `system_peek_context` lets the target app
 * show what is attached *before* sending; `system_clear_context` drops it. */

/** One attached context entry (mirrors `wm::SystemContextEntry`). */
export interface SystemContextEntry {
  /** The app that attached it (e.g. `"notes"`). */
  source_window: string;
  text: string;
  timestamp_ms: number;
}

/**
 * Attach `text` (from the app `sourceWindow`) to `targetWindow` for its next AI
 * request. Offline → `null` and nothing is attached (the app must not claim
 * otherwise).
 */
export async function systemSetContext(
  targetWindow: string,
  sourceWindow: string,
  text: string,
): Promise<void | null> {
  return invoke<void>("system_set_context", { targetWindow, sourceWindow, text });
}

/** Drop any context attached to `targetWindow`. Offline → `null`. */
export async function systemClearContext(targetWindow: string): Promise<void | null> {
  return invoke<void>("system_clear_context", { targetWindow });
}

/**
 * Peek (without consuming) the context attached to `targetWindow`.
 *
 * `null` means **either** "nothing attached" **or** "could not ask" (offline /
 * command failed) — the two are indistinguishable on the wire, so a caller must
 * only render something when an entry comes back and stay silent otherwise.
 */
export async function systemPeekContext(
  targetWindow: string,
): Promise<SystemContextEntry | null> {
  return invoke<SystemContextEntry>("system_peek_context", { targetWindow });
}

/* ---- TTS bridge (final translation segments -> local Piper / mock PCM) ---- */
export interface TtsPayload {
  sample_rate: number;
  channels: number;
  samples: number[];
}

/** Synthesize `text` to PCM via the Rust `tts_synthesize` command. */
export async function ttsSynthesize(text: string, lang = "zh"): Promise<TtsPayload | null> {
  return invoke<TtsPayload>("tts_synthesize", { text, lang });
}

/* ---- Android compatibility (legacy Waydroid/demo apps over the shared pipe) ---- */
export interface AndroidApp {
  name: string;
  package_name: string;
  icon_path?: string;
  activity?: string;
}

export interface AndroidLaunchResult {
  success: boolean;
  window_id?: string;
  window_label?: string;
  error?: string;
}

/** See `lib/android.ts::AndroidAppsReply` — the list plus the runtime behind it. */
export interface AndroidAppsReply {
  apps: AndroidApp[];
  runtime: string;
  demo: boolean;
}

/** List installed Android apps + the runtime that answered (null outside Tauri). */
export async function getAndroidApps(): Promise<AndroidAppsReply | null> {
  return invoke<AndroidAppsReply>("get_android_apps");
}

/** Launch a package in the container (registers an external System window). */
export async function launchAndroidApp(packageName: string): Promise<AndroidLaunchResult | null> {
  return invoke<AndroidLaunchResult>("launch_android_app", { packageName });
}

/** Fetch a PNG icon (bytes) for an app so the UI can render a data URI. */
export async function getAndroidAppIcon(packageName: string): Promise<number[] | null> {
  return invoke<number[]>("get_android_app_icon", { packageName });
}

/* ---- Voice / ASR (translate daemon: transcribe_audio / translate_text) ---- */
export interface TranscriptionResult {
  text: string;
  recognized: boolean;
}

/** Transcribe captured audio via the translate daemon's ASR (`Transcribe` RPC). */
export async function transcribeAudio(
  audio: ArrayLike<number>,
  opts: { language?: string; format?: string } = {},
): Promise<TranscriptionResult | null> {
  return invoke<TranscriptionResult>("transcribe_audio", {
    audio: Array.from(audio),
    language: opts.language ?? "",
    format: opts.format ?? "wav",
  });
}

/** Translate text via the translate daemon's unary `Translate` RPC. */
export async function translateText(
  text: string,
  opts: { sourceLang?: string; targetLang?: string } = {},
): Promise<string | null> {
  return invoke<string>("translate_text", {
    text,
    sourceLang: opts.sourceLang ?? "",
    targetLang: opts.targetLang ?? "",
  });
}

/* ---- Telephony (amos-telephony service over the OS UDS: dial/end/status/recording).
 *       Mirrors amos_tauri_lib::telephony payloads. -------- */
export type TelephonyCall = {
  id: string;
  peer: string;
  state: string;
  /** "Outgoing" / "Incoming" — who initiated the call. */
  direction: string;
  emergency: boolean;
  /** "Off" / "On" / "Failed" — whether the call is being recorded. */
  recording: string;
};
export type TelephonyDialResult = { id: string };

/** Tauri event carrying one live-call state snapshot (incoming/connected/ended). */
export const TELEPHONY_EVENT = "telephony-event";

/** Place a call. `emergency` (or an emergency number) uses the privileged path. */
export async function telephonyDial(
  number: string,
  emergency = false,
): Promise<TelephonyDialResult | null> {
  return invoke<TelephonyDialResult>("telephony_dial", { number, emergency });
}

/**
 * Place a **real** outbound call through Android Telecom (`ACTION_CALL`), bypassing
 * the daemon's mock. Returns `true` when the call was handed to the OS; `false` when
 * real dialing is unavailable (desktop host, or on-device build without the bound
 * context / `CALL_PHONE` grant) so the caller can fall back to `telephonyDial`.
 * Emergency numbers intentionally go through the privileged mock path (see dialer).
 */
export async function realDial(number: string): Promise<boolean> {
  const status = await invoke<string>("real_dial", { number });
  return typeof status === "string";
}

/** End a live call by id. */
export async function telephonyEnd(callId: string): Promise<void | null> {
  return invoke<void>("telephony_end", { callId });
}

/* ---- Terminal (PTY shell bridge; real only when the backend `terminal-pty`
 *       feature is built in — otherwise every call returns id 0 + an error). -- */
export type TermOut = {
  id: number;
  output: string | null;
  error: string;
  running: boolean;
};

export async function termSpawn(
  cwd?: string | null,
  allowlist?: string[] | null,
): Promise<TermOut | null> {
  return invoke<TermOut>("term_spawn", { cwd: cwd ?? null, allowlist: allowlist ?? null });
}
export async function termWrite(session: number, data: string): Promise<TermOut | null> {
  return invoke<TermOut>("term_write", { session, data });
}
export async function termRead(
  session: number,
  max?: number | null,
): Promise<TermOut | null> {
  return invoke<TermOut>("term_read", { session, max: max ?? null });
}
export async function termKill(session: number): Promise<TermOut | null> {
  return invoke<TermOut>("term_kill", { session });
}
export async function termResize(session: number, cols: number, rows: number): Promise<TermOut | null> {
  return invoke<TermOut>("term_resize", { session, cols, rows });
}

/** Answer an incoming (ringing) call by id. */
export async function telephonyAnswer(callId: string): Promise<void | null> {
  return invoke<void>("telephony_answer", { callId });
}

/** Dev/demo: ask the mock daemon to ring an incoming call; returns its call id. */
export async function telephonySimulateIncoming(
  number: string,
): Promise<string | null> {
  return invoke<string>("telephony_simulate_incoming", { number });
}

/** List live calls (dialling / ringing / active). */
export async function telephonyStatus(): Promise<TelephonyCall[] | null> {
  return invoke<TelephonyCall[]>("telephony_status");
}

/**
 * Subscribe to live call-state events pushed from the daemon `Watch` stream via the
 * Rust bridge. Outside Tauri this is a no-op (returns an unsubscribe). Each call to
 * `onEvent` receives a `TelephonyCall`.
 */
export function onTelephonyEvent(
  onEvent: (call: TelephonyCall) => void,
): () => void {
  let cancelled = false;
  let unsub: (() => void) | null = null;
  void subscribe(TELEPHONY_EVENT, (payload) => {
    const call = payload as TelephonyCall;
    if (call && typeof call.id === "string") onEvent(call);
  }).then((u) => {
    if (cancelled) u();
    else unsub = u;
  });
  return () => {
    cancelled = true;
    unsub?.();
  };
}

/** Start recording a live call; returns its authoritative snapshot. */
export async function telephonyStartRecording(
  callId: string,
): Promise<TelephonyCall | null> {
  return invoke<TelephonyCall>("telephony_start_recording", { callId });
}

/** Stop recording a live call; returns its authoritative snapshot. */
export async function telephonyStopRecording(
  callId: string,
): Promise<TelephonyCall | null> {
  return invoke<TelephonyCall>("telephony_stop_recording", { callId });
}

/* ---- Radio / connectivity (radio_*: wifi / bluetooth / airplane / hotspot). Real
 *       radios live on the System UI side (Android services), so unlike telephony
 *       these do NOT round-trip through the headless daemon. ---- */
export type RadioPayload = {
  wifi: boolean;
  bluetooth: boolean;
  airplane: boolean;
  hotspot: boolean;
};

/** Read the current radio state (wifi / bluetooth / airplane / hotspot). */
export async function radioStatus(): Promise<RadioPayload | null> {
  return invoke<RadioPayload>("radio_status");
}

/**
 * Why a `radio_set` did not apply (REQ-A203). Machine tokens only — the screen owns
 * the wording; `detail` is free-form ledger copy.
 */
export type RadioRefusal = {
  /** `platform_managed` / `airplane_active` / `provider_refused` / `unsupported`. */
  kind: string;
  /** The radio the refusal names (a cascade names the refused member), if known. */
  radio?: string | null;
  /** For `platform_managed`: the system surface that owns the switch. */
  surface?: string | null;
  /** For `platform_managed`: why (`switch_removed` / `privileged_only`). */
  reason?: string | null;
  /** Diagnostic sentence for the ledger — never the screen's primary wording. */
  detail?: string;
};

/** The full, structured answer to one `radio_set` (REQ-A203): refusals are data. */
export type RadioSetReply = {
  radio: string;
  requested: boolean;
  /** `true` when the write landed (and the store was mirrored Rust-side). */
  applied: boolean;
  /** The device's state **after the attempt** — `null` only when even the read failed. */
  state: RadioPayload | null;
  /** Present exactly when `applied` is `false`. */
  refusal: RadioRefusal | null;
};

/**
 * Toggle one radio. Airplane mode cascades Wi-Fi + Bluetooth + the hotspot off and
 * gates them until it is turned back off. The reply is **structured**: `applied`
 * says whether the write landed, and a refusal (the device saying no to *this*
 * attempt, a platform-owned switch, the airplane guard) comes back as data with
 * machine tokens — instead of a failed `invoke` that used to collapse into `null`
 * and leave a tile tap looking like nothing happened (REQ-A203).
 */
export async function radioSet(
  key: "wifi" | "bluetooth" | "airplane" | "hotspot",
  enabled: boolean,
): Promise<RadioSetReply | null> {
  const res = await invoke<RadioSetReply>("radio_set", { key, enabled });
  // The refusal no longer travels as a command failure, so the ledger routing that
  // `invoke` used to do happens here — the diagnostic record must not get quieter
  // just because the answer became structured.
  if (res && !res.applied) {
    amosWarn("backend", "radio_set refused", res.refusal?.detail ?? res.refusal?.kind ?? res.refusal);
  }
  return res;
}

/* ---- Platform-managed switches (REQ-A202): on modern Android the platform owns the
 *       Wi-Fi (API 29+) and Bluetooth (API 33+) switches, and the airplane bit has always
 *       needed WRITE_SECURE_SETTINGS. `radio_set` then refuses — before touching anything —
 *       and the screen's job is to say so and offer the system surface instead of a write
 *       that cannot succeed. These two commands are that path. ---- */

/** The platform's answer to "may an app switch this radio?" (machine tokens only). */
export type RadioControlReply = {
  radio: string;
  /** `true` = this app may switch it (a `radio_set` failure is then a real refusal). */
  app_controlled: boolean;
  /** The system surface that owns it: `"wifi_panel"` / `"bluetooth_settings"` / … */
  surface: string | null;
  /** Why not: `"switch_removed"` (the platform took the API away) / `"privileged_only"`. */
  reason: string | null;
};

/** Ask whether this app may switch `key`, and which system surface owns it if not. */
export async function radioControl(
  key: "wifi" | "bluetooth" | "airplane" | "hotspot",
): Promise<RadioControlReply | null> {
  return invoke<RadioControlReply>("radio_control", { key });
}

/** Open the system surface that owns a platform-managed switch. `true` = an Activity
 *  started; `null`/`false` means it did not, and the screen must say so. */
export async function radioOpenSettings(
  key: "wifi" | "bluetooth" | "airplane" | "hotspot",
): Promise<boolean | null> {
  return invoke<boolean>("radio_open_settings", { key });
}

/* ---- Bluetooth details (REQ-A199): what the adapter calls itself and which devices
 *       it is paired with. Each call answers with the **device's** value, or fails when
 *       nobody can ask (offline host, or a build whose Android glue never attached) —
 *       in which case the screen keeps showing its stored preference and says so. ---- */

/** One paired device as the adapter reports it. */
export type BluetoothPeer = { address: string; name: string };

/** The adapter's own name, as the device reports it. Fails when nobody can ask. */
export async function bluetoothAdapterName(): Promise<string | null> {
  return invoke<string>("bluetooth_adapter_name");
}

/** Rename the adapter; resolves with the name the **adapter** reports afterwards (it may
 *  truncate), or null when the request did not reach a device. */
export async function bluetoothRenameAdapter(name: string): Promise<string | null> {
  return invoke<string>("bluetooth_rename_adapter", { name });
}

/** The devices the adapter is paired with (empty list = paired with nothing). */
export async function bluetoothPairedDevices(): Promise<BluetoothPeer[] | null> {
  return invoke<BluetoothPeer[]>("bluetooth_paired_devices");
}

/* ---- Bluetooth discovery (REQ-A200; LE + bond states REQ-A201): the scan runs in the
 *       device glue, the screen starts/stops it and polls its state. `scan_allowed:
 *       false` (no BLUETOOTH_SCAN) is deliberately distinct from an empty `devices` list,
 *       and `classic` / `le` say which transports were actually searched. ---- */

/** One device seen by a scan. */
export type BluetoothScanDevice = {
  address: string;
  /** Advertised name, or "" when the platform has none (label the row with the address). */
  name: string;
  rssi: number | null;
  /**
   * The raw platform bond state: 10 none / 11 bonding / 12 bonded. Not a bool — "pairing
   * in progress" is a third answer the row renders as progress (see `lib/bluetooth`).
   */
  bond: number;
  /** Seen over a Bluetooth **LE** advertisement (vs classic BR/EDR discovery). */
  le: boolean;
};

/** One bond transition the glue saw during the scan session. */
export type BluetoothBond = { address: string; state: number };

/** A scan's state: running / transports / capped / allowed / results / bond changes. */
export type BluetoothScan = {
  /** A search is running (classic discovery **or** the LE scan). */
  discovering: boolean;
  /** Classic (BR/EDR) discovery is running. */
  classic: boolean;
  /** The LE scan is running (`false` = LE was not searched, not "LE found nothing"). */
  le: boolean;
  /** The result list hit the device-side cap, so it may be partial. */
  capped: boolean;
  /** Whether this app may scan at all (`BLUETOOTH_SCAN` granted). */
  scan_allowed: boolean;
  devices: BluetoothScanDevice[];
  /** Bond transitions seen this session, for the address the user asked to pair with. */
  bonds: BluetoothBond[];
};

/** Start a scan. `false` = the platform refused (no adapter / no BLUETOOTH_SCAN). */
export async function bluetoothStartScan(): Promise<boolean | null> {
  return invoke<boolean>("bluetooth_start_scan");
}

/** Cancel a scan (called when the screen leaves the Bluetooth page). */
export async function bluetoothStopScan(): Promise<boolean | null> {
  return invoke<boolean>("bluetooth_stop_scan");
}

/** The current scan state. */
export async function bluetoothScanState(): Promise<BluetoothScan | null> {
  return invoke<BluetoothScan>("bluetooth_scan_state");
}

/** Ask the platform to pair with `address`. `true` = the request was ACCEPTED (the
 *  system's pairing flow starts and the user confirms on the peer) — never "paired". */
export async function bluetoothPair(address: string): Promise<boolean | null> {
  return invoke<boolean>("bluetooth_pair", { address });
}

/* ---- Flashlight / torch (flashlight_*). Illumination on/off. Like the radios,
 *       the Android torch (CameraManager) is reachable only from the System UI,
 *       so it does NOT round-trip through the headless daemon. ---- */
export type FlashlightPayload = { on: boolean; torch_present: boolean; available: boolean };

/** Read the current flashlight state (torch on/off + hardware presence). */
export async function flashlightStatus(): Promise<FlashlightPayload | null> {
  return invoke<FlashlightPayload>("flashlight_status");
}

/** Set the torch on/off. Returns the authoritative resulting state (the backend
 * refuses to light a torch when no usable flash hardware exists). */
export async function flashlightSet(enabled: boolean): Promise<FlashlightPayload | null> {
  return invoke<FlashlightPayload>("flashlight_set", { enabled });
}

/* ---- Mail (amos-mail bridge: mail_mailboxes / mail_list / mail_inbox /
 *       mail_read / mail_send). Shapes mirror the Rust amos_mail models. ---- */
export type MailAddr = { name: string; email: string };
export type MailFlags = { seen: boolean; flagged: boolean; answered: boolean };
export interface MailSummary {
  id: string;
  mailbox: string;
  from: MailAddr | null;
  to: MailAddr[];
  subject: string;
  date: number; // unix epoch seconds
  flags: MailFlags;
  attachment_count: number;
}
export type MailAttachment = { id: string; filename: string; mime: string; size: number };
export interface MailMessage {
  summary: MailSummary;
  body_plain: string;
  body_html: string | null;
  attachments: MailAttachment[];
}
export type MailReceipt = { id: string; date: number };

/** List selectable mailbox names. */
export async function mailMailboxes(): Promise<string[] | null> {
  return invoke<string[]>("mail_mailboxes");
}

/** Summaries in a mailbox, newest first. */
export async function mailList(
  mailbox: string,
  limit?: number | null,
): Promise<MailSummary[] | null> {
  return invoke<MailSummary[]>("mail_list", { mailbox, limit: limit ?? null });
}

/** Search summaries in a mailbox (sender/recipient/subject/body), newest first. */
export async function mailSearch(mailbox: string, query: string): Promise<MailSummary[] | null> {
  return invoke<MailSummary[]>("mail_search", { mailbox, query });
}

/** Fetch a message and mark it read. */
export async function mailRead(mailbox: string, id: string): Promise<MailMessage | null> {
  return invoke<MailMessage>("mail_read", { mailbox, id });
}

/** Send a message (sender is the account). */
export async function mailSend(o: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
}): Promise<MailReceipt | null> {
  const cc = o.cc && o.cc.length > 0 ? o.cc : null;
  return invoke<MailReceipt>("mail_send", {
    to: o.to,
    subject: o.subject,
    body: o.body,
    cc,
  });
}

/** Star / unstar a message. Resolves (null) on success, else the command throws. */
export async function mailSetFlagged(
  mailbox: string,
  id: string,
  flagged: boolean,
): Promise<null> {
  return invoke<null>("mail_set_flagged", { mailbox, id, flagged });
}

/** Mark a message read / unread. */
export async function mailSetSeen(mailbox: string, id: string, seen: boolean): Promise<null> {
  return invoke<null>("mail_set_seen", { mailbox, id, seen });
}

/** Delete a message from a mailbox. Resolves (null) on success. */
export async function mailDelete(mailbox: string, id: string): Promise<null> {
  return invoke<null>("mail_delete", { mailbox, id });
}

/** Move a message into another mailbox (archive / trash). */
export async function mailMove(
  mailbox: string,
  id: string,
  target: string,
): Promise<null> {
  return invoke<null>("mail_move", { mailbox, id, target });
}

/* ---- App Store (amos-appstore bridge: appstore_catalog / appstore_search /
 *       appstore_find / appstore_installed / appstore_updatable /
 *       appstore_status / appstore_install / appstore_upgrade /
 *       appstore_uninstall). Shapes mirror the Rust amos_appstore models. ---- */
export type AppVersion = { major: number; minor: number; patch: number; pre: string | null };
export type AppCategory =
  | "other" | "tools" | "media" | "communication"
  | "games" | "productivity" | "education" | "system";
export type PackageFormat = "tar_gz" | "zip";
export type AppChecksum = { algorithm: "sha256"; value: string };
export interface PackageRef {
  format: PackageFormat;
  url: string;
  sha256: AppChecksum | null;
  size_bytes: number | null;
}
export interface AppManifest {
  id: string;
  name: string;
  summary: string;
  description?: string;
  author: string;
  version: AppVersion;
  category: AppCategory;
  homepage?: string;
  icon_url?: string;
  package: PackageRef;
  /** Optional Ed25519 developer signature (present only for signed apps). */
  publisher?: { public_key: string; signature: string } | null;
}
export interface InstalledApp {
  manifest: AppManifest;
  installed_at: number; // unix epoch seconds
}
/** Mirrors the Rust AppStatus serde shape: a bare "Available" string, or an
 *  externally-tagged { installed } / { updatable } object. */
export type AppStatus =
  | "Available"
  | { installed: { version: string } }
  | { updatable: { installed: string; latest: string } };

/** The full store catalog (browse view), sorted by id. */
export async function storeCatalog(): Promise<AppManifest[] | null> {
  return invoke<AppManifest[]>("appstore_catalog");
}

/** Search the catalog (id/name/summary/author/category, case-insensitive). */
export async function storeSearch(query: string): Promise<AppManifest[] | null> {
  return invoke<AppManifest[]>("appstore_search", { query });
}

/** One catalog entry, if still published (null when not bridged / not found). */
export async function storeFind(id: string): Promise<AppManifest | null> {
  return invoke<AppManifest>("appstore_find", { id });
}

/** The apps currently installed. */
export async function storeInstalled(): Promise<InstalledApp[] | null> {
  return invoke<InstalledApp[]>("appstore_installed");
}

/** Ids of installed apps that have a newer release in the catalog. */
export async function storeUpdatable(): Promise<string[] | null> {
  return invoke<string[]>("appstore_updatable");
}

/** Lifecycle state of one app (Available / Installed / Updatable). */
export async function storeStatus(id: string): Promise<AppStatus | null> {
  return invoke<AppStatus>("appstore_status", { id });
}

/** Download → verify → install the catalog's release of `id`. */
export async function storeInstall(id: string): Promise<InstalledApp | null> {
  return invoke<InstalledApp>("appstore_install", { id });
}

/** Upgrade `id` to the catalog's newest release. */
export async function storeUpgrade(id: string): Promise<InstalledApp | null> {
  return invoke<InstalledApp>("appstore_upgrade", { id });
}

/** Uninstall `id`. Resolves (null) on success. */
export async function storeUninstall(id: string): Promise<null> {
  return invoke<null>("appstore_uninstall", { id });
}

/**
 * Write `value` (the raw string a caller would put in `localStorage`) through to
 * the Rust `SharedStore`. Offline → `null` (the local write still stands).
 *
 * This is the **write-through** half of the shared store: the Rust store is the
 * durable copy plus the cross-window bus (`store-updated`). It replaces the old
 * `window.Amos.storeWrite` shim, which nothing ever injected — so every
 * `writeStoreValue` silently stopped mirroring (and boot's hydrate could only
 * ever pull stale data back).
 */
export async function systemStoreSet(key: string, value: string): Promise<void | null> {
  return invoke<void>("store_set", { key, value });
}

/** Snapshot of the durable Rust system store (boot hydration into localStorage). */
export async function systemStoreSnapshot(): Promise<Record<string, string> | null> {
  return invoke<Record<string, string>>("store_snapshot");
}



/* ---- Notes export: write a .txt via the Rust core ---- */

export interface ExportedTxtFile {
  name: string;
  path: string;
  bytes: number;
}

/** Ask the Rust core to write `text` to a `<name>.txt` file in its export dir and
 *  return the on-disk path. Outside Tauri (or when the command is unavailable)
 *  this returns null so the UI can fall back to copying to the AmOS clipboard. */
export async function exportTxtFile(name: string, text: string): Promise<ExportedTxtFile | null> {
  return invoke<ExportedTxtFile>("notes_export_txt", { name, text });
}

/* ---- Native exact-alarm bridge (docs/native-alarm-bridge.md; §9 ③) ---- */

/** Ask the Rust host to register a one-shot exact alarm at `atMs` (epoch ms).
 *  Offline (no Tauri bridge) → no-op returning null, so the WebView still rings
 *  via its own JS notifier. */
export async function registerNativeAlarm(id: string, atMs: number): Promise<void> {
  await invoke("scheduler_alarm_register", { id, atMs });
}

/** Ask the Rust host to cancel a pending exact alarm. Offline → null. */
export async function cancelNativeAlarm(id: string): Promise<boolean | null> {
  return invoke<boolean>("scheduler_alarm_cancel", { id });
}

/** Poll the Rust host for alarms due by `nowMs` (defaults to host wall clock).
 *  Returns { due: string[] } on-device, or null offline. */
export async function pollNativeAlarms(nowMs?: number): Promise<{ due: string[] } | null> {
  return invoke<{ due: string[] }>("scheduler_alarm_poll", { nowMs });
}

/* ---- SMS (real device inbox via amos-sms; empty/absent on host) ---- */

/** One SMS thread (mirrors `amos-tauri::sms::SmsThreadOut`). */
export interface SmsThreadOut {
  id: string;
  address: string;
  display_name: string;
  last_text: string;
  last_ts_ms: number;
  unread: number;
}

/** One SMS message (mirrors `amos-tauri::sms::SmsMessageOut`). */
export interface SmsMessageOut {
  thread_id: string;
  id: string;
  from_me: boolean;
  text: string;
  ts_ms: number;
  read: boolean;
}

/** Spam-blocking rules (`amos-tauri::blocklist`). */
export interface BlockRuleOut {
  id: string;
  pattern: string;
  kind: "exact" | "prefix";
  channel: "call" | "sms" | "both";
  label: string;
  created_ms: number;
}

/** The whole blocklist: rules (newest first) + the unknown-number switch. */
export interface BlocklistOut {
  block_unknown: boolean;
  rules: BlockRuleOut[];
}

/** Why an address is blocked (`null` = allowed). */
export type BlockReasonOut =
  | { kind: "rule"; id: string; pattern: string; label: string; channel: BlockRuleOut["channel"] }
  | { kind: "unknown" };

/**
 * Whether call blocking can actually take effect (rules alone are not enough —
 * Android only rejects calls while AmOS holds the Call Screening role).
 */
export interface BlocklistStatusOut {
  has_call_rules: boolean;
  has_sms_rules: boolean;
  /** The platform supports the role (Android 10+). */
  role_supported: boolean;
  /** AmOS holds the role right now → incoming calls really are rejected. */
  role_held: boolean;
  /** The native glue is bound, so "grant the role" can actually do something. */
  role_requestable: boolean;
}

/** Read the blocklist. `null` when unavailable. */
export async function blocklistSnapshot(): Promise<BlocklistOut | null> {
  return invoke<BlocklistOut>("blocklist_snapshot");
}

/** Add (or refresh) a rule; rejects with the domain's honest error message. */
export async function blocklistAdd(
  pattern: string,
  kind: BlockRuleOut["kind"],
  channel: BlockRuleOut["channel"],
  label = "",
): Promise<BlockRuleOut | null> {
  return invoke<BlockRuleOut>("blocklist_add", { pattern, kind, channel, label });
}

/** Remove a rule by id. */
export async function blocklistRemove(id: string): Promise<boolean> {
  return (await invoke<boolean>("blocklist_remove", { id })) === true;
}

/** Drop every rule (keeps the unknown-number switch). */
export async function blocklistClear(): Promise<void> {
  await invoke<null>("blocklist_clear");
}

/** Turn unknown/withheld-number blocking on/off. */
export async function blocklistSetUnknown(on: boolean): Promise<void> {
  await invoke<null>("blocklist_set_unknown", { on });
}

/** Why an address is blocked for a channel (`null` = allowed / unavailable). */
export async function blocklistCheck(
  address: string,
  channel: BlockRuleOut["channel"],
): Promise<BlockReasonOut | null> {
  return invoke<BlockReasonOut | null>("blocklist_check", { address, channel });
}

/** Rules + on-device enforcement status. `null` when the bridge is unavailable. */
export async function blocklistStatus(): Promise<BlocklistStatusOut | null> {
  return invoke<BlocklistStatusOut>("blocklist_status");
}

/**
 * Ask the system for the Call Screening role (foreground). Resolves `true` when the
 * dialog was posted or the role is already held; rejects when unsupported.
 */
export async function blocklistRequestRole(): Promise<boolean> {
  return (await invoke<boolean>("blocklist_request_role")) === true;
}

export type SmsFolder = "inbox" | "sent" | "draft";

/** Every folder, in the order the UI shows them. */
export const SMS_FOLDERS: readonly SmsFolder[] = ["inbox", "sent", "draft"];

/** Per-folder distinct-thread counts (`amos-tauri::sms::SmsFolderCountsOut`). */
export interface SmsFolderCounts {
  inbox: number;
  sent: number;
  draft: number;
}

/** Which backend backs SMS: `device: false` means the honest host mock, so the
 *  UI must keep using local conversations instead of showing an empty inbox. */
export interface SmsStatusOut {
  provider: string;
  device: boolean;
}

/** Event the device backend emits when an SMS arrived (`amos-tauri::sms`
 *  `SMS_RECEIVED_EVENT`); the Messages screen re-reads the inbox on it. */
export const SMS_RECEIVED_EVENT = "sms-received";

/** Ask which SMS backend is active (no device I/O). `null` outside Tauri. */
export async function smsStatus(): Promise<SmsStatusOut | null> {
  return invoke<SmsStatusOut>("sms_status");
}

/** Distinct thread counts per folder (tabs/badges). `null` when unavailable. */
export async function smsCounts(): Promise<SmsFolderCounts | null> {
  return invoke<SmsFolderCounts>("sms_counts");
}

/** A snapshot outcome that keeps "empty folder" and "could not read" distinct:
 *  the former is a real (empty) folder, the latter needs an honest message
 *  (e.g. READ_SMS denied) — collapsing them would lie to the user. */
export type SmsFolderSnapshotResult =
  | { ok: true; threads: SmsThreadOut[] }
  | { ok: false; error: string; denied: boolean; notBridged: boolean };

/** Read one folder's threads, distinguishing success (possibly empty) from failure. */
export async function smsFolderSnapshot(folder: SmsFolder): Promise<SmsFolderSnapshotResult> {
  const threads = await invoke<SmsThreadOut[]>("sms_snapshot", { folder });
  if (threads) return { ok: true, threads };
  const diag = bridgeDiag();
  if (!diag.ok && diag.kind === "not-bridged") {
    return { ok: false, error: "not bridged", denied: false, notBridged: true };
  }
  const error = diag.ok ? "no result" : String(diag.detail ?? "failed");
  return {
    ok: false,
    error,
    denied: /permission|denied|not granted/i.test(error),
    notBridged: false,
  };
}

/** Messages of one SMS thread (chronological). `folder` scopes them to a folder;
 *  omitted = the whole conversation. `address` is the thread's remote party: when
 *  it is blocked for SMS the command refuses with an honest error. `null` when
 *  unavailable.
 *
 * Tauri v2 deserializes command args in camelCase, so the key must be
 * `threadId` (the Rust param is `thread_id`); passing snake_case fails with
 * "missing required key threadId" — verified on device. */
export async function smsMessages(
  threadId: string,
  folder?: SmsFolder,
  address?: string,
): Promise<SmsMessageOut[] | null> {
  return invoke<SmsMessageOut[]>("sms_messages", {
    threadId,
    folder: folder ?? "",
    address: address ?? "",
  });
}

/** Send a real SMS. `true` only on the command's explicit success marker. */
export async function smsSend(address: string, text: string): Promise<boolean> {
  const r = await invoke<string>("sms_send", { address, text });
  return r === "sent";
}

// ---- View-layer trash (REQ-A42) ------------------------------------------------
// Deleting a real SMS requires owning the platform's default-SMS-app role, which
// AmOS does not hold. The trash therefore *hides* messages in the AmOS UI only —
// the system SMS app keeps the originals. The backend stores ids + timestamps
// (never bodies) and persists them across restarts.

/** One trash entry (mirrors `amos-tauri::sms::TrashOut`): ids and times only —
 *  the hidden message body is deliberately not here. The fields are the wire's
 *  **snake_case** names (serde's default; nothing in `sms.rs` renames them), so a
 *  camelCase read here would silently be `undefined`. */
export interface SmsTrashEntryOut {
  thread_id: string;
  message_id: string;
  ts_ms: number;
  trashed_ms: number;
}

/** Outcome of a trash request, keeping the honest cases apart: trashed, refused
 *  (blocked sender / storage error — `reason`), or the message was not found in
 *  the given folder (e.g. the list went stale). Mirrors `sms::TrashAddOut` — the
 *  bridge's three-state contract, keys snake_case on the wire. */
export type SmsTrashAddResult =
  | { trashed: true }
  | { trashed: false; reason: string }
  | { trashed: false; not_found: true };

/** Hide one message in the AmOS UI. `folder` scopes the request to the folder
 *  the user is viewing (the whole thread when omitted). `null` outside Tauri. */
export async function smsTrashAdd(
  threadId: string,
  messageId: string,
  folder?: SmsFolder,
): Promise<SmsTrashAddResult | null> {
  const r = await invoke<SmsTrashAddResult>("sms_trash_add", {
    threadId,
    messageId,
    folder: folder ?? "",
  });
  return r;
}

/** The current trash (newest first). `null` when unavailable. */
export async function smsTrashList(): Promise<SmsTrashEntryOut[] | null> {
  return invoke<SmsTrashEntryOut[]>("sms_trash_list");
}

/** Put a trashed message back (undo). `true` only when an entry was removed.
 *  The command answers a **boolean** (serde `true`/`false`); an earlier revision of
 *  this wrapper compared it to the string `"restored"`, so a successful restore was
 *  reported as a failure and the list never refreshed. */
export async function smsTrashRestore(threadId: string, messageId: string): Promise<boolean> {
  return (await invoke<boolean>("sms_trash_restore", { threadId, messageId })) === true;
}

/** Empty the trash: every hidden message becomes visible again (an honest
 *  "restore all" — nothing is destroyed). Returns whether the call itself
 *  succeeded (the command answers the number purged; `0` is a successful no-op,
 *  never an error). */
export async function smsTrashPurge(): Promise<boolean> {
  const purged = await invoke<number>("sms_trash_purge");
  return typeof purged === "number";
}

