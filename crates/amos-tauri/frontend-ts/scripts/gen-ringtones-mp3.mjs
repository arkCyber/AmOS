#!/usr/bin/env node
// gen-ringtones-mp3.mjs — convert the WAV ringtone sources to the MP3 assets the
// player actually serves (small & universally decoded by the WebView/<audio>).
// Requires ffmpeg on PATH. Deterministic mapping: bell/alarm/bugle/melody.
//   Usage: node scripts/gen-ringtones-mp3.mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sounds", "ringtones");
const IDS = ["bell", "alarm", "bugle", "melody"];

for (const id of IDS) {
  const wav = join(DIR, `${id}.wav`);
  const mp3 = join(DIR, `${id}.mp3`);
  if (!existsSync(wav)) {
    console.error(`missing source ${wav} — run gen-ringtones.mjs first`);
    process.exitCode = 1;
    continue;
  }
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-codec:a", "libmp3lame", "-q:a", "5", mp3]);
  console.log(`wrote ${mp3}`);
}
