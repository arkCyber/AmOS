#!/usr/bin/env node
/**
 * P2-1 gate: enforce a minimum line-coverage on the core pure-logic modules
 * (src/lib/**) using the lcov report Bun writes to ./coverage/lcov.info.
 *
 * Usage (from frontend-ts):
 *   bun test --coverage --coverage-reporter=lcov
 *   node scripts/lib-coverage-gate.mjs [threshold]   # threshold default 0.80
 *
 * Aggregate is over src/lib only (components/theme/tests excluded), so the gate
 * tracks the code that is meant to be unit-tested headlessly.
 */
import { readFileSync } from "node:fs";

const LCOV = "coverage/lcov.info";
const threshold = parseFloat(process.argv[2] ?? process.env.COVERAGE_THRESHOLD ?? "0.90");
if (!Number.isFinite(threshold)) throw new Error("invalid coverage threshold");

let cur = null;
let curLines = null;
const files = {}; // path -> { total, hit }
for (const raw of readFileSync(LCOV, "utf8").split("\n")) {
  const line = raw.trim();
  if (line.startsWith("SF:")) {
    cur = line.slice(3);
    curLines = {};
    files[cur] = curLines;
  } else if (line.startsWith("DA:") && cur !== null) {
    const [ln, count] = line.slice(3).split(",", 2);
    const n = Number(ln);
    const hits = Number(count) || 0;
    if (Number.isFinite(n)) curLines[n] = hits;
  } else if (line === "end_of_record") {
    cur = null;
  }
}

let total = 0;
let hit = 0;
const libFiles = [];
for (const [path, lines] of Object.entries(files)) {
  if (!path.startsWith("src/lib/")) continue;
  const ft = Object.keys(lines).length;
  const fh = Object.values(lines).filter((c) => c > 0).length;
  total += ft;
  hit += fh;
  libFiles.push([path, ft, fh]);
}

if (total === 0) {
  console.error("No src/lib coverage found — did coverage/lcov.info get generated?");
  process.exit(2);
}

const pct = (100 * hit) / total;
console.log(`src/lib line coverage: ${pct.toFixed(2)}% (${hit}/${total} lines, ${libFiles.length} files)`);
console.log(`threshold: ${(threshold * 100).toFixed(0)}%`);
if (pct < threshold * 100) {
  console.error(`P2-1 GATE FAILED: coverage ${pct.toFixed(2)}% < ${(threshold * 100).toFixed(0)}%`);
  process.exit(1);
}
console.log("P2-1 gate passed.");
