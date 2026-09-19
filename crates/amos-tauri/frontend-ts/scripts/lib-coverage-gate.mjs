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
const reports = [
  LCOV,
  ...readdirSync("coverage")
    .filter((f) => /^lcov\.part-\d+\.info$/.test(f))
    .sort()
    .map((f) => `coverage/${f}`),
].filter((f) => existsSync(f));

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

  if (problems.length > 0) {
    console.error(`[lib-coverage-gate] selftest FAIL:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[lib-coverage-gate] selftest: ${n} assertion(s), 0 failure(s).`);
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

const pct = (100 * hit) / total;
console.log(`src/lib line coverage: ${pct.toFixed(2)}% (${hit}/${total} executable lines, ${libFiles.length} files)`);
console.log(`src/lib modules: ${modulesOnDisk.length - unmentioned.length}/${modulesOnDisk.length} measurable (the rest have no coverage record at all)`);
console.log(`threshold: ${(threshold * 100).toFixed(0)}%`);

if (unmentioned.length > 0 || rottenAllowlist.length > 0) {
  console.error("P2-1 GATE FAILED: the denominator has a blind spot (REQ-A405).");
  for (const p of unmentioned) console.error(`  never mentioned by any report (no test imports it?): ${p}`);
  for (const p of rottenAllowlist) console.error(`  stale/invalid ${allowPath} entry: ${p}`);
  console.error(`  fix: add a test that imports the module (so it becomes measurable), or list it in ${allowPath} with a reason`);
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
