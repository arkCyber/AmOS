/**
 * Typed bridge to the Tauri Rust core (window.__TAURI_INTERNALS__), mirroring the
 * legacy vanilla UI's commands. Outside Tauri every call degrades to null/false so
 * the UI can show a localized "daemon not connected" state instead of crashing.
 */
import type { AiProviderId } from "./providers";
import { amosWarn } from "./debugLog";
import { localId } from "./localId";

interface TauriBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  /** `null` when the host did **not** establish the subscription (REQ-A838). */
  listen(channel: string, handler: (e: { payload: unknown }) => void): Promise<(() => void) | null>;
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
 * `listen` helper does not exist.
 *
 * Returns an unsubscribe function, or **`null` when the subscription was not
 * established** (REQ-A838). This function used to answer `() => {}` for every failure —
 * a plugin path that is unavailable, a registration the host rejected — which is the same
 * value it answers for success, so no caller could tell a live channel from a dead one.
 * `null` is the honest answer, and it is the convention every other wrapper in this module
 * already follows ([`invoke`] answers `null` for the same reason); [`subscribe`] records
 * *why* in the diagnostic ledger so `bridgeDiag(channel)` can still distinguish
 * "not bridged" from "the host refused".
 */
async function listenEvent(
  internals: TauriInternals,
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  channel: string,
  handler: (e: { payload: unknown }) => void,
): Promise<(() => void) | null> {
  if (typeof internals.listen === "function") {
    return internals.listen(channel, handler);
  }
  const transform = internals.transformCallback?.bind(internals);
  if (typeof transform !== "function") return null;
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
    // The host refused the registration. Unregister the callback we minted so the id is
    // not leaked, then report the failure honestly rather than as a no-op unsubscribe.
    internals.unregisterCallback?.(handlerId);
    return null;
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
  // `command-failed` carries the raw shape Tauri throws when a `Result<T, AmosError>`
  // comes back `Err`: `{ code, message, cause? }`. The `code` field is the wire-stable
  // name (e.g. `amos.interpret.no_active`) the UI branches on; `message` is the
  // developer-facing diagnostic the Rust side wrote, **never** shown to users as-is
  // — the i18n mirror is the contract, the message is the debug trail. The shape is
  // typed as optional `string` so a non-AmosError throw (a thrown JS value, a Tauri
  // bug that bypassed `Result::Err`) still fits and the ledger stays total.
  | {
      ok: false;
      kind: "command-failed";
      command: string;
      detail?: unknown;
      code?: string;
    }
  /**
   * A subscription that was **not established** (REQ-A838). Its own kind because the
   * consequence differs from a failed command: a refused `invoke` means one answer is
   * missing, while a refused `listen` means **no event will ever arrive** — the surface
   * stays up and simply never updates, which is indistinguishable from a quiet channel.
   */
  | { ok: false; kind: "listen-failed"; command: string; detail?: unknown };

let lastDiag: BridgeDiag = { ok: true };

/**
 * Last outcome **per command**, so a caller can ask about the call it actually made.
 *
 * `lastDiag` alone is a single global slot: every `invoke` writes it, so by the time a
 * surface logs "why did *this* fail?" an unrelated command that finished later may have
 * overwritten the answer. That is not only a wrong log line — `PhoneApp` branches on it
 * (`if (!bridgeDiag().ok)`), so a stale slot could roll back a switch the host *did*
 * save, or (worse) hide a real failure behind someone else's success (REQ-A296).
 *
 * Bounded (oldest command evicted first) because "one entry per command name" must not
 * grow with the number of distinct commands a session ever calls.
 */
const perCommandDiag = new Map<string, BridgeDiag>();
const PER_COMMAND_CAP = 48;

function noteDiag(command: string, d: BridgeDiag): void {
  lastDiag = d;
  if (!perCommandDiag.has(command) && perCommandDiag.size >= PER_COMMAND_CAP) {
    const oldest = perCommandDiag.keys().next().value;
    if (oldest !== undefined) perCommandDiag.delete(oldest);
  }
  perCommandDiag.set(command, d);
}

/**
 * Structured diagnosis of a bridge call.
 *
 * * `bridgeDiag()` — the **last** outcome of any command (kept for compatibility; prefer
 *   the form below whenever the question is about one specific call).
 * * `bridgeDiag(command)` — the last outcome of *that* command. A command that was never
 *   called has no record: the answer is `{ ok: true }` — "no recorded failure", which is
 *   the honest default for a caller whose own `null` check is the authority
 *   (`invoke` returns `null` on failure, so the value is the primary signal and this is
 *   the explanation).
 */
export function bridgeDiag(command?: string): BridgeDiag {
  if (command === undefined) return lastDiag;
  return perCommandDiag.get(command) ?? { ok: true };
}

/** Call a Tauri command; returns null when not running inside Tauri. */
export async function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const b = bridge();
  if (!b) {
    noteDiag(command, { ok: false, kind: "not-bridged", command });
    return null;
  }
  try {
    const result = (await b.invoke(command, args)) as T;
    noteDiag(command, { ok: true });
    return result;
  } catch (err) {
    // Tauri throws the Rust `AmosError` envelope as a plain object:
    //   `{ code: "amos.<group>.<kind>", message: "<debug>", cause?: ["…"] }`
    // We surface the `code` on the diagnostic ledger (REQ-A461) so a caller can
    // branch on the typed reason — "no active session" vs. "session id mismatch"
    // vs. "text too long" — rather than parsing the (English-only, possibly
    // renamable) message string. The full envelope still rides along in
    // `detail` for any caller that wants the developer-facing diagnostic.
    const code =
      err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
        ? ((err as { code: string }).code)
        : undefined;
    noteDiag(command, { ok: false, kind: "command-failed", command, detail: err, code });
    // Routed through the diagnostic ledger (P1-3) so a failed bridge call is
    // retrievable from the UI, not just visible in logcat while it scrolls away.
    amosWarn("backend", `${command} failed`, err);
    return null;
  }
}

/**
 * Subscribe to a backend event channel.
 *
 * Returns an unsubscribe function, or **`null` when the channel was not subscribed** —
 * which is the failure value, and the same convention [`invoke`] uses (REQ-A838). The
 * `bridgeDiag(channel)` entry says which failure it was:
 *
 * * `{ ok: false, kind: "not-bridged" }` — no host at all (a browser, a test double).
 * * `{ ok: false, kind: "listen-failed" }` — a host **is** there and refused the
 *   registration. This is the case that used to be invisible: it is a real fault, and the
 *   surface it feeds will never update.
 *
 * It used to answer `() => {}` in every case, including success, so a screen driven by a
 * dead channel looked exactly like one on a quiet channel — no error, no gap, nothing to
 * notice. Reading the verdict is what separates them, and a caller that does not care can
 * still collapse deliberately (`?? undefined`) and say so.
 */
export async function subscribe(
  channel: string,
  onEvent: (payload: unknown) => void,
): Promise<(() => void) | null> {
  const b = bridge();
  if (!b) {
    noteDiag(channel, { ok: false, kind: "not-bridged", command: channel });
    return null;
  }
  try {
    const un = await b.listen(channel, (e) => onEvent(e.payload));
    if (typeof un !== "function") {
      // `listenEvent` answers `null` for the failures it handles internally (no
      // `transformCallback`, a rejected `plugin:event|listen`). Warn on this path too —
      // the `catch` below warns, and a ledger entry nobody writes a breadcrumb for is the
      // half-visible failure this round is about.
      noteDiag(channel, { ok: false, kind: "listen-failed", command: channel });
      amosWarn("backend", `listen(${channel}) was refused by the host`);
      return null;
    }
    noteDiag(channel, { ok: true });
    return () => {
      try {
        un();
      } catch {
        /* ignore */
      }
    };
  } catch (err) {
    noteDiag(channel, { ok: false, kind: "listen-failed", command: channel, detail: err });
    amosWarn("backend", `listen(${channel}) failed`, err);
    return null;
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
 * Returns the daemon launch report. `null` means *either* "not running inside
 * Tauri" *or* "the command answered `Err`" — `invoke` catches the error envelope
 * and folds both into `null`, so callers must ask `bridgeDiag("ai_backend_switch")`
 * before treating `null` as success. */
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

/**
 * Stable conversation id persisted for multi-turn memory.
 *
 * Minted once per install and then read back, so a collision is not a momentary lost row —
 * it is two sessions sharing one multi-turn history. Uses the shared `localId` (REQ-A401);
 * the `conv-` prefix is kept (`backend-bridge.test.ts` keys on it).
 */
export function conversationId(): string {
  const KEY = "amos.ai.session";
  const existing = readStored(KEY, "");
  if (existing) return existing;
  const id = localId("conv");
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
/**
 * Which of four things a *failed* `granted:false` means (REQ-A787 / F-AND-010).
 *
 * Mirrors `crates/amos-tauri/src/mic_permission.rs`'s `MicGrantState` variant for variant
 * (`#[serde(rename_all = "kebab-case")]`), and `declaredMirrors.test.ts` fails when the two
 * drift: `"granted"`, `"denied"`, `"unreadable"`, `"timed-out"`, `"host"`. `"unreadable"` is
 * the one a UI must never word as a fact about the user — the read failed, so the grant
 * question was never answered.
 */
export type MicGrantStateWire = "granted" | "denied" | "unreadable" | "timed-out" | "host";

export interface MicPermissionState {
  /** True only when the OS-grant concept exists here (Android System UI, glue bound). */
  native: boolean;
  /** True **only** when the OS itself answered "yes" — i.e. `state === "granted"`. */
  granted: boolean;
  /** *Why* `granted` is false, when it is — never inferred from `granted` alone. */
  state: MicGrantStateWire;
  /** The host's own words when `state === "unreadable"`; absent otherwise. */
  detail?: string;
}

/** Dialog-free snapshot of the OS `RECORD_AUDIO` grant. Host → `state: "host"`. */
export async function micPermissionState(): Promise<MicPermissionState | null> {
  return invoke<MicPermissionState>("mic_permission_state");
}

/**
 * JS-awaitable: ensure `RECORD_AUDIO` for the native AAudio mic, posting the OS
 * dialog only when it is not already held. Host → `state: "host"` (no dialog, no
 * fabricated grant).
 */
export async function micPermissionRequest(): Promise<MicPermissionState | null> {
  return invoke<MicPermissionState>("mic_permission_request");
}

/* ---- OS SMS grant (READ_SMS / SEND_SMS / RECEIVE_SMS — the whole set is one grant) ---- */

/** Wire spellings of the SMS grant read; the same five states as the mic grant. */
export type SmsGrantStateWire = "granted" | "denied" | "unreadable" | "timed-out" | "host";

export interface SmsPermissionState {
  /** True only when the OS-grant concept exists here (Android System UI, glue bound). */
  native: boolean;
  /** True **only** when the OS answered that the whole set is held. */
  granted: boolean;
  /** *Why* `granted` is false, when it is — never inferred from `granted` alone. */
  state: SmsGrantStateWire;
  /** The host's own words when `state === "unreadable"`; absent otherwise. */
  detail?: string;
}

/**
 * JS-awaitable: ask the OS for READ_SMS / SEND_SMS / RECEIVE_SMS, posting the dialog
 * only when the set is not already held. Host → `state: "host"` (no dialog, no
 * fabricated grant).
 */
export async function smsPermissionRequest(): Promise<SmsPermissionState | null> {
  return invoke<SmsPermissionState>("sms_permission_request");
}

/* ---- OS location grant (the native `LocationManager` read needs it; not the WebView path) ---- */

/**
 * State of the OS location grant for the native GNSS read behind the sensor snapshot's
 * `gnss` block. `native` is true only inside the Android System UI where the Kotlin
 * `LocationPermissionGlue` is bound.
 *
 * Three levels, not a boolean: Android 12+ lets the user answer **approximate**, and a
 * boolean would report that as the precise grant — the UI would then promise an accuracy
 * the receiver was never allowed to give (REQ-A772 / F-SH-228).
 */
export interface LocationPermissionState {
  native: boolean;
  grant: "none" | "coarse" | "fine";
}

/** Dialog-free snapshot of the OS location grant. Host → `native:false`. */
export async function locationPermissionState(): Promise<LocationPermissionState | null> {
  return invoke<LocationPermissionState>("location_permission_state");
}

/**
 * JS-awaitable: ensure the location grant for the native `LocationManager` read, posting the
 * OS dialog only when none is held. Host → `{ native:false, grant:"none" }` (no dialog, no
 * fabricated grant).
 */
export async function locationPermissionRequest(): Promise<LocationPermissionState | null> {
  return invoke<LocationPermissionState>("location_permission_request");
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

/**
 * Force the in-flight utterance to translate now, without waiting for the VAD's silence.
 * The command answers `Result<(), String>`, and `()` serializes to `null` — the same value
 * `invoke` returns on failure — so success is read from the diagnostic ledger
 * (`bridgeDiag("interpret_end_of_speech").ok`), the pattern `PhoneApp` uses for its
 * `()`-returning commands, not from the return value. */
export async function interpretEndOfSpeech(sessionId: number): Promise<unknown> {
  return invoke("interpret_end_of_speech", { sessionId });
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
  /**
   * "Off" / "On" / "Failed" — whether the call is being recorded.
   *
   * `undefined` is "no claim", exactly like `muted`: a real in-call bridge reply answers
   * about *one* toggle, so a mute / speaker / hold reply carries no recording. A caller
   * applying this payload field-by-field must keep the recording state it already has.
   * Every daemon snapshot and every `Watch` event carries the field.
   */
  recording?: string;
  /**
   * Whether the daemon's call state says this call's outbound audio is muted.
   *
   * `undefined` means the host made **no claim** (the real in-call recording bridge
   * answers about recording only), so a caller must leave its current mute state
   * alone rather than reading `undefined` as `false`.
   */
  muted?: boolean;
  /**
   * Whether this call's audio is routed to the loudspeaker.
   *
   * Only the **real in-call bridge** answers this: the daemon's transport has no audio
   * route, so every daemon snapshot and every `Watch` event leaves it `undefined`. The
   * same "no claim" rule as `muted` — a caller keeps the speaker state it has.
   */
  speaker?: boolean;
  /** Whether this call is on hold. Real in-call bridge only — see `speaker`. */
  hold?: boolean;
};
export type TelephonyDialResult = { id: string };

/** Tauri event carrying one live-call state snapshot (incoming/connected/ended). */
export const TELEPHONY_EVENT = "telephony-event";
/** The host's native-menu activation channel (`crates/amos-tauri/src/menu.rs`). */
export const MENU_EVENT = "menu-event";

/** Place a call. `emergency` (or an emergency number) uses the privileged path. */
export async function telephonyDial(
  number: string,
  emergency = false,
): Promise<TelephonyDialResult | null> {
  return invoke<TelephonyDialResult>("telephony_dial", { number, emergency });
}

/**
 * Place a **real** outbound call through Android Telecom (`ACTION_CALL`). Returns
 * `true` when the platform took the call; `false` when real dialing is unavailable
 * (desktop host, or an on-device build without the bound context / `CALL_PHONE`
 * grant) — never a fabricated success.
 *
 * The dialer reaches this as the **first** transport of `placeOutgoingCall`
 * (`lib/phone.ts`): a real platform call is preferred over a simulated one, and this
 * is the only path that reaches the platform. A daemon that can genuinely own a call
 * (backend kind `android`) is preferred ahead of it so the in-call UI stays bound;
 * otherwise a failed real dial is reported honestly rather than downgraded to a mock.
 */
export async function realDial(number: string): Promise<boolean> {
  const status = await invoke<string>("real_dial", { number });
  return typeof status === "string";
}

/** Whether this host can place a **real** call, and if not, why not. */
export type RealDialStatus = {
  /** This build is an on-device (Android) System UI build that could dial. */
  on_device: boolean;
  /**
   * A real call can be fired right now: on-device, the dial context bound **and** the
   * `CALL_PHONE` grant held. `false` also covers "the grant could not be read" — the
   * safe direction, so a caller never routes a dial into a rejected `ACTION_CALL`
   * (REQ-A1626).
   */
  available: boolean;
  /** Why `available` is false, in the host's own words ("" when available). */
  reason: string;
};

/**
 * Ask whether a real call can be placed right now.
 *
 * `null` means the host never answered — which must **not** be read as either
 * "yes" or "no": a caller that cannot classify the host treats it as "cannot place a
 * real call" and reports failure rather than trusting a simulation.
 */
export async function realDialStatus(): Promise<RealDialStatus | null> {
  return invoke<RealDialStatus>("telephony_real_dial_status");
}

/** Which provider backs the daemon's telephony service. */
export type TelephonyBackend = {
  /** `mock` | `android` | `unconfigured` | `unspecified`. */
  kind: string;
  /** The backend's own words about itself. */
  detail: string;
  /** Does `Dial` reach the platform telephony stack? True only for `android`. */
  real: boolean;
};

/**
 * Ask which provider backs the daemon's telephony `Dial`.
 *
 * `null` (the daemon did not answer) is **not** "mock" and **not** "real": it is
 * "unknown", and an unknown backend is never trusted as a real call path.
 */
export async function telephonyBackendKind(): Promise<TelephonyBackend | null> {
  return invoke<TelephonyBackend>("telephony_backend_kind");
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
 * Rust bridge. Each call to `onEvent` receives a `TelephonyCall`.
 *
 * The returned value is the **cleanup**, and it is the same function whether or not the
 * subscription was established: releasing a subscription that does not exist is a no-op, so a
 * caller that only calls it in `onMount`'s teardown needs nothing more. Whether events will
 * actually arrive is answered by `bridgeDiag(TELEPHONY_EVENT)` (REQ-A838) — a refused listen
 * records `listen-failed` there and warns through the debug ledger, rather than looking like a
 * call stream that happens to be quiet. Outside Tauri there is no bridge at all, so the answer
 * is `not-bridged` and no event will ever be delivered.
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
    if (u === null) return; // never established — nothing to release
    if (cancelled) u();
    else unsub = u;
  });
  return () => {
    cancelled = true;
    unsub?.();
  };
}

/**
 * Subscribe to the host's **native menu** activations.
 *
 * The Rust side installs the macOS menu bar and forwards every item activation as a `menu-event`
 * carrying the item id (`crates/amos-tauri/src/menu.rs`, `app.emit("menu-event", id)`); the shell
 * maps a small subset of those ids (Preferences / New Window / Close Window / Enter Full Screen).
 *
 * This function is why `DesktopShell.svelte` could not mount for a while (REQ-A342): it imported
 * `onMenuEvent` from this module, the export did not exist, and calling `undefined` threw inside
 * the component's `onMount` — so the whole desktop chrome failed to initialise, while the event
 * the host emits had **no consumer at all**. Both halves of that sentence are now fixed: the
 * subscriber exists here (same shape as `onTelephonyEvent`: a synchronously returned unsubscribe,
 * a no-op outside Tauri), and the emit has a reader again.
 *
 * REQ-A838: the menu bar has no polling fallback — if the listen is refused, no item activation
 * will ever reach the shell and the menu will simply do nothing. That is exactly the shape this
 * round is about, so the refusal is recorded where the shell already looks: `subscribe` writes
 * `listen-failed` to the diagnosis ledger under `MENU_EVENT`, which `DesktopShell.svelte` reads
 * back with `bridgeDiag`. A dead menu is then a verdict, not an absence of evidence.
 */
export function onMenuEvent(onEvent: (id: string) => void): () => void {
  let cancelled = false;
  let unsub: (() => void) | null = null;
  void subscribe(MENU_EVENT, (payload) => {
    if (typeof payload === "string" && payload) onEvent(payload);
  }).then((u) => {
    if (u === null) return; // never established — nothing to release
    if (cancelled) u();
    else unsub = u;
  });
  return () => {
    cancelled = true;
    unsub?.();
  };
}


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

/**
 * Set the mute flag on a live call; returns the daemon's authoritative snapshot.
 *
 * `muted` is the **desired state**, not a toggle, so a retried call is safe. The
 * daemon owns this flag — it is the same call state `Watch` subscribers receive — so
 * muting here is visible to the lock screen and the AI assistant too. Physically
 * cutting the microphone is the audio pipeline's job; this records the decision.
 */
export async function telephonySetMuted(
  callId: string,
  muted: boolean,
): Promise<TelephonyCall | null> {
  return invoke<TelephonyCall>("telephony_set_muted", { callId, muted });
}

/**
 * Send one **DTMF** tone to a live call, so a caller navigating an IVR reaches it.
 *
 * The answer is `true` **only** when a bound in-call service handed the tone to Telecom;
 * `false` is the host's honest "the tone did not reach the call" (no in-call service is
 * bound, or Telecom refused). It is deliberately not an error — a keypad keystroke is
 * best-effort, and the pad already says so. A malformed tone is a typed `AmosError`
 * (`invoke` folds it to `null`; the reason is in `bridgeDiag("telephony_play_dtmf")`).
 *
 * The three-valued answer is the whole point: the pad's note must not promise the far end
 * hears the digits when it does not, and must not keep disclaiming them when it does.
 * (REQ-A1146 / F-SH-453)
 */
export async function telephonyPlayDtmf(
  callId: string,
  tone: string,
): Promise<boolean | null> {
  return invoke<boolean>("telephony_play_dtmf", { callId, tone });
}

/**
 * Route a live call's audio to the **loudspeaker** (`true`) or the earpiece (`false`).
 *
 * `speaker` is the desired state, not a toggle, so a retried call cannot flip a route the
 * user did not touch. Device-only: without a bound in-call service there is no audio route
 * to change, and the host refuses in typed words (a fabricated `Ok` would light the button
 * over a call still on the earpiece).
 */
export async function telephonySetSpeaker(
  callId: string,
  speaker: boolean,
): Promise<TelephonyCall | null> {
  return invoke<TelephonyCall>("telephony_set_speaker", { callId, speaker });
}

/**
 * Put a live call on hold (`true`) or take it off hold (`false`). Device-only, like
 * [`telephonySetSpeaker`]; a call that cannot be held is a typed refusal rather than a
 * silent no-op that leaves a "held" button lit over a live call.
 */
export async function telephonySetHold(
  callId: string,
  hold: boolean,
): Promise<TelephonyCall | null> {
  return invoke<TelephonyCall>("telephony_set_hold", { callId, hold });
}

/**
 * Whether AmOS is the device's **default phone app** (`ROLE_DIALER`) — the precondition
 * for every real in-call control (`telephony_answer` / `telephony_end` /
 * `telephony_set_muted` / `telephony_set_speaker` / `telephony_set_hold` /
 * `telephony_play_dtmf` / the recording pair), each of which refuses with "AmOS is not the
 * default phone app" until the role is held.
 *
 * The three fields are the same triple `BlocklistStatusOut` uses for the sibling
 * ROLE_CALL_SCREENING role, and carry the same meanings:
 * * `role_supported` — this device can hold the role at all (Android + telephony).
 * * `role_held` — the **platform's** verdict (`RoleManager#isRoleHeld`), not "an in-call
 *   service happens to be bound": that question (`incall.rs::is_default_dialer_bound`)
 *   answers `false` between calls on a correctly configured phone.
 * * `role_requestable` — a request can actually be delivered (the native glue is bound).
 *   `false` means "we could not ask", never a verdict.
 *
 * `null` when the bridge is unavailable. (REQ-A1180)
 */
export interface DialerRoleStatusOut {
  role_supported: boolean;
  role_held: boolean;
  role_requestable: boolean;
}

/** Is AmOS the default phone app, and can it ask to become one? `null` = no bridge. */
export async function telephonyDefaultDialerStatus(): Promise<DialerRoleStatusOut | null> {
  return invoke<DialerRoleStatusOut>("telephony_default_dialer_status");
}

/**
 * Post the system dialog that grants the default-phone-app role (foreground, user-initiated).
 *
 * Resolves `true` when the dialog was posted **or** the role is already held — never "the
 * user accepted", which only a later [`telephonyDefaultDialerStatus`] read can answer.
 */
export async function telephonyRequestDefaultDialer(): Promise<boolean> {
  return (await invoke<boolean>("telephony_request_default_dialer")) === true;
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
  /**
   * The system surface where the switch can still be worked by hand: the owning screen
   * for `platform_managed`, and the tethering settings for a refused AP attempt
   * (`provider_refused` on `hotspot`). `null` when the device offered none.
   */
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

/* ---- Rotation lock / forced orientation (rotation_*). The Android
 *       Activity#setRequestedOrientation is reachable only from the System UI, so
 *       like the torch it does NOT round-trip through the headless daemon. ---- */

export type RotationModeKey = "auto" | "locked" | "portrait" | "landscape";
export type RotationSnapshotPayload = { mode: string; available: boolean };
export type RotationAppliedPayload = {
  mode: string;
  available: boolean;
  outcome: { state: string; detail?: string };
};

/** Read the committed rotation intent + whether this platform can apply it. */
export async function rotationGet(): Promise<RotationSnapshotPayload | null> {
  return invoke<RotationSnapshotPayload>("rotation_get");
}

/** Commit a rotation mode and apply it to the device. The reply says what the
 *  platform actually did (`outcome.state`), never rounded up to "applied". */
export async function rotationSet(
  mode: RotationModeKey,
): Promise<RotationAppliedPayload | null> {
  return invoke<RotationAppliedPayload>("rotation_set", { mode });
}

/* ---- Cellular signal (`cellular_signal`). Needs a real `TelephonyManager`, so
 *       like the torch and rotation it does NOT round-trip through the headless
 *       daemon. ---- */

/**
 * The device's cellular facts — `supported` (is this a phone), `present` (a SIM is
 * ready) and the real `signal` level (`1..=4`, or `null` when none is readable).
 * Mirrors `RadioSignal` plus `supported`, so `readCellularSignal` can spread it.
 */
export type CellularSignalPayload = {
  supported: boolean;
  present: boolean;
  signal: number | null;
};

/** Ask the host for the real cellular presence + signal level. `null` when the
 *  call itself failed (desktop, or no host) — an absent answer, not "no modem". */
export async function cellularSignal(): Promise<CellularSignalPayload | null> {
  return invoke<CellularSignalPayload>("cellular_signal");
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
/**
 * The engine's acknowledgment. `delivered` is `false` when the backend had no
 * wire — the message was filed in `Sent` but transmitted nowhere, so the UI must
 * not call that 「已发送」(F-SH-824).
 */
export type MailReceipt = { id: string; date: number; delivered: boolean };

/** What the mail surface can actually deliver (`provider` + whether it has a wire). */
export type MailStatus = { provider: string; delivers: boolean };

/** List selectable mailbox names. */
export async function mailMailboxes(): Promise<string[] | null> {
  return invoke<string[]>("mail_mailboxes");
}

/**
 * The backend's capability: `{ provider, delivers }`. `delivers: false` is the
 * offline mock — a send stores a copy in `Sent` and leaves the device never.
 * Read **before** composing so the composer can say so up front rather than
 * after a silent non-delivery.
 */
export async function mailStatus(): Promise<MailStatus | null> {
  return invoke<MailStatus>("mail_status");
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

/**
 * Star / unstar a message. **It never rejects** — a `void` command resolves `null`
 * on success and `invoke` also answers `null` for a call that failed (the reason
 * goes to the per-command diagnosis). Read `bridgeDiag("mail_set_flagged").ok` for
 * the verdict; the return value cannot carry it (REQ-A830 / F-SH-263).
 */
export async function mailSetFlagged(
  mailbox: string,
  id: string,
  flagged: boolean,
): Promise<null> {
  return invoke<null>("mail_set_flagged", { mailbox, id, flagged });
}

/** Mark a message replied / un-replied. `void` — the verdict is `bridgeDiag("mail_set_answered").ok`, not the null return. */
export async function mailSetAnswered(
  mailbox: string,
  id: string,
  answered: boolean,
): Promise<null> {
  return invoke<null>("mail_set_answered", { mailbox, id, answered });
}

/** Mark a message read / unread. `void` — the verdict is `bridgeDiag("mail_set_seen").ok`, not the null return. */
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
/** `pre` is **absent** (not `null`) on a full release: the Rust side carries
 *  `#[serde(skip_serializing_if = "Option::is_none")]`, so `pre` is `undefined`
 *  on the wire whenever there is no pre-release tag — measured, not assumed. */
export type AppVersion = { major: number; minor: number; patch: number; pre?: string | null };
export type AppCategory =
  | "other" | "tools" | "media" | "communication"
  | "games" | "productivity" | "education" | "system";
/** The serde wire tokens of `amos_appstore::PackageFormat` — note `tar_gz`, which
 *  is **not** the same spelling as the Rust `as_str()` (`tar.gz`); the wire is the
 *  serde one. `"apk"` is the third variant and is produced by the F-Droid ingest. */
export type PackageFormat = "tar_gz" | "zip" | "apk";
export type AppChecksum = { algorithm: "sha256"; value: string };
export interface PackageRef {
  format: PackageFormat;
  url: string;
  /** Absent (not `null`) when the source publishes no digest — `skip_serializing_if`. */
  sha256?: AppChecksum | null;
  /** Absent (not `null`) when the source announces no size — `skip_serializing_if`. */
  size_bytes?: number | null;
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

/* ---- Files app: preview + bundle export/import (Rust-side, real FS work) ----
 * Real filesystem operations live in `crates/amos-tauri/src/files.rs`. The JS layer
 * never inlines PDF parsing or gzip compression — those were `reqdev/preview-failed`
 * gap fillers before the Rust commands landed (see i18n-allowlist.json
 * "files.preview*" history).
 */

/** Result of `files_preview_bytes`: a typed classification + the data the renderer
 *  needs.  `data` is a decoded text string for kind="text", a data URL for media,
 *  or empty for binary/empty.  `error` is non-null only for truncation notices. */
export interface FilesPreviewResult {
  /** "text" | "image" | "audio" | "video" | "binary" | "empty" */
  kind: string;
  data: string;
  mime: string | null;
  isText: boolean;
  sizeLabel: string;
  error: string | null;
}

/** Preview bytes via the Rust command (real MIME classification + safe text decode). */
export async function filesPreviewBytes(
  name: string,
  mime: string | null,
  bytes: Uint8Array | number[],
): Promise<FilesPreviewResult | null> {
  return invoke<FilesPreviewResult>("files_preview_bytes", {
    name,
    mime: mime ?? "",
    data: Array.from(bytes),
  });
}

/** Bundle export reply. */
export interface FilesBundleExport {
  text: string;
  originalBytes: number;
  compressedBytes: number;
  entryCount: number;
  ratioLabel: string;
}

/** Externally-tagged bundle import reply: `{tag: "Ok", data: {...}}` or
 *  `{tag: "Err", data: {reason, compressedBytes?, uncompressedBytes?}}`. */
export type FilesBundleImport =
  | {
      tag: "Ok";
      data: {
        entries: unknown[];
        originalBytes: number;
        compressedBytes: number;
        entryCount: number;
      };
    }
  | {
      tag: "Err";
      data: {
        reason: string;
        compressedBytes: number | null;
        uncompressedBytes: number | null;
      };
    };

/** Serialize an FEntry[] array into a gzip-compressed, base64-encoded bundle
 *  suitable for sharing (`.amos-bundle` text). */
export async function filesBundleExport(
  entries: unknown[],
): Promise<FilesBundleExport | null> {
  return invoke<FilesBundleExport>("files_bundle_export", { entries });
}

/** Parse + decompress + validate an `.amos-bundle` text into FEntry[].  The
 *  reply is structured so a corrupted bundle is reported honestly, never as
 *  a fabricated empty list. */
export async function filesBundleImport(raw: string): Promise<FilesBundleImport | null> {
  return invoke<FilesBundleImport>("files_bundle_import", { raw });
}

/** Validate a cloud snapshot structure on the Rust side before persisting.  Returns
 *  the normalised snapshot (with `savedAt` defaulted if absent) or `null` if the
 *  JSON serialisation fails — the WebView stores the validated reply. */
export interface FilesCloudSnapshot {
  label: string;
  savedAt: number;
  collections: string[];
  /** `null` when any entry's size was not reported — see `filesCloud.ts::buildSnapshot`. */
  totalBytes: number | null;
  fileCount: number;
  files: Array<{
    id: string;
    name: string;
    kind: string;
    collection: string;
    sizeBytes: number | null;
    ts: number;
  }>;
}

export async function filesCloudValidate(
  snapshot: FilesCloudSnapshot,
): Promise<FilesCloudSnapshot | null> {
  return invoke<FilesCloudSnapshot>("files_cloud_validate", { snapshot });
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

/**
 * What the **OS half** of an alarm registration did, as `alarm_sched::DeviceOutcome`
 * serialises it. Until REQ-A369 the command answered nothing at all, so "registered" meant
 * only "written to the host's in-memory ledger" — which is why a real device round
 * (REQ-A362) measured `dumpsys alarm` empty while the WebView saw a success: a dozing or
 * killed process was never woken. `host_only` is the honest desktop/CI answer.
 */
export interface NativeAlarmDeviceState {
  state: "host_only" | "scheduled" | "cancelled" | "disallowed" | "unattached" | "unavailable" | "denied" | "unknown";
  /** Present only for `state: "unknown"` — the glue's own words, never rounded up. */
  detail?: string;
}

/** Reply of `scheduler_alarm_register` (`AlarmArmed`). */
export interface NativeAlarmArmed {
  id: string;
  atMs: number;
  device: NativeAlarmDeviceState;
}

/** Reply of `scheduler_alarm_cancel` (`AlarmCanceled`). */
export interface NativeAlarmCanceled {
  id: string;
  /** The old boolean answer: did the in-process ledger still hold this id? */
  wasRegistered: boolean;
  device: NativeAlarmDeviceState;
}

/** Ask the Rust host to register a one-shot exact alarm at `atMs` (epoch ms).
 *  Offline (no Tauri bridge) → null, so the WebView still rings via its own JS notifier.
 *  The reply's `device.state` says whether the **phone** was actually armed: `scheduled`
 *  means it will wake when asleep, `host_only`/`disallowed`/`unattached` mean it will not. */
export async function registerNativeAlarm(id: string, atMs: number): Promise<NativeAlarmArmed | null> {
  return invoke<NativeAlarmArmed>("scheduler_alarm_register", { id, atMs });
}

/** Ask the Rust host to cancel a pending exact alarm. Offline → null. */
export async function cancelNativeAlarm(id: string): Promise<NativeAlarmCanceled | null> {
  return invoke<NativeAlarmCanceled>("scheduler_alarm_cancel", { id });
}

/**
 * Ask the host to open the device's per-app **Alarms & reminders** screen, so a user whose OS
 * refuses exact alarms has a way out — a banner that only states the problem is a dead end
 * (REQ-A373). Resolves `true` only when a screen was actually started: the Kotlin glue answers
 * `false` when no foreground Activity is attached, and a host without `AlarmManager` errors.
 */
export async function openNativeAlarmSettings(): Promise<boolean | null> {
  return invoke<boolean>("scheduler_alarm_open_settings");
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
  /**
   * The call path can reject a call *at all* — a rule covers calls **or** the
   * unknown-number switch is on. This, not `has_call_rules`, is what the
   * enforcement banner gates on: with the switch on and no call rules a
   * withheld caller is still rejected, so the role is still worth requesting.
   */
  filters_calls: boolean;
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

/** Every folder, in the order the UI shows them. The one declaration; {@link SmsFolder}
 * derives from it, so the allowlist that validates a folder is the type. */
export const SMS_FOLDERS = ["inbox", "sent", "draft"] as const;
export type SmsFolder = (typeof SMS_FOLDERS)[number];

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

/**
 * The words a failed command's diagnostic carries, as one searchable string.
 *
 * `invoke` records **what Tauri threw**. When a `Result<T, AmosError>` comes back `Err`
 * that is the envelope *object* `{ code, message, cause? }` — so `String(detail)` is
 * `"[object Object]"` and **not one word of the host's answer survives the fold**
 * (only a JS-level throw — a test fixture, a Tauri bug — is string-shaped). Read the
 * envelope's own fields instead, exactly as `hostFs.ts::extractEnvelope` does for its
 * typed `code` (REQ-A542); the envelope's `cause[0]` is where `AmosError::with_cause`
 * puts the provider's own words (`error.rs`'s `SmsProviderRejected` doc).
 */
export function commandFailureText(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (detail === null || detail === undefined) return "";
  if (typeof detail === "object") {
    const e = detail as { code?: unknown; message?: unknown; cause?: unknown };
    const parts = [
      typeof e.code === "string" ? e.code : "",
      typeof e.message === "string" ? e.message : "",
      ...(Array.isArray(e.cause) ? e.cause.filter((c): c is string => typeof c === "string") : []),
    ];
    const joined = parts.filter((s) => s.length > 0).join(" ");
    if (joined.length > 0) return joined;
  }
  return String(detail);
}

/** Read one folder's threads, distinguishing success (possibly empty) from failure. */
export async function smsFolderSnapshot(folder: SmsFolder): Promise<SmsFolderSnapshotResult> {
  const threads = await invoke<SmsThreadOut[]>("sms_snapshot", { folder });
  if (threads) return { ok: true, threads };
  // REQ-A407: 同上 —— 问的是**这一次**调用，就用 `bridgeDiag("sms_snapshot")`
  // （`backend.bridgeDiag` 的文档："prefer the named form whenever the question is about
  // one specific call"）。今天两者结果相同（写与读只隔一个微任务跳，见 bundleHost 的注释），
  // 改的是"将来插入 await 也仍然对"。
  const diag = bridgeDiag("sms_snapshot");
  if (!diag.ok && diag.kind === "not-bridged") {
    return { ok: false, error: "not bridged", denied: false, notBridged: true };
  }
  const error = diag.ok ? "no result" : commandFailureText(diag.detail) || "failed";
  return {
    ok: false,
    error,
    // REQ-A1756: the host's refusal arrives as the envelope object, whose `cause[0]` is
    // the `SmsError` words (`SMS permission denied: …`). Folding in the envelope's own
    // fields is what lets this regex see them.
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

/** A send's verdict as the platform reported it. `failed` covers a refusal *and* an
 *  unavailable bridge; `unconfirmed` means the platform gave no verdict within its
 *  window — the message may still go out, so the caller must not claim it was sent. */
export type SmsSendVerdict = "sent" | "unconfirmed" | "failed";

/** Send a real SMS. Resolves to `sent` **only** when the radio confirmed it took the
 *  message; "the command did not throw" is deliberately not the question. */
export async function smsSend(
  address: string,
  text: string,
): Promise<SmsSendVerdict> {
  const r = await invoke<string>("sms_send", { address, text });
  if (r === "sent") return "sent";
  if (r === "unconfirmed") return "unconfirmed";
  return "failed";
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
 *  reported as a failure and the list never refreshed.
 *
 *  `null` = the bridge never answered (no bridge, or the command `Err`ed — since the
 *  handler persists on the blocking pool, a worker timeout/panic is now reachable).
 *  That is *not* the same as `false`, which means "no trash entry matched": the two
 *  demand different sentences, so they must not be folded together here. */
export async function smsTrashRestore(
  threadId: string,
  messageId: string,
): Promise<boolean | null> {
  const r = await invoke<boolean>("sms_trash_restore", { threadId, messageId });
  return typeof r === "boolean" ? r : null;
}

/** Empty the trash: every hidden message becomes visible again (an honest
 *  "restore all" — nothing is destroyed). Returns whether the call itself
 *  succeeded (the command answers the number purged; `0` is a successful no-op,
 *  never an error). */
export async function smsTrashPurge(): Promise<boolean> {
  const purged = await invoke<number>("sms_trash_purge");
  return typeof purged === "number";
}

/**
 * What the host did with a request for the platform's About panel (REQ-A796).
 *
 * Mirrors `menu::AboutPanelOutcome` — the Rust enum is `#[serde(rename_all = "snake_case")]`,
 * so these three spellings **are** the wire and this union is the only place the frontend
 * spells them.
 *
 * Why an enum and not a `Result`/`()`: `invoke` answers `null` both for a command that
 * failed and for a successful command that returns nothing (Tauri serializes `()` to
 * `null`), so a `void` command makes "the panel came up" and "the host refused" the same
 * value — F-SH-236, the defect this signal exists to avoid. Three words cost one string and
 * are distinguishable.
 */
export type AboutPanelOutcome = "shown" | "unsupported_host" | "wrong_thread";

/**
 * Why no About panel appeared. `shown` is excluded by construction (a success is never a
 * failure reason); `unreachable` cannot come from the host at all — it is what a `null`
 * reply means here, i.e. no bridge or no such command, and `null` is not a spelling the
 * host can send.
 */
export type AboutPanelFailure = Exclude<AboutPanelOutcome, "shown"> | "unreachable";

/** Whether the shell's Apple menu got the platform About panel on screen, and if not, why.
 *  The reason is a value rather than a log line because the row that asks for the panel has
 *  to *say* what happened: a menu item that appears to work and silently does nothing is
 *  F-SH-001, and this repository has shipped it more than once. */
export type AboutPanelResult =
  | { shown: true }
  | { shown: false; reason: AboutPanelFailure; diag: BridgeDiag };

/**
 * Ask the host for the platform's About panel — the same panel the native
 * `menu.about` item opens (`menu::show_about_dialog`), reached from the WebView.
 *
 * Honest boundary: on a host whose platform has no such panel (Linux/Windows) the host
 * answers `unsupported_host` rather than pretending; on macOS, if the call arrives off the
 * main thread it answers `wrong_thread` rather than doing nothing. Neither is treated as a
 * crash — both are answered, and the caller is expected to report them.
 */
export async function shellAboutPanel(): Promise<AboutPanelResult> {
  const r = await invoke<AboutPanelOutcome>("shell_about_panel");
  if (r === "shown") return { shown: true };
  return { shown: false, reason: r ?? "unreachable", diag: bridgeDiag("shell_about_panel") };
}

