#!/usr/bin/env node
/**
 * coverage-low.mjs — the second half of the coverage workflow.
 *
 * `coverage:gate` (lib-coverage-gate.mjs) answers *is `src/lib/**` above the threshold?*;
 * this answers *which files to fix*, by reading the lcov report and printing the 20
 * worst-covered `src/lib/**` files. Complementary, not redundant: the gate only prints the
 * aggregate.
 *
 *   bun run test:coverage     # writes coverage/lcov.info (bun test --coverage)
 *   bun run coverage:low      # this script
 *
 * REQ-A190 gave it that entry point: the file shipped in the tree while **nothing** named
 * it — no `package.json` key, no Makefile target, no doc — so the workflow it completes
 * (measure → inspect → fix) was, in practice, unreachable. The gate found it by asking,
 * for every script on disk, who invokes it.
 */
import { readFileSync } from "node:fs";
const t = readFileSync("coverage/lcov.info", "utf8");
const rows = [];
for (const f of t.split("end_of_record")) {
  const sf = (f.match(/SF:(.*)/) || [])[1];
  const lf = (f.match(/\nLF:(\d+)/) || [])[1];
  const lh = (f.match(/\nLH:(\d+)/) || [])[1];
  if (!sf || !lf || lh === undefined) continue;
  if (!sf.includes("src/lib/")) continue;
  const total = Number(lf);
  const hit = Number(lh);
  rows.push({ f: sf.replace(/^.*\/src\/lib\//, ""), hit, total, pct: (hit / total) * 100 });
}
rows.sort((a, b) => a.pct - b.pct);
for (const r of rows.slice(0, 20)) {
  console.log(
    r.pct.toFixed(1).padStart(5) + "%  " + String(r.hit).padStart(4) + "/" + String(r.total).padStart(4) + "  " + r.f,
  );
}
