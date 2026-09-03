#!/usr/bin/env node
/**
 * bun-iso-test.mjs — run the TS suite with TRUE per-file process isolation for
 * DOM test files, so each file gets its own happy-dom global window.
 *
 * Bun's `bun test` runs every file in ONE shared process by default, and the
 * DOM files share a single happy-dom window via `GlobalRegistrator`. Adding more
 * DOM files (or any file that installs window globals) then deterministically
 * breaks the shared-window DOM pack. Solution:
 *
 *   • NON-DOM (pure logic) files run together in ONE `bun test` process (fast).
 *   • Every DOM test file runs in its OWN `bun test ./<file>` process.
 *
 * Usage:
 *   node scripts/bun-iso-test.mjs test          # run everything (default)
 *   node scripts/bun-iso-test.mjs coverage      # pure-batch coverage + P2-1 gate
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(root, "src", "__tests__");

function collectTests(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) collectTests(p, acc);
    else if (/\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(ent.name)) acc.push(p);
  }
  return acc;
}

function isDom(file) {
  try {
    const src = readFileSync(file, "utf8");
    return src.includes("happy-dom/global-registrator") || src.includes("GlobalRegistrator.register");
  } catch {
    return false;
  }
}

function rel(p) {
  return "./" + p.slice(root.length + 1);
}

const all = collectTests(testsDir).sort();
const pure = all.filter((f) => !isDom(f));
const dom = all.filter(isDom);

function run(binArgs, opts = {}) {
  const r = spawnSync("bun", binArgs, { cwd: root, stdio: "inherit", ...opts });
  return r.status === 0;
}

const mode = process.argv[2] ?? "test";
let ok = true;

if (mode === "test") {
  console.log(`\n[bun-iso] ${pure.length} pure file(s) in one process, ${dom.length} DOM file(s) isolated.\n`);
  ok = run(["test", ...pure.map(rel)]) && ok;
  for (const f of dom) {
    ok = run(["test", rel(f)]) && ok;
  }
} else if (mode === "coverage") {
  // P2-1 gate measures src/lib only; pure files carry that coverage. DOM files
  // are run isolated (correctness) and need not contribute to the lib gate.
  if (existsSync(join(root, "coverage"))) spawnSync("rm", ["-rf", join(root, "coverage")]);
  ok = run(["test", "--coverage", "--coverage-reporter=lcov", ...pure.map(rel)]) && ok;
  ok = run(["scripts/lib-coverage-gate.mjs"]) && ok;
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

console.log(ok ? `\n[bun-iso] ${mode} OK` : `\n[bun-iso] ${mode} FAILED`);
process.exit(ok ? 0 : 1);
