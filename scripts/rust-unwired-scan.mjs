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
 * Gated as a **ratchet** (`scripts/rust-unwired-baseline.json`): the existing
 * backlog is frozen, a **new** unwired `pub fn` fails the gate, and a baseline
 * entry that became wired is reported so the ratchet cannot rot. The backlog is
 * explained by kind in `docs/rust-unwired-audit.md`.
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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crates = join(root, "crates");

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
let baseline = { values: [] };
if (existsSync(baselinePath)) baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const baseValues = new Set(baseline.values ?? []);
const key = (f) => `${f.path}::${f.name}`;
const newFindings = findings.filter((f) => !baseValues.has(key(f)));
const fixedValues = [...baseValues].filter((k) => !findings.some((f) => key(f) === k));

if (process.argv.includes("--update-baseline")) {
  const next = { values: findings.map(key).sort() };
  const fs = await import("node:fs");
  fs.writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
  console.log(`[rust-unwired-scan] baseline updated: ${next.values.length} entry(ies).`);
  process.exit(0);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ scanned: files.length, findings, newFindings, fixedValues }, null, 2));
} else {
  console.log(
    `[rust-unwired-scan] ${files.length} .rs file(s) scanned; ` +
      `${findings.length} unwired \`pub fn\` (${newFindings.length} new, baseline ${baseValues.size}).`,
  );
  if (fixedValues.length > 0) {
    console.log(
      `[rust-unwired-scan] baseline: ${fixedValues.length} entry(ies) now wired — shrink with --update-baseline.`,
    );
  }
  for (const f of newFindings) {
    console.error(
      `[rust-unwired-scan] FAIL — ${key(f)} (${f.testRefs > 0 ? "test-only" : "referenced nowhere"})`,
    );
  }
  if (newFindings.length > 0) {
    console.error(
      "\nFix by wiring the function into production, deleting it, or (if it is deliberate\n" +
        "library/FFI surface) recording it in scripts/rust-unwired-baseline.json via\n" +
        "`--update-baseline` with its reason in docs/rust-unwired-audit.md.",
    );
  }
}

process.exit(newFindings.length === 0 ? 0 : 1);

