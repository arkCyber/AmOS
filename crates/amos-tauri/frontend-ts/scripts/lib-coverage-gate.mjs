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
 * outside comments. String/template content counts as code (continuation lines of a
 * multi-line expression are attributed by coverage tools too). Template literals and
 * block comments span lines, so the scanner keeps state across the whole file; `${…}`
 * interpolation nesting is tracked with a small stack. Regex literals need no special
 * handling: their characters are non-whitespace "code", and a `//` that opens a
 * comment can never appear at a code position inside a well-formed regex anyway.
 */
function executableLines(relPath) {
  let src;
  try {
    src = readFileSync(relPath, "utf8");
  } catch {
    return null; // unreadable/renamed file — caller falls back to lcov-declared lines
  }
  const ex = new Set();
  let inBlock = false;
  const tpl = []; // stack of { interp: boolean, depth: number } for `…${ … }…`
  src.split(/\r?\n/).forEach((s, idx) => {
    let saw = false;
    let j = 0;
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
          j++;
        } else if (c === "$" && d === "{") {
          top.interp = true;
          top.depth = 0;
          saw = true;
          j += 2;
        } else j++;
        continue;
      }
      if (c === "/" && d === "*") {
        inBlock = true;
        j += 2;
        continue;
      }
      if (c === "/" && d === "/") break; // line comment — nothing executable after it
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
        continue;
      }
      if (c === "`") {
        tpl.push({ interp: false, depth: 0 });
        saw = true;
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
      if (!/\s/.test(c)) saw = true;
      j++;
    }
    if (saw) ex.add(idx + 1);
  });
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

const pct = (100 * hit) / total;
console.log(`src/lib line coverage: ${pct.toFixed(2)}% (${hit}/${total} executable lines, ${libFiles.length} files)`);
console.log(`threshold: ${(threshold * 100).toFixed(0)}%`);
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
