#!/usr/bin/env node
/**
 * rust-clock-assert-scan.mjs — "a wall-clock assertion measures the machine, not the code"
 * (REQ-A854 / F-DEV-109; the Rust half of REQ-A850 / F-DEV-106, which fixed the frontend's
 * 22 instances and added `crates/amos-tauri/frontend-ts/scripts/perf-budget-scan.mjs`).
 *
 * Why this exists
 * ---------------
 * `assert!(start.elapsed() < Duration::from_millis(500))` reads like a claim about the code and
 * is really a claim about the *box*: `elapsed()` is the work **plus** whatever else the OS
 * scheduled on that core. Contention only ever **adds** time, so such an assertion is
 * non-deterministic in exactly one direction — it can go red while the code is unchanged, and it
 * can never go red *because* the code got faster. Measured on this repo's frontend half: under 40
 * spinners on 18 cores, 4 of 12 single-shot samples crossed a 50 ms budget (`max 201.49 ms`) while
 * the min over K=5 attempts of the SAME work crossed it 0 times (`max 40.90 ms`).
 *
 * The instrument that removes the machine is the **minimum over K attempts** (`fastest_of`): each
 * attempt is "true cost + non-negative noise", so the minimum approaches the unloaded cost, and a
 * genuine regression raises every attempt. `min ≤ any single sample`, so binding an assertion
 * through it can only turn red→green — which is why the frontend conversion widened no threshold.
 *
 * The rule
 * --------
 * In every assertion an `.elapsed()` (or `Instant::now() - start`) reading must not be the value
 * judged to be **small enough**. Polarity is decided by the comparison, i.e. by what the assertion
 * is doing with the clock — not by the presence of a clock:
 *
 *   * `start.elapsed() <  X` / `<=` / `==` / `!=`   **flagged**  — "must be quick" is a machine claim
 *   * `start.elapsed() >  X` / `>=`                 informational — "at least X passed" cannot
 *                                                    flake from load: contention only makes it
 *                                                    more true. (Reported, never a failure; a
 *                                                    lower bound still needs a clock that moves.)
 *   * no comparison at all (`assert!(within(start.elapsed()))`) **flagged** — unclassifiable, and
 *                                                    a gate that silently skips what it cannot
 *                                                    classify is the failure mode this family of
 *                                                    scans exists to avoid.
 *
 * A flagged site passes only if it is bound through the instrument — `let best =
 * fastest_of(5, || { … }); assert!(best < Duration::from_millis(500));` — or carries an entry in
 * `rust-clock-assert-allowlist.json` with a **kind**, a **reason** and its own **note** (printed
 * on every run so a reader can rebut it). The scan judges the **binding**, never whether the
 * number is meaningful: `assert!(best < Duration::from_secs(3600))` is compliant.
 *
 * Honest limits (state them, do not paper over them)
 * -------------------------------------------------
 *  * `min` masks a regression *below the noise floor* — it buys determinism, not sensitivity.
 *  * The threshold stays an absolute number on one machine; cross-machine comparability would
 *    need a ratio against an in-run reference workload, which this repo does not do.
 *  * The perfect fix for a *timeout* is a clock you control (`tokio::time::pause`,
 *    `start_paused = true`, or an injected `Instant` — the idiom 33 files in this workspace
 *    already use, e.g. `amos-robot/src/watchdog.rs`). The instrument is the fallback for tests
 *    that must exercise the **real** clock.
 *
 * Scope: every `.rs` under `crates/` except `target/` — production, unit tests and integration
 * tests. `benches/` and `examples/` are included: they run in this repo too.
 *
 * The scanner is dependency-free (regex + fs, plus this repo's shared comment/string masker and
 * bracket matcher) and never executes or imports the Rust it inspects.
 *
 * Usage (from the repo root):
 *   node scripts/rust-clock-assert-scan.mjs                 # gate (non-zero on regression)
 *   node scripts/rust-clock-assert-scan.mjs --selftest      # pin the extractor/classifier
 *   node scripts/rust-clock-assert-scan.mjs --json          # machine-readable report
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { maskProse, matchBracket } from "./tauri-reply-scan.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cratesDir = join(repoRoot, "crates");
const allowlistPath = join(repoRoot, "scripts", "rust-clock-assert-allowlist.json");

/**
 * The instrument's names. A site bound through one of these is judged by the **binding**, the way
 * the frontend scanner (`perf-budget-scan.mjs`) judges `fastest()`/`fastestAsync()`.
 */
const INSTRUMENT_RE = /\b(?:fastest|fastest_of|min_elapsed|best_of)\s*\(/;

/** A reading of the wall clock (as opposed to an injected/instrumented value). */
const CLOCK_RE = /\.elapsed\(\)|Instant::now\(\)\s*-\s*[A-Za-z_]\w*/;

const ASSERT_RE = /\b(debug_assert(?:_eq|_ne)?|assert(?:_eq|_ne)?)!\s*\(/g;

/** Longest first: `<=` must not be read as `<`. */
const COMPARISONS = ["<=", ">=", "==", "!=", "<", ">"];

/**
 * The sites that must keep their instrument. Set equality in **both** directions (`pinDiff`): a
 * missing name means the instrument was reverted or deleted, and a deleted assertion trips no
 * other rule — that is the whole reason the frontend gate grew `MUST_SEE_FILES` (REQ-A845 /
 * F-SH-273: a floor cannot see a one-name loss, because a lost name has no call sites).
 */
export const MUST_SEE_INSTRUMENTED = [
  "crates/amos-audio/src/ring.rs",
  "crates/amos-link/src/keyexpr.rs",
];

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** Every `.rs` under `crates/`, `target/` excluded. Deterministic order. */
export function rustFiles(dir = cratesDir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "target" || e.name === ".git") continue;
        walk(p);
      } else if (e.name.endsWith(".rs")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * The top-level comparison operators inside a macro's argument text, as `{op, at}`.
 *
 * Only depth-0 operators count: at `assert!(a.elapsed() < Duration::from_millis(500))` the `<` is
 * at depth 0 and the `(`-guarded text is not scanned, so a `<` inside a nested generic or call
 * cannot be mistaken for the assertion's own comparison.
 */
export function topLevelComparisons(args) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0) {
      const op = COMPARISONS.find((o) => args.startsWith(o, i));
      if (op) {
        out.push({ op, at: i });
        i += op.length - 1;
      }
    }
  }
  return out;
}

/** The `;` that ends the statement starting at `from`, skipping nested brackets. */
export function statementEnd(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return i;
  }
  return src.length;
}

/**
 * What the identifier `name` is bound to **before** `before`: `"instrument"`, `"clock"`, or `null`
 * when it has no `let` binding in this file. Order matters — a binding that appears *after* the
 * assertion cannot cover it, and a name bound from a raw clock reading (`let best =
 * start.elapsed();`) must not launder it (an alias is not an instrument).
 */
export function bindingOf(src, name, before) {
  const decl = new RegExp(`\\blet\\s+(?:mut\\s+)?${name}\\b`, "g");
  let last = null;
  for (const m of src.slice(0, before).matchAll(decl)) last = m;
  if (!last) return null;
  const rhs = src.slice(last.index, statementEnd(src, last.index));
  if (INSTRUMENT_RE.test(rhs)) return "instrument";
  if (CLOCK_RE.test(rhs)) return "clock";
  return null;
}

/**
 * Classify one assertion's argument text.
 *
 * Returns `{verdict, detail, at}` where `at` is the offset (inside `args`) of the value judged,
 * and `verdict` is:
 *   `"clean"`        — no wall-clock reading is being judged by this assertion
 *   `"informational"`— a lower-bound reading (contention cannot falsify it)
 *   `"instrumented"` — the judged value is bound through the min-of-K instrument
 *   `"raw"`          — the judged value IS a wall-clock reading  ← the failure
 *   `"unclassified"` — a clock reading with no top-level comparison  ← also a failure
 */
export function classify(args, src, before, macro = "assert") {
  const clock = args.match(CLOCK_RE);
  const depthAt = (index) => {
    let depth = 0;
    for (let i = 0; i < index; i++) {
      if ("([{".includes(args[i])) depth++;
      else if (")]}".includes(args[i])) depth--;
    }
    return depth;
  };
  // `assert_eq!`/`assert_ne!` assert equality *by name*: there is no comparison operator to read,
  // and an equality against a fixed duration is as much a machine claim as a `<`.
  const byName = /_(eq|ne)$/.test(macro);
  if (clock && byName && depthAt(clock.index) === 0) {
    return { verdict: "raw", detail: `${clock[0]} compared for equality with a fixed duration`, at: clock.index };
  }
  const cmp = topLevelComparisons(args)[0];
  if (!cmp) {
    if (clock && depthAt(clock.index) === 0) {
      return { verdict: "unclassified", detail: `clock reading ${clock[0]} with no top-level comparison`, at: clock.index };
    }
    // A clock inside a nested call is not this assertion's judged value — but it is not provably
    // harmless either, and a gate that silently skips what it cannot read is the failure mode
    // this family exists to avoid. Only the *subject* case is reported; an argument that merely
    // mentions a clock (`assert!(f(elapsed))`) fails closed as unclassified.
    if (clock) return { verdict: "unclassified", detail: `clock reading ${clock[0]} is not at top level`, at: clock.index };
    return { verdict: "clean", detail: "", at: 0 };
  }
  // The side the assertion demands to be **small**: the LHS of `<`/`<=`, the RHS of `>`/`>=`.
  const smallIsLeft = cmp.op === "<" || cmp.op === "<=";
  const judged = smallIsLeft ? args.slice(0, cmp.at).trim() : args.slice(cmp.at + cmp.op.length).trim();
  const judgedAt = smallIsLeft ? 0 : cmp.at + cmp.op.length;
  const clockOnSmallSide = clock && (smallIsLeft ? clock.index < cmp.at : clock.index > cmp.at) && depthAt(clock.index) === 0;
  if (clockOnSmallSide) {
    return { verdict: "raw", detail: `${clock[0]} ${cmp.op} … decides how busy this machine is`, at: clock.index };
  }
  if (cmp.op === "==" || cmp.op === "!=") {
    if (clock && depthAt(clock.index) === 0) {
      return { verdict: "raw", detail: `${clock[0]} ${cmp.op} … compares a wall clock to a fixed value`, at: clock.index };
    }
  }
  if (clock && depthAt(clock.index) === 0 && !smallIsLeft) {
    // `elapsed() > X`: the value must be large. Load can only make it more true.
    return { verdict: "informational", detail: `${clock[0]} ${cmp.op} … (lower bound: load cannot falsify it)`, at: clock.index };
  }
  const name = judged.match(/^([A-Za-z_]\w*)$/)?.[1];
  const bound = name ? bindingOf(src, name, before) : null;
  if (bound === "instrument") {
    const at = args.indexOf(name, judgedAt) < 0 ? judgedAt : args.indexOf(name, judgedAt);
    return { verdict: "instrumented", detail: `${name} is bound through the min-of-K instrument`, at };
  }
  if (bound === "clock") {
    const at = args.indexOf(name, judgedAt) < 0 ? judgedAt : args.indexOf(name, judgedAt);
    return { verdict: "raw", detail: `${name} is bound straight to a clock reading (an alias is not an instrument)`, at };
  }
  if (clock && depthAt(clock.index) === 0) {
    return { verdict: "unclassified", detail: `clock reading ${clock[0]} is judged, but not on the small side`, at: clock.index };
  }
  return { verdict: "clean", detail: "", at: 0 };
}

/** Every assertion in `source` that judges a wall-clock value, with its verdict. */
export function clockAssertions(source) {
  const masked = maskProse(source, { strings: true });
  const out = [];
  for (const m of masked.matchAll(ASSERT_RE)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close === -1) continue; // unbalanced macro — nothing to judge here
    const args = masked.slice(open + 1, close);
    // Candidates: anything mentioning a clock, plus every top-level comparison — the second half
    // is what lets an **aliased** clock (`let best = start.elapsed(); assert!(best < …)`) be
    // judged, which the clock text alone cannot reveal.
    if (!CLOCK_RE.test(args) && topLevelComparisons(args).length === 0) continue;
    const original = source.slice(open + 1, close);
    const { verdict, detail, at } = classify(args, masked, m.index, m[1]);
    if (verdict === "clean") continue;
    out.push({
      macro: m[1],
      line: lineOf(masked, open + 1 + at),
      args: original.trim(),
      verdict,
      detail,
    });
  }
  return out;
}

/** Set-equality in both directions, so a lost name and an unexplained new one both surface. */
export function pinDiff(got, want) {
  const g = new Set(got);
  const w = new Set(want);
  return {
    missing: [...w].filter((x) => !g.has(x)),
    extra: [...g].filter((x) => !w.has(x)),
  };
}

export function checkAllowlistShape(doc) {
  const problems = [];
  if (!doc || typeof doc !== "object") return ["allow-list is not an object"];
  if (!doc.kinds || typeof doc.kinds !== "object") problems.push("no `kinds` table");
  else {
    for (const [k, v] of Object.entries(doc.kinds)) {
      if (!v || typeof v.reason !== "string" || !v.reason.trim()) problems.push(`kind ${k} has no reason`);
    }
  }
  for (const s of doc.sites ?? []) {
    if (!s.file || typeof s.file !== "string") problems.push("a site entry has no file");
    if (!s.kind || !(doc.kinds ?? {})[s.kind]) problems.push(`${s.file}: kind ${JSON.stringify(s.kind)} is not defined`);
    if (!s.note || !String(s.note).trim()) problems.push(`${s.file}: no note`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────── selftest

const FIXTURES = [
  {
    name: "a raw upper bound is flagged",
    src: `#[test]\nfn t() {\n    let start = Instant::now();\n    assert!(start.elapsed() < Duration::from_millis(500), "must not block long");\n}`,
    expect: [["raw", 4]],
  },
  {
    name: "the reversed spelling is flagged too",
    src: `fn t() {\n    assert!(Duration::from_millis(500) > start.elapsed());\n}`,
    expect: [["raw", 2]],
  },
  {
    name: "a lower bound is informational, never a failure",
    src: `fn t() {\n    assert!(silent_for > Duration::from_millis(50), "{silent_for:?}");\n    assert!(start.elapsed() > Duration::from_millis(50));\n}`,
    expect: [["informational", 3]],
  },
  {
    name: "an elapsed equality is a machine claim",
    src: `fn t() {\n    assert_eq!(start.elapsed(), Duration::from_millis(10));\n}`,
    expect: [["raw", 2]],
  },
  {
    name: "bound through the instrument ⇒ instrumented",
    src: `fn t() {\n    let best = fastest_of(5, || { let _ = read(); });\n    assert!(best < Duration::from_millis(500));\n}`,
    expect: [["instrumented", 3]],
  },
  {
    name: "an alias of a clock reading is not an instrument",
    src: `fn t() {\n    let best = start.elapsed();\n    assert!(best < Duration::from_millis(500));\n}`,
    expect: [["raw", 3]],
  },
  {
    name: "the instrument bound AFTER the assertion does not cover it",
    src: `fn t() {\n    assert!(best < Duration::from_millis(500));\n    let best = fastest_of(5, || {});\n}`,
    expect: [],
  },
  {
    name: "a clock with no comparison fails closed",
    src: `fn t() {\n    assert!(within_budget(start.elapsed()));\n}`,
    expect: [["unclassified", 2]],
  },
  {
    name: "a nested comparison is not the assertion's own",
    src: `fn t() {\n    assert!(is_fast(start.elapsed().as_millis()));\n}`,
    expect: [["unclassified", 2]],
  },
  {
    name: "a clock-free assertion is not a site",
    src: `fn t() {\n    assert!(clock.is_fresh(Duration::from_secs(60)));\n    assert_eq!(a.since(&b), Duration::ZERO);\n}`,
    expect: [],
  },
  {
    name: "the same shaped text in a comment is invisible",
    src: `// assert!(start.elapsed() < Duration::from_millis(500));\n/* assert!(x.elapsed() <= y); */\nfn t() {}`,
    expect: [],
  },
  {
    name: "the same shaped text in a string literal is invisible",
    src: `fn t() {\n    let doc = "assert!(start.elapsed() < Duration::from_millis(500))";\n}`,
    expect: [],
  },
  {
    name: "a multi-line assertion is matched",
    src: `fn t() {\n    assert!(\n        start.elapsed() < Duration::from_millis(500),\n        "must not block long"\n    );\n}`,
    expect: [["raw", 3]],
  },
];

function selftest() {
  let fail = 0;
  const check = (cond, msg) => {
    if (!cond) {
      fail++;
      console.error(`  ✗ ${msg}`);
    }
  };
  for (const f of FIXTURES) {
    const got = clockAssertions(f.src);
    const want = f.expect;
    check(
      got.length === want.length,
      `${f.name}: expected ${want.length} site(s), got ${got.length} (${got.map((g) => `${g.verdict}@${g.line}`).join(", ")})`,
    );
    want.forEach(([verdict, line], i) => {
      check(got[i]?.verdict === verdict, `${f.name}[${i}]: expected ${verdict}, got ${got[i]?.verdict}`);
      check(got[i]?.line === line, `${f.name}[${i}]: expected line ${line}, got ${got[i]?.line}`);
    });
  }
  // pinDiff must be two-sided; a one-sided pin cannot see a lost name.
  const d = pinDiff(["a"], ["a", "b"]);
  check(d.missing.length === 1 && d.missing[0] === "b", "pinDiff: must report a missing name");
  check(d.extra.length === 0, "pinDiff: must not invent extras");
  const e = pinDiff(["a", "c"], ["a"]);
  check(e.extra.length === 1 && e.extra[0] === "c", "pinDiff: must report an unexplained extra");
  // The allow-list's own shape rules.
  check(checkAllowlistShape({ kinds: { k: { reason: "r" } }, sites: [{ file: "f", kind: "k", note: "n" }] }).length === 0, "allow-list: a well-formed entry must pass");
  check(checkAllowlistShape({ kinds: {}, sites: [{ file: "f", kind: "k", note: "n" }] }).length > 0, "allow-list: an undefined kind must fail");
  check(checkAllowlistShape({ kinds: { k: { reason: "r" } }, sites: [{ file: "f", kind: "k" }] }).length > 0, "allow-list: a site without its own note must fail");
  // The instrument's own names must satisfy the recogniser (a renamed helper would silently
  // disarm every binding rule, the way a renamed wrapper left a floor green — REQ-A845).
  for (const n of ["fastest", "fastest_of", "min_elapsed", "best_of"]) {
    check(INSTRUMENT_RE.test(`${n}(5, || {})`), `instrument recogniser must accept ${n}(`);
  }
  console.log(`[rust-clock-assert] selftest: ${FIXTURES.length} fixture(s) + 8 assertion(s), ${fail} failure(s).`);
  return fail === 0;
}

// ─────────────────────────────────────────────────────────────────────────────── gate

function main(argv) {
  const json = argv.includes("--json");
  const allow = existsSync(allowlistPath) ? JSON.parse(readFileSync(allowlistPath, "utf8")) : { kinds: {}, sites: [] };
  const allowed = new Set((allow.sites ?? []).map((s) => `${s.file}:${s.line ?? "*"}`));

  const findings = [];
  let sites = 0;
  const instrumented = [];
  for (const abs of rustFiles()) {
    const src = readFileSync(abs, "utf8");
    const rel = relative(repoRoot, abs);
    for (const site of clockAssertions(src)) {
      sites++;
      if (site.verdict === "instrumented") {
        if (!instrumented.includes(rel)) instrumented.push(rel);
        continue;
      }
      if (site.verdict === "clean" || site.verdict === "informational") {
        if (site.verdict === "informational") console.log(`[rust-clock-assert] note ${rel}:${site.line} — ${site.detail}`);
        continue;
      }
      const key = `${rel}:${site.line}`;
      if (allowed.has(key) || allowed.has(`${rel}:*`)) continue;
      findings.push({ file: rel, line: site.line, verdict: site.verdict, detail: site.detail, args: site.args });
    }
  }

  const pin = pinDiff(instrumented, MUST_SEE_INSTRUMENTED);
  const shape = checkAllowlistShape(allow);

  if (json) {
    console.log(JSON.stringify({ sites, findings, pin, shapeProblems: shape }, null, 2));
  } else {
    for (const s of (allow.sites ?? [])) console.log(`[rust-clock-assert] allow-listed ${s.file}:${s.line ?? "*"} (${s.kind}) — ${s.note}`);
    for (const f of findings) console.error(`[rust-clock-assert] FAIL ${f.file}:${f.line} — ${f.args}\n    ${f.detail}`);
    for (const m of pin.missing) console.error(`[rust-clock-assert] FAIL ${m} no longer binds any assertion through the min-of-K instrument (pin)`);
    for (const x of pin.extra) console.error(`[rust-clock-assert] FAIL ${x} is newly instrumented — add it to MUST_SEE_INSTRUMENTED (the pin is a set, not a floor)`);
    for (const p of shape) console.error(`[rust-clock-assert] FAIL allow-list: ${p}`);
    console.log(
      `[rust-clock-assert] ${sites} clock-bearing assertion(s) across ${rustFiles().length} .rs file(s); ` +
        `${instrumented.length} file(s) binding through the instrument; ${findings.length} unaccounted; ${(allow.sites ?? []).length} allow-listed.`,
    );
    if (findings.length === 0 && pin.missing.length === 0 && pin.extra.length === 0 && shape.length === 0) {
      console.log("[rust-clock-assert] OK — no assertion decides how busy the machine is.");
    }
  }
  return findings.length === 0 && pin.missing.length === 0 && pin.extra.length === 0 && shape.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const code = process.argv.includes("--selftest") ? (selftest() ? 0 : 1) : main(process.argv.slice(2));
  process.exit(code);
}
