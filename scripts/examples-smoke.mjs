#!/usr/bin/env node
/**
 * examples-smoke.mjs — actually **run** the crates' examples, because nothing else does.
 *
 * Why this exists (closes F-DEV-048, REQ-A463): `cargo clippy --workspace --all-targets`
 * **compiles** every example and `cargo test` runs none of them, so an example compiles
 * and still breaks the moment someone runs it. `crates/amos-robot/examples/serial_loopback.rs`
 * was exactly that (a hand-written "12 bytes" against a driver whose wire form is 11), and
 * it was found **by hand** — no gate could see it. This file is that gate.
 *
 * The first defect it found on its own is a different one, and worth reading:
 * `crates/amos-monitor/examples/sample_health.rs` used `amos_monitor::linux::LinuxSystemSampler`
 * without declaring `required-features`, so `cargo build -p amos-monitor --all-targets`
 * failed (E0432, unresolved import) while `cargo clippy --workspace --all-targets` passed —
 * cargo **unifies features across the workspace**, and `amos-ai` depends on `amos-monitor`
 * with `features = ["linux"]`. In other words: the package was broken in isolation and
 * every gate in the tree was green.
 *
 * Method:
 *   1. `cargo build --workspace --examples` **once**. This is not an optimisation — the
 *      hand measurement that motivated this file mistook a slow compile for a hang:
 *      `scan_dir` "timed out" at 20 s and then ran in 0.12 s (it prints a usage line and
 *      exits 2 without a `<ROOT>` argument).
 *   2. run every discovered example with `cargo run -q -p <crate> --example <name>` under a
 *      timeout.
 *   3. a run is OK **only** on exit code 0. A non-zero exit, a signal or a timeout is a
 *      defect **unless** the example is listed in `scripts/examples-smoke-allowlist.json`
 *      with a reason (needs a device/model/feature, an argument, or a terminal).
 *
 * Suppression discipline (REQ-A447): every entry carries a `why`, an entry with a
 * placeholder reason fails, and an entry that no longer matches the corpus is **stale** and
 * fails — a suppression that outlives its cause hides the next regression.
 *
 * Usage (repo root):
 *   node scripts/examples-smoke.mjs                 # gate (exit 1 on any defect)
 *   node scripts/examples-smoke.mjs --json
 *   node scripts/examples-smoke.mjs --timeout 60000
 *   node scripts/examples-smoke.mjs --selftest      # pin the classifier + allow-list rules
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(root, "scripts", "examples-smoke-allowlist.json");

/** `crates/amos-media/examples/scan_dir.rs` → `{ id, crate, name }`. */
export function exampleOf(file) {
  const m = /^crates\/([^/]+)\/examples\/([^/]+)\.rs$/.exec(file);
  if (!m) return null;
  return { id: `${m[1]}/${m[2]}`, crate: m[1], name: m[2] };
}

/** Every example in the tree, sorted by id. `files` is injected so the selftest can fake it. */
export function discover(files) {
  return files
    .map(exampleOf)
    .filter((e) => e !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * What a finished run means. `cargo run` reports a signal as `status === null` and a
 * timeout as `error.code === "ETIMEDOUT"`, and all three failures need to be told apart in
 * the report — "nothing printed and it was killed" is a different problem from "it printed
 * an assertion and exited 1".
 */
export function outcomeOf({ status, signal, timedOut }) {
  if (timedOut) return "timeout";
  if (signal) return "signal";
  return status === 0 ? "ok" : "exit";
}

/**
 * Allow-list hygiene: a reason is mandatory (and must not be a placeholder), and an entry
 * whose example is not in the corpus any more is stale. Returns `{ problems, stale }` so
 * the caller can print both.
 */
export function allowlistProblems(entries, ids) {
  const known = new Set(ids);
  const problems = [];
  const stale = [];
  const seen = new Set();
  for (const e of entries) {
    const why = String(e?.why ?? "").trim();
    if (!e?.example) {
      problems.push("entry without an `example`");
      continue;
    }
    if (seen.has(e.example)) problems.push(`${e.example}: duplicate entry`);
    seen.add(e.example);
    if (why.length < 20 || /^(todo|tbd|n\/a|unreviewed)$/i.test(why)) {
      problems.push(`${e.example}: no real reason ("${why}")`);
    }
    if (!known.has(e.example)) stale.push(e.example);
  }
  return { problems, stale };
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST)) return [];
  const raw = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  return Array.isArray(raw.entries) ? raw.entries : [];
}

/**
 * Build every example once. A workspace-wide example build failing is itself a defect —
 * that is exactly how the `required-features` case showed up (`cargo build -p X
 * --all-targets` fails while `--workspace --all-targets` passes, because cargo unifies the
 * feature in from another member).
 */
function buildExamples() {
  return spawnSync("cargo", ["build", "--workspace", "--examples", "-q"], {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Run one example **from a scratch directory**, not from the repository root.
 *
 * Why: this gate must not mutate the tree it audits. The first version ran from the repo
 * root (the obvious thing) and `crates/amos-pdf-parser/examples/make_sample_pdf.rs` wrote
 * `sample.pdf` there — an untracked artifact created by a *verification* step, which
 * `untracked-source-scan` then (correctly) complained about. Cargo is pointed at the
 * workspace explicitly with `--manifest-path`, so the build still uses the shared target dir
 * while the example's own `cwd` is a fresh temp dir that is removed afterwards. It also
 * matches how a reader runs an example from a crate README: from wherever they happen to be.
 */
function runExample(ex, timeoutMs) {
  const sandbox = mkdtempSync(join(tmpdir(), "amos-example-"));
  try {
    const r = spawnSync(
      "cargo",
      ["run", "-q", "--manifest-path", join(root, "Cargo.toml"), "-p", ex.crate, "--example", ex.name],
      {
        cwd: sandbox,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return {
      ...ex,
      outcome: outcomeOf({
        status: r.status,
        signal: r.signal,
        timedOut: r.error?.code === "ETIMEDOUT",
      }),
      output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** The last few non-empty lines of an example's output — enough to name the failure. */
function tailOf(s, n = 4) {
  return s
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-n)
    .join("\n");
}

/** Every example in the tree, from the filesystem (the caller injects nothing here). */
function treeExamples() {
  const crates = readdirSync(join(root, "crates"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `crates/${e.name}`);
  const files = [];
  for (const c of crates) {
    const dir = join(root, c, "examples");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) files.push(`${c}/examples/${f}`);
  }
  return discover(files);
}

// --- main --------------------------------------------------------------------
const argv = process.argv.slice(2);
let timeoutMs = 30_000;
const flags = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--timeout") {
    timeoutMs = Number(argv[i + 1]);
    i += 1;
    continue;
  }
  flags.push(argv[i]);
}
const unknown = flags.filter((f) => !["--selftest", "--json"].includes(f));
if (unknown.length > 0) {
  console.error(`[examples-smoke] unknown flag(s): ${unknown.join(" ")}`);
  console.error("Usage: node scripts/examples-smoke.mjs [--json] [--selftest] [--timeout <ms>]");
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("[examples-smoke] --timeout must be a positive number of milliseconds");
  process.exit(2);
}

if (flags.includes("--selftest")) {
  const cases = [];
  const ok = (name, cond) => cases.push([name, cond]);

  const a = exampleOf("crates/amos-media/examples/scan_dir.rs");
  ok("exampleOf reads crate and name", a?.id === "amos-media/scan_dir" && a?.crate === "amos-media");
  ok("exampleOf ignores non-examples", exampleOf("crates/amos-media/src/lib.rs") === null);
  ok("exampleOf ignores nested dirs", exampleOf("crates/x/examples/nested/y.rs") === null);
  ok(
    "discover sorts and drops non-examples",
    discover(["crates/b/examples/z.rs", "crates/a/src/lib.rs", "crates/a/examples/y.rs"])
      .map((e) => e.id)
      .join(",") === "a/y,b/z",
  );

  ok("outcome: zero exit is ok", outcomeOf({ status: 0 }) === "ok");
  ok("outcome: non-zero exit", outcomeOf({ status: 2 }) === "exit");
  ok("outcome: a signal is its own outcome", outcomeOf({ status: null, signal: "SIGTERM" }) === "signal");
  ok("outcome: a timeout is its own outcome", outcomeOf({ timedOut: true, status: null }) === "timeout");

  const good = [{ example: "a/y", why: "needs a device that is not present in this tree" }];
  ok("allowlist: a usable entry passes", allowlistProblems(good, ["a/y"]).problems.length === 0);
  ok("allowlist: a matched entry is not stale", allowlistProblems(good, ["a/y"]).stale.length === 0);
  ok(
    "allowlist: a placeholder reason fails",
    allowlistProblems([{ example: "a/y", why: "TODO" }], ["a/y"]).problems.length === 1,
  );
  ok(
    "allowlist: a short reason fails",
    allowlistProblems([{ example: "a/y", why: "nope" }], ["a/y"]).problems.length === 1,
  );
  ok(
    "allowlist: an entry for a vanished example is stale",
    allowlistProblems(good, ["a/other"]).stale.join() === "a/y",
  );
  ok(
    "allowlist: a duplicate is a problem",
    allowlistProblems([...good, ...good], ["a/y"]).problems.length === 1,
  );
  ok(
    "allowlist: an entry without an example is a problem",
    allowlistProblems([{ why: "a perfectly good long reason" }], []).problems.length === 1,
  );

  const failed = cases.filter(([, cond]) => !cond);
  if (failed.length > 0) {
    console.log(`[examples-smoke] selftest FAILED — ${failed.length} case(s):`);
    for (const [name] of failed) console.log(`  ✗ ${name}`);
    process.exit(1);
  }
  console.log(`[examples-smoke] selftest OK — ${cases.length} classifier/allow-list case(s).`);
  process.exit(0);
}

const examples = treeExamples();
const entries = readAllowlist();
const { problems, stale } = allowlistProblems(
  entries,
  examples.map((e) => e.id),
);
const skipped = new Set(entries.map((e) => e.example).filter(Boolean));
const planned = examples.filter((e) => !skipped.has(e.id));

// Build first, then run: a slow compile must not be measured as a hanging example.
const build = buildExamples();
const buildOk = build.status === 0;
const results = buildOk ? planned.map((e) => runExample(e, timeoutMs)) : [];
const failures = results.filter((r) => r.outcome !== "ok");
const defects = (buildOk ? 0 : 1) + failures.length + problems.length + stale.length;

if (flags.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        inTree: examples.length,
        planned: planned.map((e) => e.id),
        skipped: [...skipped],
        buildOk,
        results,
        problems,
        stale,
        defects,
      },
      null,
      2,
    ),
  );
  process.exit(defects === 0 ? 0 : 1);
}

if (defects > 0) {
  console.log(
    `[examples-smoke] FAIL — ${defects} problem(s); ${planned.length} example(s) run, ${skipped.size} skipped by allow-list.`,
  );
  if (!buildOk) {
    console.log("  the workspace example build failed:");
    for (const line of tailOf(`${build.stdout ?? ""}\n${build.stderr ?? ""}`, 8).split("\n")) {
      console.log(`    ${line}`);
    }
  }
  for (const r of failures) {
    console.log(`  ${r.outcome}: ${r.id}`);
    for (const line of tailOf(r.output).split("\n")) console.log(`    ${line}`);
  }
  for (const p of problems) console.log(`  allow-list: ${p}`);
  for (const p of stale) console.log(`  stale allow-list entry: ${p}`);
  console.log(
    "  Fix: make the example run to a zero exit, or record why it cannot in\n" +
      "       scripts/examples-smoke-allowlist.json (needs a device/feature/argument/terminal).",
  );
  process.exit(1);
}
console.log(
  `[examples-smoke] OK — ${planned.length} example(s) ran to a zero exit; ${skipped.size} skipped with a reason (${examples.length} in the tree).`,
);
