/**
 * A tiny, asset-free notification "ring" via the Web Audio API.
 *
 * The OS has no bundled sound files, so the ring is synthesized: a short,
 * pleasant two-note chime through an `OscillatorNode` with an exponential gain
 * envelope. Used by the notification-arrival path only when the effective sound
 * policy allows audible alerts (`ring`). Degrades silently (no-op) when Web
 * Audio is unavailable (SSR, tests, headless), or when the browser blocks audio.
 */

/** Options for the synthesized chime. */
export interface NotifyToneOptions {
  /**
   * Chime loudness 0..1 (1 = the historical default envelope; 0 = play nothing).
   * Scales only the gain of the tone we synthesize ourselves — never a claim
   * about any system audio stream.
   */
  volume?: number;
}

/** Clamp to 0..1; unreadable → 1 (the historical default). */
function chimeVolume(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/** Play the notification chime. Safe to call anywhere — never throws. */
export function playNotifyTone(opts?: NotifyToneOptions): void {
  const vol = chimeVolume(opts?.volume);
  if (vol <= 0) return; // volume 0 = honest silence: no context, no oscillator
  try {
    if (typeof window === "undefined") return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const dur = 0.5;
    const peak = 0.15 * vol;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    // Two rising notes (A5 → D6) for a friendly, audible-but-not-annoying chime.
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.16);

    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(peak, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
    // Close the context once playback finishes (async, best-effort).
    osc.addEventListener("ended", () => {
      void ctx.close().catch(() => {
        /* ignore */
      });
    });
  } catch {
    /* audio unavailable/blocked — ignore */
  }
}
