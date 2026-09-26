#!/usr/bin/env node
/**
 * read-fold-scan.mjs — "a refused read folded into an absence".
 *
 * Why: `invoke()` in `src/lib/backend.ts` **never rejects**. A refused command answers
 * `null` — and every read wrapper is declared `Promise<T | null>`, so `null` is the
 * documented failure value. The idiom that erases it is the null-coalesce:
 *
 *     const rows = await mailList(mb);
 *     list = rows ?? [];                        // ← "we could not ask" becomes "nothing"
 *
 * The folded value then flows into wording that makes a claim about the device: 《暂无
 * 邮件》/《没有匹配的邮件》/《Wine 已安装，但它的前缀里没有可启动的 Windows 应用》/
 * 《本机没有安装 Wine》. **An empty answer and an unanswered question are different
 * sentences**, and this repo has said so in prose since before it said it in code:
 *
 *   * `lib/nativeApps.ts`'s own doc: "`[]` means the host answered and found nothing —
 *     two different states the screen must not conflate" (the body then merged a
 *     refused half into the same array).
 *   * `locales/*.ts`'s `native.offlineHint`: 「既不显示应用，也不假装成「本机没有应用」」.
 *   * `lib/sensors.ts`'s `normalizeSnapshot` doc: "**unknown stays unknown** — and the
 *     panels print `—` for them".
 *   * `MailApp.svelte`'s `refresh` does it right (`rows === null` → the honest error)
 *     while the search path in the same file did not.
 *
 * The repo's sibling gate for the *write* side (`void-cmd-scan.mjs`, "a void command
 * called without anyone reading its verdict") asks about the **verdict** of a command
 * that returns nothing. This gate asks about the **value** of a command that returns
 * something: did the caller keep the failure value, or coerce it away?
 *
 * ## What it checks
 *
 * For file `F` and read wrapper `W` (declared `Promise<… | null>` over `invoke<…>`), a
 * **fold site** is one of:
 *
 *   (A) an inline coercion — `await W(…) ?? D`, `(await W(…)) ?? D`, same for `|| D`;
 *   (B) a named coercion — `const x = await W(…)` in some function, and a later
 *       `x ?? D` / `x || D` **in that same function's body**.
 *
 * `??` is only ever a default, but `||` is also a boolean operator, so `x || …` in a
 * boolean position is a **guard on the read** and not a fold of it — see `isBooleanUse`.
 * Getting that wrong is not hypothetical: before the rule existed this gate reported
 * `if (!perm || !perm.native)`, `if (!live || live.length === 0 || calling)` and
 * `if (!r || r.output == null)` as folds of reads that were in fact being tested.
 *
 * The fold is accepted when one of:
 *
 *   (a) `D` is literally `null` — the failure value itself, so nothing is lost. (The
 *       coercion is a no-op, and saying so is the whole rule.)
 *   (b) the file reads that command's verdict: a real `bridgeDiag("<command>")` call, or
 *       a one-hop helper carrying the literal — exactly the bindings `void-cmd-scan.mjs`
 *       accepts, imported from it rather than re-implemented;
 *   (c) for a (B) site, the enclosing scope **guards the read** — either an explicit
 *       null comparison (`x === null` / `!== null` / `== null`) or the falsy form this
 *       repo actually uses most (`if (!x || …)`, `!x ? … : …`); see `testsForNull` for
 *       both the heuristic's shape and its honest limits;
 *   (d) the site is in `scripts/read-fold-allowlist.json` under a kind whose reason says
 *       why losing the failure value is acceptable *there*.
 *
 * **Comments are stripped before every extraction** (via `void-cmd-scan.mjs`'s
 * `stripComments`): a doc comment that quotes the fold must not be read as one, and a
 * commented-out fold must not be reported.
 *
 * Usage (from frontend-ts):
 *   node scripts/read-fold-scan.mjs              # gate
 *   node scripts/read-fold-scan.mjs --selftest   # pin the extractors
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripComments,
  matchDelim,
  findDefs,
  bindsLiteral,
  bindsOneHopHelper,
  checkAllowlistShape,
  invokedDirectly,
} from "./void-cmd-scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src");
const BACKEND = join(SRC, "lib", "backend.ts");
const ALLOWLIST = join(root, "scripts", "read-fold-allowlist.json");

/**
 * Floors that keep the window honest. The authority is the wrapper inventory in
 * `backend.ts`: if a rewrite moves the nullable wrappers out of the window the extractor
 * reads, the inventory empties and every rule below passes **vacuously**. Measured
 * 2026-09-21 against this tree: **81** nullable wrapper(s) and **4** fold site(s) — the
 * four being `AiApp.refreshContext` and `RadioPage` (`?? null`, i.e. no-ops), and
 * `MailApp.refresh` / `MailApp`'s search (`rows === null` / `res === null`, the two the
 * repo already guards honestly). Set well below so ordinary refactoring is allowed while
 * a total extraction break is not — and note that a floor is *not* a pin: `MUST_SEE` below
 * carries the one name whose silent loss this round actually observed.
 */
export const FLOORS = { wrappers: 60, folds: 2 };

/**
 * Wrappers the inventory **must** contain, by name.
 *
 * A floor over the whole inventory cannot catch the failure this round found. The
 * depth-unaware `Promise<…>` regex dropped exactly **one** wrapper — `subscribe`, whose
 * return type `Promise<(() => void) | null>` contains `=>` — and the run stayed green, with
 * the inventory reading 80 instead of 81. Any floor loose enough to survive ordinary
 * refactoring is also loose enough to swallow a one-name loss, so "this specific wrapper
 * stays visible" needs its own pin. Same shape as the selftest's `inv.get("mailList")`,
 * lifted to the whole-tree run.
 *
 * `subscribe` is on the list because it is the *channel* of the REQ-A838 family: if it slips
 * out of the inventory again, every fold of a subscription result is invisible while the
 * gate still reports OK — the vacuous green, reproduced and measured on this tree.
 */
export const MUST_SEE = ["subscribe"];

/**
 * The nullable-read inventory: exported functions in `backend.ts` declared with `| null`
 * in the return type, keyed by wrapper name, with the command they call.
 *
 * `invoke<T | null>("cmd")` and `invoke<T>("cmd")` are both seen: `invoke` answers `null`
 * for a refused call regardless of `T`, so the declared `| null` is what makes the
 * wrapper honest about it — and a wrapper that *omits* the `| null` is the `tauri-reply-
 * scan` family, not this one.
 */
/**
 * The declared `Promise<…>` return type of a function-body chunk, or `null`.
 *
 * Depth-aware, **not** a `Promise<([^>]*)>` regex. An arrow-function type puts a `>`
 * *inside* the type — `subscribe`'s own `Promise<(() => void) | null>` — and a `[^>]*` run
 * stops dead at the `>` of `=>`, so that wrapper vanished from the inventory entirely.
 * That is not a cosmetic miss: the very wrapper this round made nullable was the one the
 * gate could not see, so a green run would have certified a family it never looked at. The
 * `=>` skip is the mirror half of the same bug — without it the closing `>` of `=>` reads
 * as the end of `Promise<`.
 */
export function declaredPromiseType(chunk) {
  const at = /\)\s*:\s*Promise\s*</.exec(chunk);
  if (!at) return null;
  const start = at.index + at[0].length;
  let depth = 0;
  for (let i = start; i < chunk.length; i += 1) {
    const c = chunk[i];
    if (c === "=" && chunk[i + 1] === ">") {
      i += 1; // the `>` of an arrow type is part of the type, not its closing bracket
      continue;
    }
    if (c === "<") depth += 1;
    else if (c === ">") {
      if (depth === 0) return chunk.slice(start, i);
      depth -= 1;
    }
  }
  return null;
}

export function nullableWrappers(rawSrc) {
  const src = stripComments(rawSrc);
  const out = new Map();
  const re = /export\s+async\s+function\s+(\w+)\s*\(/g;
  const starts = [];
  let m;
  while ((m = re.exec(src)) !== null) starts.push({ name: m[1], at: m.index });
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1].at : src.length;
    const chunk = src.slice(starts[k].at, end);
    const type = declaredPromiseType(chunk);
    if (type === null || !/\|\s*null/.test(type)) continue;
    const call = /invoke<[^>]*>\(\s*"([^"]+)"/.exec(chunk) ?? /invoke\(\s*"([^"]+)"/.exec(chunk);
    if (call) {
      out.set(starts[k].name, { command: call[1], type, channelParam: null });
      continue;
    }
    // A wrapper whose channel is a **parameter** rather than an `invoke` literal:
    // `subscribe(channel, handler)`. There is no single command to bind to it, so the
    // channel is resolved per call site from the first argument (see `foldSites`). Before
    // this, such a wrapper was dropped from the inventory outright — the same blind spot
    // as the type parse, one layer down.
    const sig = /^export\s+async\s+function\s+\w+\s*\(\s*(\w+)/.exec(chunk);
    if (sig && /\blisten\s*\(/.test(chunk)) {
      out.set(starts[k].name, { command: null, type, channelParam: sig[1] });
    }
  }
  return out;
}

/**
 * The channel a parameterized wrapper call names, or `null` when it is not a literal.
 *
 * Only a literal counts. A channel held in a variable could be resolved one hop, but a
 * *derived* channel would have to be traced to know which verdict belongs to it — and an
 * unattributable site must not be excused by a `bridgeDiag` call for some other channel.
 * Returning `null` makes the caller skip the site: under-detection is a false red, which is
 * the safe direction for a gate.
 */
export function channelArgLiteral(src, openParen, closeParen) {
  const inner = src.slice(openParen + 1, closeParen);
  const m = /^\s*["'`]([^"'`]+)["'`]/.exec(inner);
  return m ? m[1] : null;
}

/**
 * The text that follows a `??` / `||` operator, up to the end of the expression.
 *
 * The closer branch runs **first and absorbs**: `]` is both a bracket and, at depth 0, a
 * terminator, so a naive "is it a stop char?" test would truncate `?? []` to `[` — and the
 * rule that reads this text compares it against `"null"`, which is a scalar and would
 * silently keep working while every array default was reported as an empty string.
 */
function defaultTextAfter(src, at) {
  const stop = /[;,\n]/;
  let depth = 0;
  let out = "";
  for (let i = at; i < src.length; i += 1) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") {
      depth += 1;
      out += c;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth -= 1;
      out += c;
      continue;
    }
    if (depth === 0 && stop.test(c)) break;
    out += c;
  }
  return out.trim();
}

/**
 * Fold sites in one file: `[{ name, command, line, kind, def, defaultText }]` where
 * `kind` is `"inline"` (A) or `"named"` (B) and `def` is the enclosing definition (B
 * only — an inline fold's binding can only be the command diagnosis).
 */
export function foldSites(file, rawSrc, wrappers) {
  const src = stripComments(rawSrc);
  const defs = findDefs(src);
  const found = [];
  const seen = new Set();
  const push = (o) => {
    const key = `${o.name}|${o.line}|${o.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ file, ...o });
  };

  for (const [name, w] of wrappers) {
    const callRe = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g");
    let cm;
    while ((cm = callRe.exec(src)) !== null) {
      const openParen = cm.index + cm[0].length - 1;
      const closeParen = matchDelim(src, openParen, "(", ")");
      if (closeParen === -1) continue;
      const line = src.slice(0, cm.index).split("\n").length;
      // A parameterized wrapper (`subscribe(channel, …)`) names its channel at each call
      // site, not at its declaration — so resolve it here. An unresolvable channel is
      // skipped rather than attributed to a neighbouring literal.
      const command = w.channelParam
        ? channelArgLiteral(src, openParen, closeParen)
        : w.command;
      if (command === null) continue;

      // --- (A) inline:  `… await W(…) ?? D`  /  `(await W(…)) ?? D` -------------------
      // `await` must precede the call (an unawaited call is a different defect).
      const before = src.slice(Math.max(0, cm.index - 40), cm.index);
      const awaited = /await\s*$/.test(before.trimEnd()) || /\bawait\s+$/.test(before);
      let j = closeParen;
      // keep the matched call object for the returned record
      let tail = src.slice(j);
      const wrapClose = /^\)\s*/.exec(tail);
      if (wrapClose) tail = tail.slice(wrapClose[0].length);
      const op = /^(\?\?|\|\|)/.exec(tail);
      if (awaited && op && !isBooleanUse(src, closeParen, j + (wrapClose ? wrapClose[0].length : 0))) {
        const at = j + (wrapClose ? wrapClose[0].length : 0) + op[0].length;
        push({
          name,
          command,
          line,
          kind: "inline",
          def: null,
          defaultText: defaultTextAfter(src, at),
        });
      }

      // --- (B) named:  `const x = await W(…)` then `x ?? D` in the same function ------
      const decl = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s*)?$/.exec(
        src.slice(Math.max(0, cm.index - 60), cm.index),
      );
      if (!decl || !awaited) continue;
      const varName = decl[1];
      const owner = defs
        .filter((d) => d.bodyStart < cm.index && cm.index < d.bodyEnd)
        .sort((a, b) => b.bodyStart - a.bodyStart)[0];
      // No named definition (an `$effect` or `void (async () => …)()` body): fall back to
      // the enclosing brace block, so `def.body` is still *a* scope rather than the whole
      // file — a whole-file scope would let a guard anywhere in the file, including one
      // on an unrelated same-named local, excuse this fold.
      const block = owner ? null : enclosingBlock(src, cm.index);
      const scope = owner ? owner.body : block?.body ?? src;
      const scopeOffset = owner ? owner.bodyStart : block?.start ?? 0;
      const useRe = new RegExp(`(?<![\\w$.])${varName}\\s*(\\?\\?|\\|\\|)`, "g");
      let um;
      while ((um = useRe.exec(scope)) !== null) {
        // A fold of this read must come *after* the read. Anything at or before the
        // call's own closing paren is the declaration (`const rows = await W(rows ?? …)`)
        // or the argument — not a coercion of the answer.
        if (scopeOffset + um.index <= closeParen) continue;
        // `x || …` in a boolean position is a guard on the read, not a default for it.
        // `um[0]` is `varName\s*(op)`, so the operator starts two chars before its end.
        const opAt = scopeOffset + um.index + um[0].length - 2;
        if (isBooleanUse(src, scopeOffset + um.index, opAt)) continue;
        const at = scopeOffset + um.index + um[0].length;
        const lineNo = src.slice(0, scopeOffset + um.index).split("\n").length;
        push({
          name,
          command,
          line: lineNo,
          kind: "named",
          def: owner ?? null,
          // The text a guard on this read must live in. Equal to `def.body` when there is
          // a named definition, else the enclosing block.
          scopeBody: scope,
          varName,
          defaultText: defaultTextAfter(src, at),
        });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * Is `src` a guard on the read named `varName` — i.e. a place where the caller *did*
 * distinguish the failure value from an answer?
 *
 * Two forms, because this repo uses both:
 *
 *  1. the explicit null comparison — `rows === null`, `rows !== null`, `rows == null`;
 *  2. **the falsy guard**, which is the more common idiom here and is equally sound for a
 *     `T | null` read: for such a value `!x` is true *only* when the read failed (an
 *     empty array is truthy, an empty string is not — but a read that legitimately
 *     answers `""` and one that was refused are the same `null` distinction the wrapper
 *     declared, so the guard is exactly the declared boundary).
 *     `if (!perm || !perm.native)`, `if (!live || live.length === 0 || calling)`,
 *     `if (!r || r.output == null)` — all in this tree, all correct.
 *
 * Form 2 is a **heuristic, not a proof**: it asks whether the `!x` sits in a *conditional*
 * head (`if (` / `while (` / a ternary), not merely whether the token appears. Without
 * that qualification a stray `console.log(!rows)` would excuse a real fold — the
 * "`contains("word")` asks presence, not assignment" trap. It still under-detects
 * (`if (rows) {} else {}` is not matched); under-detection costs a false red, which is
 * the safe direction for a gate.
 */
export function testsForNull(src, varName) {
  if (new RegExp(`(?<![\\w$.])${varName}\\s*[!=]==?\\s*null\\b`).test(src)) return true;

  // A ternary **condition**: `!x ? a : b`. The `?` must follow the guard — searching
  // backwards for one would also accept `a ? !x : b`, where `!x` is a branch *value* and
  // guards nothing.
  if (new RegExp(`(?<![\\w$.])!\\s*${varName}(?![\\w$.])\\s*\\?`).test(src)) return true;

  // `!x` in an `if (` / `while (` head. The `(?<![\w$.])` before `!` keeps `!=` out.
  const re = new RegExp(`(?<![\\w$.])!\\s*${varName}(?![\\w$.])`, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    // Walk back to the head of the *statement* this `!x` belongs to, then ask whether
    // that statement is a conditional. Deliberately not `&&`/`||`: `const flag = a && !x`
    // is a value, and the `&&` test accepts it.
    const before = src.slice(Math.max(0, m.index - 200), m.index);
    const cut = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"));
    if (/(?:^|\W)(?:if|while)\s*\(/.test(before.slice(cut + 1))) return true;
  }
  return false;
}

/**
 * Is the operator at `opOffset` — the `??` or `||` matched after an occurrence of `x` —
 * being used as a **default** (a fold), or as ordinary boolean logic (a guard)?
 *
 * `??` is never a boolean operator, so it is always a default and this always says
 * `false` for it. `||` is ambiguous, and getting it wrong produced **three of the four
 * first-run "defects" this gate reported**: `if (!perm || !perm.native)`,
 * `if (!live || live.length === 0 || calling)` and `if (!r || r.output == null)` were each
 * read as `perm || …`, `live || …`, `r || …` — guards reported as folds of a read that
 * was in fact being tested. A gate that reports a guard as a defect is the kind of noise
 * that gets a gate switched off, so `||` is only a default when it is demonstrably not a
 * boolean use:
 *
 *   * the operand is negated — `!x || …` (`!` immediately before `x`), or
 *   * the `||` sits inside an `if (` / `while (` head, or
 *   * the right-hand side is a predicate (`… === null`, `!…`, a comparison) rather than a
 *     value, which is what a boolean chain's next clause looks like.
 *
 * The last two are heuristics and are documented as such; the first is exact. A missed
 * default costs a false red (safe); a guard read as a default costs annoying noise.
 */
export function isBooleanUse(src, varAt, opAt) {
  if (src.slice(opAt, opAt + 2) === "??") return false;

  // `!x || …` — what immediately precedes the *name* (not the operator; the two can have
  // whitespace between them, which is why the name's own offset is the argument).
  if (/!\s*$/.test(src.slice(Math.max(0, varAt - 4), varAt))) return true;

  // `if (… || …)` / `while (… || …)` — walk back to the statement head.
  const before = src.slice(Math.max(0, opAt - 200), opAt);
  const cut = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"));
  const head = before.slice(cut + 1);
  if (/(?:^|\W)(?:if|while)\s*\(/.test(head)) return true;

  // A predicate to the right: `… || x === null`, `… || !x`.
  const rhs = defaultTextAfter(src, opAt + 2);
  if (/(?:[!=]==?|!==|<=|>=|<|>)\s*[^;]*$/.test(rhs) || /^!/.test(rhs)) return true;

  return false;
}

/**
 * The innermost brace block containing byte offset `at`, or `null`.
 *
 * Needed because the enclosing **named** definition is not always available: this tree
 * runs reads inside `void (async () => { … })();` bodies and `$effect` arrows, which
 * `findDefs` (rightly) does not treat as definitions. The block is a smaller scope than
 * the real one, so a guard living in an *ancestor* block is missed — again a false red
 * rather than a false green.
 */
export function enclosingBlock(src, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const c = src[i];
    if (c === "}") depth += 1;
    else if (c === "{") {
      if (depth === 0) {
        const end = matchDelim(src, i, "{", "}");
        return end === -1 ? null : { body: src.slice(i, end), start: i, end };
      }
      depth -= 1;
    }
  }
  return null;
}

/**
 * Why a fold site is accepted, or `null` when nothing excuses it.
 *
 * Pure and exported so each of the four rules — and each one's negative control — can be
 * pinned by the selftest instead of only being reachable through a whole-tree run.
 * `src` is the **raw** (unstripped) file text: `bindsLiteral`/`bindsOneHopHelper` strip
 * comments themselves, and `def.body` already came from the stripped source.
 */
export function accepts(site, src, allowedKeys = new Set()) {
  if (site.defaultText === "null") return "the default is the failure value itself";
  if (bindsLiteral(src, site.command) || bindsOneHopHelper(src, site.command)) {
    return `the file reads bridgeDiag("${site.command}")`;
  }
  if (site.kind === "named" && site.scopeBody && site.varName && testsForNull(site.scopeBody, site.varName)) {
    return site.def
      ? `the enclosing \`${site.def.name}\` tests \`${site.varName}\` for null`
      : `the enclosing block tests \`${site.varName}\` for null`;
  }
  if (allowedKeys.has(`${site.file}::${site.command}`)) return "allow-listed";
  return null;
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST)) return { kinds: {}, sites: [] };
  return JSON.parse(readFileSync(ALLOWLIST, "utf8"));
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(p, acc);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".svelte")) {
      acc.push(p);
    }
  }
  return acc;
}

function analyse() {
  const wrappers = nullableWrappers(readFileSync(BACKEND, "utf8"));
  const sites = [];
  const files = walk(SRC).filter((p) => p !== BACKEND);
  for (const p of files) {
    sites.push(...foldSites(relative(root, p), readFileSync(p, "utf8"), wrappers));
  }
  return { wrappers, sites, files };
}

export function runScan() {
  const { wrappers, sites, files } = analyse();
  const allowed = readAllowlist();
  const allowedKeys = new Set((allowed.sites ?? []).map((s) => `${s.file}::${s.command}`));

  const shape = checkAllowlistShape(allowed);
  if (shape.length > 0) {
    for (const p of shape) console.error(`[read-fold-scan] FAIL — allow-list: ${p}`);
    console.error(
      "[read-fold-scan] an allow-listed site must name a defined `kind`, and every kind " +
        "must carry a non-empty `reason`.",
    );
    process.exit(1);
  }
  if (wrappers.size < FLOORS.wrappers) {
    console.error(
      `[read-fold-scan] FAIL — only ${wrappers.size} nullable wrapper(s) found in ` +
        `src/lib/backend.ts (floor ${FLOORS.wrappers}). The inventory has moved or changed ` +
        "shape; fix the extractor before trusting a green run.",
    );
    process.exit(1);
  }
  for (const name of MUST_SEE) {
    if (!wrappers.has(name)) {
      console.error(
        `[read-fold-scan] FAIL — \`${name}\` is missing from the nullable wrapper inventory. ` +
          "It is a named pin, not a floor: losing one wrapper leaves the run green while " +
          "every fold of its result becomes invisible. Check the return-type parser first — " +
          "an arrow function type (`Promise<() => void>`) breaks a naive `[^>]*` run.",
      );
      process.exit(1);
    }
  }
  if (sites.length < FLOORS.folds) {
    console.error(
      `[read-fold-scan] FAIL — only ${sites.length} fold site(s) found (floor ${FLOORS.folds}). ` +
        "An empty window would pass vacuously.",
    );
    process.exit(1);
  }

  const failures = [];
  const sources = new Map();
  for (const s of sites) {
    if (!sources.has(s.file)) sources.set(s.file, readFileSync(join(root, s.file), "utf8"));
    if (accepts(s, sources.get(s.file), allowedKeys) !== null) continue;
    failures.push(s);
  }

  const usedKeys = new Set(
    sites.map((s) => `${s.file}::${s.command}`).filter((k) => allowedKeys.has(k)),
  );
  const stale = [...allowedKeys].filter((k) => !usedKeys.has(k) && !k.endsWith("::*"));

  for (const f of failures) {
    console.error(
      `[read-fold-scan] FAIL — ${f.file}:${f.line} folds \`${f.name}()\` (\`${f.command}\`) ` +
        `into \`${f.defaultText}\`: \`invoke\` answers \`null\` for a refused call, so this ` +
        'turns "we could not ask" into an answer the screen then states as a fact. Keep the ' +
        "failure value (branch on `=== null`, as `MailApp.refresh` and `LmkDebugPanel` do), " +
        `read \`bridgeDiag("${f.command}").ok\`, or list the site in ` +
        "scripts/read-fold-allowlist.json with a reason.",
    );
  }
  for (const k of stale) {
    const [file, command] = k.split("::");
    console.log(`[read-fold-scan] allow-list: no fold site for ${file} / ${command} — shrink it.`);
  }

  console.log(
    `[read-fold-scan] ${wrappers.size} nullable read wrapper(s); ${sites.length} fold site(s) ` +
      `in ${new Set(sites.map((s) => s.file)).size} of ${files.length} file(s); ` +
      `${usedKeys.size} allow-listed.`,
  );
  if (failures.length === 0) {
    console.log(
      "[read-fold-scan] OK — no read's failure value is coerced into an absence without its verdict.",
    );
  } else {
    console.error(
      "\nA refused read and an empty answer are different sentences. Keep the difference, or\n" +
        "classify the site with a reason.",
    );
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const backend = [
    "export async function mailList(mailbox: string): Promise<MailSummary[] | null> {",
    '  return invoke<MailSummary[] | null>("mail_list", { mailbox });',
    "}",
    "export async function readThing(): Promise<string | null> {",
    '  return invoke<string | null>("thing_read");',
    "}",
    "export async function missing(): Promise<number> {",
    '  return invoke<number>("no_null_in_type");',
    "}",
  ].join("\n");
  const inv = nullableWrappers(backend);
  ok("nullable wrapper inventory: array read", inv.get("mailList")?.command === "mail_list");
  ok("nullable wrapper inventory: scalar read", inv.get("readThing")?.command === "thing_read");
  ok("a wrapper without `| null` is not in the inventory", !inv.has("missing"));
  ok("inventory size is exactly the 2 nullable wrappers", inv.size === 2);

  // --- the arrow-type blind spot (REQ-A838). Both halves are pinned: the parser must see a
  // `=>` inside the type, and a parameterized channel must be inventoried rather than
  // dropped. Without these, `subscribe` — the wrapper this round made nullable — is absent
  // from the inventory and the family is uncapped while the gate still reports OK.
  const arrow = [
    "export async function subscribe(channel: string, h: (p: unknown) => void): " +
      "Promise<(() => void) | null> {",
    "  return listen(channel, h);",
    "}",
  ].join("\n");
  const invArrow = nullableWrappers(arrow);
  ok(
    "an arrow type in the return position is parsed (`=>` is not the closing `>`)",
    invArrow.has("subscribe"),
  );
  ok(
    "…and its channel is recorded as a parameter, not a literal",
    invArrow.get("subscribe")?.channelParam === "channel" &&
      invArrow.get("subscribe")?.command === null,
  );
  ok(
    "a `Promise<Record<string, number> | null>` still parses (nested generics)",
    declaredPromiseType("): Promise<Record<string, number> | null> {") ===
      "Record<string, number> | null",
  );
  ok(
    "a plain `Promise<T | null>` still parses (no regression)",
    declaredPromiseType("): Promise<string | null> {") === "string | null",
  );
  ok(
    "a non-Promise return is not parsed",
    declaredPromiseType("): string {") === null,
  );
  const argOf = (call) => {
    const open = call.indexOf("(");
    return channelArgLiteral(call, open, call.length - 1);
  };
  ok("channelArgLiteral resolves a quoted channel", argOf('subscribe("probe-ch", h)') === "probe-ch");
  ok(
    "channelArgLiteral refuses a variable channel (unattributable ⇒ skip)",
    argOf("subscribe(CH, h)") === null,
  );

  const W = nullableWrappers(backend);
  const foldOf = (src) => foldSites("f.ts", src, W);

  ok(
    "inline `await W() ?? []` is a fold",
    foldOf("const a = (await mailList(m)) ?? [];").length === 1,
  );
  ok(
    "inline `|| []` is a fold too",
    foldOf("const a = (await mailList(m)) || [];").length === 1,
  );
  ok(
    "an unawaited `W() ?? []` is not this fold",
    foldOf("const a = mailList(m) ?? [];").length === 0,
  );
  ok("`?? null` is still reported (the caller filters it)", foldOf("const a = (await mailList(m)) ?? null;").length === 1);
  ok(
    "a named fold in the same function is found",
    foldOf("async function f(){ const rows = await mailList(m); list = rows ?? []; }").length === 1,
  );
  ok(
    "the DEFAULT is captured for the message",
    foldOf("const a = (await mailList(m)) ?? [];")[0]?.defaultText === "[]",
  );
  ok(
    "a commented-out fold is not a fold",
    foldOf("// const a = (await mailList(m)) ?? [];\n").length === 0,
  );
  ok(
    "a doc comment QUOTING the fold is not a fold",
    foldOf("/** `rows ?? []` used to erase it. */\nconst a = 1;").length === 0,
  );
  ok(
    "a member call is not a wrapper call",
    foldOf("const a = (await obj.mailList(m)) ?? [];").length === 0,
  );
  ok(
    "the enclosing definition is attached to a named fold",
    foldOf("async function f(){ const rows = await mailList(m); list = rows ?? []; }")[0]?.def
      ?.name === "f",
  );
  ok(
    "a null test on the read is recognised",
    testsForNull("if (rows === null) error = 1;", "rows") &&
      testsForNull("if (rows !== null) go();", "rows") &&
      testsForNull("if (rows == null) error = 1;", "rows"),
  );
  ok(
    "a null test on a DIFFERENT variable is not a test for this one",
    !testsForNull("if (other === null) error = 1;", "rows"),
  );
  // The falsy guard is the repo's more common idiom — see `PhoneApp.adoptLiveCall`,
  // `DeviceMicButton.start`, `TerminalApp`'s poller.
  ok(
    "the falsy guard `if (!x || …)` is a guard",
    testsForNull("const a = 1; if (!rows || rows.length === 0) return;", "rows"),
  );
  ok("`while (!x)` is a guard", testsForNull("while (!rows) spin();", "rows"));
  ok("a ternary on `!x` is a guard", testsForNull("const n = !rows ? a : b;", "rows"));
  ok(
    "`!x` as a ternary BRANCH is not a guard (the `?` must come first)",
    !testsForNull("const n = a ? !rows : b;", "rows"),
  );
  // …and the control: a mere *mention* is not a guard. Without this the rule would be
  // "the token appears somewhere", which is the `contains("word")` trap.
  ok(
    "a bare `!x` outside any conditional is NOT a guard",
    !testsForNull("const rows = 1; console.log(!rows);", "rows"),
  );
  ok(
    "`!x` used as a VALUE is not a guard",
    !testsForNull("const rows = 1; const flag = !rows;", "rows"),
  );
  ok(
    "`!other` in a conditional is not a guard on this read",
    !testsForNull("if (!other) return;", "rows"),
  );
  ok("`!=` is not read as a `!x`", !testsForNull("if (a != rows) return;", "rows"));
  ok(
    "a property access is not a guard on the read (`!perm.native`)",
    !testsForNull("if (!perm.native) return;", "perm"),
  );

  const helper = [
    "const run = async (command: string) => { if (!bridgeDiag(command).ok) throw 1; };",
    'run("mail_list");',
  ].join("\n");
  ok("a one-hop helper binding is accepted", bindsOneHopHelper(helper, "mail_list"));
  ok(
    "a one-hop helper for ANOTHER command does not bind this one",
    !bindsOneHopHelper(helper, "thing_read") && !bindsLiteral(helper, "thing_read"),
  );

  // --- the acceptance rules, each with a control ---------------------------------------
  const fold = foldOf("const a = (await mailList(m)) ?? [];")[0];
  ok("an unbound `?? []` fold is NOT accepted", accepts(fold, "const a = 1;") === null);
  ok(
    "a real `bridgeDiag(\"mail_list\")` read accepts it",
    accepts(fold, 'if (!bridgeDiag("mail_list").ok) throw 1;') !== null,
  );
  ok(
    "a bridgeDiag read for a DIFFERENT command does not",
    accepts(fold, 'if (!bridgeDiag("thing_read").ok) throw 1;') === null,
  );
  ok(
    "a bridgeDiag read inside a COMMENT does not (comments are stripped)",
    accepts(fold, '// if (!bridgeDiag("mail_list").ok) throw 1;') === null,
  );
  const nullFold = foldOf("const a = (await mailList(m)) ?? null;")[0];
  ok("`?? null` is accepted: it is the failure value itself", accepts(nullFold, "const a = 1;") !== null);
  const namedSrc = "async function f(){ const rows = await mailList(m); list = rows ?? []; }";
  const namedFold = foldOf(namedSrc)[0];
  ok("a named fold is NOT accepted on its own", accepts(namedFold, namedSrc) === null);
  // `def.body` is captured at extraction time, so a control must re-derive the site from
  // the modified source rather than pass the new text against a stale body.
  const guarded = namedSrc.replace(
    "list = rows ?? [];",
    "if (rows === null) return; list = rows ?? [];",
  );
  ok(
    "…but a null test on that read in the SAME function accepts it",
    accepts(foldOf(guarded)[0], guarded) !== null,
  );
  const elsewhere =
    "async function g(){ if (rows === null) return; }\n" +
    "async function f(){ const rows = await mailList(m); list = rows ?? []; }";
  ok(
    "a null test on it in a DIFFERENT function does not",
    accepts(foldOf(elsewhere)[0], elsewhere) === null,
  );
  ok(
    "an allow-listed site is accepted, and only under its own file/command",
    accepts(namedFold, namedSrc, new Set(["f.ts::mail_list"])) !== null &&
      accepts(namedFold, namedSrc, new Set(["g.ts::mail_list"])) === null &&
      accepts(namedFold, namedSrc, new Set(["f.ts::thing_read"])) === null,
  );

  // --- the scope fallback for anonymous bodies -----------------------------------------
  // Real shape: `MailApp`'s search and `TerminalApp`'s poller both read inside
  // `void (async () => { … })();`, which is not a `findDefs` definition.
  const anon =
    "void (async () => {\n" +
    "  const res = await mailList(m);\n" +
    "  if (res === null) failed = true;\n" +
    "  list = res ?? [];\n" +
    "})();";
  const anonFold = foldOf(anon)[0];
  ok("an anonymous-body fold has no named def", anonFold?.def === null);
  ok("…but it still carries a scope", typeof anonFold?.scopeBody === "string");
  ok("…and the guard in that scope is found", accepts(anonFold, anon) !== null);
  const anonUnguarded = anon.replace("if (res === null) failed = true;", "");
  ok(
    "…while the same body without the guard is NOT accepted",
    accepts(foldOf(anonUnguarded)[0], anonUnguarded) === null,
  );
  // The control for the fallback *itself*: a guard in a sibling block must not leak in.
  const sibling =
    "function g() { const res = 1; if (res === null) return; }\n" +
    "void (async () => {\n  const res = await mailList(m);\n  list = res ?? [];\n})();";
  ok(
    "a guard in a SIBLING block does not excuse the fold",
    accepts(foldOf(sibling)[0], sibling) === null,
  );
  // `"a { b { c } }"` — offset 8 is `c`; the innermost block opens at 6, not 2.
  ok("enclosingBlock finds the innermost block", enclosingBlock("a { b { c } }", 8)?.start === 6);
  ok("enclosingBlock outside every block is null", enclosingBlock("a b c", 2) === null);

  // --- `||` as guard vs. default --------------------------------------------------------
  const B = (src, name) => {
    const m2 = new RegExp(`${name}\\s*(\\?\\?|\\|\\|)`).exec(src);
    return isBooleanUse(src, m2.index, m2.index + m2[0].length - 2);
  };
  ok("`!x || …` is a boolean use, not a default", B("if (!perm || !perm.native) {", "perm"));
  ok("`x || …` in an `if (` head is a boolean use", B("if (live || other) return;", "live"));
  ok("`x || …` in a `while (` head is a boolean use", B("while (r || more()) {}", "r"));
  ok(
    "`x || predicate` is a boolean use",
    B("const ok = rows || fallback === null;", "rows"),
  );
  // The controls: a real default must survive, and `??` is never a boolean use.
  ok("`x || []` as a value IS a default", !B("const list = rows || [];", "rows"));
  ok("`x || fallback` as a value IS a default", !B("const n = rows || fallback;", "rows"));
  ok("`??` is never a boolean use", !B("if (rows ?? []).length {} ", "rows"));

  let bad = 0;
  for (const [name, cond] of checks) {
    if (cond) console.log(`  [ok] ${name}`);
    else {
      console.error(`  [FAIL] ${name}`);
      bad += 1;
    }
  }
  if (bad === 0) console.log(`[read-fold-scan] selftest OK — ${checks.length} case(s).`);
  else console.error(`[read-fold-scan] selftest FAILED — ${bad}/${checks.length} case(s).`);
  process.exit(bad === 0 ? 0 : 1);
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
else if (IS_ENTRY) runScan();
