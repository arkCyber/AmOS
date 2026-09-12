/**
 * Alarm ringtone PLAYER — loops a ringtone until told to stop, and plays
 * one-shot previews.
 *
 * Two engines sharing one module-wide active slot (only one sound at a time):
 *  1. FILE: an `<audio loop>` pointed at a real ringtone file in the default
 *     directory (`public/sounds/ringtones/<id>.wav`), used when ringtone files
 *     are enabled (a real browser/WebView where the assets are served). If the
 *     file fails to play it transparently falls back to synthesis.
 *  2. SYNTH (default, always available): `lib/ringtone.makeToneSamples()` is
 *     rendered into a looping `AudioBufferSourceNode` — asset-free, so it works
 *     on the server, in headless tests and in dev even before files ship.
 *
 * Everything is safe when audio is unavailable (SSR / headless) — strict no-op.
 * Autoplay policies can still mute output until a user gesture has occurred.
 */
import { makeToneSamples, ringtoneFileUrl, ringtoneIdFor } from "./ringtone";
import type { RingtoneId } from "./ringtone";

/** Playback sample rate used by the synth engine. */
const RATE = 16_000;

interface WebAudioLike {
  createBuffer(ch: number, len: number, rate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  readonly destination: AudioNode;
  close(): Promise<void>;
}

let _ctx: WebAudioLike | null = null;
let _src: AudioBufferSourceNode | null = null;
let _fileAudio: HTMLAudioElement | null = null;
let _activeId: RingtoneId | null = null;
/** When true, real files are preferred over synthesis (browser/WebView). */
let _fileEnabled = false;

/** Prefer bundled ringtone files over synthesis (call once on a real host). */
export function setRingtoneFilesEnabled(v: boolean): void {
  _fileEnabled = v;
}

/** Which ringtone (if any) is currently sounding. */
export function activeRingtone(): RingtoneId | null {
  return _activeId;
}

function audioCtor(): { new (): WebAudioLike } | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: { new (): WebAudioLike };
    webkitAudioContext?: { new (): WebAudioLike };
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function browserAudioCtor(): typeof Audio | null {
  try {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { Audio?: typeof Audio };
    return typeof w.Audio === "function" ? w.Audio : null;
  } catch {
    return null;
  }
}

/** Stop the current synth source and close its context (idempotent). */
function stopSynth(): void {
  const src = _src;
  _src = null;
  if (src) {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
    try {
      src.disconnect();
    } catch {
      /* ignore */
    }
  }
  if (_ctx) {
    const ctx = _ctx;
    _ctx = null;
    void ctx.close().catch(() => {
      /* ignore */
    });
  }
}

/** Stop any looping ring (file + synth) — idempotent, never throws. */
export function stopAlarmRing(): void {
  const fa = _fileAudio;
  _fileAudio = null;
  if (fa) {
    try {
      fa.pause();
    } catch {
      /* ignore */
    }
    try {
      fa.removeAttribute("src");
      if (typeof fa.load === "function") fa.load();
    } catch {
      /* ignore */
    }
  }
  stopSynth();
  _activeId = null;
}

/** Loop the SYNTHETIC ring for a token (fallback / non-file path). */
function startSynth(token: string | undefined): RingtoneId | null {
  const Ctor = audioCtor();
  if (!Ctor) return null;
  const id = ringtoneIdFor(token);
  const samples = makeToneSamples(token, RATE);
  if (samples.length === 0) return null;
  try {
    const ctx = new Ctor();
    _ctx = ctx;
    const buffer = ctx.createBuffer(1, samples.length, RATE);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    _src = src;
    _activeId = id;
    return id;
  } catch {
    stopSynth();
    _activeId = null;
    return null;
  }
}

/** Loop a real ringtone FILE; false when audio/file is unusable. */
function startFileRing(id: RingtoneId, token: string | undefined): boolean {
  const A = browserAudioCtor();
  if (!A) return false;
  const el = new A();
  let fellBack = false;
  const fallback = () => {
    if (fellBack) return;
    fellBack = true;
    stopAlarmRing();
    startSynth(token);
  };
  try {
    el.loop = true;
    el.volume = 0.6;
    el.preload = "auto";
    el.src = ringtoneFileUrl(id); // relative — resolves against the served root
    el.addEventListener("error", fallback, { once: true });
    const p = el.play() as unknown;
    if (p && typeof (p as Promise<void>).catch === "function") {
      (p as Promise<void>).catch(fallback);
    }
    _fileAudio = el;
    _activeId = id;
    return true;
  } catch {
    try {
      el.pause && el.pause();
    } catch {
      /* ignore */
    }
    return false;
  }
}

/**
 * Start looping a ringtone (file first when enabled, else synthesis). Returns
 * the active id, or null when audio is unavailable.
 */
export function startAlarmRing(token?: string): RingtoneId | null {
  stopAlarmRing();
  const id = ringtoneIdFor(token);
  if (_fileEnabled && startFileRing(id, token)) return id;
  return startSynth(token);
}

/** Play a short one-shot preview of a tone (used by the editor's 试听). */
export function previewAlarmTone(token?: string): void {
  stopAlarmRing();
  const id = ringtoneIdFor(token);
  if (_fileEnabled) {
    const A = browserAudioCtor();
    if (A) {
      try {
        const el = new A();
        el.volume = 0.8;
        el.preload = "auto";
        const cleanup = () => {
          try {
            el.removeAttribute("src");
            el.removeEventListener("ended", cleanup);
          } catch {
            /* ignore */
          }
        };
        el.addEventListener("ended", cleanup);
        el.src = ringtoneFileUrl(id);
        const p = el.play() as unknown;
        if (p && typeof (p as Promise<void>).catch === "function") {
          (p as Promise<void>).catch(() => {
            /* file unplayable — ignore */
          });
        }
        return;
      } catch {
        /* fall through to synthesis */
      }
    }
  }
  // Synthesis one-shot: play the motif once (non-looping), close on ended.
  const Ctor = audioCtor();
  if (!Ctor) return;
  try {
    const samples = makeToneSamples(token, RATE);
    if (samples.length === 0) return;
    const ctx = new Ctor();
    const buffer = ctx.createBuffer(1, samples.length, RATE);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    src.addEventListener("ended", () => {
      void ctx.close().catch(() => {
        /* ignore */
      });
    });
  } catch {
    /* audio unavailable/blocked */
  }
}

