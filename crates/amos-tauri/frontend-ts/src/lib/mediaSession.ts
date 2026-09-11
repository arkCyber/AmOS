/**
 * mediaSession.ts — best-effort OS media-session wiring for the player.
 *
 * A real device shows lock-screen / notification / headset controls for the
 * active media via the Web `MediaSession` API. This module is a **thin,
 * injectable** wrapper so the player behaves identically (and stays testable)
 * when the API is absent: with no session object every call is a no-op.
 *
 * Nothing here throws: a host that rejects metadata/handlers is treated as
 * "no media session", never as a player failure.
 */

/** Metadata shown by the OS media controls. */
export interface MediaSessionMeta {
  title: string;
  artist?: string;
  album?: string;
}

/** Transport callbacks the OS may invoke (all optional). */
export interface MediaSessionHandlers {
  play?: () => void;
  pause?: () => void;
  previoustrack?: () => void;
  nexttrack?: () => void;
  seekto?: (details: { seekTime?: number }) => void;
}

/** The subset of `MediaSession` this module uses. */
export interface MediaSessionLike {
  metadata: unknown;
  playbackState: string;
  setActionHandler(action: string, handler: ((details: unknown) => void) | null): void;
}

/** Constructor shape of `MediaMetadata` (injectable for tests). */
export interface MediaMetadataCtor {
  new (init: { title?: string; artist?: string; album?: string }): unknown;
}

/** The real `navigator.mediaSession`, or null when unsupported/absent. */
export function defaultMediaSession(): MediaSessionLike | null {
  if (typeof navigator === "undefined") return null;
  const ms = (navigator as unknown as { mediaSession?: MediaSessionLike }).mediaSession;
  return ms && typeof ms.setActionHandler === "function" ? ms : null;
}

/** The real `MediaMetadata` constructor, or null when unsupported/absent. */
export function defaultMediaMetadataCtor(): MediaMetadataCtor | null {
  if (typeof globalThis === "undefined") return null;
  const ctor = (globalThis as unknown as { MediaMetadata?: MediaMetadataCtor }).MediaMetadata;
  return typeof ctor === "function" ? ctor : null;
}

/**
 * Publish metadata + playback state + transport handlers to the OS. Safe to call
 * on every state change: it replaces the current handlers idempotently. A null
 * session (unsupported host) is a silent no-op.
 */
export function applyMediaSession(
  session: MediaSessionLike | null,
  meta: MediaSessionMeta | null,
  playing: boolean,
  handlers: MediaSessionHandlers,
  MetaCtor: MediaMetadataCtor | null = defaultMediaMetadataCtor(),
): void {
  if (!session) return;
  try {
    session.metadata = meta && MetaCtor ? new MetaCtor({ title: meta.title, artist: meta.artist, album: meta.album }) : null;
    session.playbackState = playing ? "playing" : "paused";
    const entries: Array<[string, ((details: unknown) => void) | null]> = [
      ["play", handlers.play ? () => handlers.play?.() : null],
      ["pause", handlers.pause ? () => handlers.pause?.() : null],
      ["previoustrack", handlers.previoustrack ? () => handlers.previoustrack?.() : null],
      ["nexttrack", handlers.nexttrack ? () => handlers.nexttrack?.() : null],
      ["seekto", handlers.seekto ? (details) => handlers.seekto?.(details as { seekTime?: number }) : null],
    ];
    for (const [action, fn] of entries) session.setActionHandler(action, fn);
  } catch {
    /* an unusable media session is not a playback failure — stay silent */
  }
}

/** Detach metadata + handlers (called when the player unmounts). */
export function clearMediaSession(session: MediaSessionLike | null): void {
  if (!session) return;
  try {
    session.metadata = null;
    session.playbackState = "none";
    for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekto"]) {
      session.setActionHandler(action, null);
    }
  } catch {
    /* nothing to clear / unsupported */
  }
}
