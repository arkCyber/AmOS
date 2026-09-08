#!/usr/bin/env node
// gen-ringtones.mjs — write the 4 default Clock ringtones as real WAV files into
// frontend-ts/public/sounds/ringtones/ (the directory documented in lib/ringtone.ts).
//
// Deterministic: the same note motifs + envelope as lib/ringtone.makeToneSamples
// (mirrored here so the files can be generated offline without a bundler). Each
// tone is a mono 16-bit PCM .wav that loops cleanly (notes decay to ~silence).
//
// Usage:  node scripts/gen-ringtones.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sounds", "ringtones");
const RATE = 16000;
const SEMI = 2 ** (1 / 12);
const N = (n) => 440 * SEMI ** n;

const TONES = {
  bell: [
    { f: N(12), at: 0.0, dur: 0.7 },
    { f: N(16), at: 0.0, dur: 0.7 },
    { f: N(19), at: 0.55, dur: 0.8 },
    { f: N(24), at: 0.55, dur: 0.8 },
  ],
  alarm: [
    { f: N(9), at: 0.0, dur: 0.22 },
    { f: N(9), at: 0.3, dur: 0.22 },
    { f: N(9), at: 0.6, dur: 0.22 },
    { f: N(21), at: 0.9, dur: 0.22 },
    { f: N(9), at: 1.2, dur: 0.22 },
    { f: N(21), at: 1.5, dur: 0.22 },
    { f: N(9), at: 1.8, dur: 0.3 },
  ],
  bugle: [
    { f: N(-2), at: 0.0, dur: 0.5 },
    { f: N(5), at: 0.55, dur: 0.5 },
    { f: N(9), at: 1.1, dur: 0.5 },
    { f: N(12), at: 1.65, dur: 0.6 },
  ],
  melody: [
    { f: N(0), at: 0.0, dur: 0.28 },
    { f: N(4), at: 0.33, dur: 0.28 },
    { f: N(7), at: 0.66, dur: 0.28 },
    { f: N(12), at: 1.0, dur: 0.5 },
    { f: N(7), at: 1.55, dur: 0.4 },
  ],
};

const MOTIF_SECONDS = 3.0;
const TOTAL = Math.floor(MOTIF_SECONDS * RATE);

function makeSamples(notes) {
  const out = new Float32Array(TOTAL);
  for (const note of notes) {
    const start = Math.max(0, Math.floor(note.at * RATE));
    const n = Math.max(1, Math.floor(note.dur * RATE));
    const lim = Math.min(n, TOTAL - start);
    if (lim <= 0) continue;
    for (let i = 0; i < lim; i++) {
      const t = i / RATE;
      const env = Math.min(1, t / 0.008) * Math.exp(-3.2 * t);
      const sample = Math.sin(2 * Math.PI * note.f * t) * env * 0.5;
      out[start + i] = Math.max(-1, Math.min(1, (out[start + i] ?? 0) + sample));
    }
  }
  return out;
}

function wavBytes(samples) {
  const n = samples.length;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const v = Math.max(-0x8000, Math.min(0x7fff, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)));
    data.writeInt16LE(v, i * 2);
  }
  const buf = Buffer.alloc(44 + data.length);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + data.length, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(data.length, 40);
  data.copy(buf, 44);
  return buf;
}

mkdirSync(ROOT, { recursive: true });
for (const [id, notes] of Object.entries(TONES)) {
  const file = join(ROOT, `${id}.wav`);
  const bytes = wavBytes(makeSamples(notes));
  writeFileSync(file, bytes);
  console.log(`wrote ${file} (${(bytes.length / 1024).toFixed(1)} KiB)`);
}
