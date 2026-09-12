#!/usr/bin/env node
/**
 * i18n-scan.mjs — static audit of the UI dictionaries (`src/i18n/locales`).
 *
 * Why: dead locale keys are user-facing copy that can never be shown, and they
 * accumulate silently — the last manual sweep removed 29 at once and nothing
 * stopped them from coming back. Two harder-to-see properties are checked too:
 *
 *   1. **Key parity** — `en` and `zh` expose exactly the same key set. (`en` is
 *      typed `Record<MessageKey, string>` off `zh`, so `tsc` already catches most
 *      drift; this is the standalone, tool-agnostic restatement.)
 *   2. **Placeholder parity** — for every key, the set of `{param}` names must be
 *      identical in `en` and `zh`. A localised string with a *different* param set
 *      silently drops (or leaves raw) `{...}` at runtime; nothing else checks it.
 *   3. **Dead keys** — a key no production file references. This is the exact
 *      analogue of `unwired-scan.mjs`, and it must NOT delete live strings, so
 *      three things are excluded first:
 *        • **Cross-language contract keys** — the literal `"key"` also appears in
 *          `crates/**` or `proto/*.proto`, i.e. the Rust daemon *emits* it and the
 *          UI renders it via a dynamic `t(data.key)` (e.g. `care.uninstall.protected`
 *          is a `reason_key`). Deleting one breaks a daemon↔UI contract.
 *        • **Dynamic namespaces** — any `` `prefix.${…}` `` template in production
 *          puts every key under `prefix.` in play (`t(\`message.folder.${f}\`)`).
 *        • Allow-listed keys (a reason is mandatory) — deliberate ahead-of-host copy.
 *      A dead key is a **hard gate** (no baseline): after this audit the dictionary
 *      has none, and any future one is a real defect, not debt.
 *
 * The scanner is dependency-free (regex + fs) and never executes the code it reads.
 * `--selftest` pins the parse/classification logic (see `make lint`).
 *
 * Usage (from frontend-ts):
 *   node scripts/i18n-scan.mjs                 # gate (non-zero on any finding)
 *   node scripts/i18n-scan.mjs --json          # machine-readable report
 *   node scripts/i18n-scan.mjs --selftest      # pin the parser/classifier
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..", "..");

// --- dictionaries -----------------------------------------------------------
/** Parse a locale module's `"key": "value",` lines into a Map. */
export function parseDict(src) {
  const out = new Map();
  const re = /^[ \t]*"((?:[^"\\]|\\.)*)":[ \t]*"((?:[^"\\]|\\.)*)",[ \t]*$/gm;
  for (const m of src.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** Sorted unique `{param}` names in a translated string. */
export function placeholders(value) {
  return [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

/** Dynamic key namespaces in production: `` `prefix.${…}` `` → `prefix.`. */
export function dynamicPrefixes(sources) {
  const out = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/`([a-z][a-zA-Z0-9_.]*\.)\$\{/g)) out.add(m[1]);
  }
  return out;
}

/**
 * Why `key` is live, or `null` when nothing references it. `prod` / `contract`
 * are concatenated corpora; `prefixes` are the dynamic namespaces.
 */
export function isLive(key, prod, contract, prefixes) {
  const quoted = `"${key}"`;
  if (prod.includes(quoted)) return "prod";
  if (contract.includes(quoted)) return "contract";
  for (const p of prefixes) if (key.startsWith(p)) return "dynamic";
  return null;
}

/**
 * The **markup** half of a `.svelte` file: everything after `</script>`, before
 * `<style>`, with HTML comments removed. That is where a screen's user-visible copy
 * lives (a string in the `<script>` block is usually data — seeds, fixtures — so it
 * is deliberately out of scope; see docs/i18n-audit.md).
 */
export function markupOf(src) {
  const end = src.lastIndexOf("</script>");
  const after = end >= 0 ? src.slice(end + "</script>".length) : src;
  const style = after.indexOf("<style");
  const html = style >= 0 ? after.slice(0, style) : after;
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * Hard-coded, user-visible literals in a `.svelte` **markup** section: text nodes,
 * translatable attributes, and any string literal (so copy inside a `{…}`
 * expression counts too). Returns `[{ literal, kind }]` — the copy a localised UI
 * must not hard-code in one language.
 */
export function hardcodedCopy(src) {
  const html = markupOf(src);
  const out = [];
  const push = (literal, kind) => {
    const t = literal.trim();
    if (t !== "" && CJK.test(t)) out.push({ literal: t, kind });
  };
  for (const m of html.matchAll(/(?:title|placeholder|alt|aria-label)="([^"]*)"/g)) push(m[1], "attr");
  for (const m of html.matchAll(/>([^<>{}]+)</g)) push(m[1], "text");
  // String literals anywhere in the markup (e.g. `{cond ? langLabel(x) : "源"}`).
  for (const m of html.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) push(m[1], "literal");
  return out;
}

// --- files ------------------------------------------------------------------
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "target" || ent.name === ".git") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
const TEST_RE = /(\.test\.|\.spec\.|\/__tests__\/)/;
const readAll = (files) => files.map((f) => readFileSync(f, "utf8")).join("\n");

function prodFiles() {
  return walk(join(root, "src"))
    .filter((f) => /\.(ts|svelte)$/.test(f))
    .filter((f) => !TEST_RE.test(f))
    .filter((f) => !/\/i18n\/locales\//.test(f));
}

function buildCorpus() {
  const src = join(root, "src");
  const prod = prodFiles();
  const testFiles = [
    ...walk(src).filter((f) => /\.(ts|svelte)$/.test(f) && TEST_RE.test(f)),
    ...walk(join(root, "svelte-tests")).filter((f) => /\.ts$/.test(f)),
  ];
  const contractFiles = [
    ...walk(join(repo, "crates")).filter((f) => f.endsWith(".rs")),
    ...walk(join(repo, "proto")).filter((f) => f.endsWith(".proto")),
  ];
  return {
    prod: readAll(prod),
    prodSources: prod.map((f) => ({ file: f, src: readFileSync(f, "utf8") })),
    tests: readAll(testFiles),
    contract: readAll(contractFiles),
    prefixes: dynamicPrefixes(prod.map((f) => readFileSync(f, "utf8"))),
  };
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const d = parseDict('export const zh = {\n  "a.b": "x {n}",\n  "c": "plain",\n};\n');
  ok("parseDict reads keys/values", d.size === 2 && d.get("a.b") === "x {n}");
  ok("placeholders sorted+unique", placeholders("{b} {a} {a}").join(",") === "a,b");
  ok("placeholders empty", placeholders("none").length === 0);

  const pre = dynamicPrefixes(['t(`message.folder.${f}`)', 't("x")']);
  ok("dynamic prefix found", pre.has("message.folder.") && !pre.has("x"));

  const svelte = [
    "<script lang=\"ts\">const a = \"数据\";</script>",
    "<div>",
    "  <!-- 注释里的中文不算 -->",
    "  <button title=\"提示\">保存</button>",
    "  <input placeholder=\"开始输入…\" />",
    "  <span>{cond ? langLabel(x) : \"源\"}</span>",
    "  <b>{t(\"note.add\")}</b>",
    "</div>",
    "<style>.a { content: \"样式\"; }</style>",
  ].join("\n");
  const copy = hardcodedCopy(svelte);
  const lits = copy.map((c) => c.literal);
  ok("markup text copy is found", lits.includes("保存"));
  ok("attribute copy is found", lits.includes("提示") && lits.includes("开始输入…"));
  ok("copy inside a {…} expression is found", lits.includes("源"));
  ok("a script-side literal is out of scope", !lits.includes("数据"));
  ok("an HTML comment is not copy", !lits.includes("注释里的中文不算"));
  ok("a <style> block is not copy", !lits.includes("样式"));
  ok("a t(...) key is not copy", !lits.includes("note.add"));
  ok("plain markup yields nothing", hardcodedCopy("<div>ok</div>").length === 0);

  const prod = 'const s = "a.b" + t("keep.me");';
  const contract = 'reason_key: "care.uninstall.protected"';
  ok("live via prod", isLive("a.b", prod, contract, pre) === "prod");
  ok("live via contract", isLive("care.uninstall.protected", prod, contract, pre) === "contract");
  ok("live via dynamic prefix", isLive("message.folder.sent", prod, contract, pre) === "dynamic");
  ok("dead key", isLive("nobody.uses.me", prod, contract, pre) === null);

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[i18n-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[i18n-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
if (process.argv.includes("--selftest")) runSelftest();

// --- scan -------------------------------------------------------------------
const en = parseDict(readFileSync(join(root, "src/i18n/locales/en.ts"), "utf8"));
const zh = parseDict(readFileSync(join(root, "src/i18n/locales/zh.ts"), "utf8"));

const allowPath = join(root, "scripts", "i18n-allowlist.json");
let allow = [];
if (existsSync(allowPath)) {
  allow = JSON.parse(readFileSync(allowPath, "utf8"));
  for (const e of allow) {
    if (!e.key || !e.reason || !String(e.reason).trim()) {
      console.error(`[i18n-scan] allow-entry without key+reason: ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }
}
const allowed = new Set(allow.map((e) => e.key));

// Check 4 — hard-coded markup copy. Allow-listed literals are deliberate (a
// language's own name, a symbol): `{ literal, reason }`.
const literalAllowPath = join(root, "scripts", "i18n-literal-allowlist.json");
let literalAllow = [];
if (existsSync(literalAllowPath)) {
  literalAllow = JSON.parse(readFileSync(literalAllowPath, "utf8"));
  for (const e of literalAllow) {
    if (!e.literal || !e.reason || !String(e.reason).trim()) {
      console.error(`[i18n-scan] literal allow-entry without literal+reason: ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }
}
const allowedLiterals = new Set(literalAllow.map((e) => e.literal));

const corpus = buildCorpus();
const hardcoded = [];
const seenCopy = new Set();
for (const { file, src } of corpus.prodSources) {
  if (!file.endsWith(".svelte")) continue;
  const rel = file.slice(file.indexOf("/src/") + 1);
  for (const { literal, kind } of hardcodedCopy(src)) {
    if (allowedLiterals.has(literal)) continue;
    // One line per (file, literal): the same `title="…"` matches the attribute and
    // the literal rule, and a toolbar repeated twice is one defect to fix.
    const key = `${rel}::${literal}`;
    if (seenCopy.has(key)) continue;
    seenCopy.add(key);
    hardcoded.push({ file: rel, literal, kind });
  }
}

const keyErrors = [];
const placeholderErrors = [];
for (const k of en.keys()) {
  if (!zh.has(k)) keyErrors.push(`missing in zh: ${k}`);
  else {
    const a = placeholders(en.get(k)).join(",");
    const b = placeholders(zh.get(k)).join(",");
    if (a !== b) placeholderErrors.push(`${k}: en=[${a}] zh=[${b}]`);
  }
}
for (const k of zh.keys()) if (!en.has(k)) keyErrors.push(`missing in en: ${k}`);

const dead = [];
const deadTestOnly = [];
for (const k of zh.keys()) {
  if (allowed.has(k)) continue;
  if (isLive(k, corpus.prod, corpus.contract, corpus.prefixes)) continue;
  if (corpus.tests.includes(`"${k}"`)) deadTestOnly.push(k);
  else dead.push(k);
}
dead.sort();
deadTestOnly.sort();

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        keys: { en: en.size, zh: zh.size },
        keyErrors,
        placeholderErrors,
        dead,
        deadTestOnly,
        hardcoded,
        prefixes: [...corpus.prefixes].sort(),
        allowlisted: [...allowed].sort(),
        allowlistedLiterals: [...allowedLiterals].sort(),
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[i18n-scan] ${zh.size} key(s) (en ${en.size}); ${corpus.prefixes.size} dynamic namespace(s); ` +
      `${allow.length} allow-listed key(s); ${literalAllow.length} allow-listed literal(s).`,
  );
  if (keyErrors.length === 0) console.log("[i18n-scan] OK — en and zh expose the same keys.");
  if (placeholderErrors.length === 0) {
    console.log("[i18n-scan] OK — en and zh agree on every {param} set.");
  }
  if (dead.length === 0 && deadTestOnly.length === 0) {
    console.log(
      "[i18n-scan] OK — every dictionary key is referenced by production (or a contract/allow-list).",
    );
  }
  for (const e of keyErrors) console.error(`[i18n-scan] FAIL — ${e}`);
  for (const e of placeholderErrors) console.error(`[i18n-scan] FAIL — placeholder mismatch ${e}`);
  for (const k of dead) console.error(`[i18n-scan] FAIL — dead key (referenced nowhere): ${k}`);
  for (const k of deadTestOnly) {
    console.error(`[i18n-scan] FAIL — dead key (only a test references it): ${k}`);
  }
  for (const h of hardcoded) {
    console.error(
      `[i18n-scan] FAIL — hard-coded copy in markup: ${h.file} ${h.kind} ${JSON.stringify(h.literal)} ` +
        "(use t(...) so both locales can read it)",
    );
  }
  if (hardcoded.length === 0) {
    console.log("[i18n-scan] OK — no user-visible copy is hard-coded in a .svelte markup section.");
  }
}

process.exit(
  keyErrors.length === 0 &&
    placeholderErrors.length === 0 &&
    dead.length === 0 &&
    deadTestOnly.length === 0 &&
    hardcoded.length === 0
    ? 0
    : 1,
);

