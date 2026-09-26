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
  /**
   * Playback. Returning `false` means the payload provably did **not** start playing;
   * returning nothing (the test-double idiom, `void`) is read as "it played" — only a
   * positive refusal may turn a successful synthesis into a failure.
   */
  play?: (pcm: TtsPayload) => boolean | void;
}

/** Lazily-created playback AudioContext (one per session, shared across segments). */
let playCtx: AudioContext | null = null;
/** The most recently started BufferSource. When a newer final segment arrives we
 * stop the previous one so read-aloud never overlaps (latest utterance wins). */
let activeSrc: { stop: () => void } | null = null;

/**
 * Stop any in-flight read-aloud and **release** the playback context.
 *
 * Called when the interpreter screen goes away: merely dropping the reference
 * leaves the `AudioContext` running, so the audio session stayed held by a screen
 * the user had already left. Closing it is best-effort (already-closed / no
 * `close` in a test double → ignored). Idempotent, never throws.
 */
export function resetPlayCtx(): void {
  const src = activeSrc;
  activeSrc = null;
  if (src) {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  const ctx = playCtx;
  playCtx = null;
  if (ctx) {
    try {
      void ctx.close()?.catch?.(() => {
        /* already closed */
      });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Play a synthesized PCM payload out of the speakers. Returns `false` when nothing was
 * started — no `AudioContext`, or an empty payload — so the caller can tell playback from
 * a silent no-op instead of reporting the synthesis reply as audio (REQ-A1444).
 */
export function playPcm(pcm: TtsPayload): boolean {
  if (typeof window === "undefined" || !pcm.samples.length) return false;
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return false;
  const ctx = playCtx ?? new Ctor();
  playCtx = ctx;
  const buf = ctx.createBuffer(1, pcm.samples.length, pcm.sample_rate || 16000);
  if (buf.copyToChannel) buf.copyToChannel(Float32Array.from(pcm.samples), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  // Low-latency rule: the newest final segment preempts any still playing one.
  activeSrc?.stop();
  activeSrc = src;
  src.start();
  return true;
}

/**
 * Speak an arbitrary translation string via the TTS backend. Resolves true when audio was
 * **produced** — which is a claim about playback, not about the synthesis reply (REQ-A1444):
 * a `playPcm` with no `AudioContext`, or an empty payload, starts nothing, and answering
 * `true` there is how a caller ends up with no sound *and* no sentence. False when there was
 * nothing to say, the backend did not answer, or the payload never reached the speakers.
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
  if (!pcm) return false;
  // Only a positive refusal (`false`) counts as "not produced"; an injected `void` player
  // is the test-double idiom and must not turn every successful synthesis into a failure.
  return play(pcm) !== false;
}

/**
 * Handle an `interpret-output` event: if it is a final segment, synthesize and
 * speak its translation. Partial/other events are never spoken.
 */
export async function onInterpFinal(payload: unknown, deps: SpeakDeps = {}): Promise<boolean> {
  const seg = finalSegmentOf(payload);
  return seg ? speakText(seg.text, seg.lang, deps) : false;
}
