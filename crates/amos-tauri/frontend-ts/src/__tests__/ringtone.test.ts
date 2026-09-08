import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  RINGTONE_BY_TOKEN,
  RINGTONE_DIR,
  RINGTONE_FILE_BY_ID,
  makeAlarmSamples,
  makeToneSamples,
  ringtoneFileUrl,
  ringtoneIdFor,
  ringtoneIdForAlarm,
} from "../lib/ringtone";
import {
  activeRingtone,
  previewAlarmTone,
  ringtoneFilesEnabled,
  setRingtoneFilesEnabled,
  startAlarmRing,
  stopAlarmRing,
} from "../lib/ringtonePlayer";
import type { Alarm } from "../lib/time";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const samplesEqual = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < 1e-9);

describe("ringtone — tokens → audible ids, default dir, and synthesis", () => {
  test("every stored emoji token maps to a stable id + a file name", () => {
    expect(Object.keys(RINGTONE_BY_TOKEN).sort()).toEqual(["🔔", "🎶", "📯", "⏰"].sort());
    for (const entry of Object.values(RINGTONE_BY_TOKEN)) {
      expect(entry.id).toBeTruthy();
      expect(entry.file).toMatch(/\.mp3$/);
    }
    // Each token has its own distinct ringtone id.
    const ids = new Set(Object.values(RINGTONE_BY_TOKEN).map((e) => e.id));
    expect(ids.size).toBe(Object.values(RINGTONE_BY_TOKEN).length);
  });

  test("ringtoneIdFor falls back to bell for unknown/empty tokens", () => {
    expect(ringtoneIdFor("⏰")).toBe("alarm");
    expect(ringtoneIdFor("🎶")).toBe("melody");
    expect(ringtoneIdFor(undefined)).toBe("bell");
    expect(ringtoneIdFor("???")).toBe("bell");
    const alarm: Pick<Alarm, "tone"> = { tone: "📯" };
    expect(ringtoneIdForAlarm(alarm)).toBe("bugle");
  });

  test("ringtone files resolve under the documented default directory", () => {
    expect(RINGTONE_DIR).toBe("sounds/ringtones");
    for (const id of Object.keys(RINGTONE_FILE_BY_ID) as (keyof typeof RINGTONE_FILE_BY_ID)[]) {
      expect(ringtoneFileUrl(id)).toBe(`sounds/ringtones/${RINGTONE_FILE_BY_ID[id]}`);
    }
  });

  test("makeToneSamples is pure: finite, clamped, non-empty, and distinct per tone", () => {
    const bell = makeToneSamples("🔔");
    const alarm = makeToneSamples("⏰");
    const bugle = makeToneSamples("📯");
    const melody = makeToneSamples("🎶");
    expect(bell.length).toBeGreaterThan(0);
    for (const s of [bell, alarm, bugle, melody]) {
      for (const v of s) expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(s.some((v) => Math.abs(v) > 1e-4)).toBe(true); // not silence
    }
    // Distinct tokens → audibly different motifs.
    const distinct = new Set([bell.join(), alarm.join(), bugle.join(), melody.join()]);
    expect(distinct.size).toBe(4);
    // Unknown/empty token falls back to the bell motif.
    expect(samplesEqual(makeToneSamples("???"), bell)).toBe(true);
    expect(samplesEqual(makeToneSamples(undefined), bell)).toBe(true);
    // makeAlarmSamples honours the alarm's stored token.
    expect(samplesEqual(makeAlarmSamples({ tone: "⏰" }), alarm)).toBe(true);
  });
});

describe("ringtonePlayer — loop start/stop with a stubbed AudioContext", () => {
  afterEach(() => {
    stopAlarmRing();
    delete (window as unknown as Record<string, unknown>).AudioContext;
    delete (window as unknown as Record<string, unknown>).webkitAudioContext;
  });

  test("start/stop are safe when Web Audio is unavailable (no-op)", () => {
    // Force "no Web Audio" regardless of the host environment.
    delete (window as unknown as Record<string, unknown>).AudioContext;
    delete (window as unknown as Record<string, unknown>).webkitAudioContext;
    expect(startAlarmRing("⏰")).toBeNull(); // no AudioContext
    expect(activeRingtone()).toBeNull();
    expect(() => stopAlarmRing()).not.toThrow();
  });

  test("starts a looping source and stops it cleanly when told to", () => {
    const calls = { start: 0, stop: 0, close: 0, loops: [] as (boolean | undefined)[] };
    const fakeNode = {
      buffer: null as unknown,
      loop: undefined as boolean | undefined,
      connect() {
        return this;
      },
      start() {
        calls.start++;
      },
      stop() {
        calls.stop++;
      },
      disconnect() {},
    };
    class FakeAudioContext {
      destination = {};
      createBuffer(_c: number, len: number, rate: number) {
        return { length: len, sampleRate: rate, copyToChannel() {} } as unknown as AudioBuffer;
      }
      createBufferSource() {
        return fakeNode as unknown as AudioBufferSourceNode;
      }
      createGain() {
        return { gain: { value: 1 }, connect: () => {} } as unknown as GainNode;
      }
      close() {
        calls.close++;
        return Promise.resolve();
      }
    }
    (window as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;

    const id = startAlarmRing("⏰");
    expect(id).toBe("alarm");
    expect(activeRingtone()).toBe("alarm");
    expect(fakeNode.loop).toBe(true); // rings continuously
    expect(calls.start).toBe(1);

    // A second ring replaces the first → the old loop is stopped first.
    startAlarmRing("🔔");
    expect(calls.stop).toBe(1);
    expect(activeRingtone()).toBe("bell");

    stopAlarmRing();
    expect(activeRingtone()).toBeNull();
    expect(calls.stop).toBe(2);
    expect(calls.close).toBe(2); // each started context is closed
  });
});

describe("preview + file engine", () => {
  afterEach(() => {
    setRingtoneFilesEnabled(false);
    stopAlarmRing();
    delete (window as unknown as Record<string, unknown>).Audio;
    delete (window as unknown as Record<string, unknown>).webkitAudioContext;
    delete (window as unknown as Record<string, unknown>).AudioContext;
  });

  test("file-engine toggle is off by default and can be enabled", () => {
    expect(ringtoneFilesEnabled()).toBe(false);
    setRingtoneFilesEnabled(true);
    expect(ringtoneFilesEnabled()).toBe(true);
    setRingtoneFilesEnabled(false);
    expect(ringtoneFilesEnabled()).toBe(false);
  });

  test("preview is a safe no-op when no audio is available", () => {
    setRingtoneFilesEnabled(true);
    delete (window as unknown as Record<string, unknown>).Audio;
    expect(() => previewAlarmTone("⏰")).not.toThrow();
    expect(activeRingtone()).toBeNull();
  });

  test("start with files enabled falls back to (absent) synth instead of crashing", () => {
    setRingtoneFilesEnabled(true);
    delete (window as unknown as Record<string, unknown>).Audio; // no file path available
    delete (window as unknown as Record<string, unknown>).AudioContext; // no synth either
    expect(startAlarmRing("🎶")).toBeNull();
    expect(activeRingtone()).toBeNull();
  });

  test("four real ringtone files ship in the default directory (MP3 + WAV source)", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL(".", import.meta.url)); // .../src/__tests__/
    const dir = join(here, "..", "..", "public", "sounds", "ringtones");
    // The player serves MP3 (mapping); each also keeps a .wav editing source.
    for (const file of Object.values(RINGTONE_FILE_BY_ID)) {
      expect(existsSync(join(dir, file))).toBe(true);
      expect(file).toMatch(/\.mp3$/);
      const wav = file.replace(/\.mp3$/, ".wav");
      expect(existsSync(join(dir, wav))).toBe(true);
    }
  });
});
