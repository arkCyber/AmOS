/**
 * Phone-call tones.
 *
 * The calling-out waiting tone ("ringback") is a real MP3 played through a shared
 * `<audio>`. The **incoming-call ring** follows the user's chosen ringtone (the
 * 「来电铃声与振动」settings page) and is synthesized from `lib/callRingtone` — that
 * page used to promise 「来电时播放的铃声」/「来电时同时振动」 while the ringer played
 * one fixed file and nothing ever vibrated (REQ-A993 / F-SH-314).
 *
 * Every entry point is a strict no-op when audio (or a vibration motor) is
 * unavailable — SSR/headless never throws.
 */
import { readStoreValue } from "./amosStore";
import { incomingRingPlan, RINGTONE_KEY, makeCallRingSamples } from "./callRingtone";
import { loadSound } from "./sound";

/** Default directory (relative to the served root) for phone call tones. */
export const PHONE_TONE_DIR = "sounds/phone";
/** Asset map: a stable key → served mp3 path. */
export const PHONE_TONES: Record<"ringback" | "incoming", string> = {
  ringback: `${PHONE_TONE_DIR}/ringback.mp3`, // calling-out waiting tone
  incoming: `${PHONE_TONE_DIR}/incoming.mp3`, // legacy fixed ring (fallback only)
};

let el: HTMLAudioElement | null = null;

/* ---- Incoming-call ring: synthesized ringtone + haptics ------------------- */

/** Sample rate the ringtone synth renders at (same as `lib/ringtonePlayer`). */
const RING_RATE = 16_000;
/** One haptic pulse per this many ms while the phone rings. */
const RING_BUZZ_MS = 1200;

interface WebAudioLike {
  createBuffer(ch: number, len: number, rate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  readonly destination: AudioNode;
  close(): Promise<void>;
}

let ringCtx: WebAudioLike | null = null;
let ringSrc: AudioBufferSourceNode | null = null;
let buzzTimer: ReturnType<typeof setInterval> | null = null;

/** Best-effort haptic pulse; hosts without a motor (desktop/tests) are a no-op. */
function buzz(pattern: number | number[]): void {
  const v = (globalThis as { navigator?: { vibrate?: (p: number | number[]) => boolean } })
    .navigator?.vibrate;
  if (typeof v !== "function") return;
  try {
    v.call((globalThis as { navigator?: unknown }).navigator, pattern);
  } catch {
    /* no motor / permission refused — the ring still sounds */
  }
}

function audioCtor(): { new (): WebAudioLike } | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: { new (): WebAudioLike };
    webkitAudioContext?: { new (): WebAudioLike };
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Stop the looping ringtone synth and its haptic pulse (idempotent). */
function stopRingSynth(): void {
  if (buzzTimer !== null) {
    clearInterval(buzzTimer);
    buzzTimer = null;
  }
  const src = ringSrc;
  ringSrc = null;
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
  if (ringCtx) {
    const ctx = ringCtx;
    ringCtx = null;
    void ctx.close().catch(() => {
      /* ignore */
    });
  }
}

/** Loop a ringtone's samples through Web Audio; no-op when audio is unavailable. */
function startRingSynth(samples: Float32Array): void {
  const Ctor = audioCtor();
  if (!Ctor || samples.length === 0) return;
  try {
    const ctx = new Ctor();
    ringCtx = ctx;
    const buffer = ctx.createBuffer(1, samples.length, RING_RATE);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    ringSrc = src;
  } catch {
    stopRingSynth();
  }
}

/** Stop any playing phone tone, ringtone synth and haptic pulse (idempotent). */
export function stopCallTone(): void {
  stopRingSynth();
  const a = el;
  el = null;
  if (a) {
    try {
      a.pause();
    } catch {
      /* ignore */
    }
    try {
      a.removeAttribute("src");
      if (typeof a.load === "function") a.load();
    } catch {
      /* ignore */
    }
  }
}

/** Start looping a phone tone file; any previous tone is stopped first. */
export function playCallTone(src: string, loop = true): void {
  stopCallTone();
  if (typeof window === "undefined") return;
  const A = (window as unknown as { Audio?: typeof Audio }).Audio;
  if (typeof A !== "function") return;
  try {
    const a = new A();
    a.src = src;
    a.loop = loop;
    a.volume = 0.6;
    const p = a.play() as unknown;
    if (p && typeof (p as Promise<void>).catch === "function") {
      (p as Promise<void>).catch(() => {
        /* autoplay/file unavailable — ignore */
      });
    }
    el = a;
  } catch {
    /* ignore */
  }
}

/** Play the calling-out waiting (ringback) tone. */
export function playRingback(): void {
  playCallTone(PHONE_TONES.ringback);
}

/**
 * Ring an incoming call: **the ringtone the user picked**, plus a haptic pulse
 * while the alert policy allows vibration.
 *
 * Both halves come from the settings page's own promises — `ringtone.selectHint`
 * (「来电时播放的铃声」) and `ringtone.vibrateHint` (「来电时同时振动」) — which the
 * ringer previously ignored in favour of one fixed file (REQ-A993 / F-SH-314).
 *
 * The bundled `sounds/phone/incoming.mp3` is still the fallback ring when the host
 * has no Web Audio, so a call is never silent where a file can play.
 */
export function playIncomingRing(): void {
  stopCallTone();
  const plan = incomingRingPlan(
    readStoreValue<unknown>(RINGTONE_KEY, null),
    loadSound().vibrate,
    RING_RATE,
  );
  startRingSynth(plan.samples);
  if (ringSrc === null) playCallTone(PHONE_TONES.incoming);
  if (plan.vibrate) {
    const pulse: number[] = [220, 120, 220];
    buzz(pulse);
    buzzTimer = setInterval(() => buzz(pulse), RING_BUZZ_MS);
  }
}

/**
 * Play one ringtone once — the settings page's 试听. It sounds the **chosen** tone
 * (not the notification chime it used before) and never buzzes.
 */
export function previewCallRingtone(id: unknown): void {
  stopCallTone();
  const Ctor = audioCtor();
  const samples = makeCallRingSamples(id, RING_RATE);
  if (!Ctor || samples.length === 0) return;
  try {
    const ctx = new Ctor();
    const buffer = ctx.createBuffer(1, samples.length, RING_RATE);
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
    /* audio unavailable — silent preview */
  }
}
