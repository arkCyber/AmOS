import { describe, expect, test } from "bun:test";
import {
  hasSignal,
  parseTranscribe,
  pcmToWavBytes,
  voiceReducer,
  wavBytes,
  type VoiceStatus,
} from "../lib/voice";

describe("voice ASR helpers", () => {
  test("voiceReducer drives a one-shot record->transcribe->idle flow", () => {
    let s: VoiceStatus = voiceReducer("idle", { type: "start" });
    expect(s).toBe("recording");
    s = voiceReducer(s, { type: "stop" });
    expect(s).toBe("transcribing");
    s = voiceReducer(s, { type: "ok" });
    expect(s).toBe("idle");
  });

  test("voiceReducer recovers from error by starting again", () => {
    let s: VoiceStatus = voiceReducer("idle", { type: "start" });
    s = voiceReducer(s, { type: "stop" });
    s = voiceReducer(s, { type: "fail" });
    expect(s).toBe("error");
    s = voiceReducer(s, { type: "start" });
    expect(s).toBe("recording");
    // Illegal transitions are ignored.
    expect(voiceReducer("idle", { type: "stop" })).toBe("idle");
    expect(voiceReducer("recording", { type: "start" })).toBe("recording");
  });

  test("parseTranscribe reads {text, recognized}", () => {
    expect(parseTranscribe({ text: "你好", recognized: true })).toEqual({
      text: "你好",
      recognized: true,
    });
    expect(parseTranscribe({ text: "", recognized: false })).toEqual({
      text: "",
      recognized: false,
    });
    expect(parseTranscribe(null)).toBeNull();
    expect(parseTranscribe({ recognized: true })).toBeNull();
  });

  test("wavBytes builds a valid RIFF/WAVE header around 16-bit PCM", () => {
    const data = [0, 0, 1, 0, 0xff, 0x7f, 0x00, 0x80]; // 4 int16 mono samples
    const wav = wavBytes(data, 16000);
    expect(wav.length).toBe(44 + data.length);
    const ascii = (off: number, n: number) =>
      String.fromCharCode(...wav.slice(off, off + n));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(36, 4)).toBe("data");
    // header declares mono 16-bit PCM at 16000 Hz (byte rate = 32000)
    expect(wav[24]).toBe(16000 & 0xff);
    expect(wav[22]).toBe(1); // channels
    expect(wav[34]).toBe(16); // bits per sample
  });

  test("pcmToWavBytes downsamples mono f32 to a 16k WAV payload", () => {
    // 1 second of 44.1k mono f32 -> 16000 samples -> 32000 int16 bytes + 44 header
    const frame = new Float32Array(44100).fill(0.1);
    const wav = pcmToWavBytes(frame, 44100);
    expect(wav.length).toBe(44 + 16000 * 2);
    expect(wav[22]).toBe(1);
  });

  test("hasSignal ignores silence but detects content", () => {
    expect(hasSignal(new Float32Array(1000))).toBe(false);
    expect(hasSignal([0, 0, 0.05, 0])).toBe(true);
  });
});
