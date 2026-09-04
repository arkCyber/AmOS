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
    out[i] = samples[idx] ?? 0; // idx is in bounds; ??0 guards the impossible case
  }
  return out;
}

/** Encode mono f32 [-1,1] as 16-bit little-endian byte chunks. Non-finite
 * samples (NaN/±Inf) are treated as digital silence (0) — never garbage. */
export function encodePcm16(samples: Float32Array): number[] {
  const bytes = new Array<number>(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] ?? 0; // never NaN/Inf garbage; see encodePcm16 doc
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

/**
 * Encode mono f32 [-1,1] as **little-endian f32 bytes** (4 bytes/sample) — the
 * exact wire format of the AI daemon's bidi `Payload::Audio` / the recognizer's
 * 16 kHz f32 PCM. Non-finite samples are treated as digital silence (0).
 */
export function encodeF32le(samples: Float32Array): number[] {
  const bytes = new Array<number>(samples.length * 4);
  const buf = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] ?? 0;
    const s = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    buf.setFloat32(0, s, true); // true = little-endian
    bytes[i * 4] = buf.getUint8(0);
    bytes[i * 4 + 1] = buf.getUint8(1);
    bytes[i * 4 + 2] = buf.getUint8(2);
    bytes[i * 4 + 3] = buf.getUint8(3);
  }
  return bytes;
}

/** Whole mono frame -> 16k mono -> little-endian f32 bytes for assistant_voice_feed. */
export function frameToAssistantChunk(samples: Float32Array, fromRate: number): number[] {
  return encodeF32le(downsample(samples, fromRate));
}

