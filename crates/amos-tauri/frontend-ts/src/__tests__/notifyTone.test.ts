import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { playNotifyTone } from "../lib/notifyTone";

let realWindow: unknown;

beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

/** Install a stub `window.AudioContext` recording oscillator lifecycle. */
function installAudio(): { created: number; startCalls: number; stopCalls: number; closed: boolean } {
  const rec = { created: 0, startCalls: 0, stopCalls: 0, closed: false };
  const destination = {};
  const gain = {
    gain: {
      setValueAtTime() {},
      exponentialRampToValueAtTime() {},
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
});
