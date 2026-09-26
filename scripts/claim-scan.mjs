#!/usr/bin/env node
/**
 * claim-scan.mjs — "an allow-list reason that names something which is not there".
 *
 * Why: every `*-allowlist.json` / `*-baseline.json` in this repo is a ledger of **decisions**, and
 * each decision is justified by prose — prose that names files, symbols, commands and other tables.
 * Nothing checked those names. Measured 2026-09-19 (REQ-A524): **32 ledger files, 552 claimed
 * tokens**; the sweep below found no *stale name* left, but it found (and REQ-A518 had already
 * fixed) the shape this gate exists for:
 *
 *   * `crates/amos-tauri/frontend-ts/scripts/unwired-allowlist.json` claimed, for `biometric.ts`,
 *     that its two commands "are registered and already allow-listed in
 *     `scripts/tauri-command-allowlist.json`" — while that table had **deleted** both entries (as
 *     `[stale]`, because a string inside that dead module counted as "a screen"), and no gate
 *     compared the two files. The claim was false for at least a commit.
 *
 * Two rules:
 *
 *   1. **every claimed token resolves** — a token in backticks (or a path-shaped token) must be a
 *      repo path, or every identifier part of it must exist in the source corpus, or it must be
 *      declared in `scripts/claim-allowlist.json` **with a reason** (the wildcards, code snippets,
 *      macOS/JNI symbols, and the historical names that are the *point* of an entry).
 *   2. **a reason that cites another ledger must be right about it** — if an entry's reason names
 *      another `*-allowlist.json` / `*-baseline.json`, then every command-shaped backticked token
 *      in that reason must exist in one of the cited tables. This is the rule that would have
 *      caught the `biometric.ts` claim on the day it became false (negative control: deleting one
 *      of the restored entries reproduces that failure).
 *
 * Rule 1 reads **code, not prose**: the identifier corpus is comment-stripped, because a name that
 * survives only inside a comment has not been resolved — it has been *remembered*. Measured
 * 2026-09-21 (REQ-A828, F-DEV-103): with the raw corpus this gate was green while **ten** claims
 * rested on a comment, and two of those comments were the *epitaph* of the very name they were
 * asked to prove — `AMOS_ACCELERATION`'s only witness in the repo says it "is not honoured
 * anywhere", and `AMOS_MEMORY_LIMIT_MB`'s was this file's own note explaining that the knob does
 * not exist. One of the ten was the real shape this gate exists for: a `why` asserting the BLE half
 * is wired "(`take_services` / `take_pending_read`)" while `take_pending_read` had been deleted by
 * the REQ-A413 fix and lived on only in a second ledger's marker list. The same measurement found
 * the opposite error too — a *file stem* now resolves (`examples/sherpa_asr.rs` for `sherpa_asr`),
 * a real example target whose only other witness was its own doc comment.
 *
 * Deliberately **not** gated: prose that names external things (a macOS API, an adb subcommand, a
 * doc file that no longer exists *because the entry says so*). Those are declared with reasons in
 * `scripts/claim-allowlist.json`, and an entry that becomes resolvable (or whose token disappears)
 * is reported as stale — so the excuse list cannot rot the way the claim could.
 *
 * Usage (repo root):
 *   node scripts/claim-scan.mjs              # gate
 *   node scripts/claim-scan.mjs --json       # machine-readable
 *   node scripts/claim-scan.mjs --selftest   # pin the extractors and both rules
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
// The repo's one self-tested comment stripper (`/\/\*…\*\//`, `//`-to-EOL, string-literal aware).
// It is Rust-shaped but its two comment forms are also JS/TS/Svelte's; over `.svelte`/`.ts`/`.mjs`
// the only gap is a regex literal containing `//`, which it truncates — and truncation can only
// *remove* identifiers, so an imperfect strip here errs toward a false RED, never a false green.
// (`sms-glue-const-scan.mjs` guards its own `main()` behind `IS_MAIN`, so this import is inert.)
import { stripRustComments } from "./sms-glue-const-scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FE_DIR = join(root, "crates/amos-tauri/frontend-ts");
const LEDGER_DIRS = [join(root, "scripts"), join(FE_DIR, "scripts")];
const ALLOWLIST = join(root, "scripts/claim-allowlist.json");
const SKIP = new Set(["node_modules", "target", ".git", "gen", "dist"]);

const BACKTICK = /`([^`\n]{2,80})`/g;
const PATHY = /(?<![\w/`])([\w./-]+\.(?:rs|ts|svelte|json|md|mjs|cjs|sh|kt|toml|java))/g;
const IDENT = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
/** A token that is not a name at all: a wildcard, a snippet, a quote, an ellipsis, a truncation. */
const NOT_A_NAME = /[*…\s"'()`{}<>#\\]|\.\.\./;
/** Command-shaped: what a `tauri-command-allowlist.json` entry is keyed by. */
const COMMAND_SHAPED = /^[a-z][a-z0-9_]{2,}$/;

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
 * Prose of one ledger row: every string it carries **except its own key fields**. A row's `name`
 * (`AMOS_MEMORY_LIMIT_MB`), `path` (`src/lib/ble.ts`) or `token` is the entry's *subject* — the
 * sentence around it explains what that subject is — so treating the key as a claim would flag
 * every ledger for naming the thing it is about (measured: the env-doc ledger's keys are knobs that
 * deliberately do not exist, and this scanner's own allow-list would flag its own tokens).
 */
export function rowProse(entry) {
  const out = [];
  for (const [k, v] of Object.entries(entry)) {
    if (k === "name" || k === "path" || k === "token") continue;
    if (typeof v === "string") out.push(v);
  }
  return out;
}

/** Every string in a JSON document (the ledger's prose lives in `reason`/`policy`/`captured`). */
export function stringsOf(value, acc = []) {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, acc);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsOf(v, acc);
  return acc;
}

/** Claimed tokens: backticked spans plus path-shaped tokens. */
export function claimedTokens(text) {
  const out = new Set();
  for (const m of text.matchAll(BACKTICK)) out.add(m[1].trim());
  for (const m of text.matchAll(PATHY)) out.add(m[1].trim());
  return [...out].filter((t) => t !== "" && !NOT_A_NAME.test(t));
}

/**
 * Does one claimed token resolve? A path when it looks like one (exact, suffix, basename, or a file
 * *stem* — `sherpa_asr` is `examples/sherpa_asr.rs`), else every identifier-ish part must exist in
 * the source corpus. Pure, so the selftest can pin it.
 */
export function resolves(token, index) {
  const t = token.trim().replace(/^`|`$/g, "");
  if (t === "") return true;
  if (index.paths.has(t) || index.basenames.has(t)) return true;
  if ([...index.paths].some((p) => p.endsWith("/" + t))) return true;
  // An example target, a binary, a module: a real file named without its extension. This is the
  // same trade the two lines above already make — a token equal to a *file* name resolves even when
  // the claim was about a symbol of that name — and it is needed for the shape that exposed it:
  // `sherpa_asr`'s only witness was its own doc comment, so stripping comments turned a real
  // example target into a false claim.
  if (index.stems?.has(t)) return true;
  for (const part of t.split(/[^A-Za-z0-9_]+/)) {
    if (part === "" || part.length <= 2 || /^\d+$/.test(part)) continue;
    if (!index.idents.has(part)) return false;
  }
  return true;
}

/** Language keywords are not names: a reason may mention `null` without claiming a ledger entry. */
const KEYWORDS = new Set([
  "null", "true", "false", "undefined", "void", "never", "any", "unknown", "object", "string",
  "number", "boolean", "async", "await", "function", "return", "const", "let", "var", "type",
  "interface", "enum", "struct", "impl", "match", "self", "super", "this", "new", "delete",
]);

/**
 * The shape of a table's keys, derived from the table itself (never hard-coded): a snake table
 * holds commands (`ble_read`), a kebab table holds events (`ai-card-received`), a path table holds
 * modules (`src/lib/ble.ts`). Rule 2 only checks a cited token against tables whose **key shape the
 * token has** — otherwise a reason that mentions a module table and a helper name would be reported
 * as a false claim (measured: `oneshot`, `null`).
 */
export function keyShape(keys) {
  const kebab = /^[a-z][a-z0-9-]+$/;
  const snake = /^[a-z][a-z0-9_]+$/;
  if (keys.length > 0 && keys.every((k) => kebab.test(k))) return "kebab";
  if (keys.length > 0 && keys.every((k) => snake.test(k))) return "snake";
  if (keys.some((k) => /[/.]/.test(k))) return "path";
  return "other";
}

const SHAPE_PATTERN = {
  kebab: /^[a-z][a-z0-9-]+$/,
  snake: /^[a-z][a-z0-9_]+$/,
  path: /[/.]/,
  other: null,
};

/**
 * Rule 2: an entry whose reason cites another ledger must be right about that ledger.
 *
 * `entryName` is the key in the ledger that owns the reason (a command name, an event name, a
 * module path…). Returns the tokens that are cited but absent from every named table.
 */
export function crossTableProblems(entryName, reason, tables) {
  // `nameKeyedTables` returns a Map; `Object.keys` on a Map is **always empty**, which made this
  // rule silently inert until the selftest caught it (the assertion "rule 2 catches a citation that
  // is wrong" failed while the scan stayed green — the exact shape of the defect this file audits).
  const byName = tables instanceof Map ? tables : new Map(Object.entries(tables));
  const cited = [...byName.keys()].filter((f) => reason.includes(f));
  if (cited.length === 0) return [];
  const problems = [];
  for (const token of claimedTokens(reason)) {
    if (KEYWORDS.has(token)) continue;
    // The citation itself is not a claim: `scripts/tauri-command-allowlist.json` (or the bare
    // filename) is *how* the sentence names the table, not a key it should contain.
    if (cited.some((f) => token === f || token.endsWith("/" + f) || token.endsWith(f) || f.endsWith(token))) continue;
    const shapes = cited
      .map((f) => byName.get(f).shape)
      .filter((s) => SHAPE_PATTERN[s] !== null && SHAPE_PATTERN[s].test(token));
    if (shapes.length === 0) continue; // the token is not the kind of key any cited table holds
    if (cited.some((f) => byName.get(f).rows.has(token))) continue;
    // A token that names the entry itself is the entry's own key, not a claim about the other table.
    if (token === entryName) continue;
    problems.push(token);
  }
  return problems;
}

function buildIndex() {
  // Every file in the repo (minus build/vendor dirs): a claimed *path* resolves by existence,
  // whatever its extension — an earlier extension list missed `examples/request_response`, which
  // exists and is named by `crate-readme-allowlist.json`.
  const paths = new Set();
  const collect = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) collect(p);
      else paths.add(relative(root, p));
    }
  };
  collect(root);
  const basenames = new Set([...paths].map((p) => p.split("/").pop()));
  const stems = new Set([...basenames].map((b) => b.replace(/\.[^.]+$/, "")));
  const idents = new Set();
  const sources = [
    ...walk(join(root, "crates"), ".rs"),
    ...walk(join(FE_DIR, "src"), ".ts").concat(walk(join(FE_DIR, "src"), ".svelte")),
    ...walk(join(root, "scripts"), ".mjs"),
    ...walk(join(FE_DIR, "scripts"), ".mjs"),
  ];
  for (const p of sources) {
    // Comments are prose. A claim is satisfied by this corpus only when the name is in *code*:
    // index the stripped text, so "the entry's sentence spells it and so does a comment" is not
    // resolution. See the header note (F-DEV-103) for what the raw corpus was accepting.
    for (const m of stripRustComments(readFileSync(p, "utf8")).matchAll(IDENT)) idents.add(m[0]);
  }
  return { paths, basenames, stems, idents };
}

/** name-keyed ledgers (a list of `{name, reason}`) with the shape of their own keys. */
export function nameKeyedTables(docs) {
  const out = new Map();
  for (const [file, data] of Object.entries(docs)) {
    const rows = Array.isArray(data) ? data : [];
    const entries = rows.filter((e) => e && typeof e === "object" && typeof e.name === "string");
    if (entries.length > 0) {
      out.set(file.split("/").pop(), {
        shape: keyShape(entries.map((e) => e.name)),
        rows: new Map(entries.map((e) => [e.name, e.reason ?? ""])),
      });
    }
  }
  return out;
}

/** Every ledger file (`.json` under the two ledger dirs), parsed. */
export function readLedgers() {
  const docs = {};
  for (const dir of LEDGER_DIRS) {
    for (const p of walk(dir, ".json")) {
      try {
        docs[relative(root, p)] = JSON.parse(readFileSync(p, "utf8"));
      } catch (e) {
        throw new Error(`${relative(root, p)} is not valid JSON: ${e.message}`);
      }
    }
  }
  return docs;
}

// --- scan -------------------------------------------------------------------
function runScan() {
  const docs = readLedgers();
  const index = buildIndex();
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (ent.isFile()) index.paths.add(ent.name);
  }

  const allow = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, "utf8")) : [];
  const allowed = new Map(allow.map((e) => [e.token, e.reason]));

  const tables = nameKeyedTables(docs);
  const unresolved = [];
  const crossTable = [];
  const claimed = new Map(); // token -> Set(ledger)
  let tokens = 0;

  for (const [file, data] of Object.entries(docs)) {
    // A list of rows: the row's key is its subject, the rest is prose (see `rowProse`).
    const isRows = Array.isArray(data) && data.some((e) => e && typeof e === "object" && "reason" in e);
    const texts = isRows
      ? data.flatMap((e) => (e && typeof e === "object" ? rowProse(e) : []))
      : stringsOf(data);
    for (const text of texts) {
      for (const token of claimedTokens(text)) {
        tokens += 1;
        if (!claimed.has(token)) claimed.set(token, new Set());
        claimed.get(token).add(file.split("/").pop());
        if (!resolves(token, index) && !allowed.has(token)) {
          unresolved.push({ token, file: file.split("/").pop() });
        }
      }
    }
    // rule 2, over ledger rows (that is where the state lives). Both key styles count: tables keyed
    // by `name` (commands, events) and the frontend's module ledger keyed by `path` — the A518
    // claim lived in the latter, so leaving it out would have made this rule blind to its own
    // motivating case.
    const rows = Array.isArray(data) ? data : [];
    for (const e of rows) {
      if (!e || typeof e.reason !== "string") continue;
      const entryName = typeof e.name === "string" ? e.name : e.path;
      if (typeof entryName !== "string") continue;
      for (const tok of crossTableProblems(entryName, e.reason, tables)) {
        crossTable.push({ file: file.split("/").pop(), name: entryName, token: tok });
      }
    }
  }

  // Anti-rot: an excuse that is no longer needed, or names a token nobody claims any more.
  const stale = allow
    .filter((e) => resolves(e.token, index) || !claimed.has(e.token))
    .map((e) => `${e.token} (${resolves(e.token, index) ? "now resolves" : "no longer claimed"})`)
    .sort();

  const failures = unresolved.length + crossTable.length + stale.length;
  const ledgers = Object.keys(docs).length;
  const distinct = claimed.size;

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        { ledgers, claimedTokens: tokens, distinctTokens: distinct, unresolved, crossTable, stale, allowListed: [...allowed.keys()].sort() },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[claim-scan] ${ledgers} ledger file(s); ${tokens} claimed token(s) (${distinct} distinct); ` +
        `${allowed.size} allow-listed; ${tables.size} name-keyed table(s).`,
    );
    for (const u of unresolved) {
      console.error(`[claim-scan] FAIL — \`${u.token}\` is claimed by ${u.file} but resolves to nothing`);
    }
    for (const c of crossTable) {
      console.error(
        `[claim-scan] FAIL — ${c.file}::${c.name} cites \`${c.token}\`, which the table it names does not contain`,
      );
    }
    for (const s of stale) {
      console.error(`[claim-scan] FAIL — claim allow-list entr(y) no longer needed: ${s}`);
    }
    if (failures === 0) {
      console.log(
        "[claim-scan] OK — every name the ledgers cite still exists, and every reason that cites " +
          "another table is right about it.",
      );
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const toks = claimedTokens('see `foo_bar` and `src/lib/x.ts` and `a_*` and `let x = 1;`');
  ok("claimedTokens finds backticked names", toks.includes("foo_bar"));
  ok("claimedTokens finds path-shaped tokens", toks.includes("src/lib/x.ts"));
  ok("claimedTokens drops a wildcard", !toks.includes("a_*"));
  ok("claimedTokens drops a snippet", !toks.some((t) => t.includes("=")));

  const index = { paths: new Set(["crates/a/src/b.rs"]), basenames: new Set(["b.rs"]), idents: new Set(["known_symbol"]) };
  ok("resolves a full path", resolves("crates/a/src/b.rs", index));
  ok("resolves a path suffix", resolves("src/b.rs", index));
  ok("resolves a basename", resolves("b.rs", index));
  ok("resolves a known symbol", resolves("known_symbol", index));
  ok("rejects an unknown symbol", !resolves("nosuch_symbol", index));
  ok(
    "a qualified name needs every part (the historical `Config.field` shape)",
    !resolves("Config.field", { ...index, idents: new Set(["field"]) }),
  );
  ok(
    "a qualified name resolves when both parts exist",
    resolves("Config2.field", { ...index, idents: new Set(["Config2", "field"]) }),
  );
  // The stem is spelled with a name **no ledger claims**, on purpose: these fixtures are string
  // literals in a `scripts/*.mjs`, and `buildIndex` indexes string literals — so a real name here
  // would witness, in the gate's own corpus, the very claim the case is about (measured: a scratch
  // copy of this file's selftest made `sherpa_asr` resolve with the stem branch removed).
  ok(
    "resolves a file stem (an example target, named without its extension)",
    resolves("zz_example_target", { ...index, stems: new Set(["zz_example_target"]) }),
  );
  ok("the stem branch is opt-in: without it the same token is unresolved", !resolves("zz_example_target", index));

  // The mechanism F-DEV-103 fixed, both directions: the corpus handed to `buildIndex` is stripped,
  // so a name that survives only in a comment cannot satisfy a claim — and a name in code still can.
  const sample = "// `ghost_accessor` was deleted by the REQ-A413 fix\nfn live_accessor() {}";
  const idxOf = (text) => ({
    paths: new Set(),
    basenames: new Set(),
    stems: new Set(),
    idents: new Set([...text.matchAll(IDENT)].map((m) => m[0])),
  });
  ok("a name that survives only in a comment does not resolve", !resolves("ghost_accessor", idxOf(stripRustComments(sample))));
  ok("...but it did resolve against the raw text — the shape this gate shipped with", resolves("ghost_accessor", idxOf(sample)));
  ok("a name in code still resolves once the comment is stripped", resolves("live_accessor", idxOf(stripRustComments(sample))));

  const tables = new Map([
    ["tauri-command-allowlist.json", { shape: "snake", rows: new Map([["dock_badge_set", "why"]]) }],
    ["unwired-allowlist.json", { shape: "path", rows: new Map([["src/lib/ble.ts", "why"]]) }],
  ]);
  ok(
    "rule 2 accepts a citation that is right",
    crossTableProblems("dock-badge-changed", "same state as `dock_badge_set` in `tauri-command-allowlist.json`", tables).length === 0,
  );
  // The real shape A518 found: the reason names the entry's own commands and points at the table
  // that was supposed to carry them.
  const wrong =
    "its two commands `biometric_available` / `biometric_authenticate` are registered and already " +
    "allow-listed in `scripts/tauri-command-allowlist.json`";
  ok("rule 2 catches a citation that is wrong", crossTableProblems("src/lib/biometric.ts", wrong, tables).length === 2);
  ok(
    "rule 2 ignores a snake token cited against a path-keyed table",
    crossTableProblems("biometric-result", "the state lives in `src/lib/ble.ts` and `oneshot` fills it", tables).length === 0,
  );
  ok(
    "rule 2 ignores language keywords",
    crossTableProblems("ble_connect", "leaks `null` — see `unwired-allowlist.json`", tables).length === 0,
  );
  ok("keyShape reads a kebab table", keyShape(["ai-card-received", "menu-event"]) === "kebab");
  ok("keyShape reads a snake table", keyShape(["ble_read", "nfc_status"]) === "snake");
  ok("keyShape reads a path table", keyShape(["src/lib/x.ts"]) === "path");
  ok(
    "nameKeyedTables reads a list of {name, reason}",
    nameKeyedTables({ "scripts/x.json": [{ name: "a", reason: "r" }] }).get("x.json").rows.get("a") === "r",
  );
  ok(
    "nameKeyedTables ignores a ledger with no names",
    nameKeyedTables({ "scripts/y.json": { policy: "p" } }).size === 0,
  );
  ok("stringsOf walks nested reasons", stringsOf({ a: [{ b: "deep" }] }).includes("deep"));

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[claim-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[claim-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (process.argv.includes("--selftest")) runSelftest();
else if (invokedDirectly) runScan();


