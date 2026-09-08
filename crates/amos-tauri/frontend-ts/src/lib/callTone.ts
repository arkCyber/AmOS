/**
 * Phone-call tones — real MP3 assets played through a shared `<audio>`.
 *
 * The dial page ("ringback" while calling out) and the incoming-call ring used to
 * synthesize a beep via `AudioContext`. Now they play real MP3 files (small, and
 * decoded by every WebView/`<audio>`) so the "waiting" and "ringing" sounds are
 * actual audio rather than synth. Falls back to silence (strict no-op) when audio
 * is unavailable (SSR/headless) — matching the previous guard.
 */
/** Default directory (relative to the served root) for phone call tones. */
export const PHONE_TONE_DIR = "sounds/phone";
/** Asset map: a stable key → served mp3 path. */
export const PHONE_TONES: Record<"ringback" | "incoming", string> = {
  ringback: `${PHONE_TONE_DIR}/ringback.mp3`, // calling-out waiting tone
  incoming: `${PHONE_TONE_DIR}/incoming.mp3`, // incoming-call ring
};

let el: HTMLAudioElement | null = null;

/** Stop any playing phone tone (idempotent). */
export function stopCallTone(): void {
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

/** Play the incoming-call ring tone. */
export function playIncomingRing(): void {
  playCallTone(PHONE_TONES.incoming);
}
