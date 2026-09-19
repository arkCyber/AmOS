#!/usr/bin/env node
/**
 * rust-unwired-scan.mjs — static "`pub fn` defined but never referenced" scan.
 *
 * Why: the frontend has `unwired-scan.mjs`, the Rust workspace had nothing. A
 * `pub` item in a **library** crate is treated as reachable by the compiler, so
 * `dead_code`/clippy never fire on it even when the whole workspace has no caller.
 * That is exactly how `SessionManager::get_or_create` — documented as "key a
 * conversation by the client-supplied `session_id` so history persists across
 * calls" — sat unused while `server.rs` minted a throwaway session per turn (a
 * real defect, Round 33). This scan is the Rust counterpart of that gate.
 *
 * Scope (deliberately narrow, to stay high-signal):
 *   • **`pub fn` only** (incl. `async` / `unsafe` / `extern "C"`). `pub(crate)` /
 *     `pub(super)` / private items are **not** scanned — `dead_code` already warns
 *     for those, so the additive value here is the crate-external surface.
 *   • Declarations come from `crates/**\/src/**\/*.rs`; a declaration whose name
 *     occurs nowhere else in `crates/**\/*.rs` is a finding.
 *   • Test usage is reported, not hidden: `test-only` means only `crates/**\/tests/`
 *     (or a `#[cfg(test)]` block) mentions it.
 *
 * Gated as a **ratchet** (`scripts/rust-unwired-baseline.json`): the existing backlog is frozen
 * with a `kind` **and a reason per entry** (`why`), a **new** unwired `pub fn` fails the gate, and
 * the baseline is itself checked (REQ-A445):
 *   R1 `missing-reason`  — an entry whose `why` is absent, too short, or a placeholder;
 *   R2 `stale-entry`     — an entry whose symbol is referenced now (the ratchet must shrink, not
 *                          rot; this used to be a printed note and nothing forced a shrink);
 *   R3 `duplicate-entry` — the same `value` twice.
 *
 * Until REQ-A445 the file was a bare `{ "values": [...] }` list: the reasons existed only as prose
 * in `docs/rust-unwired-audit.md`, nothing required a new entry to have one, and `--update-baseline`
 * rewrote the whole file — so a finding could be excused with no reason recorded anywhere, which is
 * precisely what that document claimed could not happen. The writer now keeps every reason it is
 * given and marks a new entry `UNREVIEWED`, which R1 refuses (the same contract as
 * `rust-macro-scan.mjs`, which has no writer at all).
 *
 * Known boundary: an item reached only from **outside the workspace** (FFI /
 * `#[no_mangle]`, a proc-macro consumer) or only through a **macro-generated**
 * expansion can look unwired here — such an item belongs in the baseline with its
 * reason recorded, not deleted.
 *
 * Usage (repo root):
 *   node scripts/rust-unwired-scan.mjs                 # gate
 *   node scripts/rust-unwired-scan.mjs --json          # machine-readable
 *   node scripts/rust-unwired-scan.mjs --selftest      # pin the extractor
 *   node scripts/rust-unwired-scan.mjs --update-baseline
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crates = join(root, "crates");

// An unrecognised flag is a failure, not a no-op — see `rust-recursion-scan.mjs` for the
// measurement that made this a rule across the `-scan` family (REQ-A443).
const KNOWN_FLAGS = new Set(["--selftest", "--json", "--update-baseline"]);
const unknownFlags = process.argv
  .slice(2)
  .filter((f) => f.startsWith("-") && !KNOWN_FLAGS.has(f));
if (unknownFlags.length > 0) {
  console.error(
    `[rust-unwired-scan] unknown flag(s): ${unknownFlags.join(", ")} — known: ${[...KNOWN_FLAGS].join(", ")}`,
  );
  process.exit(2);
}

const SKIP = new Set(["node_modules", "target", ".git", "gen"]);
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (p.endsWith(".rs")) acc.push(p);
  }
  return acc;
}

/**
 * `pub fn` / `pub async fn` / `pub unsafe fn` — deliberately **not**
 * `pub extern "C" fn` / JNI `Java_*` / `#[no_mangle]`, which are **entry points
 * called from outside Rust** (the JVM, the OS) and have no in-workspace caller by
 * design. `pub(crate)` is excluded too: `dead_code` already covers it.
 */
const DECL_RE = /^[ \t]*pub\s+(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][\w]*)/gm;

/** Declarations in `src`, ignoring FFI entry points and test-only sources. */
export function extractDecls(src) {
  const out = [];
  for (const m of src.matchAll(DECL_RE)) {
    const name = m[1];
    if (name.startsWith("Java_")) continue;
    // Walk back over the attribute lines *immediately* preceding this one. A fixed
    // character window is wrong: it can reach an unrelated item above and skip a
    // function that only *looks* annotated (caught by --selftest).
    const before = src.slice(0, m.index).split("\n");
    let j = before.length - 2; // -1 is the (empty) tail of the decl line's newline
    let attrs = "";
    while (j >= 0 && /^\s*#/.test(before[j])) attrs += before[j--] + "\n";
    if (/#\[(no_mangle|export_name)/.test(attrs)) continue;
    out.push(name);
  }
  return out;
}

export function countName(name, src) {
  return (src.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
}

export function isTestPath(rel) {
  return rel.includes("/tests/") || rel.includes("/benches/");
}

// --- the ratchet's own rules (REQ-A445) --------------------------------------
/**
 * The reason floor. A `why` shorter than this, or one of the placeholder shapes a hurried author
 * writes, is not a recorded decision — and a baseline entry *is* a decision to leave a `pub fn`
 * unwired, which is the one thing a reader cannot re-derive from the code.
 */
const WHY_FLOOR = 40;
const WHY_PLACEHOLDERS = [
  /^\s*$/,
  /^todo/i,
  /^tbd/i,
  /^n\/?a$/i,
  /^<.*>$/i,
  /^why\??$/i,
  /^fill/i,
  /^unused$/i,
];

export function reasonIsReal(why) {
  return (
    typeof why === "string" &&
    why.trim().length >= WHY_FLOOR &&
    !WHY_PLACEHOLDERS.some((re) => re.test(why.trim()))
  );
}

/**
 * Every problem with the baseline *itself* — the checks this gate was missing (REQ-A445), which
 * `rust-macro-scan.mjs` has had since REQ-A442:
 *
 *   R1 `missing-reason`  — an entry with no real `why`;
 *   R2 `stale-entry`     — an entry whose symbol is referenced somewhere now. This used to be a
 *                          printed note; a ratchet that is never shrunk is a ratchet nobody
 *                          reads, so it fails (the same rule as the macro whitelist's R2);
 *   R3 `duplicate-entry` — the same `value` listed twice.
 *
 * The legacy `{ "values": [...] }` shape is read as *reasonless* entries rather than crashing
 * (`entriesOf`): an older baseline keeps ratcheting, it just fails R1 until the reasons are
 * written down — which is the honest reading of a bare list.
 */
export function baselineProblems(entries, findings) {
  const problems = [];
  const seen = new Set();
  const unwiredNow = new Set(findings.map((f) => `${f.path}::${f.name}`));
  for (const e of entries) {
    if (seen.has(e.value)) problems.push({ rule: "duplicate-entry", detail: e.value });
    seen.add(e.value);
    if (!reasonIsReal(e.why)) {
      problems.push({
        rule: "missing-reason",
        detail: `${e.value} — ${e.why === undefined ? "no `why`" : `the \`why\` is a placeholder ("${e.why}")`}`,
      });
    }
    if (!unwiredNow.has(e.value)) {
      problems.push({
        rule: "stale-entry",
        detail: `${e.value} — no longer unwired; remove it from the baseline`,
      });
    }
  }
  return problems;
}

/** Shape-tolerant reader: `{entries:[{value,why,kind}]}` (current) or the legacy `{values:[…]}`. */
export function entriesOf(baseline) {
  if (Array.isArray(baseline?.entries)) {
    return baseline.entries.map((e) => ({ value: e.value, why: e.why, kind: e.kind }));
  }
  return (baseline?.values ?? []).map((value) => ({ value, why: undefined, kind: undefined }));
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const src = [
    "pub fn plain() {}",
    "pub async fn asynchronous() {}",
    "pub unsafe fn un() {}",
    'pub extern "C" fn ffi() {}',
    "pub fn Java_com_example_Glue_attach() {}",
    "#[no_mangle]\npub fn mangled() {}",
    "pub(crate) fn crate_visible() {}",
    "    pub fn indented() {}",
  ].join("\n");
  const names = extractDecls(src);
  ok("extracts pub fn", names.includes("plain"));
  ok("extracts pub async fn", names.includes("asynchronous"));
  ok("extracts pub unsafe fn", names.includes("un"));
  ok("extracts indented pub fn", names.includes("indented"));
  ok("ignores pub(crate) fn", !names.includes("crate_visible"));
  ok("ignores extern-ABI fn (FFI entry point)", !names.includes("ffi"));
  ok("ignores JNI Java_* fn", !names.includes("Java_com_example_Glue_attach"));
  ok("ignores #[no_mangle] fn", !names.includes("mangled"));

  ok("countName counts word occurrences", countName("foo", "foo(foo)") === 2);
  ok("countName ignores substrings", countName("foo", "foobar") === 0);
  ok("isTestPath detects tests dir", isTestPath("crates/a/tests/x.rs"));
  ok("isTestPath rejects src", !isTestPath("crates/a/src/x.rs"));

  // The ratchet's own rules (REQ-A445) — the half this gate was missing.
  const goodReason =
    "fluent constructor for library consumers; in-workspace callers build the struct directly, so it is unused today";
  ok("R1 accepts a real reason", reasonIsReal(goodReason));
  ok("R1 rejects a missing reason", !reasonIsReal(undefined));
  ok("R1 rejects a placeholder reason", !reasonIsReal("TODO"));
  ok("R1 rejects a too-short reason", !reasonIsReal("unused"));
  const live = [{ path: "crates/a/src/x.rs", name: "unwired" }];
  ok(
    "R1 flags a reasonless entry",
    baselineProblems([{ value: "crates/a/src/x.rs::unwired" }], live).some(
      (p) => p.rule === "missing-reason",
    ),
  );
  ok(
    "R2 flags an entry that is wired now",
    baselineProblems([{ value: "crates/a/src/x.rs::gone", why: goodReason }], live).some(
      (p) => p.rule === "stale-entry",
    ),
  );
  ok(
    "R3 flags a duplicated entry",
    baselineProblems(
      [
        { value: "crates/a/src/x.rs::unwired", why: goodReason },
        { value: "crates/a/src/x.rs::unwired", why: goodReason },
      ],
      live,
    ).some((p) => p.rule === "duplicate-entry"),
  );
  ok(
    "a complete, live entry is not a problem",
    baselineProblems([{ value: "crates/a/src/x.rs::unwired", why: goodReason }], live).length === 0,
  );
  ok(
    "the legacy `values` shape reads as reasonless, not as a crash",
    entriesOf({ values: ["crates/a/src/x.rs::unwired"] })[0].why === undefined,
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[rust-unwired-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[rust-unwired-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
if (process.argv.includes("--selftest")) runSelftest();

// --- scan -------------------------------------------------------------------
const files = walk(crates);
const rel = (f) => relative(root, f);
const sources = files.map((f) => [f, readFileSync(f, "utf8")]);

const findings = [];
for (const [file, src] of sources) {
  const r = rel(file);
  if (isTestPath(r)) continue; // declarations only from production sources
  for (const name of extractDecls(src)) {
    let refs = 0;
    let testRefs = 0;
    for (const [other, otherSrc] of sources) {
      const n = countName(name, otherSrc);
      if (n === 0) continue;
      if (other === file) refs += Math.max(0, n - 1); // discount the declaration
      else if (isTestPath(rel(other))) {
        refs += n;
        testRefs += n;
      } else {
        refs += n;
      }
    }
    // Zero references *anywhere* (production or `tests/`) — an integration test
    // exercising a public API is real usage, so `testRefs > 0` is never a finding
    // on its own; it is reported as context.
    if (refs === 0) findings.push({ path: r, name, testRefs });
  }
}
findings.sort((a, b) => (a.path === b.path ? a.name.localeCompare(b.name) : a.path.localeCompare(b.path)));

const baselinePath = join(root, "scripts", "rust-unwired-baseline.json");
let baseline = { entries: [] };
if (existsSync(baselinePath)) baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const entries = entriesOf(baseline);
const baseValues = new Set(entries.map((e) => e.value));
const key = (f) => `${f.path}::${f.name}`;
const newFindings = findings.filter((f) => !baseValues.has(key(f)));
// The ratchet checks itself: a reasonless entry, an entry that is wired now, or a duplicate is a
// problem with the *baseline*, not with the code (REQ-A445).
const ratchetProblems = baselineProblems(entries, findings);

if (process.argv.includes("--update-baseline")) {
  // The writer keeps every reason it is given and marks a new entry `UNREVIEWED` with a
  // placeholder that R1 refuses — so `--update-baseline` cannot silently turn a new unwired
  // `pub fn` into an excused one. (This is the mistake `rust-macro-scan.mjs` avoids by having no
  // writer at all and `rust-recursion-scan.mjs` avoids by emitting a `reason` field to fill in.)
  const known = new Map(entries.map((e) => [e.value, e]));
  const next = {
    policy: baseline.policy ?? "",
    captured: new Date().toISOString().slice(0, 10),
    entries: findings
      .map(key)
      .sort()
      .map((value) => {
        const prev = known.get(value);
        return prev
          ? { value, kind: prev.kind ?? "unreviewed", why: prev.why }
          : {
              value,
              kind: "UNREVIEWED",
              why: "<why this is deliberate — fill this in, and add it to docs/rust-unwired-audit.md>",
            };
      }),
  };
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
  const unreviewed = next.entries.filter((e) => !reasonIsReal(e.why)).length;
  console.log(
    `[rust-unwired-scan] baseline written: ${next.entries.length} entry(ies), ${unreviewed} WITHOUT a real reason ` +
      "(R1 fails until each one is written down — an entry is a decision, not a default).",
  );
  process.exit(0);
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { scanned: files.length, findings, newFindings, ratchetProblems, entries },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[rust-unwired-scan] ${files.length} .rs file(s) scanned; ` +
      `${findings.length} unwired \`pub fn\` (${newFindings.length} new, baseline ${baseValues.size}).`,
  );
  for (const f of newFindings) {
    console.error(
      `[rust-unwired-scan] FAIL — ${key(f)} (${f.testRefs > 0 ? "test-only" : "referenced nowhere"})`,
    );
  }
  for (const p of ratchetProblems) {
    console.error(`[rust-unwired-scan] ${p.rule}: ${p.detail}`);
  }
  if (newFindings.length > 0 || ratchetProblems.length > 0) {
    console.error(
      "\nFix by wiring the function into production, deleting it, or (if it is deliberate\n" +
        "library/FFI surface) recording it in scripts/rust-unwired-baseline.json via\n" +
        "`--update-baseline` **with a real `why`**, and adding its kind to\n" +
        "docs/rust-unwired-audit.md. An entry that is wired now must be removed (R2).",
    );
  }
}

process.exit(newFindings.length === 0 && ratchetProblems.length === 0 ? 0 : 1);

