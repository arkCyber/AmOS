import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ttsSynthesize } from "../lib/backend";
import { onInterpFinal, speakText } from "../lib/realtimeTts";
import { finalSegmentOf } from "../lib/stream";

let realWindow: unknown;
function setWindow(obj: Record<string, unknown>) {
  (globalThis as { window?: unknown }).window = obj;
}
beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

const PCM = { sample_rate: 16000, channels: 1, samples: [0, 1, 0] };

describe("tts bridge -> realtime read-aloud", () => {
  test("ttsSynthesize invokes tts_synthesize with text+lang", async () => {
    const args: Record<string, unknown>[] = [];
    setWindow({
      __TAURI_INTERNALS__: {
        invoke: async (c: string, a?: Record<string, unknown>) => {
          expect(c).toBe("tts_synthesize");
          args.push(a ?? {});
          return PCM;
        },
        listen: async () => async () => {},
      },
      localStorage: new Map() as unknown as Storage,
    });
    const out = await ttsSynthesize("你好", "zh");
    expect(out).toEqual(PCM);
    expect(args[0]).toEqual({ text: "你好", lang: "zh" });
  });

  test("finalSegmentOf extracts only segment_final target text", () => {
    expect(finalSegmentOf({ kind: "segment_final", target_text: "Hola", target_lang: "es" })).toEqual({ text: "Hola", lang: "es" });
    expect(finalSegmentOf({ kind: "partial", text: "x" })).toBeNull();
    expect(finalSegmentOf(null)).toBeNull();
  });

  test("speakText synthesizes+plays non-empty text", async () => {
    const calls: string[] = [];
    const played: unknown[] = [];
    const synth = async (t: string, l: string) => {
      calls.push(`${l}:${t}`);
      return PCM;
    };
    const play = (p: unknown) => played.push(p);
    expect(await speakText("Hola", "es", { synth, play })).toBe(true);
    expect(calls).toEqual(["es:Hola"]);
    expect(played).toEqual([PCM]);
  });

  test("speakText skips blank text", async () => {
    const synth = async () => PCM;
    const play = () => {};
    expect(await speakText("   ", "zh", { synth, play })).toBe(false);
  });

  test("onInterpFinal speaks a final segment but not a partial", async () => {
    const synths: string[] = [];
    const plays: unknown[] = [];
    const synth = async (t: string, l: string) => {
      synths.push(`${l}:${t}`);
      return PCM;
    };
    const play = (p: unknown) => plays.push(p);

    expect(await onInterpFinal({ kind: "segment_final", target_text: "Hola", target_lang: "es" }, { synth, play })).toBe(true);
    expect(synths).toEqual(["es:Hola"]);
    expect(plays).toHaveLength(1);

    await onInterpFinal({ kind: "partial", text: "bo" }, { synth, play });
    expect(synths).toHaveLength(1); // partials are never synthesized
  });
});
