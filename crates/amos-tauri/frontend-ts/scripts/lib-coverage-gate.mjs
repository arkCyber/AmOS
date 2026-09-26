#!/usr/bin/env node
/**
 * P2-1 gate: enforce a minimum line-coverage on the core pure-logic modules
 * (src/lib/**) using the lcov report Bun writes to ./coverage/lcov.info.
 *
 * Usage (from frontend-ts):
 *   node scripts/bun-iso-test.mjs coverage            # builds all lcov parts, then runs this gate
 *   node scripts/lib-coverage-gate.mjs [threshold]   # threshold default 0.90
 *
 * Aggregate is over src/lib only (components/theme/tests excluded), so the gate
 * tracks the code that is meant to be unit-tested headlessly.
 *
 * REQ-A396: the denominator counts **executable** lines only. Bun's lcov ranges
 * include comment/blank lines of every function the run entered (always `DA:n,0`),
 * and its `LF` is the whole file length — both make comment-heavy files look
 * permanently uncovered. Blank/comment-only lines are classified by scanning the
 * source (string/block-comment aware) and dropped from the total; executable lines
 * that no run ever recorded stay counted as missed, so real gaps cannot hide.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";

const require = createRequire(import.meta.url);
let tsMod = null;
function getTS() {
  if (tsMod === null) {
    try {
      tsMod = require("typescript");
    } catch {
      tsMod = false; // optional: without it only comments/blanks are filtered
    }
  }
  return tsMod;
}

const LCOV = "coverage/lcov.info";

/**
 * Self-test flag first: it must not depend on a coverage run existing.
 */
if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

const threshold = parseFloat(process.argv[2] ?? process.env.COVERAGE_THRESHOLD ?? "0.90");
if (!Number.isFinite(threshold)) throw new Error("invalid coverage threshold");

/**
 * Every report Bun wrote: the pure batch's `lcov.info` plus one part per isolated DOM/zoned
 * test file (`bun-iso-test.mjs`). Hits are **maxed** per line — a line covered by any run is
 * covered. Before REQ-A390 only `lcov.info` was read, so five test files' coverage was
 * invisible to this gate.
 */
// REQ-A863: the directory is read defensively. `coverage/` is gitignored, so on a fresh
// checkout it does not exist — and `readdirSync` on a missing directory throws ENOENT,
// which would crash the gate before the "nothing to measure" branch below could explain
// why. A crash and a diagnosis look nothing alike to whoever has to act on it.
const reports = [
  LCOV,
  ...(existsSync("coverage") ? readdirSync("coverage") : [])
    .filter((f) => /^lcov\.part-\d+\.info$/.test(f))
    .sort()
    .map((f) => `coverage/${f}`),
].filter((f) => existsSync(f));

// REQ-A863: `coverage/` is gitignored, so a fresh checkout has **no** reports at all.
// Every rule below reads them, and the honest answer then is not a count — it is that
// there is nothing to measure yet. Saying so is also what keeps the REQ-A405 message
// truthful: with zero reports, "the reports are older than the tree" would be a
// strange way to describe a directory that does not exist.
if (reports.length === 0) {
  console.error("P2-1 GATE FAILED: no coverage reports under ./coverage — nothing to measure.");
  console.error("  fix: run `node scripts/bun-iso-test.mjs coverage` (it writes the reports, then this gate).");
  process.exit(1);
}

/**
 * Line numbers (1-based) that contain executable code: any non-whitespace character
 * outside comments, **and not a bare closing bracket** (REQ-A404 — see below).
 *
 * String/template content counts as code (continuation lines of a multi-line expression
 * are attributed by coverage tools too). Template literals and block comments span lines,
 * so the scanner keeps state across the whole file; `${…}` interpolation nesting is
 * tracked with a small stack. Regex literals need no special handling: their characters
 * are non-whitespace "code", and a `//` that opens a comment can never appear at a code
 * position inside a well-formed regex anyway.
 *
 * REQ-A404 — **structural lines are not executable.** A line whose entire code content is
 * `}` / `});` / `};` / `]` has no statement of its own, and bun's lcov emits it as
 * `DA:n,0` for many files while *never* marking it hit (measured for `notes.ts`: the
 * line list the gate called "missed" was **41 lines, all of them closing braces**, i.e.
 * the file is covered while the gate read 87.6%). Across `src/lib` that artifact was
 * **1,946 of 2,669 reported misses (72.9%)** — the gate read 84.67% where the real number
 * is ~95%. Excluding them changes no code and no test: a test cannot cover a closing
 * brace independently of the construct it closes, and a block that is never entered
 * still shows up through its statements.
 */
export function executableLinesFromSource(src) {
  const ex = new Set();
  let inBlock = false;
  const tpl = []; // stack of { interp: boolean, depth: number } for `…${ … }…`
  src.split(/\r?\n/).forEach((s, idx) => {
    let saw = false;
    let substantive = false; // some code that is not just a closing bracket
    // REQ-A405: `,` joins the bracket/semicolon set. A line whose whole code content is
    // `},` / `}),` / `],` has no statement of its own (it closes an object literal / call
    // argument / array and separates it from the next element) **and** bun's lcov never
    // emits a record for it — measured: 14 such lines were reported as "missed" forever.
    // A *value* followed by a comma (`x,` inside a multi-line call) still counts as code:
    // only lines made *entirely* of these characters drop.
    const structuralChar = (c) => c === "}" || c === "]" || c === ")" || c === ";" || c === ",";
    let j = 0;
    let codeEnd = s.length; // where the code stops (a `//` comment may cut it short)
    while (j < s.length) {
      const c = s[j];
      const d = s[j + 1];
      if (inBlock) {
        if (c === "*" && d === "/") {
          inBlock = false;
          j += 2;
        } else j++;
        continue;
      }
      const top = tpl[tpl.length - 1];
      if (top && !top.interp) {
        // inside template text
        if (c === "\\") {
          j += 2;
        } else if (c === "`") {
          tpl.pop();
          saw = true;
          substantive = true;
          j++;
        } else if (c === "$" && d === "{") {
          top.interp = true;
          top.depth = 0;
          saw = true;
          substantive = true;
          j += 2;
        } else j++;
        continue;
      }
      if (c === "/" && d === "*") {
        inBlock = true;
        j += 2;
        continue;
      }
      if (c === "/" && d === "/") {
        codeEnd = j; // line comment — nothing executable after it
        break;
      }
      if (c === "'" || c === '"') {
        const q = c;
        j++;
        while (j < s.length) {
          if (s[j] === "\\") {
            j += 2;
            continue;
          }
          if (s[j] === q) {
            j++;
            break;
          }
          j++;
        }
        saw = true;
        substantive = true; // a string is code, even if its content is "}"
        continue;
      }
      if (c === "`") {
        tpl.push({ interp: false, depth: 0 });
        saw = true;
        substantive = true;
        j++;
        continue;
      }
      if (top && c === "{") {
        top.depth++;
        j++;
        continue;
      }
      if (top && c === "}") {
        if (top.depth === 0) top.interp = false;
        else top.depth--;
        j++;
        continue;
      }
      if (!/\s/.test(c)) {
        saw = true;
        if (!structuralChar(c)) substantive = true;
      }
      j++;
    }
    if (!saw || !substantive) return;
    // REQ-A405: a switch label alone on its line (`default:` / `case x:`) has no statement
    // of its own, and bun emits **no record** for it even when the branch runs (measured:
    // `appIcon.ts:88` / `telemetrySpy.ts:105,119,133` — the label is "missed" while its body
    // line is hit). 15 such lines were counted as permanent misses. A label with a statement
    // on the same line (`default: return null;`) keeps counting, and a never-taken branch is
    // still visible through the body lines inside it (which bun *does* record as `DA:n,0`).
    if (/^(default|case\b[^;{}]*)\s*:\s*$/.test(s.slice(0, codeEnd).trim())) return;
    ex.add(idx + 1);
  });
  return ex;
}

function executableLines(relPath) {
  let src;
  try {
    src = readFileSync(relPath, "utf8");
  } catch {
    return null; // unreadable/renamed file — caller falls back to lcov-declared lines
  }
  const ex = executableLinesFromSource(src);
  // Second pass: TypeScript AST marks lines that consist purely of type-level
  // syntax (interfaces, type aliases, annotations, ambient declarations, overload
  // signatures) — they produce no runtime code and can never be recorded, so they
  // are dropped from the denominator just like comments (REQ-A396).
  const ts = getTS();
  if (!ts) return ex;
  const sf = ts.createSourceFile(relPath, src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const ranges = [];
  const hasDeclare = (n) => (n.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
  const visit = (n) => {
    const k = n.kind;
    if (
      k === ts.SyntaxKind.InterfaceDeclaration ||
      k === ts.SyntaxKind.TypeAliasDeclaration ||
      k === ts.SyntaxKind.PropertySignature ||
      k === ts.SyntaxKind.MethodSignature ||
      k === ts.SyntaxKind.CallSignature ||
      k === ts.SyntaxKind.ConstructSignature ||
      k === ts.SyntaxKind.IndexSignature ||
      k === ts.SyntaxKind.TypeAnnotation ||
      (k === ts.SyntaxKind.ImportDeclaration && n.importClause?.isTypeOnly === true) ||
      (k === ts.SyntaxKind.ExportDeclaration && n.isTypeOnly === true) ||
      hasDeclare(n) ||
      // abstract methods / accessors and overload signatures carry no runtime body
      ((k === ts.SyntaxKind.MethodDeclaration ||
        k === ts.SyntaxKind.GetAccessorDeclaration ||
        k === ts.SyntaxKind.SetAccessorDeclaration ||
        k === ts.SyntaxKind.FunctionDeclaration) &&
        !n.body)
    ) {
      ranges.push([n.getStart(sf), n.getEnd()]);
    }
    // REQ-A405: a multi-line `import { a, b, … } from "x";` is **one** static statement.
    // bun attributes it to its first line and never records the continuation lines, so the
    // name list (`calendarCore.ts` 12 lines, `quickRadio.ts` 8, …) read as 46 permanent
    // "misses". Only the *continuation* lines are dropped (from the end of the first line
    // to the end of the statement); the `import {` line itself stays in the denominator.
    if (k === ts.SyntaxKind.ImportDeclaration) {
      const start = n.getStart(sf);
      const firstLineEnd = src.indexOf("\n", start);
      if (firstLineEnd !== -1 && firstLineEnd < n.getEnd()) ranges.push([firstLineEnd, n.getEnd()]);
    }
    if (k === ts.SyntaxKind.AsExpression || k === ts.SyntaxKind.SatisfiesExpression) {
      if (n.type) ranges.push([n.type.getStart(sf), n.type.getEnd()]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // absorb separators/whitespace so a type annotation that ends a line with a
  // trailing `,`/`;` still hides that line
  for (const r of ranges) {
    let s = r[0];
    let e = r[1];
    while (s > 0 && /[\s,;]/.test(src[s - 1])) s--;
    while (e < src.length && /[\s,;]/.test(src[e])) e++;
    r[0] = s;
    r[1] = e;
  }
  const lineStarts = [];
  let off = 0;
  for (const l of src.split(/\r?\n/)) {
    lineStarts.push(off);
    off += l.length + 1;
  }
  src.split(/\r?\n/).forEach((l, i) => {
    const trimmed = l.trim();
    if (trimmed.length === 0) return;
    const ls = lineStarts[i] + (l.length - l.trimStart().length);
    const le = lineStarts[i] + trimmed.length;
    if (ranges.some(([s, e]) => s <= ls && le <= e)) ex.delete(i + 1);
  });
  return ex;
}

let cur = null;
let curLines = null;
const files = {}; // path -> { line -> max hits }
for (const report of reports)
for (const raw of readFileSync(report, "utf8").split("\n")) {
  const line = raw.trim();
  if (line.startsWith("SF:")) {
    cur = line.slice(3);
    // Accumulate across reports: `files[cur] = {}` would make each report *replace* what
    // earlier ones recorded for the same file (that bug made the gate read only the last
    // report per file: 12,211 lines instead of 13,812).
    curLines = files[cur] ?? (files[cur] = {});
  } else if (line.startsWith("DA:") && cur !== null) {
    const [ln, count] = line.slice(3).split(",", 2);
    const n = Number(ln);
    const hits = Number(count) || 0;
    if (!Number.isFinite(n)) continue;
    // max, not assignment: the reports overlap and a line covered in *any* run counts.
    curLines[n] = Math.max(curLines[n] ?? 0, hits);
  } else if (line === "end_of_record") {
    cur = null;
  }
}

let total = 0;
let hit = 0;
const libFiles = []; // [path, executableLines, hitLines, missedLineNumbers]
for (const [path, lines] of Object.entries(files)) {
  if (!path.startsWith("src/lib/")) continue;
  const exec = executableLines(path);
  let ft = 0;
  let fh = 0;
  const missed = [];
  if (exec) {
    ft = exec.size;
    for (const n of exec) {
      if ((lines[n] ?? 0) > 0) fh++;
      else missed.push(n);
    }
    // Lines bun recorded for a file but that are comments/blanks are simply not in
    // `exec` and drop out of the denominator (REQ-A396).
  } else {
    // Source unavailable: fall back to lcov-declared lines (old behaviour).
    ft = Object.keys(lines).length;
    fh = Object.values(lines).filter((c) => c > 0).length;
    for (const [n, c] of Object.entries(lines)) if (c === 0) missed.push(Number(n));
  }
  total += ft;
  hit += fh;
  missed.sort((a, b) => a - b);
  libFiles.push([path, ft, fh, missed]);
}

if (total === 0) {
  console.error("No src/lib coverage found — did coverage/lcov.info get generated?");
  process.exit(2);
}

/**
 * Pins the line classifier. The two halves that matter:
 *   • **excluded**: blank/comment-only lines and bare closing brackets (`}`, `});`, `};`)
 *     — no statement of their own;
 *   • **kept**: anything with real code, including `} else {` (a branch), a string whose
 *     *content* is a brace, and every ordinary statement — so a real uncovered line
 *     cannot hide behind this filter (that is the whole risk of the change).
 */
function selftest() {
  const problems = [];
  let n = 0;
  const want = (label, got, expected) => {
    n++;
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    }
  };
  const lines = (src) => [...executableLinesFromSource(src)].sort((a, b) => a - b);

  // excluded: bare closing brackets
  want("function body: only the closing brace drops", lines("function f() {\n  return 1;\n}"), [1, 2]);
  want("object literal: `};` drops", lines("const o = {\n  a: 1,\n};"), [1, 2]);
  want("call spread over lines: `});` drops", lines("run(\n  x,\n);"), [1, 2]);
  want("array literal: `];` drops", lines("const a = [\n  1,\n];"), [1, 2]);

  // kept: real code, including branch lines and brace-containing strings
  want("`} else {` is a branch, not structure", lines("if (x) {\n  y();\n} else {\n  z();\n}"), [1, 2, 3, 4]);
  want("a string whose content is a brace is code", lines('const s = "}";'), [1]);
  want("an ordinary statement is code", lines("x = 1;"), [1]);
  want("a trailing comment does not make a statement structural", lines("y(); // done"), [1]);
  want("`}; // done` still drops (no statement of its own)", lines("const o = {\n  a: 1,\n}; // done"), [1, 2]);

  // REQ-A405: the same shape with a comma — `},` / `}),` / `],` closed an element and bun
  // never records them, so they were 14 permanent "misses" (webman.ts:127/131/135/139 …).
  want("`},` (object-literal element end) drops", lines("const o = {\n  a: 1,\n},\n;"), [1, 2]);
  want("`}),` (call argument end) drops", lines("run({\n  a: 1,\n}),\n;"), [1, 2]);
  want("a *value* with a comma still counts (`x,` in a call)", lines("run(\n  x,\n  y,\n);"), [1, 2, 3]);
  want("an array element `1,` still counts", lines("const a = [\n  1,\n];"), [1, 2]);

  // REQ-A405: a switch label alone on its line carries no statement of its own and is never
  // recorded by bun (even when the branch runs) — but the body lines inside it are.
  want(
    "switch labels alone on their line drop, their bodies stay",
    lines("switch (x) {\n  case 1:\n    return 1;\n  default:\n    return 2;\n}"),
    [1, 3, 5],
  );
  want("a one-line `default: return …;` stays (it holds a statement)", lines("default: return 2;"), [1]);
  want("`case 1: {` stays (opens a block, not a bare label)", lines("case 1: {\n  y();\n}"), [1, 2]);

  // excluded: blanks/comments (REQ-A396 behaviour, unchanged)
  want("blank lines drop", lines("\n\n"), []);
  want("line comment drops", lines("// nothing here"), []);
  want("block comment drops", lines("/* a\n b */"), []);
  want("multi-line template text is not its own line", lines("const t = `\n  text\n`;"), [1, 3]);
  want("template interpolation is code", lines("const t = `${x}`;"), [1]);

  // REQ-A861: the comment stripper, and the importer resolver built on it.
  want("a line comment is prose", stripComments('x(); // from "./a"').includes("from"), false);
  want("a block comment is prose", stripComments('/* from "./a" */ y();').includes("from"), false);
  want("a string literal survives — its specifier IS the answer", stripComments('import x from "./a";').includes('"./a"'), true);
  // F-DEV-104's trap: the usual `replace(/\/\*[\s\S]*?\*\//g, …)` idiom reads the `/*`
  // inside a literal as a comment opener and eats real code up to the next `*/`.
  want(
    "`/*` inside a string does not open a comment",
    stripComments('const a = "/*";\nconst keep = 1;\nconst b = "*/";').includes("keep"),
    true,
  );
  want("`//` inside a regex does not open a comment", stripComments("const r = /\\/\\//;\nconst keep = 1;").includes("keep"), true);
  want("stripComments keeps the line count", stripComments("/* a\n b */\nx();\ny();").split("\n").length, 4);

  const mods = new Set(["src/lib/a.ts", "src/lib/deep/b.ts", "src/lib/dir/index.ts"]);
  const one = (path, src) => importedModules([{ path, src }], mods);
  want("a relative specifier resolves against its own file", one("src/lib/__tests__/a.test.ts", 'import { x } from "../a";').get("src/lib/a.ts"), "src/lib/__tests__/a.test.ts");
  want("a `..` specifier resolves from its own directory", one("src/__tests__/b.test.ts", 'import { y } from "../lib/deep/b";').get("src/lib/deep/b.ts"), "src/__tests__/b.test.ts");
  want("a directory specifier resolves to index.ts", one("svelte-tests/c.test.ts", 'import { z } from "../src/lib/dir";').has("src/lib/dir/index.ts"), true);
  want("a bare specifier names no module of ours", one("x.test.ts", 'import "svelte";').size, 0);
  want("an import named only in a comment is not an import", one("src/lib/__tests__/a.test.ts", '// the shape is `from "../a"`').size, 0);
  want("a module nothing imports stays absent (the control)", one("src/lib/__tests__/a.test.ts", 'import { x } from "../a";').has("src/lib/deep/b.ts"), false);

  // REQ-A1325: the three-valued classification. The middle value is the fix — a module whose
  // only importer is in the `.svelte` harness is measured *there*, not a blind spot here.
  const cm = (pairs) => new Map(pairs);
  const cls = classifyUnmentioned(
    ["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts"],
    cm([["src/lib/a.ts", "src/__tests__/a.test.ts"]]),
    cm([["src/lib/b.ts", "svelte-tests/b.svelte.test.ts"]]),
  );
  want("a measured-corpus importer is a stale report", cls.staleReport, ["src/lib/a.ts"]);
  want("a svelte-tests-only importer is the other harness, not a blind spot", cls.otherHarness, ["src/lib/b.ts"]);
  want("no importer anywhere is the blind spot", cls.blindSpot, ["src/lib/c.ts"]);
  const both = classifyUnmentioned(
    ["src/lib/a.ts"],
    cm([["src/lib/a.ts", "src/__tests__/a.test.ts"]]),
    cm([["src/lib/a.ts", "svelte-tests/a.svelte.test.ts"]]),
  );
  want("a measured-corpus importer wins over the harness — a stale report is never excused", both.staleReport, ["src/lib/a.ts"]);
  want("…and such a module is not also listed as other-harness", both.otherHarness, []);

  if (problems.length > 0) {
    console.error(`[lib-coverage-gate] selftest FAIL:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[lib-coverage-gate] selftest: ${n} assertion(s), 0 failure(s).`);
}

/**
 * Strip comments only — string literals are kept **verbatim**, because the thing this is
 * for is reading an import specifier out of `from "./x"`, and masking the strings would
 * delete the answer along with the noise (REQ-A861).
 *
 * Comments must go for the opposite reason: an import statement is *this repository's*
 * house style for explaining a sibling module in a doc comment, so a comment-aware scan
 * would read a module's own header as evidence that a test imports it. The consequence of
 * that direction is the dangerous one — a module with genuinely no test would be reported
 * as "the report is stale", which is a false reassurance, not a false alarm.
 *
 * Written as one stateful pass rather than the usual "blank out every block comment with
 * a non-greedy regex" idiom, for the F-DEV-104 reason: that regex reads the opener written
 * **inside a string literal** as a comment opener, and replaces everything up to the next
 * closer — real code — with spaces. The literal state here is entered before either
 * comment state is considered, so a literal can never open a comment. Template
 * interpolations are copied verbatim with the literal: a comment inside one is not
 * written in practice, and copying it is the conservative direction (it can only ever add
 * a candidate importer, never remove one).
 *
 * Length and newlines are preserved, so the output stays line-aligned with the input.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let prev = ""; // last non-space code character, for the regex-literal heuristic
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && d === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      if (i < n) { out += "  "; i += 2; }
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        out += src[i];
        if (src[i] === c) { i++; break; }
        i++;
      }
      prev = c;
    } else if (c === "/" && "([,=:[!&|?{};+-*%<>~^".includes(prev)) {
      // A regex literal is copied verbatim: a `"` inside it (e.g. /"/) would otherwise
      // open a string state and swallow the rest of the file as prose.
      out += c;
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { out += src[i]; i++; break; }
        out += src[i];
        i++;
      }
      prev = "/";
    } else {
      out += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out;
}

/**
 * A `/` right after one of `([,=:[!&|?{};+-*%<>~^` can only open a regex literal, never a
 * division (the classic heuristic). It is spelled inline in `stripComments` rather than
 * named here so the selftest — which runs before this line — cannot reach a `const` in
 * its temporal dead zone.
 */

/** Every module specifier a source names, comments already stripped. */
export function importSpecifiers(src) {
  const out = [];
  const re = /(?:\bfrom\s*|\brequire\s*\(?\s*|\bimport\s*\(?\s*)["']([^"'\n]+)["']/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

/**
 * Which of `modules` a set of test sources imports — resolved **per file**, relative to
 * the file that writes the specifier (a directory-walk order would answer for the wrong
 * file; REQ-A405's follow-up). `entries` is `[{ path, src }]`, `modules` a `Set` of
 * frontend-root-relative paths like `src/lib/shareSheet.ts`. The value is the test file
 * that imports it, for the message.
 *
 * Only relative specifiers are resolved. A bare specifier (`"svelte"`) names a package,
 * not one of our modules, so it can never be the answer.
 */
export function importedModules(entries, modules) {
  const imported = new Map();
  for (const { path, src } of entries) {
    // Stripped here, not by the caller: a caller that forgets would let a doc comment
    // count as an import, and that is the direction that hides a real blind spot.
    for (const spec of importSpecifiers(stripComments(src))) {
      if (!spec.startsWith(".")) continue;
      const base = normalize(join(dirname(path), spec));
      for (const cand of [`${base}.ts`, `${base}.svelte.ts`, `${base}/index.ts`]) {
        if (modules.has(cand) && !imported.has(cand)) imported.set(cand, path);
      }
    }
  }
  return imported;
}

/** The test files whose coverage the runner actually reports — see TEST_ROOTS. */
export function testEntries(roots = TEST_ROOTS) {
  const out = [];
  const collect = (dir) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${ent.name}`;
      if (ent.isDirectory()) collect(p);
      else if (/\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(ent.name)) {
        out.push({ path: p, src: readFileSync(p, "utf8") });
      }
    }
  };
  for (const r of roots) collect(r);
  return out;
}

/**
 * The two test roots the coverage runner scans — `scripts/bun-iso-test.mjs`'s
 * `testRoots`, mirrored here on purpose. It has to be **these** files and no others:
 * a module imported only from `svelte-tests/` gets no record from this runner, so
 * counting it would excuse a module whose coverage is genuinely absent.
 */
const TEST_ROOTS = ["src/__tests__", "src/lib/__tests__"];

/**
 * The `.svelte` harness (`vitest.config.ts`'s `include`) — the corpus this coverage runner
 * **cannot** execute: its files import the vitest API and `@testing-library/svelte`, whose
 * `mount` needs `vite-plugin-svelte`. Reading it is what makes the "does a test import it?"
 * measurement answer the question it asks (REQ-A1325).
 */
const DOM_TEST_ROOTS = ["svelte-tests"];

/**
 * Split the modules **no report mentions** into the three distinct facts they can be.
 *
 * The question the gate prints is "does a test import it?", and until REQ-A1325 it answered
 * that from `TEST_ROOTS` alone — so `src/lib/realCall.ts`, whose only importers are
 * `svelte-tests/phone-real-call-*.svelte.test.ts`, was reported as *"never mentioned by any
 * report, and no test imports it"*: a false statement, twice over. Both remedies it offered
 * were wrong for it — re-running the reports cannot help (this runner never executes those
 * files, so no report will ever mention the module), and `coverage-unmentioned-allowlist.json`
 * means "this module has no test at all", which is the opposite of true.
 *
 * So the classification is three-valued, and the third value is *printed*, never silent:
 *   * `staleReport` — imported by a file in the measured corpus, absent from the reports
 *     ⇒ the reports are older than the tree; re-run them (fails).
 *   * `otherHarness` — imported *only* by a `svelte-tests/` file ⇒ this runner structurally
 *     cannot measure it; the `.svelte` harness does. Printed with its importer every run so
 *     "measured elsewhere" never reads as "measured here" (the `dead-member-scan` precedent
 *     for its `unadjudicable` list). Not a failure — it is a fact, not a defect.
 *   * `blindSpot` — no importer anywhere ⇒ unmeasured and untested; add a test or allowlist
 *     it with a reason (fails).
 *
 * An importer in the **measured** corpus wins over one in the DOM harness: a module a stale
 * report *and* a svelte-test both import is a stale report, because re-running really would
 * fix it. The harness must never excuse a report that is merely old.
 */
export function classifyUnmentioned(unmentioned, covImporters, domImporters) {
  const staleReport = unmentioned.filter((p) => covImporters.has(p));
  const otherHarness = unmentioned.filter((p) => !covImporters.has(p) && domImporters.has(p));
  const blindSpot = unmentioned.filter((p) => !covImporters.has(p) && !domImporters.has(p));
  return { staleReport, otherHarness, blindSpot };
}

// Audit trail for the next coverage round: every src/lib file with real misses and
// the exact line numbers (executable ones only).
writeFileSync(
  "coverage/lib-coverage-misses.txt",
  libFiles
    .filter(([, , , m]) => m.length > 0)
    .sort((a, b) => b[3].length - a[3].length)
    .map(([p, t, h, m]) => `${p}  missed ${m.length}/${t} (${((100 * h) / t).toFixed(1)}%)\n  ${m.join(",")}\n`)
    .join("\n"),
);

/**
 * The denominator's **other** blind spot (REQ-A405): everything above can only see
 * modules that some report *mentions* (`files` is built from `SF:` records). A
 * `src/lib` module no test ever imported has no record anywhere, so it is silently
 * absent — the gate then reports a healthy aggregate over "150 files" while the
 * directory holds 154. Measured before this rule existed: `sysIcons.ts` (radio/quick
 * icon mapping, the battery glyph), `version.ts`, `shellChrome.ts` — the first is real
 * logic, so "unmeasured" is exactly where a real gap hides behind a green number.
 *
 * Rule: every TypeScript module under `src/lib` must either be **mentioned by a report** (hence
 * measurable) or be listed in `scripts/coverage-unmentioned-allowlist.json` with a
 * non-empty `reason`. A stale entry (the module is measured now, or no longer exists)
 * fails too, so the exempt list cannot rot. The count is printed on every run, so the
 * size of the blind spot stays visible even when the rule passes.
 *
 * REQ-A861 — **the rule must answer the question it asks.** The message above says
 * "no test imports it?"; until this round that was a guess from an absence, and the
 * reports it reads are a *snapshot of the last coverage run*, not of the tree. Measured
 * on 2026-09-21: all **13** modules this rule accused had a test importing them (the
 * newest report was 2026-09-20 18:16; the 13 tests were written between 20:05 and the
 * next day 22:57). Every one of them was a *stale report*, and the printed remedy —
 * "add a test that imports the module" — was wrong 13 times out of 13. The third
 * option it offers is worse than wrong: listing those 13 in the allowlist would have
 * put modules that **have** tests into the one file whose meaning is "this module has
 * no test", hiding the real blind spot behind them permanently.
 *
 * So the guess is replaced by the measurement: `importedModules` resolves each test
 * file's own relative specifiers (per file, not by a directory walk), and the
 * unmentioned set is reported as two different things with two different remedies —
 * a module a test imports but no report mentions (the reports are old: re-run them)
 * versus a module nothing imports (write the test, or allowlist it with a reason).
 * Both still fail the gate: a stale corpus must not pass, and the aggregate
 * percentage above is computed over the same stale reports.
 */
function libModulesOnDisk(dir = "src/lib", out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (ent.name !== "__tests__" && !ent.name.startsWith(".")) libModulesOnDisk(`${dir}/${ent.name}`, out);
    } else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts")) {
      out.push(`${dir}/${ent.name}`);
    }
  }
  return out.sort();
}

const modulesOnDisk = libModulesOnDisk();
const allowPath = "scripts/coverage-unmentioned-allowlist.json";
let allowlisted = {};
if (existsSync(allowPath)) {
  try {
    allowlisted = JSON.parse(readFileSync(allowPath, "utf8"));
  } catch {
    console.error(`P2-1 GATE FAILED: ${allowPath} is not valid JSON`);
    process.exit(1);
  }
}
const unmentioned = modulesOnDisk.filter((p) => !files[p] && !(p in allowlisted));
const rottenAllowlist = Object.entries(allowlisted)
  .filter(([p, v]) => !v || typeof v.reason !== "string" || v.reason.trim() === "" || files[p] || !existsSync(p))
  .map(([p]) => p);

// REQ-A863: `unmentioned` is "no report mentions it", which is a fact about the reports.
// Whether a test imports the module is a fact about the code, and it is the one the
// message needs — so measure it instead of inferring it from the absence. Skipped when
// there is nothing to explain, so the reading of ~400 test files is not a tax on the
// passing path.
const moduleSet = new Set(modulesOnDisk);
const covImporters =
  unmentioned.length > 0 ? importedModules(testEntries(TEST_ROOTS), moduleSet) : new Map();
const domImporters =
  unmentioned.length > 0 ? importedModules(testEntries(DOM_TEST_ROOTS), moduleSet) : new Map();
const { staleReport, otherHarness, blindSpot } = classifyUnmentioned(
  unmentioned,
  covImporters,
  domImporters,
);

const pct = (100 * hit) / total;
console.log(`src/lib line coverage: ${pct.toFixed(2)}% (${hit}/${total} executable lines, ${libFiles.length} files)`);
console.log(
  `src/lib modules: ${modulesOnDisk.length - unmentioned.length}/${modulesOnDisk.length} measurable ` +
    `(${blindSpot.length} with no test importing them, ${staleReport.length} whose test the reports predate, ` +
    `${otherHarness.length} measured by the .svelte harness)`,
);
console.log(`threshold: ${(threshold * 100).toFixed(0)}%`);

// Printed on **every** run, passing or failing: a module this runner cannot measure must not
// read as one it measured (REQ-A1325). The importer is the proof it is a `.svelte` test.
if (otherHarness.length > 0) {
  console.log(
    `  ${otherHarness.length} module(s) whose only importer is outside this runner's corpus ` +
      `(${DOM_TEST_ROOTS.join(", ")}/) — measured by the \`.svelte\` harness, not rejected here:`,
  );
  for (const p of otherHarness) console.log(`    ${p}  <- ${domImporters.get(p)}`);
}

if (blindSpot.length > 0 || staleReport.length > 0 || rottenAllowlist.length > 0) {
  console.error("P2-1 GATE FAILED: the denominator has a blind spot (REQ-A405).");
  for (const p of blindSpot) console.error(`  never mentioned by any report, and no test imports it: ${p}`);
  if (staleReport.length > 0) {
    console.error(
      `  ${staleReport.length} module(s) a test DOES import and no report mentions — these are not`,
    );
    console.error("  untested, the coverage reports are older than the tree:");
    for (const p of staleReport) console.error(`    ${p}  <- ${covImporters.get(p)}`);
  }
  for (const p of rottenAllowlist) console.error(`  stale/invalid ${allowPath} entry: ${p}`);
  console.error("  fix: re-run `node scripts/bun-iso-test.mjs coverage` (the aggregate is stale too); for a");
  console.error(`  module nothing imports, add a test, or list it in ${allowPath} with a reason.`);
  console.error(`  Do not allowlist anything in the "a test DOES import" list: ${allowPath} means`);
  console.error('  "this module has no test at all", and an entry there hides it from this rule forever.');
  process.exit(1);
}
if (!Number.isFinite(pct)) {
  console.error("P2-1 GATE FAILED: coverage is not a finite number — corrupt report?");
  process.exit(1);
}
if (pct < threshold * 100) {
  console.error(`P2-1 GATE FAILED: coverage ${pct.toFixed(2)}% < ${(threshold * 100).toFixed(0)}%`);
  const worst = libFiles
    .filter(([, , , m]) => m.length > 0)
    .sort((a, b) => b[3].length - a[3].length)
    .slice(0, 12);
  for (const [p, , , m] of worst) console.error(`  ${m.length.toString().padStart(4)}  ${p}`);
  console.error("  full list: coverage/lib-coverage-misses.txt");
  process.exit(1);
}
console.log("P2-1 gate passed.");
