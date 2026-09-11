import { describe, expect, test } from "bun:test";
import { applyMediaSession, clearMediaSession } from "../lib/mediaSession";
import type { MediaMetadataCtor, MediaSessionLike } from "../lib/mediaSession";

/** A minimal `MediaSession` stub that records what the player publishes. */
function fakeSession() {
  const handlers: Record<string, ((d: unknown) => void) | null> = {};
  const session = {
    metadata: null as unknown,
    playbackState: "",
    setActionHandler(action: string, handler: ((d: unknown) => void) | null) {
      handlers[action] = handler;
    },
  };
  return { session: session as unknown as MediaSessionLike, handlers, raw: session };
}

/** A `MediaMetadata` stub that just keeps its init object. */
class FakeMeta {
  readonly init: { title?: string; artist?: string; album?: string };
  constructor(init: { title?: string; artist?: string; album?: string }) {
    this.init = init;
  }
}
const MetaCtor = FakeMeta as unknown as MediaMetadataCtor;

describe("mediaSession: no-op without a session", () => {
  test("apply/clear on a null session are safe", () => {
    expect(() => applyMediaSession(null, { title: "t" }, true, {}, MetaCtor)).not.toThrow();
    expect(() => clearMediaSession(null)).not.toThrow();
  });
});

describe("mediaSession: publishing metadata + state", () => {
  test("sets metadata via the ctor and reflects playing/paused", () => {
    const { session, raw } = fakeSession();
    applyMediaSession(session, { title: "晨光", artist: "Music" }, true, {}, MetaCtor);
    expect(raw.metadata).toBeInstanceOf(FakeMeta);
    expect((raw.metadata as FakeMeta).init).toEqual({ title: "晨光", artist: "Music", album: undefined });
    expect(raw.playbackState).toBe("playing");

    applyMediaSession(session, { title: "晨光" }, false, {}, MetaCtor);
    expect(raw.playbackState).toBe("paused");
  });

  test("a null meta clears metadata; no ctor also clears it", () => {
    const { session, raw } = fakeSession();
    applyMediaSession(session, null, false, {}, MetaCtor);
    expect(raw.metadata).toBeNull();
    applyMediaSession(session, { title: "x" }, false, {}, null);
    expect(raw.metadata).toBeNull();
  });
});

describe("mediaSession: transport handlers", () => {
  test("wires the provided handlers and forwards details", () => {
    const { session, handlers } = fakeSession();
    const calls: string[] = [];
    let seek: number | undefined;
    applyMediaSession(
      session,
      { title: "t" },
      true,
      {
        play: () => calls.push("play"),
        pause: () => calls.push("pause"),
        previoustrack: () => calls.push("prev"),
        nexttrack: () => calls.push("next"),
        seekto: (d) => {
          seek = d.seekTime;
        },
      },
      MetaCtor,
    );
    handlers.play?.(undefined);
    handlers.pause?.(undefined);
    handlers.previoustrack?.(undefined);
    handlers.nexttrack?.(undefined);
    handlers.seekto?.({ seekTime: 12 });
    expect(calls).toEqual(["play", "pause", "prev", "next"]);
    expect(seek).toBe(12);
  });

  test("omitted handlers are registered as null (no stale callbacks)", () => {
    const { session, handlers } = fakeSession();
    applyMediaSession(session, { title: "t" }, false, { play: () => {} }, MetaCtor);
    expect(typeof handlers.play).toBe("function");
    expect(handlers.pause).toBeNull();
    expect(handlers.nexttrack).toBeNull();
    expect(handlers.seekto).toBeNull();
  });
});

describe("mediaSession: clear", () => {
  test("removes metadata + handlers and marks playback none", () => {
    const { session, handlers, raw } = fakeSession();
    applyMediaSession(session, { title: "t" }, true, { play: () => {} }, MetaCtor);
    clearMediaSession(session);
    expect(raw.metadata).toBeNull();
    expect(raw.playbackState).toBe("none");
    for (const a of ["play", "pause", "previoustrack", "nexttrack", "seekto"]) {
      expect(handlers[a]).toBeNull();
    }
  });
});

describe("mediaSession: a hostile host is not a playback failure", () => {
  test("a throwing session swallows apply/clear errors", () => {
    const throwing: MediaSessionLike = {
      metadata: null,
      playbackState: "",
      setActionHandler() {
        throw new Error("not supported");
      },
    };
    expect(() => applyMediaSession(throwing, { title: "t" }, true, {}, MetaCtor)).not.toThrow();
    expect(() => clearMediaSession(throwing)).not.toThrow();
  });
});
