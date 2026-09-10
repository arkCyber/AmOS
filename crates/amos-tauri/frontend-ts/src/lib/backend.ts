/**
 * Typed bridge to the Tauri Rust core (window.__TAURI_INTERNALS__), mirroring the
 * legacy vanilla UI's commands. Outside Tauri every call degrades to null/false so
 * the UI can show a localized "daemon not connected" state instead of crashing.
 */
import type { AiProviderId } from "./providers";

interface TauriBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(channel: string, handler: (e: { payload: unknown }) => void): Promise<() => void>;
}

function bridge(): TauriBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriBridge };
  return w && typeof w.__TAURI_INTERNALS__ === "object" ? (w.__TAURI_INTERNALS__ as TauriBridge) : null;
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
    console.warn(`[backend] ${command} failed`, err);
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

/* ---- 同传 / interpret RPC (degrade to null outside Tauri) ---- */
export interface InterpOpts {
  source?: string;
  target?: string;
}

export async function interpretStart(opts: InterpOpts = {}): Promise<string | null> {
  return invoke<string>("interpret_start", {
    source_lang: opts.source ?? "auto",
    target_lang: opts.target ?? "zh",
  });
}

export async function interpretAudio(sessionId: string, chunk: ArrayLike<number>): Promise<unknown> {
  return invoke("interpret_audio", { sessionId, chunk: Array.from(chunk) });
}

export async function interpretText(sessionId: string, text: string): Promise<unknown> {
  return invoke("interpret_text", { sessionId, text });
}

export async function interpretStop(sessionId: string): Promise<unknown> {
  return invoke("interpret_stop", { sessionId });
}

export async function interpretPause(sessionId: string): Promise<unknown> {
  return invoke("interpret_pause", { sessionId });
}

export async function interpretResume(sessionId: string): Promise<unknown> {
  return invoke("interpret_resume", { sessionId });
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

/** List installed Android apps exposed by the daemon (null outside Tauri). */
export async function getAndroidApps(): Promise<AndroidApp[] | null> {
  return invoke<AndroidApp[]>("get_android_apps");
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

/* ---- Radio / connectivity (radio_*: wifi / bluetooth / airplane). Real radios
 *       live on the System UI side (Android services), so unlike telephony these
 *       do NOT round-trip through the headless daemon. ---- */
export type RadioPayload = { wifi: boolean; bluetooth: boolean; airplane: boolean };

/** Read the current radio state (wifi / bluetooth / airplane). */
export async function radioStatus(): Promise<RadioPayload | null> {
  return invoke<RadioPayload>("radio_status");
}

/** Toggle one radio. Airplane mode cascades Wi-Fi + Bluetooth off and gates
 * them until it is turned back off; returns the authoritative resulting state. */
export async function radioSet(
  key: "wifi" | "bluetooth" | "airplane",
  enabled: boolean,
): Promise<RadioPayload | null> {
  return invoke<RadioPayload>("radio_set", { key, enabled });
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

/** The INBOX summaries (the mail app's default view). */
export async function mailInbox(limit?: number | null): Promise<MailSummary[] | null> {
  return invoke<MailSummary[]>("mail_inbox", { limit: limit ?? null });
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

/** Snapshot of the durable Rust system store (boot hydration into localStorage). */
export async function systemStoreSnapshot(): Promise<Record<string, string> | null> {
  return invoke<Record<string, string>>("store_snapshot");
}

/** One file of an installed web-bundle, served as base64 + MIME for the UI to render. */
export interface BundleResource {
  mime: string;
  nosniff: boolean;
  base64: string;
}
export async function storeBundleResource(
  id: string,
  path: string,
): Promise<BundleResource | null> {
  return invoke<BundleResource>("appstore_bundle_resource", { id, path });
}

/** One file of an installed web-bundle addressed as an `amos-app://` URI. */
export async function storeBundleUri(uri: string): Promise<BundleResource | null> {
  return invoke<BundleResource>("appstore_bundle_uri", { uri });
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

/** Real-SMS inbox snapshot (threads). `null` when not bridged/errored; an empty
 *  array means "no real SMS available" (never fabricated). */
export async function smsSnapshot(): Promise<SmsThreadOut[] | null> {
  return invoke<SmsThreadOut[]>("sms_snapshot");
}

/** Messages of one SMS thread (chronological). `null` when unavailable. */
export async function smsMessages(threadId: string): Promise<SmsMessageOut[] | null> {
  return invoke<SmsMessageOut[]>("sms_messages", { thread_id: threadId });
}

/** Send a real SMS. `true` only on the command's explicit success marker. */
export async function smsSend(address: string, text: string): Promise<boolean> {
  const r = await invoke<string>("sms_send", { address, text });
  return r === "sent";
}

