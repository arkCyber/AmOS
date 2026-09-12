import { describe, expect, test } from "bun:test";
import { playPcm, resetPlayCtx, type SpeakDeps, speakText } from "../lib/realtimeTts";
import type { TtsPayload } from "../lib/backend";

interface FakeSrc {
  stopped: boolean;
  connect: () => void;
  start: () => void;
  stop: () => void;
}
/** Install a fake window.AudioContext and return the recorded sources + contexts. */
function fakeAudio(): {
  sources: FakeSrc[];
  contexts: Array<{ closed: number }>;
  restore: () => void;
} {
  const sources: FakeSrc[] = [];
  const contexts: Array<{ closed: number }> = [];
  const prevWindow = (globalThis as Record<string, unknown>).window as unknown;
  (globalThis as Record<string, unknown>).window = {
    AudioContext: class {
      destination = {};
      closed = 0;
      constructor() {
        contexts.push(this as unknown as { closed: number });
      }
      close() {
        this.closed += 1;
        return Promise.resolve();
      }
      createBuffer(_ch: number, _len: number, _rate: number) {
        return { copyToChannel() {} };
      }
      createBufferSource() {
        const s: FakeSrc = {
          stopped: false,
          connect() {},
          start() {},
          stop() {
            s.stopped = true;
          },
        };
        sources.push(s);
        return s;
      }
    },
  };
  resetPlayCtx();
  const restore = () => {
    if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = prevWindow;
    resetPlayCtx();
  };
  return { sources, contexts, restore };
}

const pcm = (n: number): TtsPayload => ({ samples: [n, 0], sample_rate: 16000, channels: 1 });

describe("realtimeTts playback (latest-segment wins)", () => {
  test("a newer final segment stops the previously playing source (no overlap)", () => {
    const { sources, restore } = fakeAudio();
    try {
      playPcm(pcm(1));
      playPcm(pcm(2));
      expect(sources.length).toBe(2);
      expect(sources[0]!.stopped).toBe(true); // preempted by segment 2
      expect(sources[1]!.stopped).toBe(false); // newest is active
    } finally {
      restore();
    }
  });

  test("resetPlayCtx silences the active source and closes the audio context", async () => {
    const { sources, contexts, restore } = fakeAudio();
    try {
      playPcm(pcm(1));
      expect(contexts).toHaveLength(1);
      resetPlayCtx();
      // Leaving the screen must actually silence read-aloud…
      expect(sources[0]!.stopped).toBe(true);
      // …and release the AudioContext (dropping the reference left it running).
      expect(contexts[0]!.closed).toBe(1);

      // Idempotent: a second reset neither throws nor double-closes.
      resetPlayCtx();
      expect(contexts).toHaveLength(1);
      expect(contexts[0]!.closed).toBe(1);

      // The next segment gets a fresh context and is not preempted by the old one.
      playPcm(pcm(2));
      expect(contexts).toHaveLength(2);
      expect(sources[1]!.stopped).toBe(false);
    } finally {
      restore();
    }
  });

  test("speakText is a no-op on empty text and still drives synth otherwise", async () => {
    const { restore } = fakeAudio();
    try {
      const calls: string[] = [];
      const deps: SpeakDeps = { synth: async (t: string) => (calls.push(t), pcm(1)) };
      expect(await speakText("   ", "en", deps)).toBe(false);
      expect(calls.length).toBe(0); // blank text never reaches the backend
      expect(await speakText("hi", "en", deps)).toBe(true);
      expect(calls).toEqual(["hi"]);
    } finally {
      restore();
    }
  });
});
