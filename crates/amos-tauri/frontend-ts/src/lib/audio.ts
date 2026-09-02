/**
 * Pure audio helpers for the 同传 (interpret) pipeline: convert live PCM into
 * the byte chunks `interpret_audio` expects. Kept pure so they are unit-testable
 * with fake samples (no browser/AudioContext needed).
 */
export const TARGET_RATE = 16000;

/** Simple linear downsample of mono f32 to the target rate. */
export function downsample(samples: Float32Array, fromRate: number, toRate: number = TARGET_RATE): Float32Array {
  // Invariant: a valid rate is a finite positive number; otherwise the input is
  // returned unchanged rather than allocating a NaN/Inf-length buffer.
  if (samples.length === 0 || fromRate === toRate || !Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    return samples;
  }
  const out = new Float32Array(Math.ceil((samples.length * toRate) / fromRate));
  const step = fromRate / toRate;
  for (let i = 0; i < out.length; i++) {
    const idx = Math.min(samples.length - 1, Math.floor(i * step));
    out[i] = samples[idx];
  }
  return out;
}

/** Encode mono f32 [-1,1] as 16-bit little-endian byte chunks. Non-finite
 * samples (NaN/±Inf) are treated as digital silence (0) — never garbage. */
export function encodePcm16(samples: Float32Array): number[] {
  const bytes = new Array<number>(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const s = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    const int = (s < 0 ? s * 0x8000 : s * 0x7fff) & 0xffff;
    bytes[i * 2] = int & 0xff;
    bytes[i * 2 + 1] = (int >> 8) & 0xff;
  }
  return bytes;
}

/** Whole mono frame -> 16k mono -> int16 bytes for interpret_audio. */
export function frameToChunk(samples: Float32Array, fromRate: number): number[] {
  return encodePcm16(downsample(samples, fromRate));
}
