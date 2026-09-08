import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  PHONE_TONES,
  playCallTone,
  playIncomingRing,
  playRingback,
  stopCallTone,
} from "../lib/callTone";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

afterEach(() => {
  stopCallTone();
  delete (window as unknown as Record<string, unknown>).Audio;
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
