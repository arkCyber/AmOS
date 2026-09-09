import { describe, expect, test } from "bun:test";
import { downsample, encodePcm16, frameToInterpChunk, TARGET_RATE } from "../lib/audio";

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

  test("frameToInterpChunk routes through 16k and keeps raw f32 samples (Vec<f32> wire)", () => {
    // Rust interpret_audio consumes `Vec<f32>` (the sherpa sample format), so the
    // chunk must be the down-sampled sample VALUES — never a PCM16 byte encoding
    // (which would split each 16-bit sample into two f32 samples and corrupt ASR).
    // 48 kHz 3 samples → 1 sample @16 kHz (decimation step 3), value preserved.
    const one = frameToInterpChunk(new Float32Array([0.5, -0.5, 0.25]), 48000);
    expect(one.length).toBe(1);
    expect(one[0]).toBeCloseTo(0.5);
    // Already at 16 kHz → length unchanged, values kept as-is (raw f32, not bytes).
    const same = frameToInterpChunk(new Float32Array([0.1, -0.2, 0.3]), TARGET_RATE);
    expect(same.length).toBe(3);
    expect(same[0]).toBeCloseTo(0.1);
    expect(same[2]).toBeCloseTo(0.3);
    // A byte encoding (PCM16) would double the length — this must never happen.
    expect(one.length).not.toBe(2);
  });

  test("downsample guards invalid/equal/empty inputs (no NaN-length alloc)", () => {
    const a = new Float32Array([0, 1, 0, -1]);
    expect(downsample(a, 16000, 16000)).toBe(a); // same rate → unchanged
    expect(downsample(a, 0, 8000)).toBe(a); // non-positive fromRate
    expect(downsample(a, -16000, 8000)).toBe(a);
    expect(downsample(a, NaN, 8000)).toBe(a); // NaN rate
    expect(downsample(a, 16000, NaN)).toBe(a);
    expect(downsample(a, 16000, 0)).toBe(a); // non-positive toRate
    expect(downsample(new Float32Array(0), 16000, 8000).length).toBe(0);
  });

  test("downsample upsampling is finite and length-proportional", () => {
    const out = downsample(new Float32Array([-1, 0, 1]), 8000, 16000);
    expect(out.length).toBe(6); // 8000→16000 doubles samples
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  test("encodePcm16 clamps range and maps non-finite samples to digital zero", () => {
    expect(encodePcm16(new Float32Array([2, -2]))).toEqual([0xff, 0x7f, 0x00, 0x80]);
    expect(encodePcm16(new Float32Array([NaN, Infinity, -Infinity]))).toEqual([0, 0, 0, 0, 0, 0]);
    // byte-count invariant: always 2 bytes per sample, all finite
    expect(encodePcm16(new Float32Array(7)).length).toBe(14);
  });
});
