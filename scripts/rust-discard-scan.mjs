#!/usr/bin/env node
/**
 * rust-discard-scan.mjs — type-aware scan for results that are silently thrown away.
 *
 * Why: R77 asked "is anything blocking an async worker?" and R80 asked "is a `std` lock
 * held across an `.await`?" — both times a **syntactic** scan was the only option, and both
 * reports said so: "a guard moved into another function, returned out of scope, or a
 * `parking_lot` lock whose `use` line does not name the type are all outside it (a type
 * checker would be needed)". This gate uses the type checker instead of guessing: it reads
 * `cargo clippy` diagnostics (JSON) for three lints that the compiler can only decide with
 * types in hand:
 *
 *   • `clippy::let_underscore_must_use` — `let _ = expr` where `expr` is `#[must_use]`.
 *     That is the explicit way to discard a `Result`, a `JoinHandle`, a `Guard`, or any
 *     other value the author of the API asked you to look at. This repository has 171 of
 *     them in production code and, until now, **no gate at all** on either side of the
 *     Rust/TS split (the frontend has `write-scan`; the Rust side had nothing).
 *   • `clippy::await_holding_lock` / `await_holding_refcell_ref` — the *type-aware* version
 *     of R80's question. They are currently **0**, which independently confirms R80's
 *     conclusion (its scan was scope-aware, but still syntactic).
 *
 * Measured and deliberately **not** gated: `.ok()` (189 production sites). Round 84 read a
 * sample of them: the overwhelming majority is the idiomatic "missing env var / unparsable
 * number ⇒ default" pattern (`std::env::var(X).ok()`, `parse::<usize>().ok()`), where the
 * absence of a value *is* the expected case. A gate over that would be pure noise, and a
 * regex cannot tell it apart from the interesting cases (a file that exists but cannot be
 * read silently becoming "empty"). Those were handled at the sites where they change what
 * the daemon reports — see `load_passages` in `rag_service.rs`, which now separates
 * "missing" from "corrupt" (REQ-A148).
 *
 * Ratchet, like `unsafe-scan` (this is debt, not a defect for every site): the per-file
 * counts live in `scripts/rust-discard-baseline.json`. A file that gains a discard — or a
 * new file that appears with one — **fails** the gate until the addition is acknowledged
 * there; a file that drops below its baseline is reported `[stale]` so the baseline cannot
 * rot; a file that disappears is reported too.
 *
 * Run:
 *   node scripts/rust-discard-scan.mjs              # gate (runs clippy itself)
 *   node scripts/rust-discard-scan.mjs --json       # counts per file, for the baseline
 *   node scripts/rust-discard-scan.mjs --selftest   # pin the parser + ratchet rules
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(root, "scripts", "rust-discard-baseline.json");

/** Lint codes this gate treats as findings (everything else clippy says is none of its business). */
export const WATCHED = [
  "clippy::let_underscore_must_use",
  "clippy::await_holding_lock",
  "clippy::await_holding_refcell_ref",
];

/**
 * Fold `cargo clippy --message-format=json` output into `{ "file": n }` counts plus the
 * findings themselves. Only diagnostics whose code is in [`WATCHED`] are counted; a
 * diagnostic with no span (a crate-level message) is counted under its lint name so it
 * cannot vanish.
 */
export function findingsFromMessages(text) {
  const perFile = new Map();
  const perLint = new Map();
  const findings = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || !line.startsWith("{")) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not a JSON diagnostic (cargo progress goes to stderr anyway)
    }
    if (msg.reason !== "compiler-message") continue;
    const message = msg.message;
    const code = message?.code?.code;
    if (!code || !WATCHED.includes(code)) continue;
    const span = (message.spans ?? []).find((s) => s.is_primary) ?? message.spans?.[0];
    const file = span?.file_name ?? `<no span: ${code}>`;
    perFile.set(file, (perFile.get(file) ?? 0) + 1);
    perLint.set(code, (perLint.get(code) ?? 0) + 1);
    findings.push({
      file,
      line: span?.line_start ?? 0,
      code,
      message: (message.message ?? "").split("\n")[0],
    });
  }
  return {
    perFile: Object.fromEntries([...perFile].sort(([a], [b]) => (a < b ? -1 : 1))),
    perLint: Object.fromEntries([...perLint].sort(([a], [b]) => (a < b ? -1 : 1))),
    findings,
  };
}

/**
 * Compare counts against the baseline. Returns the problems (failures) and the stale
 * entries (informational — the baseline should be tightened).
 */
export function ratchet(counts, baseline) {
  const problems = [];
  const stale = [];
  for (const [file, n] of Object.entries(counts)) {
    const b = baseline[file];
    if (b === undefined) {
      problems.push(
        `new discarded result: ${file} (${n}) — acknowledge it in scripts/rust-discard-baseline.json, or handle the value`,
      );
    } else if (n > b) {
      problems.push(`more discards than baselined: ${file} (${n} > ${b})`);
    } else if (n < b) {
      stale.push(`${file} (baseline ${b}, now ${n})`);
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!(file in counts)) stale.push(`${file} (baseline ${baseline[file]}, now 0)`);
  }
  return { problems, stale: stale.sort() };
}

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);

/**
 * Run clippy over the workspace's production targets (`--lib --bins`: `#[cfg(test)]` code
 * and test/example targets are excluded, since discarding a temp-file cleanup result there
 * is idiomatic and not what this gate is about). The lints are requested as *warnings* so
 * the run always completes and this gate — not clippy's exit code — decides.
 */
function runClippy() {
  try {
    return execFileSync(
      "cargo",
      [
        "clippy",
        "--workspace",
        "--lib",
        "--bins",
        "--message-format=json",
        "--",
        ...WATCHED.flatMap((lint) => ["-W", lint]),
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    // A build failure still produces diagnostics on stdout; only a run that produced
    // *nothing* is a hard error (otherwise a red build would look like "0 findings").
    if (typeof e.stdout === "string" && e.stdout.includes('"reason":"compiler-message"')) {
      return e.stdout;
    }
    throw e;
  }
}

function runSelfTest() {
  let failures = 0;
  let assertions = 0;
  const check = (name, ok) => {
    assertions += 1;
    if (!ok) {
      failures += 1;
      console.error(`[rust-discard-scan] selftest FAIL: ${name}`);
    }
  };
  const diag = (code, file, line) =>
    JSON.stringify({
      reason: "compiler-message",
      message: {
        message: "non-binding `let` on an expression with `#[must_use]` type",
        level: "warning",
        code: { code },
        spans: [{ file_name: file, line_start: line, is_primary: true }],
      },
    });

  const sample = [
    '{"reason":"compiler-artifact","package_id":"x"}',
    diag("clippy::let_underscore_must_use", "crates/a/src/lib.rs", 10),
    diag("clippy::let_underscore_must_use", "crates/a/src/lib.rs", 20),
    diag("clippy::await_holding_lock", "crates/a/src/lib.rs", 30),
    diag("clippy::await_holding_refcell_ref", "crates/b/src/lib.rs", 5),
    diag("clippy::unwrap_used", "crates/a/src/lib.rs", 99),
    "not json at all",
    "",
  ].join("\n");
  const got = findingsFromMessages(sample);
  check("counts per file", JSON.stringify(got.perFile) === '{"crates/a/src/lib.rs":3,"crates/b/src/lib.rs":1}');
  check("counts per lint", got.perLint["clippy::let_underscore_must_use"] === 2);
  check("unwatched lint is ignored", !got.findings.some((f) => f.code === "clippy::unwrap_used"));
  check("line numbers are captured", got.findings[0].line === 10);
  check("non-JSON lines do not throw", got.findings.length === 4);

  const base = { "crates/a/src/lib.rs": 3 };
  check(
    "equal counts pass",
    ratchet({ "crates/a/src/lib.rs": 3 }, base).problems.length === 0,
  );
  check(
    "an increase fails",
    ratchet({ "crates/a/src/lib.rs": 4 }, base).problems[0].includes("4 > 3"),
  );
  check(
    "a new file fails",
    ratchet({ "crates/b/src/lib.rs": 1 }, base).problems[0].includes("new discarded result"),
  );
  check(
    "a decrease is stale, not a failure",
    ratchet({ "crates/a/src/lib.rs": 2 }, base).stale[0].includes("baseline 3"),
  );
  check(
    "a vanished file is stale",
    ratchet({}, base).stale[0].includes("now 0"),
  );
  check("no baseline ⇒ everything new is a problem", ratchet({ "x.rs": 1 }, {}).problems.length === 1);

  console.log(`[rust-discard-scan] selftest: ${assertions} assertion(s), ${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

function main() {
  const text = runClippy();
  const { perFile, perLint, findings } = findingsFromMessages(text);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ perFile, perLint, findings }, null, 2));
  }
  const baseline = existsSync(BASELINE)
    ? (JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {})
    : {};
  const { problems, stale } = ratchet(perFile, baseline);
  const total = Object.values(perFile).reduce((a, b) => a + b, 0);

  if (stale.length > 0) {
    console.log("[rust-discard-scan] note — baseline entries to tighten:");
    for (const s of stale) console.log(`  [stale] ${s}`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`[rust-discard-scan] ${p}`);
    console.error(
      `[rust-discard-scan] FAIL — ${problems.length} problem(s); ${total} discard(s) in production code (baseline total ${Object.values(baseline).reduce((a, b) => a + b, 0)}).`,
    );
    return 1;
  }
  console.log(
    `[rust-discard-scan] ${total} discarded must-use value(s) in production code, none above the baseline; ` +
      `await-holding-lock/refcell: ${perLint["clippy::await_holding_lock"] ?? 0}/${perLint["clippy::await_holding_refcell_ref"] ?? 0} (type-checked). OK.`,
  );
  return 0;
}

if (args.includes("--selftest")) {
  runSelfTest();
} else {
  process.exit(main());
}
