import { describe, expect, test } from "bun:test";
import {
  hasSignal,
  parseTranscribe,
  parseVoiceEvent,
  pcmToAssistantChunk,
  pcmToWavBytes,
  voiceReducer,
  wavBytes,
  type VoiceAction,
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

describe("voice reducer — aerospace state-machine audit", () => {
  const STATES: VoiceStatus[] = ["idle", "recording", "transcribing", "error"];
  const ACTIONS: VoiceAction[] = [
    { type: "start" },
    { type: "stop" },
    { type: "ok" },
    { type: "fail" },
  ];

  test("reducer is total over the full state×action matrix (never undefined/invalid)", () => {
    const reached = new Set<VoiceStatus>();
    for (const s of STATES) {
      for (const a of ACTIONS) {
        const r = voiceReducer(s, a);
        expect(STATES).toContain(r); // always returns a declared state
        reached.add(r);
      }
    }
    expect(reached.size).toBe(STATES.length); // all four states reachable
  });

  test("every state is reachable from idle (no unreachable/ghost states)", () => {
    const reach = new Set<VoiceStatus>(["idle"]);
    let frontier: VoiceStatus[] = ["idle"];
    for (let k = 0; k < STATES.length + 1 && frontier.length; k++) {
      const next: VoiceStatus[] = [];
      for (const s of frontier) {
        for (const a of ACTIONS) {
          const r = voiceReducer(s, a);
          if (!reach.has(r)) {
            reach.add(r);
            next.push(r);
          }
        }
      }
      frontier = next;
    }
    for (const s of STATES) expect(reach.has(s)).toBe(true);
  });

  test("illegal transitions are no-ops (deterministic, no leak to other states)", () => {
    expect(voiceReducer("idle", { type: "stop" })).toBe("idle");
    expect(voiceReducer("idle", { type: "ok" })).toBe("idle");
    expect(voiceReducer("idle", { type: "fail" })).toBe("error"); // explicit failure always lands on error
    expect(voiceReducer("recording", { type: "start" })).toBe("recording");
    expect(voiceReducer("recording", { type: "stop" })).toBe("transcribing");
    expect(voiceReducer("transcribing", { type: "start" })).toBe("transcribing");
    expect(voiceReducer("transcribing", { type: "stop" })).toBe("transcribing");
  });

  test("failure injection: denied mic / silent clip route to error, then recover", () => {
    // denied mic: recording -> fail
    let s = voiceReducer("idle", { type: "start" });
    s = voiceReducer(s, { type: "fail" });
    expect(s).toBe("error");
    // user retries from error
    s = voiceReducer(s, { type: "start" });
    expect(s).toBe("recording");
    // stop, but ASR returns nothing recognized -> fail -> error
    s = voiceReducer(s, { type: "stop" });
    expect(s).toBe("transcribing");
    s = voiceReducer(s, { type: "fail" });
    expect(s).toBe("error");
    // successful retry returns to idle
    s = voiceReducer(s, { type: "start" });
    s = voiceReducer(s, { type: "stop" });
    s = voiceReducer(s, { type: "ok" });
    expect(s).toBe("idle");
  });

  test("fault: stray ok while recording does not wedge the machine", () => {
    // Even an out-of-order "ok" from the async transcribe completing must not
    // leave the machine stuck — it lands on idle and a fresh start works.
    let s = voiceReducer("idle", { type: "start" });
    s = voiceReducer(s, { type: "ok" });
    expect(s).toBe("idle");
    s = voiceReducer(s, { type: "start" });
    expect(s).toBe("recording");
  });
});

describe("assistant resident-voice helpers", () => {
  test("pcmToAssistantChunk encodes 16k f32 little-endian", () => {
    // 4 mono f32 samples at 16k (no down-sample): 16 bytes.
    const bytes = pcmToAssistantChunk(Float32Array.from([1.0, -1.0, 0.5, 0.0]), 16000);
    expect(bytes.length).toBe(16);
    // 1.0 as IEEE-754 little-endian f32 = 00 00 80 3f.
    expect(bytes.slice(0, 4)).toEqual([0x00, 0x00, 0x80, 0x3f]);
    // -1.0 = 00 00 80 bf.
    expect(bytes.slice(4, 8)).toEqual([0x00, 0x00, 0x80, 0xbf]);
    // NaN/inf treated as digital silence (0x00000000).
    const silent = pcmToAssistantChunk(Float32Array.from([NaN]), 16000);
    expect(silent.slice(0, 4)).toEqual([0, 0, 0, 0]);
  });

  test("pcmToAssistantChunk down-samples 48k to 16k (x3 shorter)", () => {
    const in48k = Float32Array.from({ length: 3000 }, () => 0.2);
    const bytes = pcmToAssistantChunk(in48k, 48000);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length % 4).toBe(0);
    // 3000 @48k → ~1000 @16k → ~4000 bytes.
    expect(bytes.length / 4).toBe(1000);
  });

  test("parseVoiceEvent reads every tagged kind and rejects junk", () => {
    expect(parseVoiceEvent({ kind: "listening", session: "s" })).toEqual({
      kind: "listening",
      session: "s",
    });
    expect(parseVoiceEvent({ kind: "token", session: "s", token: "hi" })).toEqual({
      kind: "token",
      session: "s",
      token: "hi",
    });
    expect(parseVoiceEvent({ kind: "turn_done", session: "s", text: "ok" })).toEqual({
      kind: "turn_done",
      session: "s",
      text: "ok",
    });
    expect(parseVoiceEvent({ kind: "stopped", session: "s" })).toEqual({
      kind: "stopped",
      session: "s",
    });
    expect(parseVoiceEvent({ kind: "error", session: "s", message: "boom" })).toEqual({
      kind: "error",
      session: "s",
      message: "boom",
    });
    expect(parseVoiceEvent({ kind: "nope" })).toBeNull();
    expect(parseVoiceEvent(null)).toBeNull();
    expect(parseVoiceEvent({ kind: "token", session: "s" })).toBeNull(); // missing token
  });
});
