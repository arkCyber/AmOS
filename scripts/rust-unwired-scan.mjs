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
 *   R3 `duplicate-entry` — the same `value` twice;
 *   R4 `unverifiable-host` — an entry whose `why` claims the daemon reports the same fact, when the
 *                          daemon does not depend on that crate at all (REQ-A645). R1 checks that a
 *                          reason *exists*; nothing checked that it is **true**. The canned clause
 *                          "the daemon reports the same state through its own RPC/status path" was
 *                          copy-pasted onto System-UI-owned crates (`amos-sms`, `amos-appstore`)
 *                          that `crates/amos-ai` never links, so the recorded reason named a
 *                          compensating host that does not exist — an excuse no reader could
 *                          falsify without grepping the daemon's manifest.
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
// The repo's one self-tested comment stripper. Imported for its *string*-aware block removal: a
// `/*` written inside a literal or a `//` comment is not a block opener (REQ-A832, F-DEV-104).
// `sms-glue-const-scan.mjs` guards its `main()` behind `IS_MAIN`, so this import is inert.
import { stripRustComments } from "./sms-glue-const-scan.mjs";

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

/**
 * `\bname\b` occurrences in the file's **code**, comments stripped.
 *
 * Counting the raw text is what this shipped with, and it made an unwired `pub fn` invisible to
 * this gate: any prose mention — a `///` line describing the function, or the note written when
 * its last caller was deleted — counted as a reference, so `refs === 0` could not fire. Eleven
 * such declarations were measured (REQ-A832, closing the half F-DEV-066 recorded as deliberately
 * deferred); `crates/amos-ai/src/server.rs`'s `serve_with_sinks` is the clearest, named in prose
 * in three places while nothing calls it.
 *
 * Stripping can only *remove* occurrences, so the residue here is a false RED, never a false
 * green: a name that is genuinely used in code still counts. (That is the argument F-DEV-066's
 * row asked for before it would accept this fix — "a half-baked implementation would introduce a
 * false green" — and it is why the fix is a *strip*, not a smarter matcher.)
 */
export function countName(name, src) {
  return (codeOf(src).match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
}

/**
 * Blank the *contents* of Rust string literals — `"…"`, `b"…"`, `r"…"`, `r#"…"#` — replacing them
 * with spaces. A `pub fn` named X can only be *called* by X appearing in code; Rust has no
 * reflection, so an X inside a literal is data, never a reference. [`stripRustComments`] keeps
 * literals verbatim (so a URL's `//` survives), which is right for prose but leaves their text in
 * the counter's corpus.
 *
 * Measured case: `crates/amos-mail-cli`'s `--pass-stdin` refusal ("could not read standard
 * input") put the word `standard` in a literal, and the unrelated `amos-config`
 * `Resolver::standard` — whose own baseline `why` says it has no caller — read as wired, so the
 * ratchet reported its entry as `stale-entry`.
 *
 * Char literals are skipped too — not for their content (one character can never be a
 * multi-character name) but because `'"'` holds a `"` that would otherwise open a bogus string
 * and swallow the code after it. That is the measured shape: `model.rs`'s `cell.contains('"')`
 * hid three tests that call `full_text`. A `'` with no closing quote is a lifetime (`&'a str`),
 * not a literal, and is left as code.
 */
export function blankStringLiterals(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const raw = c === "r" || c === "b" ? /^(?:b)?r(#*)"/.exec(src.slice(i, i + 8)) : null;
    if (raw) {
      const close = `"${raw[1]}`;
      const open = i + raw[0].length;
      const end = src.indexOf(close, open);
      const stop = end === -1 ? n : end + close.length;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      const stop = Math.min(j + 1, n);
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === "'") {
      const stop = charLiteralEnd(src, i);
      if (stop !== -1) {
        out += " ".repeat(stop - i);
        i = stop;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Index just past a char literal opening at `i`, or `-1` when this `'` is a lifetime. */
function charLiteralEnd(src, i) {
  const n = src.length;
  if (src[i + 1] === "\\") {
    let j = i + 2;
    while (j < n && src[j] !== "'") j++;
    return j < n ? j + 1 : -1;
  }
  const cp = src.codePointAt(i + 1);
  if (cp === undefined) return -1;
  const after = i + 1 + String.fromCodePoint(cp).length;
  return src[after] === "'" ? after + 1 : -1;
}

/**
 * Memo for the strip above. The scan calls `countName` once per (file, name) pair — ~2.3 M times on
 * this workspace — so stripping inside the call would pay for the same file tens of thousands of
 * times. `sources` is held live for the whole run regardless, so the cached copies are the only
 * addition. `countName` keeps its signature, so the exported predicate and the selftest that pins
 * it are unaffected.
 */
const STRIPPED = new Map();
function strippedOf(src) {
  let v = STRIPPED.get(src);
  if (v === undefined) {
    v = stripRustComments(src);
    STRIPPED.set(src, v);
  }
  return v;
}

/** Comments stripped **and** string literals blanked — the corpus a reference count may read. */
const CODE_ONLY = new Map();
function codeOf(src) {
  let v = CODE_ONLY.get(src);
  if (v === undefined) {
    v = blankStringLiterals(strippedOf(src));
    CODE_ONLY.set(src, v);
  }
  return v;
}

export function isTestPath(rel) {
  return rel.includes("/tests/") || rel.includes("/benches/");
}

/**
 * Public item names a module declares — `pub fn` (via [`extractDecls`]) plus public types,
 * consts, statics and aliases.
 *
 * Types count because a module can be reachable for a *type* alone; for the module-level
 * question below ("is anything in here used from outside?") the item kind is irrelevant.
 */
export function extractPublicItems(src) {
  const out = new Set(extractDecls(src));
  const re =
    /^\s*pub(?:\s*\([^)]*\))?\s+(?:struct|enum|trait|union|const|static|type)\s+([A-Za-z_]\w*)/gm;
  for (const m of src.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** Module names declared as `mod x;` / `pub mod x;` anywhere in `sources` ([[path, src]]). */
export function declaredModules(sources) {
  const names = new Set();
  for (const [, src] of sources) {
    for (const m of src.matchAll(/^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([a-z_]\w*)\s*;/gm)) {
      names.add(m[1]);
    }
  }
  return names;
}

/**
 * **The module-level pass (REQ-A480)** — the shape the function-level pass structurally cannot see.
 *
 * The loop in the scan asks "is this `pub fn` referenced?" and counts the **declaring file's own**
 * references (minus one for the declaration) as usage. A *coordinated* module therefore certifies
 * itself: its helpers call each other (`add_recording` → `load_index`/`save_index`) and its tests
 * call everything, so every count is > 0 while the file is unreachable from the rest of the
 * workspace. Measured on this repo: `crates/amos-tauri/src/recording.rs` (207 lines, 6 `pub fn`,
 * 8 tests, a JSON ledger and an atomic writer) had **zero** references from any other file —
 * production *or* tests — while `lib.rs` said "used by telephony", which was false.
 *
 * So the question is asked one level up: a file that **is** a module (`mod <name>;` is declared
 * somewhere) must have at least one of its public item names referenced from **another file**.
 * One finding per such file, spelled `path::*`, so the existing baseline file, the R1/R2/R3
 * ratchet rules and the `--update-baseline` writer all apply unchanged: an orphan that gets
 * wired reports `stale-entry`, exactly like a wired `pub fn`.
 */
export function orphanModuleFindings(sources) {
  const modules = declaredModules(sources);
  const findings = [];
  for (const [path, src] of sources) {
    const base = path.split("/").pop() ?? "";
    if (!base.endsWith(".rs") || base === "mod.rs") continue; // a `mod.rs` is a folder facade
    // …and a module reached from **outside Rust** is not an orphan either: the `#[no_mangle]` /
    // `Java_*` trampoline is the same exemption `DECL_RE` documents, one level up. Measured case
    // (REQ-A832): `crates/amos-clipboard/src/android.rs`'s only public item is built and installed
    // by `Java_com_amos_ai_glue_AndroidClipboardGlue_attach`, which the Kotlin `AndroidClipboardGlue`
    // calls — so demanding an *in-workspace Rust* reference reported a live module as dead. Prose
    // does not exempt: the test runs on the comment-stripped source.
    const code = strippedOf(src);
    if (/^[ \t]*#\[no_mangle\]/m.test(code) || /\bfn\s+Java_[A-Za-z0-9_]+/.test(code)) continue;
    const name = base.slice(0, -".rs".length);
    if (!modules.has(name)) continue;
    const items = extractPublicItems(src);
    if (items.length === 0) continue; // nothing public ⇒ nothing anyone could reference
    let external = 0;
    for (const [other, otherSrc] of sources) {
      if (other === path) continue;
      for (const item of items) {
        if (countName(item, otherSrc) > 0) external++;
      }
    }
    if (external === 0) findings.push({ path, name: "*", items: items.sort(), testRefs: 0 });
  }
  return findings;
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
 * The one canned clause R4 exists to falsify: a `why` that justifies having no in-workspace caller
 * by pointing at the **daemon** reporting the same fact. Kept as a narrow pattern (not `/daemon/i`)
 * because a reason may legitimately *mention* the daemon while denying a counterpart — the rule
 * targets the positive claim, which is the shape that gets copy-pasted.
 */
const DAEMON_COUNTERPART = /\bthe daemon\b[^.]*\b(reports|surfaces|answers|serves)\b/i;

export function claimsDaemonCounterpart(why) {
  return typeof why === "string" && DAEMON_COUNTERPART.test(why);
}

/**
 * The crate names `crates/amos-ai` actually links, read from its manifest. A `why` that names the
 * daemon as the compensating host is only truth-bearing for one of these; for any other crate the
 * daemon has no code path that could report the fact (REQ-A645).
 */
export function daemonDependencyCrates(root) {
  const manifest = join(root, "crates", "amos-ai", "Cargo.toml");
  if (!existsSync(manifest)) return null;
  const names = new Set();
  let inDeps = false;
  for (const line of readFileSync(manifest, "utf8").split("\n")) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) {
      inDeps = section[1].trim() === "dependencies";
      continue;
    }
    if (!inDeps) continue;
    // `foo = …` and the dotted form `foo.workspace = true` both declare the crate `foo`.
    const dep = line.match(/^\s*([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)*\s*=/);
    if (dep) names.add(dep[1].replace(/_/g, "-"));
  }
  return names;
}

/** The crate directory an entry value names (`crates/<crate>/…::<symbol>` → `<crate>`). */
export function entryCrate(value) {
  const parts = String(value).split("/");
  return parts[0] === "crates" && parts.length > 1 ? parts[1] : null;
}

/**
 * Every problem with the baseline *itself* — the checks this gate was missing (REQ-A445), which
 * `rust-macro-scan.mjs` has had since REQ-A442:
 *
 *   R1 `missing-reason`  — an entry with no real `why`;
 *   R2 `stale-entry`     — an entry whose symbol is referenced somewhere now. This used to be a
 *                          printed note; a ratchet that is never shrunk is a ratchet nobody
 *                          reads, so it fails (the same rule as the macro whitelist's R2);
 *   R3 `duplicate-entry` — the same `value` listed twice;
 *   R4 `unverifiable-host` — a `why` that claims the daemon reports the same fact for a crate the
 *                          daemon does not depend on (REQ-A645; see the header). `daemonDeps` is
 *                          optional: the older two-argument callers keep working and simply skip
 *                          R4, which is why `--selftest` pins it explicitly.
 *
 * The legacy `{ "values": [...] }` shape is read as *reasonless* entries rather than crashing
 * (`entriesOf`): an older baseline keeps ratcheting, it just fails R1 until the reasons are
 * written down — which is the honest reading of a bare list.
 */
export function baselineProblems(entries, findings, daemonDeps) {
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
    if (daemonDeps && claimsDaemonCounterpart(e.why)) {
      const crate = entryCrate(e.value);
      if (crate && !daemonDeps.has(crate)) {
        problems.push({
          rule: "unverifiable-host",
          detail: `${e.value} — the \`why\` claims the daemon reports the same fact, but \`crates/${crate}\` is not a dependency of \`crates/amos-ai\` (no such path exists)`,
        });
      }
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
  // The direction this gate shipped without (REQ-A829, F-DEV-104). Both halves matter: a prose
  // mention must not count, and a real call still must — otherwise the fix would just be a
  // different way of getting the answer wrong.
  const proseOnly = [
    '/// zz_ghost_decl was the only reader of the old slot; it is gone now',
    '// see `zz_ghost_decl` — deleted by the REQ-A413 fix',
    'fn zz_real_caller() { zz_ghost_decl(); }',
  ].join("\n");
  ok("countName does not count a prose mention", countName("zz_ghost_decl", proseOnly) === 1);
  ok("countName counts the call that is still there", countName("zz_real_caller", proseOnly) === 1);
  ok("countName still counts a code-only name", countName("zz_live_decl", "zz_live_decl();") === 1);
  // The shape it shipped with, spelled out: on the raw text that same name reads as three
  // references, which is exactly how a retired accessor stayed "wired".
  ok(
    "...and the raw text was what it used to count",
    (proseOnly.match(new RegExp("\\bzz_ghost_decl\\b", "g")) ?? []).length === 3,
  );
  // …and the block form the old stripper could not tell from code: a `/*` inside a literal
  // opened a span to the next `*/`, deleting the declaration between them.
  const litPair = 'let a = "/*";\nfn zz_lit_neighbour() {}\nlet b = "*/";';
  ok("countName survives a `/*` written inside a literal", countName("zz_lit_neighbour", litPair) === 1);
  // A name *inside* a string literal is data, not a reference — and the two halves must both hold
  // or the fix is just another way to be wrong. The measured case: `amos-mail-cli`'s `--pass-stdin`
  // message mentions "standard input", which made `amos-config`'s `Resolver::standard` read as
  // wired while its own `why` says nothing calls it.
  const mailCli = 'let e = "could not read standard input";';
  ok("countName ignores a name inside a string literal", countName("standard", mailCli) === 0);
  ok(
    "…but still counts it when the call is really there",
    countName("standard", `${mailCli}\nfn f() { let _ = standard(); }`) === 1,
  );
  ok("countName ignores a raw string literal", countName("foo", 'let s = r#"foo"#;') === 0);
  ok("countName ignores a byte string literal", countName("foo", 'let s = b"foo";') === 0);
  ok(
    "an escaped quote does not end the literal early",
    countName("foo", 'let s = "a\\" foo";') === 0,
  );
  ok("blankStringLiterals keeps code outside literals", countName("foo", 'let foo = 1; let s = "foo";') === 1);
  // A `'"'` char literal holds a `"`: read as a string opener it swallows the code after it.
  // This is the shape that hid `amos-pdf-parser`'s `full_text` — `cell.contains('"')` above
  // three tests that call it. A lifetime has no closing quote and must stay code.
  ok(
    "a `'\"'` char literal does not swallow the code after it",
    countName("foo", "let x = cell.contains('\"');\nfn foo() {}") === 1,
  );
  ok("a lifetime is not a char literal", countName("foo", "fn f<'a>(x: &'a str) { let _ = foo(); }") === 1);
  ok("a `'\\''` char literal is skipped", countName("foo", "let q = '\\''; let _ = foo();") === 1);
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

  // R4 (REQ-A645): a reason that points at the daemon as the compensating host is only true for a
  // crate the daemon links.
  const daemonWhy = "the daemon reports the same state through its own RPC path, so nothing here reads it yet";
  const deps = new Set(["amos-ai", "amos-monitor"]);
  ok("R4 recognises the daemon-counterpart claim", claimsDaemonCounterpart(daemonWhy));
  ok(
    "R4 does not fire on a reason that merely denies a daemon counterpart",
    !claimsDaemonCounterpart(
      "the daemon has no SMS surface at all; this value is composed where it is read",
    ),
  );
  ok(
    "R4 flags a daemon-counterpart reason for a crate the daemon does not link",
    baselineProblems([{ value: "crates/amos-sms/src/trash.rs::trashed_in", why: daemonWhy }], live, deps).some(
      (p) => p.rule === "unverifiable-host",
    ),
  );
  ok(
    "R4 accepts the same reason for a crate the daemon links",
    !baselineProblems(
      [{ value: "crates/amos-monitor/src/monitor.rs::sampler_name", why: daemonWhy }],
      [{ path: "crates/amos-monitor/src/monitor.rs", name: "sampler_name" }],
      deps,
    ).some((p) => p.rule === "unverifiable-host"),
  );
  ok(
    "R4 is skipped when no daemon dependency set is supplied (older callers)",
    !baselineProblems([{ value: "crates/amos-sms/src/trash.rs::trashed_in", why: daemonWhy }], live).some(
      (p) => p.rule === "unverifiable-host",
    ),
  );
  ok("entryCrate reads the crate directory", entryCrate("crates/amos-sms/src/trash.rs::x") === "amos-sms");

  // The module-level pass (REQ-A480): a coordinated module must not certify itself.
  ok(
    "extractPublicItems sees types as well as functions",
    (() => {
      const items = extractPublicItems("pub fn f() {}\npub struct S;\npub const C: u8 = 1;");
      return items.includes("f") && items.includes("S") && items.includes("C");
    })(),
  );
  ok(
    "declaredModules finds `mod x;` and `pub mod x;`, not `mod x {`",
    (() => {
      const m = declaredModules([
        ["a.rs", "mod inner;\npub mod outer;\nmod inline { }\n"],
      ]);
      return m.has("inner") && m.has("outer") && !m.has("inline");
    })(),
  );
  const orphanSrc = [
    ["crates/a/src/lib.rs", "pub mod shelf;\n"],
    ["crates/a/src/shelf.rs", "pub fn add() { load(); }\npub fn load() {}\n"],
    ["crates/a/src/used.rs", "pub fn reach() {}\n"],
    ["crates/a/src/other.rs", "mod used;\nfn go() { used::reach(); }\n"],
  ];
  ok(
    "an unreferenced module file is an orphan finding",
    orphanModuleFindings(orphanSrc).some((f) => f.path === "crates/a/src/shelf.rs"),
  );
  ok(
    "a module referenced from another file is not an orphan",
    !orphanModuleFindings(orphanSrc).some((f) => f.path === "crates/a/src/used.rs"),
  );
  ok(
    "a module whose own items reference each other is still an orphan",
    orphanModuleFindings(orphanSrc).find((f) => f.path === "crates/a/src/shelf.rs")?.items.length ===
      2,
  );
  // The FFI exemption, both ways (REQ-A832). A module whose item is built and installed by a
  // `#[no_mangle]` trampoline is called from *outside* Rust — the reason `DECL_RE` skips those —
  // so it must not be reported as dead; and a *commented-out* trampoline must not exempt anything,
  // or prose would be deciding again.
  const jniSrc = [
    ["crates/a/src/lib.rs", "pub mod guest;\n"],
    [
      "crates/a/src/guest.rs",
      'pub struct Guest;\n\n#[no_mangle]\npub unsafe extern "system" fn Java_a_b_Glue_attach(env: *mut u8) {\n    let _ = Guest;\n    let _ = env;\n}\n',
    ],
  ];
  ok(
    "a module reached by a `#[no_mangle]` trampoline is not an orphan",
    !orphanModuleFindings(jniSrc).some((f) => f.path === "crates/a/src/guest.rs"),
  );
  const proseSrc = [
    ["crates/a/src/lib.rs", "pub mod shelf;\n"],
    ["crates/a/src/shelf.rs", "// was reached by a `#[no_mangle]` Java_a_b_Glue_attach trampoline\npub fn add() {}\n"],
  ];
  ok(
    "a commented-out trampoline does not exempt a module",
    orphanModuleFindings(proseSrc).some((f) => f.path === "crates/a/src/shelf.rs"),
  );
  ok(
    "the orphan finding uses the `path::*` shape the ratchet understands",
    (() => {
      const f = orphanModuleFindings(orphanSrc)[0];
      return f.name === "*" && `${f.path}::${f.name}` === "crates/a/src/shelf.rs::*";
    })(),
  );
  ok(
    "R2 also flags a wired-now orphan module (the ratchet shrinks here too)",
    baselineProblems([{ value: "crates/a/src/used.rs::*", why: goodReason }], orphanModuleFindings(orphanSrc)).some(
      (p) => p.rule === "stale-entry",
    ),
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

// The module-level pass (REQ-A480): same baseline, same ratchet, one level up.
const relSources = sources.map(([f, s]) => [rel(f), s]);
const orphans = orphanModuleFindings(relSources);
findings.push(...orphans);
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
const ratchetProblems = baselineProblems(entries, findings, daemonDependencyCrates(root));

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
      `${findings.length} unwired \`pub fn\` (${newFindings.length} new, baseline ${baseValues.size})` +
      `, ${orphans.length} orphan module(s).`,
  );
  // The kind histogram, printed so `docs/rust-unwired-audit.md`'s numbers can be *copied* from a
  // run instead of remembered: that doc already drifted once (a stale "25", REQ-A445) and had
  // drifted again by one when REQ-A480 read it — the numbers live here, so print them.
  if (entries.length > 0) {
    const kinds = new Map();
    for (const e of entries) kinds.set(e.kind ?? "unreviewed", (kinds.get(e.kind ?? "unreviewed") ?? 0) + 1);
    const hist = [...kinds.entries()].sort().map(([k, n]) => `${k} ${n}`).join(", ");
    console.log(`[rust-unwired-scan] baseline kinds: ${hist}`);
  }
  for (const f of newFindings) {
    const what =
      f.name === "*"
        ? `orphan module — nothing outside this file references any of its ${f.items.length} ` +
          `public item(s): ${f.items.slice(0, 5).join(", ")}${f.items.length > 5 ? ", …" : ""}`
        : f.testRefs > 0
          ? "test-only"
          : "referenced nowhere";
    console.error(`[rust-unwired-scan] FAIL — ${key(f)} (${what})`);
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

