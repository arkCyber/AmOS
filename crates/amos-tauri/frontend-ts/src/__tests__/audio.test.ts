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
