/**
 * Pure helpers for the Voice → ASR (transcribe) flow.
 *
 * Kept free of DOM/audio APIs so the state machine, the transcription-result
 * parser and the PCM → WAV byte builder are unit-testable headlessly. The actual
 * mic capture lives in the UI and hands us raw mono samples (plus the source
 * sample rate); this module down-samples to 16 kHz and wraps them as a WAV so the
 * translate daemon's ASR recognizer (format = "wav") can consume them.
 */
import { downsample, encodeF32le, encodePcm16, TARGET_RATE } from "./audio";

export type VoiceStatus = "idle" | "recording" | "transcribing" | "error";

export type VoiceAction =
  | { type: "start" }
  | { type: "stop" }
  | { type: "ok" }
  | { type: "fail" };

/** Small state machine for a one-shot "tap to speak → transcribe" interaction. */
export function voiceReducer(status: VoiceStatus, action: VoiceAction): VoiceStatus {
  switch (action.type) {
    case "start":
      return status === "idle" || status === "error" ? "recording" : status;
    case "stop":
      return status === "recording" ? "transcribing" : status;
    case "ok":
      return "idle";
    case "fail":
      return "error";
  }
}

/** Serialized result of the `transcribe_audio` command. */
export interface TranscribeOut {
  text: string;
  recognized: boolean;
}

/** Parse the `transcribe_audio` result payload (null when it isn't one). */
export function parseTranscribe(payload: unknown): TranscribeOut | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.text !== "string") return null;
  return { text: p.text, recognized: !!p.recognized };
}

/**
 * Wrap 16-bit little-endian PCM samples in a minimal RIFF/WAVE container so the
 * ASR recognizer can decode them as `format = "wav"`.
 */
export function wavBytes(pcm: number[], sampleRate: number): number[] {
  const dataLen = pcm.length;
  const bytes = new Array<number>(44 + dataLen);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i) & 0xff;
  };
  const u32 = (off: number, v: number) => {
    bytes[off] = v & 0xff;
    bytes[off + 1] = (v >>> 8) & 0xff;
    bytes[off + 2] = (v >>> 16) & 0xff;
    bytes[off + 3] = (v >>> 24) & 0xff;
  };
  const u16 = (off: number, v: number) => {
    bytes[off] = v & 0xff;
    bytes[off + 1] = (v >>> 8) & 0xff;
  };
  ascii(0, "RIFF");
  u32(4, 36 + dataLen);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  u32(16, 16); // fmt chunk size
  u16(20, 1); // PCM
  u16(22, 1); // mono
  u32(24, sampleRate);
  u32(28, sampleRate * 2); // byte rate
  u16(32, 2); // block align
  u16(34, 16); // bits per sample
  ascii(36, "data");
  u32(40, dataLen);
  for (let i = 0; i < dataLen; i++) bytes[44 + i] = (pcm[i] ?? 0) & 0xff;
  return bytes;
}

/**
 * Convert raw mono f32 samples at `fromRate` into a WAV byte payload (16 kHz mono
 * PCM) suitable for `transcribeAudio(…, { format: "wav" })`.
 */
export function pcmToWavBytes(frames: ArrayLike<number>, fromRate: number): number[] {
  const f = frames instanceof Float32Array ? frames : Float32Array.from(frames);
  const pcm = encodePcm16(downsample(f, fromRate, TARGET_RATE));
  return wavBytes(pcm, TARGET_RATE);
}

/** Rough silence guard: is there any audible content above `threshold`? */
export function hasSignal(frames: ArrayLike<number>, threshold = 0.004): boolean {
  for (let i = 0; i < frames.length; i++) {
    const v = Math.abs(frames[i] ?? 0);
    if (v > threshold) return true;
  }
  return false;
}

/* ---- AI assistant resident-voice (streaming Payload::Audio) ---- */

/** Typed mirror of the Rust `assistant-voice-event` payloads. */
export type AssistantVoiceEvent =
  | { kind: "listening"; session: string }
  | { kind: "token"; session: string; token: string }
  | { kind: "turn_done"; session: string; text: string }
  | { kind: "stopped"; session: string }
  | { kind: "error"; session: string; message: string };

const VOICE_KINDS = ["listening", "token", "turn_done", "stopped", "error"] as const;

/** Parse a `assistant-voice-event` payload (null when it isn't one). */
export function parseVoiceEvent(payload: unknown): AssistantVoiceEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const k = p.kind;
  if (typeof k !== "string" || !(VOICE_KINDS as readonly string[]).includes(k)) return null;
  const kind = k as AssistantVoiceEvent["kind"];
  const session = String(p.session ?? "");
  switch (kind) {
    case "listening":
      return { kind, session };
    case "token":
      return typeof p.token === "string" ? { kind, session, token: p.token } : null;
    case "turn_done":
      return typeof p.text === "string" ? { kind, session, text: p.text } : null;
    case "stopped":
      return { kind, session };
    case "error":
      return typeof p.message === "string" ? { kind, session, message: p.message } : null;
  }
}

/**
 * Convert raw mono f32 frames at `fromRate` into a **16 kHz little-endian f32**
 * byte chunk — the exact `Payload::Audio` frame `assistant_voice_feed` pushes to
 * the daemon's recognizer.
 */
export function pcmToAssistantChunk(frames: ArrayLike<number>, fromRate: number): number[] {
  const f = frames instanceof Float32Array ? frames : Float32Array.from(frames);
  return encodeF32le(downsample(f, fromRate, TARGET_RATE));
}

