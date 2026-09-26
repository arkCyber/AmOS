#!/usr/bin/env node
/**
 * tauri-command-scan.mjs — "a registered Tauri command that no screen ever asks for", and its
 * mirror (REQ-A517): "a literal call the UI makes whose command the host does not have".
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
 *      production frontend code (`frontend-ts/src`, minus tests **and minus the modules
 *      `unwired-allowlist.json` records as unreachable** — see REQ-A518 below), or a call from
 *      Rust production code (`name(…)`, tests excluded — e.g. the device-care bridge
 *      calling `perm_record_audit`), or an entry in
 *      `scripts/tauri-command-allowlist.json` **with a reason** (the documented
 *      deliberate non-wirings).
 *   3. **Every literal call the UI makes exists** (REQ-A517) — a production
 *      `invoke("name")` / `call("name")` whose command is not registered. The
 *      mirror-image blind spot of check 2, and the one that let
 *      `lib/media.ts::mediaStreamBase()` call `media_stream_base` for months: the
 *      frontend builds (TypeScript sees a string), the Rust side is green (nothing
 *      registers it), and **no gate compared the two sides**. Such a call always
 *      resolves to the offline value *and* writes a `command-failed` entry into the
 *      diagnostic ledger — a failure the user cannot act on, invented by the client.
 *      Deliberate gaps go in `scripts/tauri-call-allowlist.json` with a reason.
 *
 * The frontend match in check 2 counts *any* quoted literal, which is the **safe**
 * direction: a missed finding is quieter than a false CI failure. It does **not** count a
 * literal inside a module nothing imports (REQ-A518) — the mirror of check 3, and the reason
 * fifteen registered commands (`biometric_*`, `ble_*`, `nfc_*`) reported as consumed while their
 * only wrapper was `src/lib/biometric.ts` / `ble.ts` / `nfc.ts`, three files
 * `unwired-allowlist.json` records as unreachable. `unwired-scan`'s hard gate keeps that list
 * honest (an unreachable module must be listed there **with a reason**), so the two instruments
 * compose: *dead module ⇒ listed ⇒ excluded here*. Check 3 counts
 * only **call sites** and does not strip comments (see `parseInvokedNames`: stripping
 * would swallow a real call after a `"http://…"` literal — the *miss* direction,
 * which is the one this check exists for). Deliberately **not** covered by either: a
 * command reached through a computed name (`invoke(NAME)`) — check 3 counts those
 * sites and prints the count, name it in the allow-list if that ever hides a gap.
 * Allow-list entries that became consumed (or whose command disappeared) are reported
 * as `[stale]` so neither list can rot silently.
 *
 * Usage (repo root):
 *   node scripts/tauri-command-scan.mjs              # gate
 *   node scripts/tauri-command-scan.mjs --json       # machine-readable
 *   node scripts/tauri-command-scan.mjs --selftest   # pin the extractors
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
// REQ-A530: one implementation of "the production part of a Rust file" (it strips `#[cfg(test)]`
// items instead of truncating at the first one) — shared with the reply scan, which owns it.
import { stripTestRegions, maskProse } from "./tauri-reply-scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_SRC = join(root, "crates/amos-tauri/src");
const LIB_RS = join(RUST_SRC, "lib.rs");
const FE_DIR = join(root, "crates/amos-tauri/frontend-ts");
const FE_SRC = join(FE_DIR, "src");
const ALLOWLIST = join(root, "scripts/tauri-command-allowlist.json");
/** REQ-A517: the other direction — a call the UI makes whose command does not exist. */
const CALL_ALLOWLIST = join(root, "scripts/tauri-call-allowlist.json");
/**
 * REQ-A518: the frontend's own record of "a module nothing imports"
 * (`crates/amos-tauri/frontend-ts/scripts/unwired-allowlist.json`). `unwired-scan.mjs`
 * **hard-gates** it: an unreachable module must be listed there with a reason, so this
 * file is an authoritative, reason-carrying list of "no screen can reach this file".
 * Check 2 uses it to decide whether a quoted command name is a *consumer*.
 */
const FE_DEAD_MODULES = join(FE_DIR, "scripts", "unwired-allowlist.json");

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

/**
 * Strip `//…` and block comments (a command named only in a comment is not called), replacing them
 * with **whitespace**.
 *
 * REQ-A851: this was a second, independent copy of the character-level mistake — `replace` matched
 * the delimiters anywhere, so `"http://…"` swallowed the rest of its line (a real `invoke("wm_open")`
 * after such a literal counted as nothing) and a block comment between two identifiers came out
 * welded into one token the compiler
 * never sees (`a`, comment, `b` → `ab`). Measured 2026-09-21, 1 225 such `//` in 193 files. It now shares the token-aware
 * masker with the reply scan, which is where the file's own `parseInvokedNames` note already said
 * the hazard lived — that extractor no longer has to dodge this function to stay honest.
 */
export function stripComments(src) {
  return maskProse(src, { strings: false });
}

/**
 * Command names from a `generate_handler![…]` block: every entry's **last** path
 * segment (`wm::open` → `open`, `open` → `open`).
 *
 * The list is delimited by **balanced brackets**, not by "the first `]`". A
 * per-entry attribute is normal Rust (`#[cfg(desktop)]` in front of a
 * desktop-only command) and carries its own `]`; a naive `indexOf("]")` therefore
 * ended the list at the first attribute and reported every command after it as
 * "declared but NOT registered" — two false failures in this repo until the
 * scanner learned to count brackets.
 */
export function parseRegistered(src) {
  // Strip comments **before** locating anything. `indexOf` cannot tell a declaration from a
  // quotation, and prose quotes this macro as freely as code writes it: `lib.rs`'s own doc block
  // names `generate_handler!` and then, a few lines later, a `#[cfg(not(target_os = "macos"))]`
  // attribute — with its `[` and `]` — while explaining the macOS menu. Locating the macro in the
  // raw source matched the *quotation*, took the prose's bracket as the list's, and parsed an
  // empty list; every registered command in the repository then read as "declared but NOT
  // registered" (588 findings, and 17 live allow-list rows reported as stale). The bracket
  // counter is just as fooled — a `]` in a comment inside the list would close it early.
  const code = stripComments(src);
  const start = code.indexOf("generate_handler!");
  if (start < 0) return [];
  const open = code.indexOf("[", start);
  if (open < 0) return [];
  const close = matchingBracket(code, open);
  if (close < 0) return [];
  return code.slice(open + 1, close)
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "")
    .map((e) => e.split("::").pop().trim())
    .filter((e) => /^[A-Za-z_]\w*$/.test(e));
}

/** Index of the `]` that closes the `[` at `open`, or -1 when unbalanced. */
export function matchingBracket(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Names carrying `#[tauri::command]` (attributes may sit between it and the fn). */
export function parseDeclared(src) {
  const clean = stripComments(src);
  const out = [];
  const re = /#\[tauri::command\][\s\S]{0,400}?pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/g;
  for (const m of clean.matchAll(re)) out.push(m[1]);
  return out;
}

/**
 * The **consumer corpus** for check 2: production frontend sources with the frontend's own
 * unreachable modules removed (REQ-A518).
 *
 * Why this exists: the original rule counted a command name appearing anywhere in production
 * code as "a screen asks for it" — including inside a module that **no screen can import**.
 * Measured 2026-09-19: **15 registered commands** (`biometric_available` /
 * `biometric_authenticate`, all seven `ble_*`, six `nfc_*`) had *every* frontend mention inside
 * `src/lib/biometric.ts` / `ble.ts` / `nfc.ts` — three files `unwired-allowlist.json` records as
 * unreachable. The gate that exists to catch "a capability the UI cannot reach" therefore
 * reported them as consumed, and their accurate allow-list entries had been deleted as `[stale]`
 * (the reason texts in `unwired-allowlist.json` still cite those very entries — a claim that had
 * been false for at least one commit). A wrapper nothing imports is not a screen.
 *
 * Pure, so the selftest can pin it.
 */
export function liveConsumerFiles(files, deadModules) {
  return files.filter((f) => !deadModules.has(f));
}

/**
 * Every quoted string literal in a corpus (the *safe* "is it mentioned?" test).
 */

export function quotedLiterals(src) {
  const out = new Set();
  for (const m of src.matchAll(/"([^"\n\\]*)"|'([^'\n\\]*)'/g)) out.add(m[1] ?? m[2]);
  return out;
}

/**
 * 前端**字面调用**的命令名（REQ-A517）：`invoke<Res>("name"` / `invoke("name"` /
 * `call<Res>("name"` —— 这是本仓桥的全部两种写法（`lib/backend.ts` 的 `invoke` 与
 * 它的 `call` 别名）。
 *
 * **不剥注释**（与本文件其它抽取器不同，故意的）：`stripComments` 会把 `"http://…"`
 * 里的 `//` 当成行注释的起点，从而**吞掉同一行后面真正的调用** —— 那是"漏报"的方向，
 * 而这条检查存在的唯一理由就是别漏（实测：本仓 `TopbarAppleMenu.svelte` 的
 * `wm_open` 就落在被吞掉的那一类里）。反过来，一条**注释**里点名了不存在的命令只会
 * 造成一次**看得见**的误报（改措辞或进豁免表即可）—— 两害相权取其轻。
 */
export function parseInvokedNames(src) {
  const out = [];
  const re = /\b(?:invoke|call)\s*(?:<[^<>()]*>)?\s*\(\s*["']([A-Za-z_]\w*)["']/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

/**
 * 名字**算出来**的调用点数量（`invoke(NAME)` / `invoke(cmd, …)`）：静态判据看不到它们，
 * 因此既不能报失败也不能当作"没人调用"。只做**计数**，让边界在输出里可见
 * （与 `http-route-scan.mjs` 对"非字面量方法"的处理同一约定）。
 */
export function countComputedCalls(src) {
  const re = /\b(?:invoke|call)\s*(?:<[^<>()]*>)?\s*\(\s*([^"'\s)][^,) ]*)/g;
  return [...src.matchAll(re)].length;
}

/**
 * Production part of a Rust source, for the "is Rust itself calling it?" check (REQ-A530).
 *
 * This used to truncate at the **first** `#[cfg(test)]`; `wm.rs` carries an inline test helper at
 * line 816 above 1 400 lines of production code, so the cut hid most of the file — including any
 * Rust-side caller. The shared `stripTestRegions` removes the test *items* instead, which is what
 * the event scan has done since REQ-A231.
 */
export function productionPart(rel, src) {
  if (rel.includes("/tests/")) return "";
  // Comments are **kept**: this scan only asks "does the name appear as a call in production?",
  // and the reply scan's parsers strip comments themselves where it matters.
  return stripTestRegions(src);
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

  // A per-entry attribute carries its own `]`; the list must survive it (the
  // regression this scanner shipped: `#[cfg(desktop)]` truncated the list at the
  // first attribute, so every command after it looked unregistered).
  const withAttrs = [
    "..generate_handler![",
    "  ai::ask,",
    "  #[cfg(desktop)]",
    "  wine::wine_apps,",
    "  #[cfg(desktop)]",
    "  linux_apps::linux_apps,",
    "]",
    "..",
  ].join("\n");
  const regAttrs = parseRegistered(withAttrs);
  ok("keeps entries after a per-entry attribute", regAttrs.length === 3);
  ok(
    "names both attributed entries",
    regAttrs.includes("wine_apps") && regAttrs.includes("linux_apps"),
  );
  ok("balanced-bracket scan finds the real close", matchingBracket("a[#[x]]b", 1) === 6);
  ok("unbalanced brackets → -1", matchingBracket("a[#[x]", 1) === -1);

  // **Prose is not code.** The doc block above the handler quotes the macro name and a
  // `#[cfg(…)]` attribute while explaining the macOS menu; reading the raw source found *that*
  // quotation and parsed an empty list, which reported every registered command in the repo as
  // unregistered. Both quotations are reproduced here, and a `]` inside a comment **within** the
  // list must not close it early either.
  const quoted = [
    "// `generate_handler!` list below, `menu::sync_window_items` in the window-event handler,",
    "// a desktop-only command carries `#[cfg(not(target_os = \"macos\"))]`.",
    "//",
    "..generate_handler![",
    "  ai::ask,",
    "  #[cfg(desktop)]",
    "  // trailing item ids are [1], [2] …",
    "  wm::open,",
    "  plain,",
    "]",
  ].join("\n");
  const regQuoted = parseRegistered(quoted);
  ok("prose quoting the macro does not become the list", regQuoted.length === 3);
  ok("a `]` in a comment inside the list does not close it", regQuoted.includes("open") && regQuoted.includes("plain"));
  ok("the quoted attribute does not end the list either", regQuoted.includes("ask"));

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

  // REQ-A851: the delimiters match only in code — a `//` inside a literal is not a comment, and a
  // comment between two identifiers must not weld them (both measured: the old copy lost the
  // `invoke("wm_open")` after a `"http://…"` literal, which is the miss direction this file's own
  // `parseInvokedNames` note works around).
  ok("stripComments does not swallow the rest of a line after a `//` inside a literal",
    stripComments('let a = "http://x"; invoke("wm_open");').includes('invoke("wm_open")'));
  ok("stripComments leaves a space behind, never welding two identifiers",
    /^a\s+b$/.test(stripComments("a/*c*/b").trim()));

  // --- REQ-A517: the call extractor -----------------------------------------
  ok(
    "parseInvokedNames finds plain + generic invoke",
    JSON.stringify(parseInvokedNames('invoke("spaces_list"); invoke<Space[]>("spaces_list", {});')) ===
      JSON.stringify(["spaces_list", "spaces_list"]),
  );
  ok(
    "parseInvokedNames finds the `call` alias (lib/backend.ts wraps it)",
    parseInvokedNames('return call<string>("media_stream_base");')[0] === "media_stream_base",
  );
  ok("parseInvokedNames ignores a computed name", parseInvokedNames("invoke(NAME)").length === 0);
  ok(
    "parseInvokedNames ignores a call-shaped substring (`reinvoke(`)",
    parseInvokedNames('reinvoke("x")').length === 0,
  );
  // Why this extractor does **not** strip comments: stripping used to turn the `//` inside a URL
  // literal into a line comment and eat a call that followed it **on that line**. REQ-A851 fixed
  // the stripper, so the hazard is gone — the pair below is now two-sided: the extractor still sees
  // the call **and** the stripper no longer loses it (this assertion used to pin the loss, i.e. it
  // asserted a defect; it now pins the repair).
  const urlThenCall = 'const base = "http://localhost:3456/media/stream"; invoke("media_list");';
  ok(
    "parseInvokedNames survives a URL literal before the call on the same line",
    parseInvokedNames(urlThenCall).includes("media_list"),
  );
  ok(
    "…and stripComments no longer eats that call (REQ-A851)",
    stripComments(urlThenCall).includes("media_list"),
  );
  ok(
    "countComputedCalls counts only non-literal sites",
    countComputedCalls('invoke("a"); invoke(NAME); call(cmd, {});') === 2,
  );

  // --- REQ-A518: the consumer corpus ---------------------------------------
  ok(
    "liveConsumerFiles drops a dead module's file",
    JSON.stringify(liveConsumerFiles(["/a.ts", "/dead.ts"], new Set(["/dead.ts"]))) ===
      JSON.stringify(["/a.ts"]),
  );
  ok(
    "liveConsumerFiles keeps everything when nothing is dead",
    liveConsumerFiles(["/a.ts", "/b.ts"], new Set()).length === 2,
  );
  ok(
    "liveConsumerFiles keys on the exact path (a prefix match must not drop a live file)",
    liveConsumerFiles(["/dead.tsx"], new Set(["/dead.ts"])).length === 1,
  );

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

// Only run the selftest when executed directly, for the same reason the scan below is guarded:
// the extractors here are imported by other gates (`tauri-args-scan.mjs` shares this file's
// `parseRegistered` so the two cannot drift apart again), and an unguarded dispatch makes an
// importer run *this* file's selftest — `node tauri-args-scan.mjs --selftest` printed
// `[tauri-command-scan] selftest: …` and exited on this file's verdict.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly && process.argv.includes("--selftest")) runSelftest();



// --- scan -------------------------------------------------------------------
// Only run the scan when executed directly (the extractors above are importable
// for tests/selftests without side effects).
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
const feProdFiles = feFiles.filter(
  (f) => !f.includes("/__tests__/") && !/\.test\.[cm]?[jt]sx?$/.test(f),
);

/**
 * REQ-A518: drop the frontend's own unreachable modules from the consumer corpus. They are the
 * files `unwired-allowlist.json` records (with a reason, under `unwired-scan`'s **hard** gate),
 * i.e. modules no screen can import — a command name inside one of them is not a consumer.
 */
function deadFrontendModules() {
  if (!existsSync(FE_DEAD_MODULES)) return new Set();
  try {
    const list = JSON.parse(readFileSync(FE_DEAD_MODULES, "utf8"));
    // `path` is relative to `crates/amos-tauri/frontend-ts` (the frontend's own root),
    // **not** to the repo root — joining the wrong base silently excluded nothing.
    return new Set(list.filter((e) => e.module).map((e) => join(FE_DIR, e.path)));
  } catch (e) {
    console.error(`[tauri-command-scan] frontend allowlist is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}
const feDeadModules = deadFrontendModules();
const feLiveFiles = liveConsumerFiles(feProdFiles, feDeadModules);
const feProd = feLiveFiles.map((f) => readFileSync(f, "utf8")).join("\n");
const consumed = quotedLiterals(feProd);

// REQ-A517: check 3 — every literal bridge call the production UI makes. Per file, so
// a failure can name the caller (the name alone rarely says which screen is broken).
//
// REQ-A518: **no** dead-module filter here, on purpose. Check 2 asks "does a *screen* use
// this command?" (reachability decides); check 3 asks "does this command exist at all?" — and a
// call inside a module nobody imports is just as wrong as one inside a screen (it would be the
// same defect the moment the module is wired), so filtering there would be the *miss* direction.
const invoked = new Map(); // name → Set(file)
for (const f of feProdFiles) {
  for (const n of parseInvokedNames(readFileSync(f, "utf8"))) {
    if (!invoked.has(n)) invoked.set(n, new Set());
    invoked.get(n).add(relative(root, f));
  }
}
const computedCalls = feProdFiles.reduce(
  (acc, f) => acc + countComputedCalls(readFileSync(f, "utf8")),
  0,
);

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

let callAllow = [];
if (existsSync(CALL_ALLOWLIST)) {
  try {
    callAllow = JSON.parse(readFileSync(CALL_ALLOWLIST, "utf8"));
  } catch (e) {
    console.error(`[tauri-command-scan] call allowlist is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}
const callAllowByName = new Map(callAllow.map((a) => [a.name, a.reason]));

const declaredNotRegistered = [...declared].filter((n) => !registered.includes(n)).sort();
const registeredNotDeclared = registered.filter((n) => !declared.has(n)).sort();

/**
 * REQ-A517: literal calls with no command behind them. `registered` is the authority — a
 * name that is not in `generate_handler!` cannot be invoked at runtime, whatever
 * `#[tauri::command]` fns happen to exist.
 */
const invokedNotRegistered = [...invoked.keys()]
  .filter((n) => !registered.includes(n) && !callAllowByName.has(n))
  .sort();

/** Anti-rot for the call list: an entry that is now registered, or no longer called. */
const callStale = callAllow
  .filter((a) => registered.includes(a.name) || !invoked.has(a.name))
  .map(
    (a) => `${a.name} (${registered.includes(a.name) ? "now registered" : "no longer called"})`,
  )
  .sort();

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

const failures =
  declaredNotRegistered.length +
  registeredNotDeclared.length +
  unwired.length +
  invokedNotRegistered.length +
  // REQ-A518: a stale allow-list entry is a **failure**, not a note (this is how the accurate
  // `biometric_*` / `ble_*` / `nfc_*` records were lost: the scan printed "now consumed, shrink
  // with a reason" and the answer was to delete them — while the "consumption" was a string
  // literal inside a module no screen imports). `unwired-scan.mjs` has always failed on stale
  // entries; the two instruments now agree. Shrinking a record is an edit someone must justify.
  stale.length +
  callStale.length;

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
        invokedNotRegistered,
        computedCalls,
        allowListed: [...allowByName.keys()].sort(),
        callAllowListed: [...callAllowByName.keys()].sort(),
        stale,
        callStale,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[tauri-command-scan] ${registered.length} registered Tauri command(s); ` +
      `${feFiles.length} frontend file(s) scanned (${feProdFiles.length - feLiveFiles.length} ` +
      `unreachable module(s) excluded from the consumer corpus); ${allowByName.size} allow-listed; ` +
      `${invoked.size} distinct literal call(s) (${computedCalls} computed, not checkable).`,
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
  for (const n of invokedNotRegistered) {
    const where = [...invoked.get(n)].sort().join(", ");
    console.error(
      `[tauri-command-scan] FAIL — \`${n}\` is called from ${where} but NOT registered ` +
        `(the host has no such command: every call resolves to the offline value and ` +
        `records a fake command-failed in the ledger)`,
    );
  }
  if (failures > 0) {
    console.error(
      "\nFix by wiring the command into a screen (or calling it from Rust), deleting it, or\n" +
        "recording it in scripts/tauri-command-allowlist.json **with a reason** (a deliberate\n" +
        "non-wiring, e.g. a host that does not exist yet) and explaining it in\n" +
        "docs/unwired-exports-audit.md.",
    );
    if (invokedNotRegistered.length > 0) {
      console.error(
        "For a call with no command behind it: add the host command, or delete the call (a\n" +
          "frontend stub alone is **not** a fix — see REQ-A517 / scripts/tauri-call-allowlist.json).",
      );
    }
  }
  if (stale.length > 0) {
    console.error(
      `[tauri-command-scan] FAIL — ${stale.length} allow-list entr(y/ies) no longer name a hole ` +
        `(the command is now consumed **by a reachable file**, or it is no longer registered): ${stale.join(", ")}`,
    );
    console.error(
      "Shrinking this list is an edit someone must justify — check *where* the name is now\n" +
        "mentioned (`git log -p` it) before deleting anything; a mention inside a module that\n" +
        "`unwired-allowlist.json` records as unreachable is not a consumer (REQ-A518).",
    );
  }
  if (callStale.length > 0) {
    console.error(
      `[tauri-command-scan] FAIL — ${callStale.length} call allow-list entr(y/ies) no longer name a gap: ${callStale.join(", ")}`,
    );
  }
  if (failures === 0) {
    console.log(
      "[tauri-command-scan] OK — every registered command is declared and reachable from a screen or from Rust, and every literal call the UI makes exists.",
    );
  }
}

process.exit(failures === 0 ? 0 : 1);
}
