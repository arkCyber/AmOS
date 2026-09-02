/**
 * Typed bridge to the Tauri Rust core (window.__TAURI_INTERNALS__), mirroring the
 * legacy vanilla UI's commands. Outside Tauri every call degrades to null/false so
 * the UI can show a localized "daemon not connected" state instead of crashing.
 */
interface TauriBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(channel: string, handler: (e: { payload: unknown }) => void): Promise<() => void>;
}

function bridge(): TauriBridge | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriBridge };
  return w && typeof w.__TAURI_INTERNALS__ === "object" ? (w.__TAURI_INTERNALS__ as TauriBridge) : null;
}

export function bridged(): boolean {
  return bridge() !== null;
}

/** Call a Tauri command; returns null when not running inside Tauri. */
export async function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const b = bridge();
  if (!b) return null;
  try {
    return (await b.invoke(command, args)) as T;
  } catch (err) {
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

export type AiStatus = { model?: string; active_sessions?: number } | null;

/** Probe the AI daemon via the same get_status the legacy AI app uses. */
export async function getAiStatus(): Promise<AiStatus> {
  return invoke<AiStatus>("get_status");
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
