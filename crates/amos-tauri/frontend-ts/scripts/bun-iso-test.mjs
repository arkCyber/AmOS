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
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Scan src/__tests__/ AND src/lib/__tests__/ (the lib/ folder has unit tests for
// pure modules with DOM-touching helpers — focusTrap, desktopView, etc.). The
// `src/lib/__tests__` is the conventional location for unit tests next to the
// modules they cover; otherwise those files would silently never run.
const testRoots = [join(root, "src", "__tests__"), join(root, "src", "lib", "__tests__")];

function collectTests(dir, acc = []) {
  if (!existsSync(dir)) return acc;
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

/**
 * A file may declare its zone: `// bun-iso-tz: <IANA zone>`.
 *
 * Those files get **their own process with `TZ` set**, because a zone is a property of the process,
 * not of a test: switching `process.env.TZ` mid-run made a case depend on which zone happened to run
 * before it (measured in REQ-A343 — the same file passed alone and failed in the batch). One file,
 * one zone, one process is deterministic; the file also asserts its own offset so a moved zone fails
 * loudly instead of quietly testing nothing.
 */
function tzOf(file) {
  try {
    const m = readFileSync(file, "utf8").match(/\/\/\s*bun-iso-tz:\s*([A-Za-z0-9_+\-/]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const all = testRoots.flatMap((d) => collectTests(d)).sort();
const zoned = all.filter((f) => tzOf(f) !== null);
const rest = all.filter((f) => tzOf(f) === null);
const pure = rest.filter((f) => !isDom(f));
const dom = rest.filter(isDom);

function run(binArgs, opts = {}) {
  const r = spawnSync("bun", binArgs, { cwd: root, stdio: "inherit", ...opts });
  return r.status === 0;
}

const mode = process.argv[2] ?? "test";
let ok = true;

if (mode === "test") {
  console.log(
    `\n[bun-iso] ${pure.length} pure file(s) in one process, ${dom.length} DOM file(s) isolated, ${zoned.length} zoned file(s) in their own process.\n`,
  );
  ok = run(["test", ...pure.map(rel)]) && ok;
  for (const f of dom) {
    ok = run(["test", rel(f)]) && ok;
  }
  for (const f of zoned) {
    // Own process **and** its declared zone: a zone cannot be switched for an instant reliably.
    ok = run(["test", rel(f)], { env: { ...process.env, TZ: tzOf(f) } }) && ok;
  }
} else if (mode === "coverage") {
  // P2-1 gate measures src/lib only. It used to be fed by the **pure batch alone**, which
  // silently dropped the coverage of the DOM-registered lib tests (enterprise, webman,
  // desktopView, dockConfig, focusTrap): measured 2026-09-17 (REQ-A390), merging them in
  // moves the gate from 77.18% to 82.91% — 1,122 covered lines that were being thrown away
  // (their *correctness* was always checked; only their contribution to the number was lost).
  //
  // Isolation is preserved: every DOM/zoned file still runs in its own process, it just
  // leaves its lcov behind as a part file for the gate to merge (max hit per line).
  //
  // REQ-A396 (2026-09-18): the pure **batch** lost per-file attribution at scale. Evidence
  // (bun 1.2.1, this repo): `enterprise-mdm-policy.test.ts` run **alone** records
  // `enterprise/mdm.ts` LH=630 with 5 missed lines, but the same file inside the 84-file
  // pure batch records almost nothing for `mdm.ts` — and the DOM parts' full-set listings
  // then mark those executed-but-unrecorded lines as **missed** in the union. Same shape
  // for `settings.ts` (alone: 0 missed / batch: 90 "missed"), `crypto/mdmCrypto.ts`
  // (alone: 3 / batch: 115), `enterprise/templates.ts` (alone: 0 / batch: 128). The union
  // was therefore *pessimistic*: tests really executed lines no part recorded. Fix: in
  // coverage mode **every** file runs in its own process (the DOM files' existing
  // treatment), so each leaves a full-attribution part; the gate merges as before.
  // Cost: ~1 process per test file (~180) instead of 1 batch — measured at roughly
  // +2 min on `make cov`. Correctness still comes from `test` mode's shared batch; only
  // the *attribution* needed isolation.
  if (existsSync(join(root, "coverage"))) spawnSync("rm", ["-rf", join(root, "coverage")]);
  // Bun always writes `coverage/lcov.info`, so each isolated run's report has to be moved
  // aside before the next run overwrites it (measured: forgetting this made the gate read
  // the *last* file's report instead of everything).
  let part = 0;
  const all = [...pure, ...dom, ...zoned];
  for (const f of all) {
    const tz = tzOf(f);
    ok =
      run(["test", "--coverage", "--coverage-reporter=lcov", rel(f)], tz ? { env: { ...process.env, TZ: tz } } : {}) &&
      ok;
    const lcov = join(root, "coverage", "lcov.info");
    if (existsSync(lcov)) {
      renameSync(lcov, join(root, "coverage", `lcov.part-${String(part).padStart(3, "0")}.info`));
    }
    part++;
  }
  ok = run(["scripts/lib-coverage-gate.mjs"]) && ok;
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

console.log(ok ? `\n[bun-iso] ${mode} OK` : `\n[bun-iso] ${mode} FAILED`);
process.exit(ok ? 0 : 1);
