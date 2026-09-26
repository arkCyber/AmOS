import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  PHONE_TONES,
  playCallTone,
  playIncomingRing,
  playRingback,
  stopCallTone,
} from "../lib/callTone";
import { RINGTONE_KEY, makeCallRingSamples } from "../lib/callRingtone";
import { SOUND_KEY } from "../lib/sound";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const RINGTONE_RATE = 16_000;

afterEach(() => {
  stopCallTone();
  const w = window as unknown as Record<string, unknown>;
  delete w.Audio;
  delete w.AudioContext;
  delete w.webkitAudioContext;
  delete (navigator as unknown as Record<string, unknown>).vibrate;
  window.localStorage.clear();
});

describe("callTone — phone-page MP3 tones", () => {
  test("assets resolve under the phone sound directory", () => {
    expect(PHONE_TONES.ringback).toBe("sounds/phone/ringback.mp3");
    expect(PHONE_TONES.incoming).toBe("sounds/phone/incoming.mp3");
    expect(PHONE_TONES.ringback.endsWith(".mp3")).toBe(true);
  });

  test("play/stop are safe (no-op) when audio is unavailable", () => {
    delete (window as unknown as Record<string, unknown>).Audio;
    expect(() => {
      playRingback();
      playIncomingRing();
      playCallTone("sounds/phone/ringback.mp3");
      stopCallTone();
    }).not.toThrow();
  });

  test("plays the real MP3 via a stubbed <audio> and stops it", () => {
    const created: Array<{ src: string; loop: boolean; playCount: number }> = [];
    class FakeAudio {
      src = "";
      loop = false;
      playCount = 0;
      play() {
        this.playCount++;
        created.push({ src: this.src, loop: this.loop, playCount: this.playCount });
        return Promise.resolve();
      }
      pause() {}
      load() {}
      removeAttribute() {}
    }
    (window as unknown as Record<string, unknown>).Audio = FakeAudio;

    playRingback();
    expect(created).toHaveLength(1);
    expect(created[0]!.src).toBe("sounds/phone/ringback.mp3");
    expect(created[0]!.loop).toBe(true);
    expect(created[0]!.playCount).toBe(1);

    // A second tone stops the previous one first.
    playIncomingRing();
    expect(created.map((c) => c.src)).toEqual([
      "sounds/phone/ringback.mp3",
      "sounds/phone/incoming.mp3",
    ]);
    expect(() => stopCallTone()).not.toThrow();
  });

  test("both MP3 files ship in the default phone directory", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL(".", import.meta.url)); // .../src/__tests__/
    const dir = join(here, "..", "..", "public", "sounds", "phone");
    for (const file of Object.values(PHONE_TONES)) {
      expect(existsSync(join(dir, file.split("/").pop()!))).toBe(true);
    }
  });
});

/**
 * The ringer used to play one fixed file and never buzz, while the 「来电铃声与振动」
 * page's own copy promised 「来电时播放的铃声」/「来电时同时振动」 (REQ-A993 / F-SH-314).
 * These pin the two promises to the code that must keep them.
 */
describe("callTone — the incoming ring honours the chosen ringtone (REQ-A993)", () => {
  interface WebAudioSpy {
    bufferLengths: number[];
    sourceLoops: boolean[];
    starts: number;
    closes: number;
  }

  /** Stub `window.AudioContext` so a successful synth is observable and the mp3 fallback is not taken. */
  function stubWebAudio(): WebAudioSpy {
    const spy: WebAudioSpy = { bufferLengths: [], sourceLoops: [], starts: 0, closes: 0 };
    class FakeGain {
      gain = { value: 1 };
      connect() {}
      disconnect() {}
    }
    class FakeBuffer {
      copyToChannel() {}
    }
    class FakeSource {
      buffer: unknown = null;
      loop = false;
      connect() {}
      disconnect() {}
      addEventListener() {}
      start() {
        spy.starts++;
        spy.sourceLoops.push(this.loop);
      }
      stop() {}
    }
    class FakeCtx {
      destination = {};
      createBuffer(_channels: number, len: number, _rate: number) {
        spy.bufferLengths.push(len);
        return new FakeBuffer();
      }
      createBufferSource() {
        return new FakeSource();
      }
      createGain() {
        return new FakeGain();
      }
      close() {
        spy.closes++;
        return Promise.resolve();
      }
    }
    (window as unknown as Record<string, unknown>).AudioContext = FakeCtx;
    return spy;
  }

  /** Stub `<audio>` so a fallback to the bundled mp3 is visible as a created element. */
  function stubAudio(): string[] {
    const created: string[] = [];
    class FakeAudio {
      src = "";
      loop = false;
      play() {
        created.push(this.src);
        return Promise.resolve();
      }
      pause() {}
      load() {}
      removeAttribute() {}
    }
    (window as unknown as Record<string, unknown>).Audio = FakeAudio;
    return created;
  }

  function stubVibrate(): number[][] {
    const pulses: number[][] = [];
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: (p: number | number[]) => {
        pulses.push(Array.isArray(p) ? p : [p]);
        return true;
      },
    });
    return pulses;
  }

  function seed(selected: string, vibrate: boolean) {
    window.localStorage.setItem(RINGTONE_KEY, JSON.stringify({ selected }));
    window.localStorage.setItem(SOUND_KEY, JSON.stringify({ ring: true, vibrate, volume: 1 }));
  }

  test("loops the CHOSEN tone's samples and does not fall back to the fixed mp3", () => {
    const ctx = stubWebAudio();
    const created = stubAudio();
    seed("bell", false);
    playIncomingRing();
    expect(ctx.bufferLengths).toEqual([makeCallRingSamples("bell", RINGTONE_RATE).length]);
    expect(ctx.starts).toBe(1);
    expect(ctx.sourceLoops).toEqual([true]);
    expect(created).toEqual([]); // Web Audio succeeded → no mp3
  });

  test("a different choice sounds a different length — the choice actually reaches the ring", () => {
    const ctx = stubWebAudio();
    stubAudio();
    seed("guitar", false);
    playIncomingRing();
    expect(ctx.bufferLengths).toEqual([makeCallRingSamples("guitar", RINGTONE_RATE).length]);
  });

  test("falls back to the bundled incoming.mp3 when the host has no Web Audio", () => {
    const created = stubAudio(); // no AudioContext stubbed
    seed("bell", false);
    playIncomingRing();
    expect(created).toEqual(["sounds/phone/incoming.mp3"]);
  });

  test("buzzes only when the effective vibrate bit allows it", () => {
    stubWebAudio();
    stubAudio();
    const pulses = stubVibrate();

    seed("classic", true);
    playIncomingRing();
    expect(pulses.length).toBeGreaterThan(0);
    expect(pulses[0]).toEqual([220, 120, 220]);

    stopCallTone();
    pulses.length = 0;

    seed("classic", false);
    playIncomingRing();
    expect(pulses).toEqual([]);
  });

  test("stopCallTone() tears the looping synth down (idempotent)", () => {
    const ctx = stubWebAudio();
    stubAudio();
    seed("piano", false);
    playIncomingRing();
    expect(ctx.closes).toBe(0);
    stopCallTone();
    expect(ctx.closes).toBe(1);
    expect(() => stopCallTone()).not.toThrow();
    expect(ctx.closes).toBe(1);
  });
});
