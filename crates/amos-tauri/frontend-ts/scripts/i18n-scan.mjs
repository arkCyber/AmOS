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
 *      An exemption that no longer earns its reason is itself a finding (check 9,
 *      REQ-A353): `live` (production references the key now, so the entry hides
 *      nothing) or `absent` (the key is in **neither** dictionary, so it protects
 *      nothing). An allow-list nobody prunes swallows the next real dead key.
 *      A dead key is a **hard gate** (no baseline): after this audit the dictionary
 *      has none, and any future one is a real defect, not debt.
 *   4. **Hard-coded CJK copy in markup** — text nodes / translatable attributes /
 *      string literals containing Chinese (the dictionary's own language).
 *   5. **Hard-coded English copy in markup** — the other half, added after audit:
 *      check 4 keys off the CJK character set, so English literals were invisible to
 *      it, and the always-on status bar had been rendering `aria-label="network
 *      status"`, `title="Do Not Disturb"`, `battery: charging 80%` … into a zh+en UI
 *      (REQ-A180). A **multi-word** English literal in `title`/`placeholder`/`alt`/
 *      `aria-label` or a text node is copy; the single-token ASCII values the DOM
 *      tests select by (`aria-label="block-add"`) are hooks. Both checks share
 *      `scripts/i18n-literal-allowlist.json`. **Scope (honest):** anything inside
 *      `<script>` is out; the non-copy single tokens that remain (`HDR`, `A`, the
 *      `debug`/`info`/`warn`/`error` levels) are allow-listed with a reason, so a
 *      *new* one shows up as a finding rather than a silent pass.
 *   6. **A test-hook id used as an accessible name** — `aria-label="note-compose"`,
 *      `title="block-add"`: read out verbatim by a screen reader, and it *overrides*
 *      the control's own visible text. Check 5 deliberately steps around these (the
 *      separator makes them not-copy), so this is where they are caught: 60 were
 *      moved to `data-testid` in REQ-A182, with a real `t(...)` name where the
 *      control needs one. Hard gate.
 *   7. **A `t("…")` reference the dictionary cannot answer** (REQ-A183). Checks 1–3
 *      audit the *dictionary* side (parity, placeholders, dead keys); nothing audited
 *      the *reference* side. Two ways a call site lies to the user, both invisible to
 *      `tsc`/`svelte-check` because `t()` takes `key: string` (`./locale.svelte.ts`)
 *      and `translate()` falls back to `const base = raw ?? key`
 *      (`./i18n.ts`): a key that does not exist renders **the key itself** into the
 *      UI (`note.back`), and a call that omits a `{param}` the string needs renders
 *      **`{param}`** (`String(params[k] ?? \`{${k}}\`)`). Neither is a typo a user
 *      would report as a bug. 1 124 literal references and 125 param-carrying calls
 *      were clean when this check landed; the gate is what keeps them that way.
 *   8. **An interactive element with no usable accessible name** (REQ-A183) — the
 *      other half of check 6, and the mistake check 6's migration could make: moving
 *      a hook to `data-testid` and dropping the label from a control whose *content*
 *      is only a glyph (`>‹</button>`), which leaves a screen reader announcing
 *      "‹, button" — or nothing at all when the icon sits in an `aria-hidden` span.
 *      A name counts when it is `aria-label`/`aria-labelledby`/`title`, the
 *      `placeholder` of a text field, a `<label>` (wrapping or `for=`), or visible
 *      text/`{…}` outside `aria-hidden` subtrees. Hard gate.
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
  // **两种引号都算引用**。代码库里 `t("nc.title")` 与 `t('airplay.title')` 并存，
  // 而这里原先只找双引号 ⇒ 一个只用单引号的组件（`AirPlayPanel.svelte` 通篇是
  // 单引号）会让它**真正在用**的键被报成"死键"，逼出错误的豁免条目
  // （REQ-A384：20 个 airplay 死键里有一半其实是活的）。
  const doubleQuoted = `"${key}"`;
  const singleQuoted = `'${key}'`;
  if (prod.includes(doubleQuoted) || prod.includes(singleQuoted)) return "prod";
  if (contract.includes(doubleQuoted) || contract.includes(singleQuoted)) return "contract";
  for (const p of prefixes) if (key.startsWith(p)) return "dynamic";
  return null;
}

/**
 * Allow-list entries that no longer earn their exemption (REQ-A353).
 *
 * The allow-list admits dictionary keys that **no code can reach**, each with a written
 * reason. Two ways an entry stops being that and becomes a lie instead:
 *
 *   - `live`   — production references the key now, so the exemption hides nothing (and
 *                the dead-key gate would pass without it). The reason text is stale too:
 *                it usually still says "not yet wired" about something that is wired.
 *   - `absent` — the key is in **neither** dictionary, so the entry protects nothing at
 *                all. (A key that is only in one dictionary is *not* this: the parity
 *                check owns that, and the exemption still exempts the locale that has it.)
 *
 * Both are findings. The other scans in this repo prune their exemptions the same way
 * (`orphan-test-scan`, `unwired-scan`): an allow-list nobody prunes quietly swallows the
 * *next* real dead key, which is the whole failure mode it was meant to expose.
 */
export function staleAllowList(allow, isReferenced, inDictionaries) {
  const out = [];
  for (const e of allow) {
    if (!inDictionaries(e.key)) out.push({ key: e.key, kind: "absent" });
    else if (isReferenced(e.key)) out.push({ key: e.key, kind: "live" });
  }
  return out;
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
 * English copy shapes: multiple words, **or a single all-letters word**.
 *
 * Single words are included because an icon-only control's accessible name is
 * usually one word (`aria-label="lock"`, `"shutter"`, `"backspace"`) — the case
 * that A180 could not decide and left out. What keeps it decidable is the
 * *separator*: every test hook in this corpus is kebab/snake/slug
 * (`block-add`, `spotlight-new-note`, `note-compose`), i.e. contains `-`, `_` or
 * `.`, while copy never does. Non-copy single tokens that remain (`HDR`, `A`, the
 * `debug`/`info`/`warn`/`error` log levels) are excused in
 * `scripts/i18n-literal-allowlist.json` with a reason.
 */
const MULTIWORD_EN = /^[A-Za-z][A-Za-z'\u2019-]*(?:[ ][A-Za-z][A-Za-z'\u2019-]*)+[.!?]?$/;
const ONEWORD_EN = /^[A-Za-z]+$/;
const isEnglishCopy = (t) => MULTIWORD_EN.test(t) || ONEWORD_EN.test(t);

/**
 * An id shaped like a test hook (`note-compose`, `block-add`, `new-sms-to`). Never a
 * usable accessible name, which is why check 6 exists (see `slugLabel`).
 */
const SLUG_ID = /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/;

/**
 * Hard-coded, user-visible literals in a `.svelte` **markup** section: text nodes,
 * translatable attributes, and any string literal (so copy inside a `{…}`
 * expression counts too). Returns `[{ literal, kind }]` — the copy a localised UI
 * must not hard-code in one language.
 */
/**
 * Copy written **inline in a `<script>` block** — the half `hardcodedCopy` cannot see
 * (REQ-A357).
 *
 * `hardcodedCopy` reads the markup section only, so a message built inside the script block
 * (`exportMsg = "已复制 .md 到剪贴板（未连接后端）"`) was invisible to **every** gate — which is
 * precisely how it shipped, in Chinese, to every locale, while `i18n-scan` stayed green
 * (F-SH-020, F-SH-022).
 *
 * The shape is deliberately narrow: a CJK string literal that is the **right-hand side of an
 * assignment** or a `$state(...)`/`$derived(...)` initialiser. A data table
 * (`const CITIES = ["北京", …]`) is *not* matched — its elements are not assignments — because
 * place names, seeds and fixtures are data, not copy, and flagging them would bury the real
 * findings under a list nobody reads. Comments are skipped for the same reason.
 */
export function assignedCJKCopy(src) {
  const end = src.indexOf("</script>");
  const body = end >= 0 ? src.slice(0, end) : src;
  const out = [];
  const re =
    /(?:\$state\(\s*|\$derived\(\s*|(?<![\w.$])[A-Za-z_$][\w$]*\s*=\s*)(["'`])((?:\\.|(?!\1).)*)\1/g;
  body.split("\n").forEach((line, i) => {
    const stripped = line.trimStart();
    if (stripped.startsWith("//") || stripped.startsWith("*")) return;
    for (const m of line.matchAll(re)) {
      const literal = m[2] ?? "";
      if (CJK.test(literal)) out.push({ line: i + 1, literal, kind: "script" });
    }
  });
  return out;
}

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

/**
 * English copy in a translatable attribute or text node: **multi-word** English, or
 * a **single all-letters word** (see `isEnglishCopy` for why the separator decides).
 *
 * `hardcodedCopy` (above) keys off the CJK character set, so non-CJK hard-coded copy
 * is invisible to it — the gap `docs/i18n-audit.md` records ("非 CJK 语言（如纯英文硬编码）
 * 不在此门内"). This is the missing half, and it is the check that found the
 * status bar's `aria-label="network status"` / `title="Do Not Disturb"` and 23 more
 * icon-only control names rendered in English inside a zh+en OS (REQ-A180).
 *
 * Why a *word-count* threshold: the single-token ASCII values the DOM tests select
 * by (`aria-label="block-add"`, `"spotlight-new-note"`, `"note-compose"` …) are test
 * hooks, not copy, and they cannot be told apart from one-word labels
 * (`aria-label="lock"`) by static analysis. Requiring at least two space-separated
 * words makes the two decidable in practice: no hook in this repo's corpus is
 * multi-word, and every real label is. Scope, honestly: one-word English labels and
 * anything inside `<script>` stay out of reach.
 */
export function englishCopy(src) {
  const html = markupOf(src);
  const out = [];
  const push = (literal, kind) => {
    const t = literal.trim();
    if (t !== "" && isEnglishCopy(t)) out.push({ literal: t, kind });
  };
  for (const m of html.matchAll(/(?:title|placeholder|alt|aria-label)="([^"]*)"/g)) push(m[1], "attr");
  for (const m of html.matchAll(/>([^<>{}]+)</g)) push(m[1], "text");
  return out;
}

/**
 * `aria-label` / `title` values shaped like a **test-hook id** (`note-compose`,
 * `block-add`, `spotlight-new-note`).
 *
 * A screen reader reads the accessible name out verbatim, so a hook used as one
 * announces "block-add" — worse than English copy, and it also *overrides* any
 * visible text the control already has. This check found 60 of them across 9
 * components (REQ-A182): each was moved to `data-testid` (the hook keeps its value,
 * so the DOM tests only changed the attribute they select on), and the controls that
 * need a name got one — an existing key where the feature already rendered it, or a
 * new one.
 *
 * The rule is decidable for the same reason check 5's is: copy never contains `-`,
 * `_` or `.` as a word separator, hooks always do.
 */
export function slugLabel(src) {
  const html = markupOf(src);
  const out = [];
  for (const m of html.matchAll(/(aria-label|title)="([^"]*)"/g)) {
    const value = m[2].trim();
    if (value !== "" && SLUG_ID.test(value)) out.push({ literal: value, kind: m[1] });
  }
  return out;
}

/**
 * Top-level argument sources of the call whose `(` sits at `open`:
 * `callArgs("f(a, g(b, c), d)", 1)` → `["a", "g(b, c)", "d"]`. Quote/bracket aware so
 * a comma inside a string, template, array or object never splits an argument.
 * `null` when the call is unterminated.
 */
export function callArgs(src, open) {
  const out = [];
  let start = open + 1;
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i += 1;
      while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
    } else if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") {
      if (depth === 0) {
        out.push(src.slice(start, i).trim());
        return out;
      }
      depth -= 1;
    } else if (c === "," && depth === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  return null;
}

/**
 * Literal `t("key")` / `` t(`key`) `` references in a source, each with the params the
 * call supplies. `supplied` is the literal property-name list of a params **object
 * literal** (`{ addr }` shorthand included), `[]` when the call passes none, and
 * `null` when it cannot be decided statically (a variable, a call, or a spread) —
 * the honest boundary, counted rather than guessed.
 */
export function keyRefs(src) {
  const out = [];
  for (const m of src.matchAll(/\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|`([^`$]*)`)/g)) {
    const key = (m[1] ?? m[2]).replace(/\\(.)/g, "$1");
    const args = callArgs(src, src.indexOf("(", m.index));
    if (args === null) continue;
    const expr = args.length > 1 ? args[1] : null;
    let supplied = [];
    if (expr !== null) {
      if (!/^\{[\s\S]*\}$/.test(expr) || /\.\.\./.test(expr)) supplied = null;
      else {
        supplied = [
          ...expr.matchAll(/(?:^|[,{])\s*(?:([A-Za-z_$][\w$]*)|"((?:[^"\\]|\\.)*)")\s*(?=[,:=}])/g),
        ].map((p) => p[1] ?? p[2]);
      }
    }
    out.push({ key, supplied });
  }
  return out;
}

/**
 * The two ways a call site can disagree with the dictionary: the key does not exist
 * (renders the key itself), or the value needs a `{param}` the call does not pass
 * (renders `{param}`). `dict` is the base (`zh`) dictionary — key parity makes the
 * other locale equivalent.
 */
export function keyRefProblems(refs, dict) {
  const out = [];
  for (const { key, supplied } of refs) {
    const value = dict.get(key);
    if (value === undefined) {
      out.push({ key, kind: "missing", lack: [] });
      continue;
    }
    if (supplied === null) continue;
    const need = placeholders(value);
    const lack = need.filter((p) => !supplied.includes(p));
    if (lack.length) out.push({ key, kind: "params", lack });
  }
  return out;
}

/**
 * Index of the `</name>` that closes the element opened at `tagStart` (nesting aware),
 * or `html.length` when unterminated.
 */
function elementEnd(html, tagStart, name) {
  const openEnd = html.indexOf(">", tagStart);
  if (openEnd < 0) return html.length;
  let i = openEnd + 1;
  let depth = 1;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return html.length;
    if (html.startsWith(`</${name}`, lt)) {
      depth -= 1;
      if (depth === 0) return lt;
    } else if (html.startsWith(`<${name}`, lt)) {
      const gt = html.indexOf(">", lt);
      if (gt > 0 && html[gt - 1] !== "/") depth += 1;
    }
    i = lt + 1;
  }
  return html.length;
}

/** The markup between an element's opening tag and its closing tag. */
function elementBody(html, tagStart, name) {
  const openEnd = html.indexOf(">", tagStart);
  if (openEnd < 0 || html[openEnd - 1] === "/") return "";
  return html.slice(openEnd + 1, elementEnd(html, tagStart, name));
}

/** Remove every `aria-hidden` subtree — its text and icons name nothing. */
function dropAriaHidden(s) {
  let out = s;
  for (let guard = 0; guard < 200; guard += 1) {
    const m = /<([a-zA-Z][\w-]*)\b[^>]*\baria-hidden(?:="[^"]*")?[^>]*>/.exec(out);
    if (!m) break;
    const name = m[1];
    const openEnd = out.indexOf(">", m.index);
    const close = out.indexOf(`</${name}>`, openEnd);
    out =
      close < 0
        ? out.slice(0, m.index) + " " + out.slice(openEnd + 1)
        : out.slice(0, m.index) + " " + out.slice(close + name.length + 3);
  }
  return out;
}

/**
 * What an element's content contributes to its accessible name:
 * `{ dynamic }` — a `{…}` expression can render localised text, so the element names
 * itself; otherwise `{ text, symbol }`, where `symbol` means the only text left is
 * glyphs/emoji (`‹`, `✕`, `＋`) — a name a screen reader cannot read out as a word.
 */
function contentName(body) {
  const cleaned = dropAriaHidden(body)
    .replace(/\{@html[^}]*\}/g, " ")
    .replace(/\{@(?:const|debug)[^}]*\}/g, " ")
    .replace(/\{[#:/][^}]*\}/g, " ");
  if (/\{[^}]*\}/.test(cleaned)) return { dynamic: true, text: "", symbol: false };
  const text = cleaned
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return { dynamic: false, text: "", symbol: false };
  return { dynamic: false, text, symbol: !/[\p{L}\p{N}]/u.test(text) };
}

/** Widget roles that are useless without a name (ARIA "Name Required: true"). */
const WIDGET_ROLE =
  /role="(button|link|checkbox|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|radio|slider|spinbutton|combobox|textbox|searchbox|progressbar|img|dialog|alertdialog|region|tablist)"/;
const INTERACTIVE_TAG = new Set(["button", "a", "summary", "select", "textarea", "input"]);

/**
 * Interactive elements in a `.svelte` markup section that expose **no usable
 * accessible name**: nothing a screen reader could read out, or only a glyph
 * (check 8; see the header). A name counts when it is `aria-label`/`aria-labelledby`/
 * `title`, the `placeholder` of a text field, a `<label>` (wrapping this element, or
 * linked via `for=`), or visible text / `{…}` outside `aria-hidden` subtrees.
 */
export function nameProblems(src) {
  const html = markupOf(src);
  const out = [];
  const labels = [...html.matchAll(/<label\b[^>]*>/g)].map((m) => [
    m.index,
    elementEnd(html, m.index, "label"),
  ]);
  const forIds = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
  const seen = new Set();
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    if (!(INTERACTIVE_TAG.has(tag) || WIDGET_ROLE.test(attrs))) continue;
    if (tag === "a" && !/\bhref=/.test(attrs)) continue; // a bare anchor is not a control
    if (/\baria-hidden=|\btype="hidden"/.test(attrs)) continue;
    // A name attribute counts in any form the UI uses it — a literal (`title="Lock"`)
    // or an expression (`aria-label={t("a11y.lock")}`) — but an *empty* literal does not
    // (accname: it contributes nothing).
    const nameAttr = /\b(aria-label|aria-labelledby|title)=(?:"([^"]*)"|\{)/.exec(attrs);
    if (nameAttr !== null && nameAttr[2] !== "") continue;
    if (/\bvalue=(?:"[^"]+"|\{)/.test(attrs)) continue; // submit/button inputs name themselves
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (id && forIds.has(id)) continue; // linked <label for="…">
    if (labels.some(([a, b]) => m.index > a && m.index < b)) continue; // wrapped by <label>
    if (
      (tag === "input" || tag === "textarea" || tag === "select") &&
      /\bplaceholder=(?:"[^"]+"|\{)/.test(attrs)
    ) {
      continue; // a text field's placeholder is a weak name, but a name
    }
    const body = elementBody(html, m.index, tag);
    const name = contentName(body);
    if (name.dynamic || (name.text !== "" && !name.symbol)) continue;
    const inner = body.replace(/\s+/g, " ").trim().slice(0, 40);
    const key = `${tag}::${inner}::${name.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tag, why: name.symbol ? "symbol" : "none", inner });
  }
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
  // Script-block copy (REQ-A357) — the shape that hid F-SH-020's hard-coded Chinese.
  ok(
    "an assigned CJK literal is copy",
    assignedCJKCopy('<script>let m = $state(""); m = "已复制到剪贴板";</script>').length === 1,
  );
  ok(
    "a $state() CJK initialiser is copy",
    assignedCJKCopy('<script>let label = $state("北京");</script>').length === 1,
  );
  ok(
    "a CJK data table is not copy",
    assignedCJKCopy('<script>const CITIES = ["北京", "上海"];</script>').length === 0,
  );
  ok(
    "a CJK comment is not copy",
    assignedCJKCopy("<script>// 已复制到剪贴板\nlet x = 1;</script>").length === 0,
  );
  ok(
    "a t(...) call is not copy",
    assignedCJKCopy('<script>let m = t("note.exportCopyFailed");</script>').length === 0,
  );

  const enMarkup = [
    '<button aria-label="Edit home screen"></button>',
    '<button aria-label="block-add" title="zoom in"></button>',
    '<button aria-label={t("a11y.editHome")}></button>',
    "<span>Hello there</span>",
    '<span aria-label="保存"></span>',
    '<div data-testid="spotlight-new-note"></div>',
  ].join("\n");
  const enLits = englishCopy(enMarkup).map((c) => c.literal);
  ok("multi-word English attr is flagged", enLits.includes("Edit home screen"));
  ok("multi-word English title is flagged", enLits.includes("zoom in"));
  ok("multi-word English text node is flagged", enLits.includes("Hello there"));
  ok("a single-token ASCII hook is NOT copy", !enLits.includes("block-add"));
  ok("a data-testid value is NOT scanned", !enLits.includes("spotlight-new-note"));
  ok("a t(...) key is not English copy", !enLits.some((l) => l.includes("a11y.")));
  ok("CJK copy is left to the CJK check", !enLits.includes("保存"));

  const oneWord = [
    '<button aria-label="lock"></button>',
    '<button aria-label="backspace" title="end"></button>',
    "<span>HDR</span>",
    '<button aria-label="note-compose"></button>',
    '<button aria-label="quarantine-copy"></button>',
  ].join("\n");
  const oneWordLits = englishCopy(oneWord).map((c) => c.literal);
  ok("a one-word label IS copy", oneWordLits.includes("lock") && oneWordLits.includes("end"));
  ok("a one-word text node IS copy", oneWordLits.includes("HDR"));
  ok("kebab/snake/slug hooks are NOT copy", !oneWordLits.includes("note-compose") && !oneWordLits.includes("quarantine-copy"));

  const slugSrc = [
    '<button aria-label="note-compose"></button>',
    '<button title="block-add"></button>',
    '<input aria-label="new-sms-to" />',
    '<button data-testid="note-compose"></button>',
    '<button aria-label={t("a11y.send")}></button>',
    '<button aria-label="Backspace"></button>',
  ].join("\n");
  const slugs = slugLabel(slugSrc).map((s) => s.literal);
  ok("a slug aria-label is flagged", slugs.includes("note-compose") && slugs.includes("new-sms-to"));
  ok("a slug title is flagged", slugs.includes("block-add"));
  ok("the same id as data-testid is not flagged", slugs.filter((s) => s === "note-compose").length === 1);
  ok("a localised label is not a slug", !slugs.includes("a11y.send") && !slugs.includes("Backspace"));

  const args = callArgs('f(a, g(b, c), "d,e", { x: [1, 2] })', 1);
  ok("callArgs splits top-level args", args !== null && args.length === 4);
  ok("callArgs keeps a nested call whole", args[1] === "g(b, c)");
  ok("callArgs keeps a comma inside a string", args[2] === '"d,e"');
  ok("callArgs is unterminated-safe", callArgs("f(a", 1) === null);

  const refs = keyRefs(
    't("a.b", { n: v }) + t("a.b", { n }) + t(`c`) + t("a.b", { ...rest }) + t("a.b", p) + t(dyn)',
  );
  ok("keyRefs reads a string key", refs.filter((r) => r.key === "a.b").length === 4);
  ok("keyRefs reads an object-literal param", refs[0].supplied.join() === "n");
  ok("keyRefs reads a shorthand param", refs[1].supplied.join() === "n");
  ok("keyRefs reads a param-less template key", refs[2].key === "c" && refs[2].supplied.length === 0);
  ok("keyRefs refuses to guess a spread", refs[3].supplied === null);
  ok("keyRefs refuses to guess a variable", refs[4].supplied === null);
  ok("keyRefs ignores a dynamic key", refs.length === 5);

  const dict2 = parseDict('export const zh = {\n  "a.b": "x {n}",\n  "c": "plain",\n};\n');
  const probs = keyRefProblems(
    keyRefs('t("gone") + t("a.b") + t("a.b", { n: 1 }) + t("c", { n: 1 }) + t("a.b", p)'),
    dict2,
  );
  ok("a key the dictionary lacks is a finding", probs.some((p) => p.key === "gone" && p.kind === "missing"));
  ok("an unfilled {param} is a finding", probs.some((p) => p.key === "a.b" && p.lack.join() === "n"));
  ok("a filled {param} is not a finding", probs.filter((p) => p.key === "a.b").length === 1);
  ok("an extra param is not a finding", !probs.some((p) => p.key === "c"));
  ok("an unreadable params shape is not a finding", keyRefProblems(keyRefs('t("a.b", p)'), dict2).length === 0);

  const a11yNames = [
    '<button data-testid="note-editor-back">‹</button>',
    '<button>{t("a.b")}</button>',
    '<button aria-label={t("a.b")}></button>',
    '<button title={t("a.b")}><span aria-hidden="true">✕</span></button>',
    '<button data-testid="x"><span aria-hidden="true">✕</span></button>',
    '<button data-icon="send">{@html iconSvg("send")}</button>',
    '<div role="region" data-testid="pane"></div>',
    '<div role="presentation"></div>',
    '<input type="checkbox" data-testid="pref" />',
    '<input type="checkbox" placeholder="x" />',
    '<label class="p"><input type="checkbox" /> text</label>',
    '<label for="i1">text</label><select id="i1"></select>',
    '<a href="#x">Go</a>',
    '<a href="#x">{@html iconSvg("x")}</a>',
    '<a>bare</a>',
  ].join("\n");
  const named = nameProblems(a11yNames);
  ok("a glyph-only control is a finding", named.some((n) => n.tag === "button" && n.why === "symbol"));
  ok("a data-testid is not a name", named.filter((n) => n.tag === "button").length === 3);
  ok("a t(...) body names the control", !named.some((n) => n.inner.includes('t("a.b")')));
  ok("an aria-hidden icon names nothing", named.some((n) => n.why === "none" && n.inner.includes("✕")));
  ok("a role needing a name is checked", named.some((n) => n.tag === "div"));
  ok("a presentational role is left alone", !named.some((n) => n.inner.includes("presentation")));
  ok("an unlabelled checkbox is a finding", named.filter((n) => n.tag === "input").length === 1);
  ok("a wrapping <label> names a field", !named.some((n) => n.inner.includes("checkbox") && n.tag === "input" && n.why === "symbol"));
  ok("a for= link names a field", !named.some((n) => n.tag === "select"));
  ok("a link with icon-only content is a finding", named.some((n) => n.tag === "a"));
  ok("a href-less anchor is not a control", named.filter((n) => n.tag === "a").length === 1);

  const prod = 'const s = "a.b" + t("keep.me");';
  const contract = 'reason_key: "care.uninstall.protected"';
  ok("live via prod", isLive("a.b", prod, contract, pre) === "prod");
  ok("live via contract", isLive("care.uninstall.protected", prod, contract, pre) === "contract");
  ok("live via dynamic prefix", isLive("message.folder.sent", prod, contract, pre) === "dynamic");
  ok("dead key", isLive("nobody.uses.me", prod, contract, pre) === null);
  // 负控：只用单引号的引用也必须算"活的" —— 放开这条就是原缺陷（REQ-A384）。
  ok(
    "a single-quoted reference counts as live",
    isLive("single.quoted", "const x = t('single.quoted');", "", new Set()) === "prod",
  );
  ok(
    "a single-quoted contract key counts as live",
    isLive("care.protected", "", "reason_key: 'care.protected'", new Set()) === "contract",
  );

  // A stale exemption (REQ-A353): the entry exists, the reason does not hold any more.
  const allowDemo = [
    { key: "live.now", reason: "r" },
    { key: "gone.away", reason: "r" },
    { key: "still.dark", reason: "r" },
  ];
  const staleDemo = staleAllowList(
    allowDemo,
    (k) => k === "live.now",
    (k) => k !== "gone.away",
  );
  ok("an exemption whose key production references now is stale", staleDemo.some((e) => e.key === "live.now" && e.kind === "live"));
  ok("an exemption whose key left the dictionaries is stale", staleDemo.some((e) => e.key === "gone.away" && e.kind === "absent"));
  ok("an exemption that still earns its reason is kept", !staleDemo.some((e) => e.key === "still.dark"));

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

// Check 5 — English copy in markup (the other half of check 4; see englishCopy).
const english = [];
const seenEnglish = new Set();
for (const { file, src } of corpus.prodSources) {
  if (!file.endsWith(".svelte")) continue;
  const rel = file.slice(file.indexOf("/src/") + 1);
  for (const { literal, kind } of englishCopy(src)) {
    if (allowedLiterals.has(literal)) continue;
    const key = `${rel}::${literal}`;
    if (seenEnglish.has(key)) continue;
    seenEnglish.add(key);
    english.push({ file: rel, literal, kind });
  }
}

// Check 6 — a test-hook id used as an accessible name (see slugLabel).
const slugLabels = [];
const seenSlug = new Set();
for (const { file, src } of corpus.prodSources) {
  if (!file.endsWith(".svelte")) continue;
  const rel = file.slice(file.indexOf("/src/") + 1);
  for (const { literal, kind } of slugLabel(src)) {
    const key = `${rel}::${literal}`;
    if (seenSlug.has(key)) continue;
    seenSlug.add(key);
    slugLabels.push({ file: rel, literal, kind });
  }
}

// Check 7 — a `t(…)` reference the dictionary cannot answer (see keyRefProblems).
const unresolved = [];
const paramSites = [];
{
  const seen = new Set();
  for (const { file, src } of corpus.prodSources) {
    const rel = file.slice(file.indexOf("/src/") + 1);
    const refs = keyRefs(src);
    for (const r of refs) if (r.supplied === null) paramSites.push({ file: rel, key: r.key });
    for (const p of keyRefProblems(refs, zh)) {
      const key = `${rel}::${p.key}::${p.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unresolved.push({ file: rel, ...p });
    }
  }
}

// Check 8 — an interactive element with no usable accessible name (see nameProblems).
const nameless = [];
{
  const seen = new Set();
  for (const { file, src } of corpus.prodSources) {
    if (!file.endsWith(".svelte")) continue;
    const rel = file.slice(file.indexOf("/src/") + 1);
    for (const p of nameProblems(src)) {
      const key = `${rel}::${p.tag}::${p.why}::${p.inner}`;
      if (seen.has(key)) continue;
      seen.add(key);
      nameless.push({ file: rel, ...p });
    }
  }
}

// Check 10 (REQ-A357) — copy written inline in a `<script>` block (see `assignedCJKCopy`).
// This is the gate the NotesApp defect walked straight through: `hardcodedCopy` reads the
// markup section only, so a hard-coded Chinese message built in the script block was invisible
// while every check stayed green.
const scriptCopy = [];
{
  for (const { file, src } of corpus.prodSources) {
    if (!file.endsWith(".svelte")) continue;
    const rel = file.slice(file.indexOf("/src/") + 1);
    for (const h of assignedCJKCopy(src)) {
      if (allowedLiterals.has(h.literal)) continue;
      scriptCopy.push({ file: rel, ...h });
    }
  }
}

// A literal exemption that matches nothing any more is rot — the same discipline the key
// allow-list got in REQ-A353: an exemption nobody prunes hides the next real finding.
const staleLiterals = literalAllow
  .map((e) => e.literal)
  .filter((literal) => !corpus.prod.includes(literal));

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

// Check 9 (REQ-A353) — an exemption that no longer earns its reason.
const staleAllow = staleAllowList(
  allow,
  (k) => isLive(k, corpus.prod, corpus.contract, corpus.prefixes) !== null,
  (k) => zh.has(k) || en.has(k),
);

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
        english,
        slugLabels,
        unresolved,
        uncheckedParamSites: paramSites,
        nameless,
        prefixes: [...corpus.prefixes].sort(),
        allowlisted: [...allowed].sort(),
        staleAllowlist: staleAllow,
        allowlistedLiterals: [...allowedLiterals].sort(),
        scriptCopy,
        staleLiterals,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[i18n-scan] ${zh.size} key(s) (en ${en.size}); ${corpus.prefixes.size} dynamic namespace(s); ` +
      `${allow.length} allow-listed key(s); ${literalAllow.length} allow-listed literal(s).` +
      (staleAllow.length > 0 ? ` ${staleAllow.length} STALE allow-list entry/entries.` : ""),
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
  for (const e of staleAllow) {
    console.error(
      `[i18n-scan] FAIL — stale allow-list entry (${e.kind === "live" ? "production references this key now" : "this key is in neither dictionary"}): ${e.key} ` +
        "(delete the entry from scripts/i18n-allowlist.json — an exemption nobody prunes hides the next real dead key)",
    );
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
  for (const e of scriptCopy) {
    console.error(
      `[i18n-scan] FAIL — hard-coded copy in a <script> block: ${e.file}:${e.line} ${JSON.stringify(e.literal)} ` +
        "(build it with t(...) — the markup check cannot see this half)",
    );
  }
  if (scriptCopy.length === 0) {
    console.log("[i18n-scan] OK — no <script>-block copy is hard-coded in one language.");
  }
  for (const literal of staleLiterals) {
    console.error(
      `[i18n-scan] FAIL — stale literal exemption (no source contains it any more): ${JSON.stringify(literal)} ` +
        "(delete the entry from scripts/i18n-literal-allowlist.json)",
    );
  }
  for (const e of english) {
    console.error(
      `[i18n-scan] FAIL — English copy in markup: ${e.file} ${e.kind} ${JSON.stringify(e.literal)} ` +
        "(use t(...) so both locales can read it; kebab/snake/slug ids are treated as test hooks)",
    );
  }
  if (english.length === 0) {
    console.log(
      "[i18n-scan] OK — no English copy (multi-word or single-word) in a translatable attribute or text node.",
    );
  }
  for (const e of slugLabels) {
    console.error(
      `[i18n-scan] FAIL — test-hook id used as an accessible name: ${e.file} ${e.kind}=${JSON.stringify(e.literal)} ` +
        '(move the hook to data-testid and give the control a real name via t(...))',
    );
  }
  if (slugLabels.length === 0) {
    console.log("[i18n-scan] OK — no test-hook id is used as an inaccessible name.");
  }
  for (const u of unresolved) {
    const why =
      u.kind === "missing"
        ? `no such key — t() would render ${JSON.stringify(u.key)} to the user`
        : `missing {${u.lack.join("} {")}} — t() would render ${JSON.stringify(`{${u.lack[0]}}`)} to the user`;
    console.error(
      `[i18n-scan] FAIL — dictionary cannot answer a t(…) reference: ${u.file} t(${JSON.stringify(u.key)}) ${why} ` +
        "(tsc accepts it: t() takes `key: string`)",
    );
  }
  if (unresolved.length === 0) {
    console.log(
      `[i18n-scan] OK — every t("…") reference resolves and passes the {param}s it needs` +
        (paramSites.length > 0
          ? ` (${paramSites.length} call site(s) pass params in a shape static analysis cannot read — counted, not judged).`
          : "."),
    );
  }
  for (const n of nameless) {
    console.error(
      `[i18n-scan] FAIL — interactive element with no usable accessible name: ${n.file} <${n.tag}> ` +
        `${n.why === "symbol" ? `only a glyph (${JSON.stringify(n.inner)})` : "no name at all"} ` +
        "(give it aria-label={t(…)} — a glyph or an aria-hidden icon announces nothing)",
    );
  }
  if (nameless.length === 0) {
    console.log("[i18n-scan] OK — every interactive element exposes a readable accessible name.");
  }
}

process.exit(
  keyErrors.length === 0 &&
    placeholderErrors.length === 0 &&
    dead.length === 0 &&
    deadTestOnly.length === 0 &&
    hardcoded.length === 0 &&
    scriptCopy.length === 0 &&
    staleLiterals.length === 0 &&
    english.length === 0 &&
    staleAllow.length === 0 &&
    slugLabels.length === 0 &&
    unresolved.length === 0 &&
    nameless.length === 0
    ? 0
    : 1,
);

