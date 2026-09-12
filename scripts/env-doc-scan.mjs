#!/usr/bin/env node
/**
 * env-doc-scan.mjs — every `AMOS_*` env var named in the **current docs** must
 * exist somewhere in the code.
 *
 * Why: `docs/life-guard.md` tells an operator to debug with `AMOS_LOG=…trace`, and
 * `docs/android-compat.md` says `AMOS_ANDROID_RUNTIME=waydroid` forces the
 * container runtime — but neither variable is read anywhere: the daemon uses
 * `EnvFilter::try_from_default_env()` (i.e. `RUST_LOG`), and `runtime::auto()`
 * only probes `PATH`. A documented knob that silently does nothing is worse than
 * an undocumented one: the operator changes it, sees no effect, and concludes the
 * feature is broken. Nothing checked doc↔code for configuration.
 *
 * Corpus: every Markdown doc that promises current behaviour — `docs/**`,
 * `.github/**`, and the root `*.md` (README/CONTRIBUTING/GETTING_STARTED/SECURITY
 * and the reports/summaries). `CHANGELOG.md` is excluded on purpose: it records
 * what was true at each release, not a promise about today.
 *
 * A mention is satisfied only by a **read site** in the code corpus
 * (`crates/**` `.rs`, frontend `src/**`, `scripts/**`, `deploy/**`, `Makefile`,
 * `Cargo.toml`, root `*.sh`) — see `isHonored`. Forward-looking notes are
 * allow-listed with a reason in `scripts/env-doc-allowlist.json`.
 *
 * Hard gate (no baseline): the knob either exists or the doc must not promise it.
 *
 * Usage (repo root):
 *   node scripts/env-doc-scan.mjs                 # gate
 *   node scripts/env-doc-scan.mjs --json
 *   node scripts/env-doc-scan.mjs --selftest
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "target", ".git", "dist"]);

export const ENV_RE = /\bAMOS_[A-Z0-9_]+\b/g;

export function envNames(text) {
  return new Set([...text.matchAll(ENV_RE)].map((m) => m[0]));
}

/**
 * Is `name` actually **read** by the code (not merely mentioned)? A comment or an
 * `export AMOS_X=1` is not a read; these are:
 *   `env::var("AMOS_X")` / `var_os("AMOS_X")` / `env!("AMOS_X")`  → `"NAME"` `'NAME'`
 *   `process.env.AMOS_X` / `import.meta.env.AMOS_X`               → `env.NAME`
 *   `"$AMOS_X"` / `"${AMOS_X}"` (shell)                           → `$NAME` / `${NAME`
 * (The first cut used a plain `includes(name)` and matched its own header comment —
 * a documented name is only satisfied by a read site.)
 */
export function isHonored(name, codeText) {
  return (
    codeText.includes(`"${name}"`) ||
    codeText.includes(`'${name}'`) ||
    codeText.includes(`env.${name}`) ||
    codeText.includes(`$${name}`) ||
    codeText.includes(`\${${name}`)
  );
}

// --- corpora ----------------------------------------------------------------
function walk(dir, filter, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, filter, acc);
    else if (filter(p)) acc.push(p);
  }
  return acc;
}

const DOC_ROOTS = [
  join(root, "docs"),
  join(root, ".github"),
];
// Root-level docs (README, CONTRIBUTING, GETTING_STARTED, SECURITY and the
// reports/summaries): every operational knob they name must be read by the code.
// `CHANGELOG.md` stays out — it records what was true at each release rather than
// promising today's behaviour.
const DOC_FILES = readdirSync(root)
  .filter((f) => f.endsWith(".md") && f !== "CHANGELOG.md")
  .map((f) => join(root, f));

const docFiles = [
  ...DOC_ROOTS.flatMap((d) => walk(d, (p) => p.endsWith(".md"))),
  ...DOC_FILES.filter(existsSync),
].sort();

const codeFiles = [
  ...walk(join(root, "crates"), (p) => p.endsWith(".rs")),
  ...walk(join(root, "crates/amos-tauri/frontend-ts/src"), (p) => /\.(ts|svelte)$/.test(p)),
  ...walk(join(root, "scripts"), (p) => /\.(mjs|sh|js)$/.test(p)),
  ...walk(join(root, "deploy"), () => true),
  ...["Makefile", "Cargo.toml", "deploy.sh"].map((f) => join(root, f)),
]
  .filter(existsSync)
  // This scanner's own header quotes the very names it looks for; looking at
  // itself would make every documented name look "honored".
  .filter((f) => f !== fileURLToPath(import.meta.url));

const codeText = codeFiles.map((f) => readFileSync(f, "utf8")).join("\n");

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);
  const names = envNames("set AMOS_LOG=info or AMOS_A_B_2=x; not AMOS_lower");
  ok("extracts AMOS_ names", names.has("AMOS_LOG") && names.has("AMOS_A_B_2"));
  ok("ignores lowercase", ![...names].some((n) => n.includes("lower")));
  ok("extracts none from prose", envNames("nothing here").size === 0);

  // Read-site detection: a mention is not a read.
  ok("rust env::var quotes", isHonored("AMOS_X", 'std::env::var("AMOS_X").ok()'));
  ok("rust env! macro", isHonored("AMOS_X", 'option_env!("AMOS_X")'));
  ok("shell $VAR", isHonored("AMOS_X", 'if [ -n "$AMOS_X" ]; then'));
  ok("shell ${VAR}", isHonored("AMOS_X", 'echo "${AMOS_X}"'));
  ok("js process.env", isHonored("AMOS_X", "process.env.AMOS_X"));
  ok("a comment is not a read", !isHonored("AMOS_X", "// reads AMOS_X to set the filter"));
  ok("an export is not a read", !isHonored("AMOS_X", "export AMOS_X=1"));
  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[env-doc-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[env-doc-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
if (process.argv.includes("--selftest")) runSelftest();

// --- allow-list -------------------------------------------------------------
const allowPath = join(root, "scripts", "env-doc-allowlist.json");
let allow = [];
if (existsSync(allowPath)) {
  allow = JSON.parse(readFileSync(allowPath, "utf8"));
  for (const e of allow) {
    if (!e.name || !e.reason || !String(e.reason).trim()) {
      console.error(`[env-doc-scan] allow-entry without name+reason: ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }
}
const allowed = new Set(allow.map((e) => e.name));

// --- scan -------------------------------------------------------------------
const docNames = new Map(); // name -> Set<file>
for (const f of docFiles) {
  for (const n of envNames(readFileSync(f, "utf8"))) {
    if (!docNames.has(n)) docNames.set(n, new Set());
    docNames.get(n).add(relative(root, f));
  }
}

const missing = [];
for (const [name, files] of [...docNames].sort()) {
  if (allowed.has(name)) continue;
  if (isHonored(name, codeText)) continue;
  missing.push({ name, files: [...files] });
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({ docs: docFiles.length, code: codeFiles.length, documented: docNames.size, missing }, null, 2),
  );
} else {
  console.log(
    `[env-doc-scan] ${docFiles.length} doc file(s), ${codeFiles.length} code file(s); ` +
      `${docNames.size} documented AMOS_* name(s); ${allow.length} allow-listed.`,
  );
  if (missing.length === 0) {
    console.log("[env-doc-scan] OK — every AMOS_* named in the docs exists in code.");
  }
  for (const m of missing) {
    console.error(`[env-doc-scan] FAIL — ${m.name} (documented in ${m.files.join(", ")}, absent from code)`);
  }
}

process.exit(missing.length === 0 ? 0 : 1);

