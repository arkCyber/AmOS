#!/usr/bin/env node
/**
 * tauri-command-scan.mjs — "a registered Tauri command that no screen ever asks for".
 *
 * Why: `unwired-scan.mjs` starts from **frontend exports** and `rust-unwired-scan.mjs`
 * from **Rust `pub fn`**s. Neither can see the mirror-image defect: a command that
 * the host *does* expose (registered in `generate_handler!`, unit-tested, documented)
 * but that **no screen calls** — a capability the UI cannot reach. That is how the
 * multi-window "selection → AI" flow sat dead in the Svelte UI while
 * `docs/gui-verify.md` documented it as a user-visible scenario (Round 39).
 *
 * Scope (deliberately narrow, to stay high-signal): the **registered** command list
 * from `crates/amos-tauri/src/lib.rs`'s `generate_handler![…]`.
 *
 * Two hard checks:
 *   1. **Registered ≡ declared.** A name in the handler list with no
 *      `#[tauri::command]` fn would fail only at runtime ("command not found"); a
 *      declared command that is not registered can *never* be invoked.
 *   2. **Every registered command has a consumer** — a quoted literal of its name in
 *      production frontend code (`frontend-ts/src`, minus tests), or a call from
 *      Rust production code (`name(…)`, tests excluded — e.g. the device-care bridge
 *      calling `perm_record_audit`), or an entry in
 *      `scripts/tauri-command-allowlist.json` **with a reason** (the documented
 *      deliberate non-wirings).
 *
 * The frontend match counts *any* quoted literal, which is the **safe** direction: a
 * missed finding is quieter than a false CI failure. Deliberately **not** covered: a
 * command reached through a computed name (`invoke(NAME)`) — name it in the
 * allow-list if that ever happens. Allow-list entries that became consumed (or whose
 * command disappeared) are reported as `[stale]` so the list cannot rot silently.
 *
 * Usage (repo root):
 *   node scripts/tauri-command-scan.mjs              # gate
 *   node scripts/tauri-command-scan.mjs --json       # machine-readable
 *   node scripts/tauri-command-scan.mjs --selftest   # pin the extractors
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_SRC = join(root, "crates/amos-tauri/src");
const LIB_RS = join(RUST_SRC, "lib.rs");
const FE_SRC = join(root, "crates/amos-tauri/frontend-ts/src");
const ALLOWLIST = join(root, "scripts/tauri-command-allowlist.json");

const SKIP = new Set(["node_modules", "target", ".git", "gen", "dist"]);

function walk(dir, ext, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, ext, acc);
    else if (p.endsWith(ext)) acc.push(p);
  }
  return acc;
}

/** Strip `//…` and block comments (a command named only in a comment is not called). */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Command names from a `generate_handler![…]` block: every entry's **last** path
 * segment (`wm::open` → `open`, `open` → `open`).
 */
export function parseRegistered(src) {
  const start = src.indexOf("generate_handler!");
  if (start < 0) return [];
  const open = src.indexOf("[", start);
  const close = src.indexOf("]", open);
  if (open < 0 || close < 0) return [];
  return stripComments(src.slice(open + 1, close))
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "")
    .map((e) => e.split("::").pop().trim())
    .filter((e) => /^[A-Za-z_]\w*$/.test(e));
}

/** Names carrying `#[tauri::command]` (attributes may sit between it and the fn). */
export function parseDeclared(src) {
  const clean = stripComments(src);
  const out = [];
  const re = /#\[tauri::command\][\s\S]{0,400}?pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/g;
  for (const m of clean.matchAll(re)) out.push(m[1]);
  return out;
}

/** Every quoted string literal in a corpus (the *safe* "is it mentioned?" test). */
export function quotedLiterals(src) {
  const out = new Set();
  for (const m of src.matchAll(/"([^"\n\\]*)"|'([^'\n\\]*)'/g)) out.add(m[1] ?? m[2]);
  return out;
}

/**
 * Production part of a Rust source, for the "is Rust itself calling it?" check:
 * everything before the first `#[cfg(test)]` (the repo keeps tests at the bottom)
 * and never a `tests/` file.
 */
export function productionPart(rel, src) {
  if (rel.includes("/tests/")) return "";
  const i = src.indexOf("#[cfg(test)]");
  return i < 0 ? src : src.slice(0, i);
}

/**
 * True when `name` is called from Rust production code: `name(` appears after
 * removing every `fn name(` declaration (the declaration itself is not a call).
 */
export function isCalledInRust(name, corpus) {
  const withoutDecls = corpus.replace(new RegExp(`fn\\s+${name}\\s*\\(`, "g"), "fn ");
  return new RegExp(`\\b${name}\\s*\\(`).test(withoutDecls);
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const handler = ["..generate_handler![", "  ai::ask,", "  wm::open,", "  plain,", "]", ".."].join("\n");
  const reg = parseRegistered(handler);
  ok("parses a `generate_handler!` list", reg.length === 3);
  ok("takes the last path segment", reg.includes("ask") && reg.includes("open"));
  ok("keeps a plain name", reg.includes("plain"));
  ok("ignores the macro name itself", !reg.includes("generate_handler"));
  ok("missing macro → empty", parseRegistered("pub fn x() {}").length === 0);

  const decls = parseDeclared(
    [
      "#[tauri::command]",
      "pub async fn a() {}",
      "#[tauri::command]",
      "#[allow(clippy::too_many_arguments)]",
      "pub fn b() {}",
      "pub fn not_a_command() {}",
      "// #[tauri::command]",
      "// pub fn commented() {}",
    ].join("\n"),
  );
  ok("finds #[tauri::command] fns", decls.includes("a") && decls.includes("b"));
  ok("ignores a plain pub fn", !decls.includes("not_a_command"));
  ok("ignores an attribute inside a comment", !decls.includes("commented"));

  const lits = quotedLiterals('invoke("one"); invoke<Res>("two", {}); const k = \'three\';');
  ok("quotedLiterals finds double quotes", lits.has("one") && lits.has("two"));
  ok("quotedLiterals finds single quotes", lits.has("three"));
  ok("quotedLiterals ignores identifiers", !quotedLiterals("foo(bar)").has("foo"));

  const rust = [
    "pub async fn inner() {}",
    "#[tauri::command]",
    "pub async fn cmd() {}",
    "async fn helper() { cmd().await; }",
    "#[cfg(test)]",
    "mod tests { fn t() { other(); } }",
  ].join("\n");
  const prod = productionPart("crates/amos-tauri/src/a.rs", rust);
  ok("isCalledInRust ignores the declaration", !isCalledInRust("inner", prod));
  ok("isCalledInRust sees a real call", isCalledInRust("cmd", prod));
  ok("isCalledInRust ignores test-only calls", !isCalledInRust("other", prod));
  ok(
    "productionPart drops tests entirely",
    productionPart("crates/amos-tauri/tests/x.rs", "fn a() { b(); }") === "",
  );

  const clean = stripComments('let a = 1; // "fake"\n/* "also-fake" */ let b = 2;');
  ok(
    "stripComments removes quoted comments",
    !quotedLiterals(clean).has("fake") && !quotedLiterals(clean).has("also-fake"),
  );
  ok("stripComments keeps code", clean.includes("let a = 1") && clean.includes("let b = 2"));

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[tauri-command-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[tauri-command-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
if (process.argv.includes("--selftest")) runSelftest();



// --- scan -------------------------------------------------------------------
// Only run the scan when executed directly (the extractors above are importable
// for tests/selftests without side effects).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  runScan();
}

function runScan() {
const libSrc = existsSync(LIB_RS) ? readFileSync(LIB_RS, "utf8") : "";
const registered = parseRegistered(libSrc);

const rustFiles = walk(RUST_SRC, ".rs");
const declared = new Set();
for (const f of rustFiles) for (const n of parseDeclared(readFileSync(f, "utf8"))) declared.add(n);

const rustProd = rustFiles
  .map((f) => productionPart(relative(root, f), readFileSync(f, "utf8")))
  .join("\n");

const feFiles = walk(FE_SRC, ".ts").concat(walk(FE_SRC, ".svelte"));
const feProd = feFiles
  .filter((f) => !f.includes("/__tests__/") && !/\.test\.[cm]?[jt]sx?$/.test(f))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const consumed = quotedLiterals(feProd);

let allow = [];
if (existsSync(ALLOWLIST)) {
  try {
    allow = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  } catch (e) {
    console.error(`[tauri-command-scan] allowlist is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}
const allowByName = new Map(allow.map((a) => [a.name, a.reason]));

const declaredNotRegistered = [...declared].filter((n) => !registered.includes(n)).sort();
const registeredNotDeclared = registered.filter((n) => !declared.has(n)).sort();

const unwired = registered.filter((n) => {
  if (consumed.has(n)) return false; // a screen asks for it
  if (isCalledInRust(n, rustProd)) return false; // Rust itself drives it
  if (allowByName.has(n)) return false; // deliberate, with a reason on file
  return true;
});

// Anti-rot: an allow-listed name that is now consumed / no longer registered.
const stale = allow
  .filter((a) => consumed.has(a.name) || !registered.includes(a.name))
  .map((a) => `${a.name} (${consumed.has(a.name) ? "now consumed" : "no longer registered"})`)
  .sort();

const failures = declaredNotRegistered.length + registeredNotDeclared.length + unwired.length;

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        registered: registered.length,
        declared: declared.size,
        frontendFiles: feFiles.length,
        declaredNotRegistered,
        registeredNotDeclared,
        unwired,
        allowListed: [...allowByName.keys()].sort(),
        stale,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[tauri-command-scan] ${registered.length} registered Tauri command(s); ` +
      `${feFiles.length} frontend file(s) scanned; ${allowByName.size} allow-listed.`,
  );
  for (const n of declaredNotRegistered) {
    console.error(
      `[tauri-command-scan] FAIL — \`${n}\` is declared #[tauri::command] but NOT registered (unreachable)`,
    );
  }
  for (const n of registeredNotDeclared) {
    console.error(
      `[tauri-command-scan] FAIL — \`${n}\` is registered but has no #[tauri::command] implementation`,
    );
  }
  for (const n of unwired) {
    console.error(`[tauri-command-scan] FAIL — \`${n}\` is registered but no screen calls it`);
  }
  if (failures > 0) {
    console.error(
      "\nFix by wiring the command into a screen (or calling it from Rust), deleting it, or\n" +
        "recording it in scripts/tauri-command-allowlist.json **with a reason** (a deliberate\n" +
        "non-wiring, e.g. a host that does not exist yet) and explaining it in\n" +
        "docs/unwired-exports-audit.md.",
    );
  }
  if (stale.length > 0) {
    console.log(
      `[tauri-command-scan] allow-list: ${stale.length} stale entry(ies) — shrink with a reason: ${stale.join(", ")}`,
    );
  }
  if (failures === 0) {
    console.log(
      "[tauri-command-scan] OK — every registered command is declared and reachable from a screen or from Rust.",
    );
  }
}

process.exit(failures === 0 ? 0 : 1);
}
