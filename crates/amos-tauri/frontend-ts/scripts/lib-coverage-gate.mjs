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
import { existsSync, readdirSync, readFileSync } from "node:fs";

const LCOV = "coverage/lcov.info";
const threshold = parseFloat(process.argv[2] ?? process.env.COVERAGE_THRESHOLD ?? "0.90");
if (!Number.isFinite(threshold)) throw new Error("invalid coverage threshold");

/**
 * Every report Bun wrote: the pure batch's `lcov.info` plus one part per isolated DOM/zoned
 * test file (`bun-iso-test.mjs`). Hits are **maxed** per line — a line covered by any run is
 * covered. Before REQ-A390 only `lcov.info` was read, so five test files' coverage was
 * invisible to this gate.
 */
const reports = [
  LCOV,
  ...readdirSync("coverage")
    .filter((f) => /^lcov\.part-\d+\.info$/.test(f))
    .sort()
    .map((f) => `coverage/${f}`),
].filter((f) => existsSync(f));

let cur = null;
let curLines = null;
const files = {}; // path -> { line -> max hits }
for (const report of reports)
for (const raw of readFileSync(report, "utf8").split("\n")) {
  const line = raw.trim();
  if (line.startsWith("SF:")) {
    cur = line.slice(3);
    // Accumulate across reports: `files[cur] = {}` would make each report *replace* what
    // earlier ones recorded for the same file (that bug made the gate read only the last
    // report per file: 12,211 lines instead of 13,812).
    curLines = files[cur] ?? (files[cur] = {});
  } else if (line.startsWith("DA:") && cur !== null) {
    const [ln, count] = line.slice(3).split(",", 2);
    const n = Number(ln);
    const hits = Number(count) || 0;
    if (!Number.isFinite(n)) continue;
    // max, not assignment: the reports overlap and a line covered in *any* run counts.
    curLines[n] = Math.max(curLines[n] ?? 0, hits);
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
