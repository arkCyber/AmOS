import { describe, expect, test } from "bun:test";
import { playPcm, resetPlayCtx, type SpeakDeps, speakText } from "../lib/realtimeTts";
import type { TtsPayload } from "../lib/backend";

interface FakeSrc {
  stopped: boolean;
  connect: () => void;
  start: () => void;
  stop: () => void;
}
/** Install a fake window.AudioContext and return the recorded sources. */
function fakeAudio(): { sources: FakeSrc[]; restore: () => void } {
  const sources: FakeSrc[] = [];
  const prevWindow = (globalThis as Record<string, unknown>).window as unknown;
  (globalThis as Record<string, unknown>).window = {
    AudioContext: class {
      destination = {};
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
  return { sources, restore };
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

  test("resetPlayCtx clears the active source so the next play is not stopped early", () => {
    const { sources, restore } = fakeAudio();
    try {
      playPcm(pcm(1));
      resetPlayCtx();
      playPcm(pcm(2));
      expect(sources[0]!.stopped).toBe(false); // no longer tracked as active
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
