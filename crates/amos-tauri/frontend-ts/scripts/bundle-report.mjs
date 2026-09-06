#!/usr/bin/env node
/**
 * bundle-report.mjs — measure the production bundle and produce a data-backed
 * table for the React→Svelte migration (立项数据支撑).
 *
 * Run `vite build` first (writes dist/), then:
 *   node scripts/bundle-report.mjs
 *
 * For each asset it reports raw + gzip bytes and classifies it:
 *   • REACT-MAIN   – the React shell (index-*.js / index-*.css)
 *   • SVELTE-APP   – a migrated screen's lazy chunk (its own <script> tag)
 *   • SVELTE-SHARE – shared Svelte infra chunk (locale/store runes)
 *
 * The headline number is `Svelte-on-demand`: everything Svelte ships lazily
 * (only fetched when that screen is actually opened), versus the one-time
 * React main bundle. Tracking this per migration shows the migration is additive
 * until the React bodies of each screen are deleted (a later phase) — that
 * deletion is where the real one-time win lands.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist", "assets");

const SVELTE_APP =
  /(CalculatorApp|WeatherApp|ContactsApp|PermissionsApp|ClockApp|MessagesApp|MusicApp|NotesApp|FilesApp|PhotosApp)-/;
const SVELTE_SHARE = /(locale\.svelte|store|class)-/;

function gzipKB(bytes) {
  return (gzipSync(bytes).length / 1024).toFixed(2);
}
function rawKB(bytes) {
  return (bytes / 1024).toFixed(2);
}

let mainRaw = 0;
let mainGz = 0;
let svelteRaw = 0;
let svelteGz = 0;
const rows = [];

for (const f of readdirSync(dist).filter((x) => /\.(js|css)$/.test(x))) {
  const buf = readFileSync(join(dist, f));
  const raw = rawKB(buf.length);
  const gz = gzipKB(buf);
  let kind = "other";
  if (/^index-/.test(f)) {
    kind = /\.css$/.test(f) ? "REACT-MAIN(css)" : "REACT-MAIN(js)";
    mainRaw += buf.length;
    mainGz += gzipSync(buf).length;
  } else if (SVELTE_APP.test(f)) {
    kind = "SVELTE-APP";
    svelteRaw += buf.length;
    svelteGz += gzipSync(buf).length;
  } else if (SVELTE_SHARE.test(f)) {
    kind = "SVELTE-SHARE";
    svelteRaw += buf.length;
    svelteGz += gzipSync(buf).length;
  }
  rows.push({ f, raw, gz, kind });
}

rows.sort((a, b) => Number(b.gz) - Number(a.gz));

console.log("\n=== per-asset (raw / gzip, kB) ===");
for (const r of rows) {
  console.log(`${r.kind.padEnd(16)} ${r.raw.padStart(7)} / ${r.gz.padStart(7)}  ${r.f}`);
}

console.log("\n=== totals (kB) ===");
console.log(`React main (one-time):  raw ${rawKB(mainRaw)} / gzip ${(mainGz / 1024).toFixed(2)}`);
console.log(
  `Svelte on-demand (lazy): raw ${rawKB(svelteRaw)} / gzip ${(svelteGz / 1024).toFixed(2)}`,
);
console.log(
  `  (of which app screens: ${rows.filter((r) => r.kind === "SVELTE-APP").map((r) => r.f.replace(/-[A-Za-z0-9_]+\.js$/, "")).join(", ") || "—"})`,
);
console.log(
  "Note: React screen bodies still ship in the React main bundle today (kept as the",
  "\nbun-test reference). Deleting them in a later phase removes that one-time cost.",
);
