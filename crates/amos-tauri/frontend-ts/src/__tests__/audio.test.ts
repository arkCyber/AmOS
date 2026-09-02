import { describe, expect, test } from "bun:test";
import { downsample, encodePcm16, frameToChunk, TARGET_RATE } from "../lib/audio";

describe("audio chunk helpers", () => {
  test("downsample halves length when rate halves", () => {
    const s = new Float32Array([0, 1, 0, -1, 0, 1]);
    const out = downsample(s, 16000, 8000);
    expect(out.length).toBe(3);
    expect(out[0]).toBeCloseTo(0);
  });

  test("encodePcm16 little-endian for +1 / -1 / 0", () => {
    expect(encodePcm16(new Float32Array([1]))).toEqual([0xff, 0x7f]);
    expect(encodePcm16(new Float32Array([-1]))).toEqual([0x00, 0x80]);
    expect(encodePcm16(new Float32Array([0]))).toEqual([0x00, 0x00]);
  });

  test("frameToChunk routes through 16k + int16 (fake chunk → bytes)", () => {
    const bytes = frameToChunk(new Float32Array([1, -1]), TARGET_RATE);
    expect(bytes).toEqual([0xff, 0x7f, 0x00, 0x80]);
  });
});
