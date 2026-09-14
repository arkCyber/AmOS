import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { playNotifyTone } from "../lib/notifyTone";

let realWindow: unknown;

beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

/** Install a stub `window.AudioContext` recording oscillator lifecycle + gain ramps. */
function installAudio(): {
  created: number;
  startCalls: number;
  stopCalls: number;
  closed: boolean;
  ramps: number[];
  sets: number[];
} {
  const rec = {
    created: 0,
    startCalls: 0,
    stopCalls: 0,
    closed: false,
    ramps: [] as number[],
    sets: [] as number[],
  };
  const destination = {};
  const gain = {
    gain: {
      setValueAtTime(v: number) {
        rec.sets.push(v);
      },
      exponentialRampToValueAtTime(v: number) {
        rec.ramps.push(v);
      },
    },
    connect() {
      return destination;
    },
  };
  const osc = {
    type: "sine",
    frequency: { setValueAtTime() {} },
    connect() {
      return gain;
    },
    start() {
      rec.startCalls += 1;
    },
    stop() {
      rec.stopCalls += 1;
    },
    addEventListener(_e: string, cb: () => void) {
      cb();
    },
  };
  class AudioContextStub {
    destination = destination;
    currentTime = 0;
    constructor() {
      rec.created += 1;
    }
    createOscillator() {
      return osc;
    }
    createGain() {
      return gain;
    }
    close() {
      rec.closed = true;
      return Promise.resolve();
    }
  }
  (globalThis as { window?: unknown }).window = {
    AudioContext: AudioContextStub,
  };
  return rec;
}

describe("playNotifyTone", () => {
  test("is a safe no-op without a window/AudioContext (SSR/headless)", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(() => playNotifyTone()).not.toThrow();

    installAudio();
    // Remove AudioContext but keep a window → still no throw.
    (globalThis as unknown as { window?: unknown }).window = {};
    expect(() => playNotifyTone()).not.toThrow();
  });

  test("synthesizes a chime through the Web Audio graph when available", () => {
    const rec = installAudio();
    playNotifyTone();
    expect(rec.created).toBe(1); // one AudioContext
    expect(rec.startCalls).toBe(1); // oscillator started
    expect(rec.stopCalls).toBe(1); // and stopped after the envelope
    expect(rec.closed).toBe(true); // context closed on 'ended'
  });

  test("defaults to the historical envelope (peak 0.15) when no loudness is given", () => {
    const rec = installAudio();
    playNotifyTone();
    // First ramp is the attack to the peak; the second is the decay to ~0.
    expect(rec.ramps.length).toBe(2);
    expect(rec.ramps[0]).toBeCloseTo(0.15);
  });

  test("scales the envelope peak with the requested loudness (REQ-A205)", () => {
    const half = installAudio();
    playNotifyTone({ volume: 0.5 });
    expect(half.ramps[0]).toBeCloseTo(0.075);

    const quiet = installAudio();
    playNotifyTone({ volume: 0.1 });
    expect(quiet.ramps[0]).toBeCloseTo(0.015);

    // Above 1 clamps to the default envelope — never a booster.
    const loud = installAudio();
    playNotifyTone({ volume: 2 });
    expect(loud.ramps[0]).toBeCloseTo(0.15);

    // Garbage falls back to the default envelope.
    const junk = installAudio();
    playNotifyTone({ volume: Number.NaN });
    expect(junk.ramps[0]).toBeCloseTo(0.15);
  });

  test("volume 0 is honest silence: no context, no oscillator at all", () => {
    const rec = installAudio();
    playNotifyTone({ volume: 0 });
    expect(rec.created).toBe(0);
    expect(rec.startCalls).toBe(0);
  });
});
