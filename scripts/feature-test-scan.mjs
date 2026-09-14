#!/usr/bin/env node
/**
 * feature-test-scan.mjs — "a test the feature gate makes invisible".
 *
 * Why: two shapes of feature-gated test escape a `cargo test --workspace` run, because the
 * module or the *item* is not compiled at all; and no gate says so, because a skipped test
 * is indistinguishable from a passing one in the output.
 *
 *   1. **REQ-A188** — a `#[cfg(feature = "…")] mod X;` declaration whose file contains
 *      runnable tests. Measured when the rule was added: **18 unit tests across 6 modules in
 *      5 crates** had never executed; nine were Android-seam ones (glue bus IMU/frame stores,
 *      the device-care reply parser, the media JNI payload caps), three the NTP resolver's
 *      offline cases, six the `audit` (pnet) env-plan/error paths.
 *   2. **REQ-A192** — a `#[test]` *item* behind a positive `#[cfg(feature = "…")]` inside a
 *      module that is *not* gated. Measured when that rule was added: **12 such items**, and
 *      two of them (`amos-tauri`'s `sherpa-asr` / `piper-tts` fallbacks) were compiled by a
 *      `cargo build` step and executed by nothing — injecting a failing assertion into one
 *      left that build step at EXIT=0, which is the defect in one line.
 *
 * The rule for both: some `cargo test` step in the Makefile must run that package with that
 * feature (transitively enabled counts — the feature graph is shared with
 * `feature-surface-scan.mjs` via `feature-graph.mjs`), or the reason must be written in
 * `scripts/feature-test-allowlist.json`, where a stale entry FAILS.
 *
 * Measured when this gate was added (2026-09-13, REQ-A188): **18 unit tests across 6
 * modules in 5 crates** had never executed. Nine were Android-seam ones (the glue bus's
 * IMU/frame stores, the device-care reply parser, the media JNI payload caps), three the
 * NTP resolver's offline cases, six the `audit` (pnet) env-plan/error paths. `make test`
 * now runs the first twelve and `make gated-check` the `audit` six; the gate is what
 * keeps that true. The proof they were really invisible: injecting a failing assertion
 * into one of them left `cargo test -p amos-tauri --lib` (the pre-fix shape of
 * `make test`) at *274 passed, 0 failed*.
 *
 * The rule: for every feature-gated `mod NAME;` declaration, if the file it resolves to
 * contains a runnable test item (`#[test]` / `#[tokio::test]`, ignoring `#[ignore]`d ones),
 * then some `cargo test` step in the Makefile must run that package **with that feature**:
 *
 *   cargo test -p <pkg> --features <pkg>/<feature>     # or a bare <feature> with -p
 *
 * Scope boundaries (honest, not silently assumed):
 *   * Inline `mod name { … }` bodies are not resolved — no feature-gated inline module
 *     carries tests today; the declaration form read here is the one the repo uses.
 *   * `#[path = "…"]` indirection is not followed, and a file-level `#![cfg(feature)]` is
 *     out of scope (neither exists today — checked).
 *   * `crates/<crate>/tests/` files are not scanned: they are separate test *targets* whose own
 *     feature gating would need a `--features` variant of the workspace run, a different
 *     (and today empty) question.
 *   * Coverage is *syntactic*: it reads the Makefile, so a test step a human deletes is
 *     reported, but a feature enabled transitively (e.g. `android` pulling in
 *     `amos-radio/android`) is not credited — the gate asks for the explicit step.
 *
 * Usage (from the repo root):
 *   node scripts/feature-test-scan.mjs              # gate
 *   node scripts/feature-test-scan.mjs --json
 *   node scripts/feature-test-scan.mjs --selftest   # pin the parser/coverage rules
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// The feature graph (features + transitive enablement) is shared with feature-surface-scan.mjs.
import { crateManifests, coveredFeatures } from "./feature-graph.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAKEFILE = join(root, "Makefile");
const ALLOWLIST = join(root, "scripts", "feature-test-allowlist.json");
const SKIP_DIRS = new Set(["target", "node_modules", ".git", "dist"]);

const rel = (p) => relative(root, p);

/** Every `.rs` file under `crates/<crate>/src` (a crate's `tests/` dirs are excluded). */
export function crateSources(dir = join(root, "crates")) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (SKIP_DIRS.has(e) || e === "tests") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".rs") && p.includes("/src/")) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}


/**
 * Feature-gated `mod NAME;` declarations in one source file, as
 * `[{ name, features: [...] }]`. Only *out-of-line* declarations (`mod x;`) are
 * reported: they name a file this gate can then read.
 *
 * The attribute stack is followed across lines (a `feature = "x"` seen in a pending
 * attribute block applies to the next `mod` item), because that is how these modules are
 * written:
 *
 *     #[cfg(feature = "android")]
 *     pub mod android;
 *
 * A blank line ends a pending block (so an attribute on some earlier item cannot leak
 * onto a later `mod`); comments between the attribute and the item do not.
 */
export function gatedModules(source) {
  const out = [];
  let features = new Set();
  let attr = null;
  for (const raw of source.split("\n")) {
    const t = raw.trim();
    if (attr !== null) {
      attr += "\n" + t;
      collectFeatures(attr, features);
      if (balanced(attr)) attr = null;
      continue;
    }
    if (t.startsWith("#[")) {
      attr = t;
      collectFeatures(attr, features);
      if (balanced(attr)) attr = null;
      continue;
    }
    if (t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) {
      if (t === "") features = new Set();
      continue;
    }
    const mod = t.match(/^(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
    if (mod && features.size > 0) out.push({ name: mod[1], features: [...features].sort() });
    features = new Set();
  }
  return out;
}

function collectFeatures(text, into) {
  for (const m of text.matchAll(/feature\s*=\s*"([^"]+)"/g)) into.add(m[1]);
}

/** An attribute is complete once its brackets close (handles multi-line `#[cfg(all(…))]`). */
function balanced(text) {
  const open = (text.match(/\[/g) ?? []).length;
  const close = (text.match(/\]/g) ?? []).length;
  return open <= close;
}

/** The file a `mod NAME;` declared in `file` resolves to, or `null`. */
export function moduleFile(file, name) {
  const dir = dirname(file);
  for (const cand of [join(dir, `${name}.rs`), join(dir, name, "mod.rs")]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * A real test *item*. Not `#[cfg(test)]` alone: four Android modules carry an empty
 * `#[cfg(test)] mod tests {}` whose body documents *why* nothing can run without a real
 * Android VM (the policy tests live in the shared `manager.rs` / `policy.rs`), and
 * `amos-radio`'s is explicitly empty — counting those would be four false positives.
 */
export const TEST_ITEM = /^[ \t]*#\[(?:tokio::)?test[\]\s(]/m;

/**
 * Whether `source` has a test item that is *meant to run* by default. An `#[ignore]`d
 * test (e.g. `amos-tts`'s Piper synthesis, which needs a downloaded model + native libs)
 * is not a silent omission — it is documented as opt-in — so a module whose tests are all
 * ignored is not a finding.
 */
export function hasRunnableTest(source) {
  const lines = source.split("\n");
  return lines.some((line, i) => {
    if (!TEST_ITEM.test(line)) return false;
    // `#[ignore]` may be written above or below the test attribute.
    return !/#\[ignore/.test(lines.slice(Math.max(0, i - 2), i + 3).join("\n"));
  });
}

/** Feature-gated modules that contain tests. One finding per (file, feature). */
export function scan() {
  const findings = [];
  const seen = new Set();
  for (const file of crateSources()) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const g of gatedModules(src)) {
      const modFile = moduleFile(file, g.name);
      if (modFile === null || !hasRunnableTest(readFileSync(modFile, "utf8"))) continue;
      const pkg = crateOf(modFile);
      if (pkg === null) continue;
      for (const feature of g.features) {
        const key = `${rel(modFile)}::${pkg}/${feature}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ file: rel(modFile), declared: rel(file), pkg, feature });
      }
    }
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** `crates/<name>/…` → `<name>`, else `null`. */
export function crateOf(abs) {
  const m = abs.match(/\/crates\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * Test items gated by a **positive** `#[cfg(feature = "…")]` in a file that is not itself a
 * feature-gated module (REQ-A192 — the boundary REQ-A188 left open). The rule above only
 * looks at feature-gated `mod X;` declarations, so a `#[cfg(feature = "x")] #[test]` inside
 * `lib.rs` was invisible to it: measured when this was added, **12 such items** existed and
 * two of them (`amos-tauri`'s `sherpa-asr` / `piper-tts` fallback tests) were compiled by a
 * `cargo build` step but executed by nothing at all.
 *
 * `#[cfg(not(feature = "x"))]` is the *opposite* gate — such a test runs in the default
 * build — so those attributes are ignored (the same care `hasRunnableTest` takes for
 * `#[ignore]`, which may sit above or below the test attribute).
 */
export function gatedTestItems(source) {
  const out = [];
  const lines = source.split("\n");
  const isAttr = (t) => t.startsWith("#[");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[(?:tokio::)?test[\]\s(]/.test(lines[i])) continue;
    const features = new Set();
    let ignored = /#\[ignore/.test(lines[i]);
    for (let j = i - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      if (!isAttr(t)) break;
      if (/#\[ignore/.test(t)) ignored = true;
      if (!/#\[cfg\(\s*not\s*\(/.test(t)) {
        for (const m of t.matchAll(/feature = "([^"]+)"/g)) features.add(m[1]);
      }
    }
    for (let j = i + 1; j < lines.length && isAttr(lines[j].trim()); j++) {
      if (/#\[ignore/.test(lines[j])) ignored = true;
    }
    if (features.size > 0 && !ignored) out.push({ line: i + 1, features: [...features].sort() });
  }
  return out;
}

/**
 * Every runnable test item behind a positive feature gate that no `cargo test` step enables
 * — one finding per (file, feature). Items inside a feature-gated *module* are skipped:
 * `scan()` above already owns those (reporting them twice would double-count one defect).
 */
export function uncoveredGatedTests(dir = join(root, "crates")) {
  const moduleFindings = scan();
  const inGatedModule = new Set(moduleFindings.map((f) => f.file));
  const makefile = readFileSync(join(root, "Makefile"), "utf8");
  // Only runs count (a `--no-run` build compiles the test but executes nothing), and the
  // enabled set is *transitive*: `amos-ai/telemetry-spy` is enabled by
  // `amos-ai/telemetry-spy-audit`, which the REQ-A188 step passes — without the graph this
  // reported that test as never run, which was simply wrong.
  const enabled = coveredFeatures(
    crateManifests(root),
    testInvocations(makefile).filter((inv) => !inv.noRun),
  );
  const owners = crateManifests(root).owners;
  const isEnabled = (pkg, feature) =>
    enabled.has(`${pkg}/${feature}`) || (owners.get(feature) ?? []).some((c) => enabled.has(`${c}/${feature}`));
  const findings = [];
  const seen = new Set();
  for (const file of crateSources(dir)) {
    const relFile = rel(file);
    if (inGatedModule.has(relFile)) continue;
    const pkg = crateOf(file);
    if (pkg === null) continue;
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const item of gatedTestItems(src)) {
      for (const feature of item.features) {
        const key = `${relFile}::${pkg}/${feature}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (isEnabled(pkg, feature)) continue;
        findings.push({ file: relFile, line: item.line, pkg, feature });
      }
    }
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}


/**
 * `cargo test` invocations in a Makefile: the recipe lines that *run* tests (a
 * `--no-run` build is not a run), with the packages and features each selects.
 * Comment lines are skipped, and `\`-continuations are joined first.
 */
export function testInvocations(makefile) {
  const out = [];
  const lines = makefile.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("#")) continue;
    if (!/\bcargo\s+test\b/.test(lines[i])) continue;
    let joined = lines[i].trim();
    while (joined.endsWith("\\") && i + 1 < lines.length && !lines[i + 1].trim().startsWith("#")) {
      joined = `${joined.slice(0, -1).trim()} ${lines[++i].trim()}`;
    }
    const args = joined.slice(joined.indexOf("cargo test") + "cargo test".length).split(/\s+/);
    const inv = {
      packages: [],
      features: [],
      workspace: false,
      allFeatures: false,
      noRun: false,
      text: joined,
    };
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (a === "-p" || a === "--package") inv.packages.push(args[++j] ?? "");
      else if (a.startsWith("--package=")) inv.packages.push(a.slice("--package=".length));
      else if (a === "--workspace" || a === "--all") inv.workspace = true;
      else if (a === "--all-features") inv.allFeatures = true;
      else if (a === "--no-run") inv.noRun = true;
      else if (a === "--features" || a === "-F") inv.features.push(...(args[++j] ?? "").split(/[,\s]+/));
      else if (a.startsWith("--features=")) {
        inv.features.push(...a.slice("--features=".length).split(/[,\s]+/));
      }
    }
    inv.features = inv.features.filter(Boolean);
    out.push(inv);
  }
  return out;
}

/**
 * Whether `inv` executes the tests of `pkg` with `feature` enabled. A bare feature name
 * counts only when the command also names the package (`-p pkg`), which is how cargo
 * scopes it; the `pkg/feature` form is unambiguous.
 */
export function covers(inv, pkg, feature) {
  if (inv.noRun) return false;
  if (!inv.workspace && !inv.packages.includes(pkg)) return false;
  if (inv.allFeatures) return true;
  return inv.features.includes(`${pkg}/${feature}`) || inv.features.includes(feature);
}

function runSelfTest() {
  const cases = [];
  const check = (name, ok) => cases.push([name, ok]);

  check(
    "a feature-gated mod is found",
    JSON.stringify(gatedModules('#[cfg(feature = "android")]\npub mod android;\n')) ===
      JSON.stringify([{ name: "android", features: ["android"] }]),
  );
  check("an ungated mod is not", gatedModules("pub mod model;\n").length === 0);
  check(
    "a blank line ends the pending attribute",
    gatedModules('#[cfg(feature = "live")]\n\npub mod model;\n').length === 0,
  );
  check(
    "a comment between attribute and item keeps it gated",
    gatedModules('#[cfg(feature = "live")]\n/// docs\npub mod http;\n')[0]?.name === "http",
  );
  check(
    "a multi-line attribute is read (features inside all(…))",
    gatedModules(
      '#[cfg(all(any(feature = "tinyalsa", feature = "aaudio"), target_os = "android"))]\n' +
        "pub mod android;\n",
    )[0]?.features.join(",") === "aaudio,tinyalsa",
  );
  check(
    "a feature-carrying `pub use` does not leak onto a later mod",
    gatedModules('#[cfg(feature = "live")]\npub use http::X;\npub mod model;\n').length === 0,
  );

  const mk = [
    "test:",
    "\tcargo test --workspace",
    "\tcargo test -p amos-appstore -p amos-appstore-cli --features live",
    "\tcargo test -p amos-tauri -p amos-media --features amos-tauri/android,amos-media/android --lib",
    "\t# cargo test -p commented --features nope/nope",
  ].join("\n");
  const inv = testInvocations(mk);
  check("one invocation per `cargo test` line (not the comment)", inv.length === 3);
  const bare = inv.find((i) => i.features.includes("live"));
  check("bare feature + -p covers it", bare !== undefined && covers(bare, "amos-appstore", "live"));
  check(
    "bare feature does NOT cover another package",
    bare !== undefined && !covers(bare, "amos-tauri", "live"),
  );
  const paired = inv.find((i) => i.features.includes("amos-tauri/android"));
  check("pkg/feature covers that package", paired !== undefined && covers(paired, "amos-tauri", "android"));
  check(
    "pkg/feature does not cover a package not named",
    paired !== undefined && !covers(paired, "amos-radio", "android"),
  );
  check(
    "--no-run is not a run",
    !covers({ packages: ["x"], features: ["x/f"], workspace: false, allFeatures: false, noRun: true }, "x", "f"),
  );
  check(
    "--workspace --features pkg/f covers it",
    covers({ packages: [], features: ["x/f"], workspace: true, allFeatures: false, noRun: false }, "x", "f"),
  );

  check("a test item is found", TEST_ITEM.test("fn a() {}\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn t() {}\n}\n"));
  check("an empty test module is not a test", !TEST_ITEM.test("#[cfg(test)]\nmod tests {}\n"));
  check("a non-test cfg attribute is not", !TEST_ITEM.test('#[cfg(feature = "android")]\n'));
  check(
    "an `#[ignore]`d test is not a runnable test",
    !hasRunnableTest('    #[tokio::test]\n    #[ignore = "needs a model"]\n    async fn t() {}\n'),
  );
  check(
    "a runnable test next to an ignored one still counts",
    hasRunnableTest('    #[test]\n    fn a() {}\n    #[tokio::test]\n    #[ignore]\n    async fn b() {}\n'),
  );
  check("the crate is read from the path", crateOf("/repo/crates/amos-media/src/android.rs") === "amos-media");

  const gated = [
    '#[cfg(feature = "live")]',
    "#[tokio::test]",
    "async fn a() {}",
    "",
    "#[cfg(feature = \"live\")]",
    "#[test]",
    '#[ignore = "needs a peer"]',
    "fn b() {}",
    "",
    "#[cfg(not(feature = \"terminal-pty\"))]",
    "#[test]",
    "fn c() {}",
    "",
    "#[test]",
    "fn plain() {}",
  ].join("\n");
  const items = gatedTestItems(gated);
  check(
    "a positive feature gate on a test is a finding (REQ-A192)",
    items.length === 1 && items[0].features.join(",") === "live" && items[0].line === 2,
  );
  check(
    "`#[ignore]` below the test attribute exempts it",
    !items.some((i) => i.features.includes("live") && i.line > 2),
  );
  check(
    "`not(feature = …)` is the opposite gate and never counts",
    !items.some((i) => i.features.includes("terminal-pty")),
  );
  check("an ungated test is not a finding", !items.some((i) => i.line === 14));

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[feature-test-scan] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[feature-test-scan] selftest OK — ${cases.length} parser/coverage case(s).`);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const makefile = readFileSync(MAKEFILE, "utf8");
const invocations = testInvocations(makefile);
const findings = scan();
const allowFile = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, "utf8")) : {};
const allow = allowFile.entries ?? {};
const allowGated = allowFile.gatedTests ?? {};

const uncovered = [];
for (const f of findings) {
  if (f.file in allow) continue;
  if (invocations.some((inv) => covers(inv, f.pkg, f.feature))) continue;
  uncovered.push(f);
}
const gatedFindings = uncoveredGatedTests();
const gatedUncovered = gatedFindings.filter((f) => !(`${f.pkg}/${f.feature}` in allowGated));
const stale = [
  ...Object.keys(allow).filter((file) => !findings.some((f) => f.file === file)),
  ...Object.keys(allowGated).filter(
    (k) => !gatedFindings.some((f) => `${f.pkg}/${f.feature}` === k),
  ),
];

if (args.includes("--json")) {
  console.log(
    JSON.stringify({ findings, uncovered, gatedFindings, gatedUncovered, stale }, null, 2),
  );
  process.exit(uncovered.length === 0 && gatedUncovered.length === 0 && stale.length === 0 ? 0 : 1);
}

for (const f of uncovered) {
  console.log(
    `  never run: ${f.file} (declared in ${f.declared}) — add a step: ` +
      `cargo test -p ${f.pkg} --features ${f.pkg}/${f.feature}`,
  );
}
for (const f of gatedUncovered) {
  console.log(
    `  never run: ${f.file}:${f.line} — a \`#[test]\` behind \`#[cfg(feature = "${f.feature}")]\`; ` +
      `add a step: cargo test -p ${f.pkg} --features ${f.pkg}/${f.feature}`,
  );
}
for (const file of stale) console.log(`  stale allow-list entry: ${file} (no longer a finding)`);
if (uncovered.length > 0 || gatedUncovered.length > 0 || stale.length > 0) {
  console.log(
    `[feature-test-scan] FAIL — ${uncovered.length} feature-gated module(s) and ` +
      `${gatedUncovered.length} feature-gated test item(s) are run by no \`cargo test\` step, ` +
      `${stale.length} stale allow-list entry(ies). A test behind a feature that ` +
      "`cargo test --workspace` does not enable is dead weight: fix the Makefile, or record " +
      "the reason in scripts/feature-test-allowlist.json.",
  );
  process.exit(1);
}
console.log(
  `[feature-test-scan] OK — ${findings.length} feature-gated module(s) with tests and ` +
    `${gatedFindings.length} feature-gated test item(s), all run by a \`cargo test\` step ` +
    `(${invocations.length} test invocation(s) read from the Makefile).`,
);

