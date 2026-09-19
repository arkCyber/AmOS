#!/usr/bin/env node
/**
 * unsafe-scan.mjs — "production `unsafe` without a written justification".
 *
 * Why: this repo already gates **panics** (`rust-panic-scan.mjs`) and *documented*
 * its aerospace posture elsewhere, but the sharper reliability question had no gate:
 * the `unsafe` surface (FFI/JNI glue, `unsafe impl Send/Sync`, raw-pointer callbacks).
 * `unsafe` blocks are exactly where "the compiler stopped checking" — a reviewer needs
 * the invariant in writing, at the site, not in the author's head. A first pass found
 * **27 sites** with no `SAFETY:` note at all.
 *
 * Two rules, matching the Rust convention:
 *   1. **Documentation** — every production `unsafe` occurrence (`unsafe {`, `unsafe
 *      fn`, `unsafe impl`, `unsafe extern "C" fn`) must carry a `// SAFETY:` comment or
 *      a `# Safety` doc section. The note may sit above the enclosing statement (e.g.
 *      above the `let x = {` the block is nested in) and may be several lines long;
 *      the scan walks up to the statement boundary (a non-comment line ending in `;`
 *      or `}`), which is where a human would attach it.
 *   2. **Ratchet** — the per-file count of `unsafe` sites lives in
 *      `scripts/unsafe-baseline.json`. A file gaining a site (or a new file appearing)
 *      fails: the addition must be acknowledged in the baseline, so the `unsafe`
 *      surface can only grow deliberately. Counts going *down* **fail** as stale entries
 *      (REQ-A447: tighten the baseline — a note was not enough), and the file's own
 *      `total` is checked against the sum of its entries instead of being trusted.
 *
 * Test code is out of scope: `tests/**` and everything from the first `#[cfg(test)]`
 * in a file (that is where raw-pointer helpers and `unsafe` test fixtures live).
 *
 * Usage (from the repo root):
 *   node scripts/unsafe-scan.mjs              # gate
 *   node scripts/unsafe-scan.mjs --json
 *   node scripts/unsafe-scan.mjs --selftest   # pin the classifier/note-detector
 */
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(root, "scripts", "unsafe-baseline.json");
const SKIP_DIRS = new Set(["target", "node_modules", ".git", "dist"]);

/** Rust sources under `crates/**\/src` (test directories excluded). */
export function productionSources(dir = join(root, "crates")) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (SKIP_DIRS.has(e) || e === "tests") continue;
      const p = join(d, e);
      // `statSync` **follows symlinks**, so a dangling one throws ENOENT. That is a real
      // state here: a device build creates `crates/amos-tauri/gen/android/.../jniLibs/
      // libamos_tauri_lib.so` as a link into `target/<triple>/debug/`, and any later
      // `cargo clean` (or a fresh clone with a half-written android build) leaves it
      // pointing at nothing. A gate must *report*, never crash: an entry we cannot stat
      // is not a Rust source, so it is skipped. (Found by exactly that: `make lint` died
      // with a Node stack trace instead of a finding.)
      let stat;
      try {
        stat = statSync(p);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(p);
      else if (p.endsWith(".rs") && p.includes("/src/")) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** Lines that open an `unsafe` construct (excluding comments). */
export function unsafeSites(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    // Skip line comments, block-comment continuations and block-comment openers.
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return;
    if (!/\bunsafe\b/.test(t)) return;
    // A function-pointer *type alias* (`type Cb = unsafe extern "C" fn(…)`) declares a
    // type; it performs no unsafe operation and needs no safety note.
    if (/\btype\b/.test(t) && t.indexOf("type") < t.indexOf("unsafe")) return;
    if (/\bunsafe\s+impl\b/.test(t)) out.push(i);
    // `unsafe fn`, `unsafe extern "C" fn`, `unsafe extern "system" fn cb(...)`.
    else if (/\bunsafe\b[^;{]*\bfn\b/.test(t)) out.push(i);
    else if (/\bunsafe\s*\{/.test(t)) out.push(i);
  });
  return out;
}

/** The comment/statement block a note would be attached to, walking up from `i`. */
export function noteBlock(lines, i) {
  let k = i;
  while (k > 0) {
    const prev = lines[k - 1].trim();
    // Transparent: comments, blanks, and attribute lines — `/// # Safety` … `#[no_mangle]`
    // … `unsafe extern "C" fn` is the canonical JNI shape.
    const transparent =
      prev.startsWith("//") || prev === "" || prev.startsWith("#[") || prev.startsWith("#![");
    if (!transparent && !prev.endsWith("{") && !prev.endsWith("(") && !prev.endsWith(",")) break;
    if (!transparent && /[;}]$/.test(prev)) break;
    k--;
  }
  return lines.slice(k, i + 1).join("\n");
}

/** True when the site carries a `// SAFETY:` note or a `# Safety` doc section. */
export function documented(lines, i) {
  return /SAFETY:|#\s*Safety/.test(noteBlock(lines, i));
}

/** Cut a file at its first `#[cfg(test)]` (production-only view). */
export function productionLines(text) {
  const lines = text.split("\n");
  const cut = lines.findIndex((l) => l.trim().startsWith("#[cfg(test)]"));
  return cut === -1 ? lines : lines.slice(0, cut);
}

export function scan() {
  const counts = {};
  const undocumented = [];
  for (const abs of productionSources()) {
    const rel = abs.replace(root + "/", "");
    const lines = productionLines(readFileSync(abs, "utf8"));
    const sites = unsafeSites(lines);
    if (sites.length === 0) continue;
    counts[rel] = sites.length;
    for (const i of sites) {
      if (!documented(lines, i)) undocumented.push(`${rel}:${i + 1}`);
    }
  }
  return { counts, undocumented };
}

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);

// An unrecognised flag is a failure, not a no-op (measured 2026-09-19: `docs/POWER_OF_10.md`
// spelled this gate's selftest `--self-test`, which it does not implement, so the documented
// "verification" line silently ran the gate instead — see `rust-recursion-scan.mjs`).
const KNOWN_FLAGS = new Set(["--selftest", "--json"]);
const unknownFlags = args.filter((f) => f.startsWith("-") && !KNOWN_FLAGS.has(f));
if (unknownFlags.length > 0) {
  console.error(
    `[unsafe-scan] unknown flag(s): ${unknownFlags.join(", ")} — known: ${[...KNOWN_FLAGS].join(", ")}`,
  );
  process.exit(2);
}

function runSelfTest() {
  const cases = [];
  const src = [
    "fn a() {",
    "    // SAFETY: pointer comes from the caller and is checked.",
    "    unsafe { deref(p) }",
    "}",
  ].join("\n");
  const lines = productionLines(src);
  cases.push(["block site found", unsafeSites(lines).length === 1]);
  cases.push(["documented block", documented(lines, unsafeSites(lines)[0])]);

  const doc = [
    "/// Does a thing.",
    "///",
    "/// # Safety",
    "/// `p` must be valid.",
    "unsafe fn f(p: *const u8) {}",
  ].join("\n");
  const dl = productionLines(doc);
  cases.push(["unsafe fn found", unsafeSites(dl).length === 1]);
  cases.push(["'# Safety' doc section counts", documented(dl, unsafeSites(dl)[0])]);

  const above = [
    "// SAFETY: the block below reads a live Box; see the constructor.",
    "let x = {",
    "    unsafe { *ptr }",
    "};",
  ].join("\n");
  const al = productionLines(above);
  cases.push(["note above an enclosing `let = {`", documented(al, unsafeSites(al)[0])]);

  const bare = ["fn b() {", "    let v = unsafe { ffi() };", "}"].join("\n");
  const bl = productionLines(bare);
  cases.push(["bare unsafe is flagged", !documented(bl, unsafeSites(bl)[0])]);

  const impl = ["// SAFETY: JNI global ref; see the module docs.", "unsafe impl Send for C {}"].join(
    "\n",
  );
  const il = productionLines(impl);
  cases.push(["unsafe impl found", unsafeSites(il).length === 1]);

  const both = ["// SAFETY: x", "unsafe { a() }", "unsafe { b() }"].join("\n");
  const tl = productionLines(both);
  cases.push(["two sites counted", unsafeSites(tl).length === 2]);
  cases.push([
    "a note covers only its own statement",
    documented(tl, unsafeSites(tl)[0]) && !documented(tl, unsafeSites(tl)[1]),
  ]);

  const testCut = ["unsafe { prod() }", "#[cfg(test)]", "mod tests { unsafe { t() } }"].join("\n");
  const cl = productionLines(testCut);
  cases.push(["test code is cut", unsafeSites(cl).length === 1]);

  const commented = ["// unsafe { not_code() }", "/* unsafe { also_not() } */"].join("\n");
  cases.push(["comments are not sites", unsafeSites(productionLines(commented)).length === 0]);

  const extern = ['unsafe extern "C" fn cb() {}'].join("\n");
  cases.push(["unsafe extern fn found", unsafeSites(productionLines(extern)).length === 1]);

  // A **dangling symlink** under a walked directory must be skipped, not fatal: a device
  // build leaves `jniLibs/libamos_tauri_lib.so` pointing into `target/<triple>/`, and a
  // later `cargo clean` makes it dangle — the unguarded walk died here with ENOENT and
  // CI reported a Node stack trace instead of a finding (the real failure that added this).
  const tmp = mkdtempSync(join(tmpdir(), "amos-unsafe-scan-"));
  try {
    mkdirSync(join(tmp, "crate", "src"), { recursive: true });
    writeFileSync(join(tmp, "crate", "src", "real.rs"), "fn f() {}\n");
    symlinkSync(join(tmp, "gone", "lib.so"), join(tmp, "crate", "src", "dangling.so"));
    let survivors;
    try {
      survivors = productionSources(tmp);
    } catch {
      survivors = null; // the regression: the walk threw instead of skipping
    }
    cases.push([
      "a dangling symlink is skipped, not fatal",
      survivors !== null && survivors.length === 1 && survivors[0].endsWith("real.rs"),
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // REQ-A447 — the baseline's own headline number is checked, not trusted.
  cases.push([
    "a `total` that drifted from the sum is a problem",
    totalProblems(233, 232).length === 1,
  ]);
  cases.push(["an agreeing `total` is not a problem", totalProblems(233, 233).length === 0]);
  cases.push([
    "a baseline without a `total` is not a problem (nothing to contradict)",
    totalProblems(undefined, 233).length === 0,
  ]);

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[unsafe-scan] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[unsafe-scan] selftest OK — ${cases.length} classifier/note case(s).`);
}

if (args.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const { counts, undocumented } = scan();
const baselineDoc = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, "utf8"))
  : {};
const baseline = baselineDoc.files ?? {};
const problems = [];
for (const [f, n] of Object.entries(counts)) {
  const b = baseline[f];
  if (b === undefined) problems.push(`new unsafe surface: ${f} (${n} site(s)) — acknowledge it in scripts/unsafe-baseline.json`);
  else if (n > b) problems.push(`more unsafe than baselined: ${f} (${n} > ${b})`);
}
const stale = Object.entries(baseline)
  .filter(([f, b]) => (counts[f] ?? 0) < b)
  .map(([f, b]) => `${f} (baseline ${b}, now ${counts[f] ?? 0})`);

const total = Object.values(counts).reduce((a, b) => a + b, 0);
// The file's own headline number is **checked, not trusted** (REQ-A447): a `total` that has drifted
// from the sum of `files` is a number nobody re-measures — the F-DEV-031 shape, sitting in the
// artefact a reviewer reads first. Pulled out as a pure function so the selftest can pin it.
export function totalProblems(declaredTotal, total) {
  return typeof declaredTotal === "number" && declaredTotal !== total
    ? [
        `scripts/unsafe-baseline.json declares total ${declaredTotal}, but the per-file counts sum to ${total}`,
      ]
    : [];
}
const declaredTotal = baselineDoc.total;
const totalProblemsFound = totalProblems(declaredTotal, total);
if (args.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        total,
        declaredTotal,
        files: counts,
        undocumented,
        problems,
        stale,
        totalProblems: totalProblemsFound,
      },
      null,
      2,
    ),
  );
  process.exit(
    problems.length + undocumented.length + stale.length + totalProblemsFound.length === 0 ? 0 : 1,
  );
}
for (const u of undocumented) console.log(`  undocumented: ${u}`);
if (undocumented.length > 0) {
  console.log(
    `[unsafe-scan] FAIL — ${undocumented.length} production unsafe site(s) have no \`// SAFETY:\` note or \`# Safety\` section.`,
  );
}
if (problems.length > 0) {
  console.log(`[unsafe-scan] FAIL — ${problems.length} ratchet violation(s):`);
  for (const p of problems) console.log("  " + p);
}
if (stale.length > 0) {
  // A note was not enough (REQ-A447): the ratchet must **shrink**, so an entry the measurement has
  // fallen below fails until it is tightened — one rule, the same one `rust-macro-scan` (R2,
  // REQ-A442), `rust-unwired-scan` (R2, REQ-A445), `unwired-script-scan` and `feature-surface-scan`
  // already enforce.
  console.log(`[unsafe-scan] FAIL — ${stale.length} stale baseline entr(ies); tighten them:`);
  for (const s of stale) console.log("  " + s);
}
for (const p of totalProblemsFound) console.log(`[unsafe-scan] FAIL — ${p}`);
const clean =
  undocumented.length + problems.length + stale.length + totalProblemsFound.length === 0;
if (clean) {
  console.log(
    `[unsafe-scan] OK — ${total} production unsafe site(s) across ${Object.keys(counts).length} file(s), all documented, none above the baseline, and \`total\` agrees with the per-file sum.`,
  );
}
process.exit(clean ? 0 : 1);

