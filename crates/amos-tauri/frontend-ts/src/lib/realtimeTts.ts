/**
 * Realtime read-aloud for the 同传 app, aligned with sokuji's low-latency design:
 * only *final* translation segments are spoken (partials are shown as text, never
 * synthesized), and each final segment is turned into PCM by the Rust TTS backend
 * (`tts_synthesize` -> local Piper when the piper-tts feature + a voice dir are
 * configured; deterministic mock otherwise), then played through a single Web
 * Audio context. Everything is injectable so it unit-tests headlessly.
 */
import { ttsSynthesize, type TtsPayload } from "./backend";
import { finalSegmentOf } from "./stream";

export interface SpeakDeps {
  synth?: (text: string, lang: string) => Promise<TtsPayload | null>;
  play?: (pcm: TtsPayload) => void;
}

/** Lazily-created playback AudioContext (one per session, shared across segments). */
let playCtx: AudioContext | null = null;
export function resetPlayCtx(): void {
  playCtx = null;
}

/** Play a synthesized PCM payload out of the speakers. No-op when unavailable. */
export function playPcm(pcm: TtsPayload): void {
  if (typeof window === "undefined" || !pcm.samples.length) return;
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  const ctx = playCtx ?? new Ctor();
  playCtx = ctx;
  const buf = ctx.createBuffer(1, pcm.samples.length, pcm.sample_rate || 16000);
  if (buf.copyToChannel) buf.copyToChannel(Float32Array.from(pcm.samples), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

/**
 * Speak an arbitrary translation string via the TTS backend. Resolves true when
 * audio was produced, false when nothing to say / backend unavailable.
 */
export async function speakText(
  text: string,
  lang = "zh",
  deps: SpeakDeps = {},
): Promise<boolean> {
  const synth = deps.synth ?? ttsSynthesize;
  const play = deps.play ?? playPcm;
  if (!text.trim()) return false;
  const pcm = await synth(text, lang);
  if (pcm) play(pcm);
  return pcm !== null;
}

/**
 * Handle an `interpret-output` event: if it is a final segment, synthesize and
 * speak its translation. Partial/other events are never spoken.
 */
export async function onInterpFinal(payload: unknown, deps: SpeakDeps = {}): Promise<boolean> {
  const seg = finalSegmentOf(payload);
  return seg ? speakText(seg.text, seg.lang, deps) : false;
}
