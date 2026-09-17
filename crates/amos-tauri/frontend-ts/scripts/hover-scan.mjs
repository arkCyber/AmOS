#!/usr/bin/env node
/**
 * hover-scan.mjs — "a finger cannot hover, and the code says so".
 *
 * Motivation (REQ-A320): a phone and a tablet are the *primary* form factors here,
 * and neither has a pointer that can hover. That makes every `hover:` utility a
 * claim about hardware the user may not have, in one of two shapes:
 *
 *   (a) **sticky hover** — the style applies on touch too, so a tap paints a control
 *       in a state the user is no longer in. Tailwind's `future.hoverOnlyWhenSupported`
 *       moves every `hover:`/`group-hover:` utility into `@media (hover: hover)`,
 *       which is the whole fix — rule 1 keeps it set.
 *   (b) **hover-only affordance** — the element is `opacity-0` until hover, so on
 *       touch it never appears *while still being hit-testable* (`opacity-0` stops
 *       neither paint nor hit-testing). `MessagesApp`'s per-message actions were
 *       exactly that: an invisible-but-tappable 删除/引用回复, and the audit
 *       (`docs/UI_APPLE_HIG_AUDIT.md` §4) had recorded it as an open 🟡 since the HIG
 *       pass. Rule 2 makes the trap impossible: an element that is invisible by
 *       default **and** revealed by hover must be `pointer-events-none`, so it can
 *       never be hit while the user cannot see it, and any real touch path (the long
 *       press `MessagesApp` now uses, or keyboard focus) has to be explicit.
 *
 * Rules:
 *   1. `tailwind.config.js` still sets `future: { hoverOnlyWhenSupported: true }`
 *      — without it (a) is back, and rule 2's `group-hover:` half would fire on
 *      touch as well;
 *   2. no class list is "invisible by default + revealed by hover + hit-testable"
 *      (an inline `hover-scan: decorative` opt-out exists for a purely visual case;
 *      adding one is a decision, not an accident);
 *   3. the built stylesheet, when one exists, really carries `@media (hover: hover)`
 *      — the artifact is what ships, so the config alone is not proof.
 *
 * Usage:
 *   node scripts/hover-scan.mjs             # the gate
 *   node scripts/hover-scan.mjs --selftest  # pin the extractors/rules
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // frontend-ts/
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".vite"]);

/** Every file under `dir`, skipping build/dependency directories. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Every double-quoted string literal in a source file — a class list in this codebase. */
export function stringLiterals(src) {
  return [...src.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]);
}

/** Is this literal invisible until a hover reveals it? */
export function isHoverRevealed(literal) {
  return /(?:^|\s)opacity-0(?:\s|$)/.test(literal) && /(?:group-)?hover:opacity-\d/.test(literal);
}

/**
 * The rule-2 verdict for one literal: `null` when fine, else why it is not.
 * An explicit `hover-scan: decorative` marker (as a class, since a class list cannot
 * hold a comment) switches the element to "purely visual" and is allowed.
 */
export function hoverRevealProblem(literal) {
  if (!isHoverRevealed(literal)) return null;
  if (/(?:^|\s)pointer-events-none(?:\s|$)/.test(literal)) return null;
  if (literal.includes("hover-scan: decorative")) return null;
  return (
    "invisible until hover and still hit-testable (opacity-0 stops neither paint nor " +
    "hit-testing): add pointer-events-none plus an explicit touch/keyboard path, or " +
    "mark it `hover-scan: decorative` if it is never interactive"
  );
}

/**
 * Does a built stylesheet scope **every** hover rule to hover-capable pointers?
 *
 * Not "is there a media query somewhere": the property that matters is that no
 * `:hover` selector is left outside one (Tailwind emits them as `.hover\:x:hover`,
 * and a mobile WebView applies anything that is not inside `@media (hover: hover)`).
 * The media blocks are found with a brace-matching scan, so nesting (`@supports`
 * inside, Tailwind's `&`-compiled selectors) is handled.
 */
export function builtCssScopesHover(css) {
  const hoverRules = (css.match(/:hover/g) ?? []).length;
  const scopedChunks = [];
  const marker = /@media \(hover:\s*hover\)/g;
  let m;
  while ((m = marker.exec(css)) !== null) {
    const open = css.indexOf("{", m.index);
    if (open === -1) break;
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    scopedChunks.push(css.slice(open, i + 1));
    marker.lastIndex = i + 1;
  }
  const scopedRules = scopedChunks.reduce((n, c) => n + (c.match(/:hover/g) ?? []).length, 0);
  return {
    hoverRules,
    scoped: scopedChunks.length,
    scopedRules,
    ok: hoverRules === scopedRules,
  };
}

/**
 * Source-level twin of rule 3 (REQ-A332): hand-written CSS must scope its own `:hover`.
 *
 * Tailwind's `hoverOnlyWhenSupported` wraps the *utility classes it generates* — it cannot
 * touch a `:hover` written by hand, in a component's `<style>` block or in a `.css` file. Rule
 * 3 could only see such a rule **after a successful build** (and a stale `dist` hid it
 * entirely), so this checks the source: every `:hover` must sit inside an
 * `@media (hover: hover)` block. Returns a short context per offending selector.
 */
export function unscopedHoverSelectors(css) {
  // Comments first: a `:hover` *mentioned* in prose (like this very rule's own documentation)
  // is not a selector. This is the same masking discipline the Rust gates use.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // Then blank out the scoped blocks (brace-matched, so nesting is handled) — anything with
  // `:hover` left over is unscoped.
  let rest = "";
  let i = 0;
  const marker = /@media \(hover:\s*hover\)/g;
  let m;
  while ((m = marker.exec(code)) !== null) {
    const open = code.indexOf("{", m.index);
    if (open === -1) break;
    let depth = 0;
    let j = open;
    for (; j < code.length; j++) {
      if (code[j] === "{") depth++;
      else if (code[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    rest += code.slice(i, m.index);
    i = j + 1;
    marker.lastIndex = i;
  }
  rest += code.slice(i);
  return [...rest.matchAll(/[^\n{}]*:hover[^\n{}]*/g)].map((hit) => hit[0].trim());
}


function selftest() {
  const problems = [];
  const want = (label, got, expected) => {
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    }
  };

  // Rule 2 — the defect this gate was written for, plus the two legitimate shapes.
  want(
    "hoverRevealProblem: the MessagesApp defect",
    hoverRevealProblem("px-1 text-xs opacity-0 transition-opacity group-hover:opacity-60") !== null,
    true,
  );
  want(
    "hoverRevealProblem: inert while hidden is fine",
    hoverRevealProblem("opacity-0 pointer-events-none group-hover:opacity-60"),
    null,
  );
  want(
    "hoverRevealProblem: decorative opt-out is fine",
    hoverRevealProblem("opacity-0 hover:opacity-100 hover-scan: decorative"),
    null,
  );
  want(
    "hoverRevealProblem: a plain hover style is not a reveal",
    hoverRevealProblem("bg-white opacity-60 hover:bg-neutral-100"),
    null,
  );
  want(
    "hoverRevealProblem: opacity-05 is not a hidden-by-default reveal",
    hoverRevealProblem("opacity-05 hover:opacity-100"),
    null,
  );

  // Rule 3 — the artifact check must fail on the pre-fix stylesheet.
  want("builtCssScopesHover: unscoped hover rules fail", builtCssScopesHover(".a:hover{color:red}").ok, false);
  want(
    "builtCssScopesHover: scoped hover rules pass",
    builtCssScopesHover("@media (hover: hover){.a:hover{color:red}}").ok,
    true,
  );
  want("builtCssScopesHover: no hover rules at all pass", builtCssScopesHover(".a{color:red}").ok, true);
  want(
    "builtCssScopesHover: one escaped rule is enough to fail",
    builtCssScopesHover("@media (hover: hover){.a:hover{color:red}}.b:hover{color:blue}").ok,
    false,
  );
  want(
    "builtCssScopesHover: nesting inside the media block still counts",
    builtCssScopesHover("@media (hover: hover){.a:hover{color:red}@supports (x:y){.b:hover{color:blue}}}").ok,
    true,
  );

  // Rule 1's extractor sees the flag's text where the reader looks for it.
  want(
    "stringLiterals: finds class lists",
    stringLiterals('const a = "px-1 opacity-0";').includes("px-1 opacity-0"),
    true,
  );

  // Rule 4 — hand-written CSS must scope its own hover (the source-level twin of rule 3).
  want(
    "unscopedHoverSelectors: a bare :hover is a finding",
    unscopedHoverSelectors(".card { color: red; }\n.card:hover { color: blue; }"),
    [".card:hover"],
  );
  want(
    "unscopedHoverSelectors: a scoped :hover is fine",
    unscopedHoverSelectors("@media (hover: hover) { .card:hover { color: blue; } }"),
    [],
  );
  want(
    "unscopedHoverSelectors: nesting inside the media block still counts as scoped",
    unscopedHoverSelectors("@media (hover: hover){.a:hover{color:red}@supports (x:y){.b:hover{color:blue}}}"),
    [],
  );
  want(
    "unscopedHoverSelectors: one escaped rule among scoped ones is found",
    unscopedHoverSelectors("@media (hover: hover){.a:hover{color:red}}\n.b:hover{color:blue}"),
    [".b:hover"],
  );
  want(
    "unscopedHoverSelectors: a :hover mentioned in a comment is not a selector",
    unscopedHoverSelectors("/* one more sticky `:hover` (REQ-A320) */\n.a { color: red; }"),
    [],
  );

  if (problems.length > 0) {
    console.error(`[hover-scan] selftest FAIL:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[hover-scan] selftest: 16 assertion(s), 0 failure(s).`);
}

if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

const problems = [];

// 1. The pointer contract's enforcement point.
const tailwindPath = join(ROOT, "tailwind.config.js");
const tailwind = existsSync(tailwindPath) ? readFileSync(tailwindPath, "utf8") : "";
if (!/hoverOnlyWhenSupported:\s*true/.test(tailwind)) {
  problems.push(
    "tailwind.config.js no longer sets `future: { hoverOnlyWhenSupported: true }` — " +
      "every hover: utility would apply on touch again (sticky hover)",
  );
}

// 2. No invisible-yet-hit-testable hover reveal anywhere in the shell.
let hoverReveals = 0;
for (const f of walk(ROOT)) {
  if (!f.endsWith(".svelte")) continue;
  const src = readFileSync(f, "utf8");
  for (const literal of stringLiterals(src)) {
    if (isHoverRevealed(literal)) hoverReveals++;
    const why = hoverRevealProblem(literal);
    if (why) problems.push(`${relative(ROOT, f)}: "${literal}" — ${why}`);
  }
}

// 3. The artifact: the config is only a claim until the stylesheet carries it.
const distDir = join(ROOT, "dist/assets");
if (existsSync(distDir)) {
  const css = readdirSync(distDir)
    .filter((n) => n.endsWith(".css"))
    .map((n) => readFileSync(join(distDir, n), "utf8"))
    .join("\n");
  const { hoverRules, scoped, scopedRules, ok } = builtCssScopesHover(css);
  if (!ok) {
    problems.push(
      `dist/assets/*.css has ${hoverRules} :hover rule(s) but only ${scopedRules} inside ` +
        `its ${scoped} @media (hover: hover) block(s) — a hover style would apply on touch; ` +
        `rebuild (make frontend-dist) after config changes`,
    );
  }
}

// 4. Hand-written CSS scopes its own hover (REQ-A332). Component `<style>` blocks and plain
//    `.css` files are **outside** Tailwind's `hoverOnlyWhenSupported`, so a bare `:hover`
//    there is a sticky-hover regression — and the artifact rule above cannot see it until a
//    build succeeds (a stale `dist` hides it completely).
const HOVER_EXEMPT = "hover-scan: deliberate";
let handWrittenHoverRules = 0;
for (const f of walk(ROOT)) {
  const isCss = f.endsWith(".css");
  if (!isCss && !f.endsWith(".svelte")) continue;
  const src = readFileSync(f, "utf8");
  if (src.includes(HOVER_EXEMPT)) continue;
  const blocks = isCss
    ? [src]
    : [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  for (const block of blocks) {
    handWrittenHoverRules += (block.match(/:hover/g) ?? []).length;
    for (const selector of unscopedHoverSelectors(block)) {
      problems.push(
        `${relative(ROOT, f)}: hand-written CSS must scope its own hover — ` +
          `\`${selector}\` is outside @media (hover: hover)`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`[hover-scan] FAIL — ${problems.length} pointer-contract problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nA hover is a claim about hardware. Phones and tablets (this OS's primary form\n" +
      "factors) have no pointer that can hover, so a hidden control must never be\n" +
      "reachable by touch while invisible, and a hover style must never stick.\n" +
      "See docs/UI_APPLE_HIG_AUDIT.md §4 and tailwind.config.js.",
  );
  process.exit(1);
}
console.log(
  `[hover-scan] OK — hover is scoped to hover-capable pointers ` +
    `(${hoverReveals} hover-revealed list(s), every one inert or deliberate; ` +
    `${handWrittenHoverRules} hand-written \`:hover\` rule(s), all inside @media (hover: hover)).`,
);
