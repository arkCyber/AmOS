#!/usr/bin/env node
/**
 * doc-cite-scan.mjs — "a `docs/….md` path written in a *source comment* must name a document
 * that exists".
 *
 * Why (REQ-A1628 / F-DEV-142, closed repo-wide by REQ-A1655 / F-DEV-143): the only instrument
 * that resolved document references was `docs-link-scan.mjs`, and it reads **Markdown link
 * syntax inside `.md` files only** (`[x](target)`, code stripped first). A `docs/….md` path
 * written in a Rust / Svelte / TS / shell **comment** therefore sat in no gate's window, and
 * `crates/amos-tauri/src/screen_record.rs` cited `docs/screen-recording.md` three times as the
 * disclosure of its honest boundaries while that file did not exist anywhere in the repo — a
 * citation read as "the boundaries are written down" that pointed at nothing.
 *
 * That round fixed the module and added a guard **local to it** (`cited_docs_in_doc_comments`).
 * A guard on one module is not a rule: the sweep that produced it measured **four** dangling
 * citations in the tree, and left three standing as outside "the latest code" (`docs/stage-manager.md`
 * ×4 — since written; plus two that named a document under `docs/` when the document lives
 * elsewhere in the tree). This file is that rule: every source comment's citation, checked
 * against the filesystem.
 *
 * **This file's own comments are inside its own window**, so a *nonexistent* path may not be
 * spelled here — the paths this round fixed are named in `CHANGELOG.md` / `docs/FMEA.md` /
 * `docs/TRACEABILITY_MATRIX.md` (`.md` prose, out of window by the rule below), and a path
 * written here is a claim that the document is there. That is the rule working as intended, not
 * a special case: a gate whose header may lie about paths is not a gate.
 *
 * ## The window (what is read, and why the rest is not)
 *
 * Two comment shapes are read, both of them *comments*:
 *
 *   • **line-leading comments** — a line whose first non-space characters open a comment
 *     (`//`, `///`, `//!`, `/*`, `*`) or, in a shell script, `#` (a `#!` shebang is not prose).
 *     A citation after code on the same line (a *trailing* comment) is deliberately **not**
 *     read: telling a trailing comment apart from a string literal on that same line means
 *     tokenising, and a wrong guess reports a path that is really a fixture. Measured
 *     2026-09-25: **zero** citations in this tree sit in a trailing comment, so the boundary
 *     costs nothing today and the strict rule cannot cry wolf.
 *   • **`.svelte` HTML comments** — the body of `<!-- … -->`, including its continuation lines
 *     (Svelte screens carry real prose there: `settings/WindowPage.svelte` names `docs/gui-verify.md`
 *     and `docs/android-compat.md` as the verification this card exists for).
 *
 * Two shapes that *mention* a `docs/….md` path are deliberately outside the window, each for a
 * measured reason and neither silently:
 *
 *   • **string literals** — a path a string literal holds is one the code builds or a fixture, not
 *     a citation (REQ-A1628's own distinction, kept here). `svelte-tests/files.svelte.test.ts`
 *     builds eleven fixture paths under a temp dir; a regex over code lines would report each as
 *     a missing document. Texts *emitted* from strings (an error message telling a developer which
 *     doc to read, e.g. `react-free-scan.mjs`'s) are citations in fact and are fixed by hand, but
 *     they are a separate window with its own detector — not this one.
 *   • **`.md` prose** — a path quoted in a document is prose about paths: the ledgers quote the
 *     dangling citations *as the record of this very defect*, and rewriting that record to a path
 *     that now resolves would falsify the history. Markdown link syntax is already
 *     `docs-link-scan.mjs`'s job.
 *
 * ## Checks
 *
 *   R1 `missing`         — a citation in the window whose path is not in the tree (repo-root
 *                          relative, which is how every citation here is written: `docs/…`).
 *   R2 `stale-allowlist` — an allow-list entry that no longer matches any citation. An exemption
 *                          outliving what it exempted reads as "checked and fine"; it fails.
 *
 * Legitimate *placeholders* go in `scripts/doc-cite-allowlist.json` with their own reason:
 * `docs-link-scan.mjs`'s header describes a link rewrite by the **shape** of the move, so the file
 * name it uses in the example names no document on purpose. An entry whose citation is gone fails
 * (R2), so an exemption cannot outlive the text it was written for.
 *
 * Usage (repo root):
 *   node scripts/doc-cite-scan.mjs             # gate (exit 1 on a finding, 2 on a read failure)
 *   node scripts/doc-cite-scan.mjs --json      # machine-readable report
 *   node scripts/doc-cite-scan.mjs --selftest  # pin the window + the two rules
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, ".."));
const ALLOWLIST = join(HERE, "doc-cite-allowlist.json");

/** Directories that are build output / vendored, never this repository's prose. */
const SKIP_DIRS = new Set(["node_modules", "target", ".git", "dist", ".svelte-kit"]);

/**
 * Paths whose files are **not** a live index and are therefore out of scope — the same recorded
 * decision `docs-link-scan.mjs` makes, and for the same reason: a frozen snapshot's references
 * describe the tree as it was when the snapshot was taken.
 */
const SKIP_PATHS = ["docs/archive/"];

/** Extensions carrying prose comments. `.md` is deliberately absent — see the header. */
const SOURCE_EXTS = new Set([".rs", ".ts", ".svelte", ".mjs", ".js", ".cjs", ".kt", ".sh"]);

/** A `docs/….md` path. The trailing `.md` keeps a sentence's full stop out of the match. */
const CITATION = /docs\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.md/g;

/** Is this line *opened* by a comment marker (its own line, not a trailing comment)? */
export function isCommentLine(line, ext) {
  const t = line.trim();
  if (t === "") return false;
  if (ext === ".sh") return t.startsWith("#") && !t.startsWith("#!");
  return /^(\/\/|\/\*|\*)/.test(t);
}

/**
 * The parts of one line that sit **inside** an HTML comment, carrying the open/closed state in and
 * out. The markers themselves belong to the comment, so a citation may share a line with either
 * delimiter; text outside the comment (before `<!--` or after `-->`) is not comment and must not be
 * read.
 */
export function htmlCommentSegments(line, inHtml) {
  const segments = [];
  let pos = 0;
  let open = inHtml;
  while (pos < line.length) {
    if (open) {
      const end = line.indexOf("-->", pos);
      if (end < 0) {
        segments.push(line.slice(pos));
        return { segments, inHtml: true };
      }
      segments.push(line.slice(pos, end));
      open = false;
      pos = end + 3;
    } else {
      const start = line.indexOf("<!--", pos);
      if (start < 0) return { segments, inHtml: false };
      pos = start + 4;
      open = true;
    }
  }
  return { segments, inHtml: open };
}

/**
 * Every `docs/….md` citation in `text`, as `{ line, path }` (1-based line numbers, de-duplicated
 * per line so one placeholder quoted twice in a sentence is one citation).
 *
 * `ext` selects the comment grammar (see [`isCommentLine`] plus the `.svelte` HTML-comment body).
 */
export function citationsIn(text, ext, file = "") {
  const out = [];
  let inHtml = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const segments = [];
    if (isCommentLine(line, ext)) segments.push(line);
    if (ext === ".svelte") {
      const res = htmlCommentSegments(line, inHtml);
      inHtml = res.inHtml;
      segments.push(...res.segments);
    }
    const seen = new Set();
    for (const seg of segments) {
      for (const m of seg.matchAll(CITATION)) {
        if (seen.has(m[0])) continue;
        seen.add(m[0]);
        out.push({ file, line: i + 1, path: m[0] });
      }
    }
  }
  return out;
}

/** Every source file in the tree whose comments can cite a document (repo-root-relative). */
export function sourceFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const p = join(dir, ent.name);
      const rel = p.slice(root.length + 1).split(sep).join("/");
      if (SKIP_PATHS.some((s) => rel.startsWith(s))) continue;
      if (ent.isDirectory()) walk(p);
      else if (SOURCE_EXTS.has(extname(ent.name))) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

/** Read the allow-list; a missing file is an empty list (the normal state). */
export function loadAllowlist(path = ALLOWLIST) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")).entries ?? [];
}

/**
 * R1 + R2 over the citations. `exists(rel)` is injected so the rules are testable without a
 * filesystem. The return value carries the *used* allow-list keys, because R2 is exactly
 * "which keys nobody used".
 */
export function citationProblems(citations, exists, allowlist = []) {
  const allowed = new Set(allowlist.map((e) => `${e.file}\0${e.cited}`));
  const used = new Set();
  const problems = [];
  for (const c of citations) {
    const key = `${c.file}\0${c.path}`;
    if (allowed.has(key)) {
      used.add(key);
      continue;
    }
    if (!exists(c.path)) {
      problems.push({ rule: "missing", file: c.file, line: c.line, cited: c.path });
    }
  }
  for (const e of allowlist) {
    if (!used.has(`${e.file}\0${e.cited}`)) {
      problems.push({ rule: "stale-allowlist", file: e.file, cited: e.cited });
    }
  }
  return problems;
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);
  const paths = (text, ext) => citationsIn(text, ext, "f.rs").map((c) => c.path);

  // The window: line-leading comments of every spelling count.
  ok("a `//` line is read", paths("// see docs/a.md", ".rs").includes("docs/a.md"));
  ok("a `///` line is read", paths("/// see docs/a.md", ".rs").includes("docs/a.md"));
  ok("a `//!` line is read", paths("//! see docs/a.md", ".rs").includes("docs/a.md"));
  ok("a block-comment opener is read", paths("/* see docs/a.md */", ".rs").includes("docs/a.md"));
  ok("a `*` continuation line is read", paths(" * see docs/a.md", ".rs").includes("docs/a.md"));
  ok("a shell `#` line is read", paths("# see docs/a.md", ".sh").includes("docs/a.md"));
  ok("a shebang is not prose", paths("#!/bin/sh docs/a.md", ".sh").length === 0);
  // REQ-A1628's distinction, kept: a path in a string literal is not a citation.
  ok("a string literal is not read", paths('let p = "docs/a.md";', ".rs").length === 0);
  ok(
    "a doc-comment-looking string is not read",
    paths('    f("//! see `docs/a.md` for the trade"),', ".rs").length === 0,
  );
  ok("a trailing comment is not read (documented boundary)", paths("let x = 1; // docs/a.md", ".rs").length === 0);
  ok("a path without `.md` is not a citation", paths("// see docs/a.rs", ".rs").length === 0);
  ok("one placeholder twice on a line is one citation", paths("// `./docs/X.md` → `docs/X.md`", ".mjs").length === 1);
  ok("line numbers are 1-based and counted", citationsIn("\n\n// docs/a.md", ".rs", "f")[0].line === 3);

  // The `.svelte` HTML-comment body — including continuation lines, which is where the real
  // citations sit (WindowPage's card cites two documents across two lines).
  ok(
    "an HTML comment body is read across lines",
    paths("<!-- a\n  docs/a.md and\n  docs/b.md -->", ".svelte").join(",") === "docs/a.md,docs/b.md",
  );
  ok(
    "text after `-->` is not read",
    paths("<!-- x --> then docs/a.md", ".svelte").length === 0,
  );
  ok("HTML comments are not read in other extensions", paths("<!-- docs/a.md -->", ".ts").length === 0);

  // R1 / R2.
  const cites = citationsIn("// docs/here.md\n// docs/gone.md", ".rs", "a.rs");
  const problems = citationProblems(cites, (p) => p === "docs/here.md");
  ok("R1 flags the resolving citation's neighbour only", problems.length === 1 && problems[0].cited === "docs/gone.md");
  ok("R1's rule is named", problems[0].rule === "missing");
  const allow = [{ file: "a.rs", cited: "docs/gone.md", reason: "placeholder" }];
  ok("an allow-list entry suppresses its finding", citationProblems(cites, (p) => p === "docs/here.md", allow).length === 0);
  ok(
    "R2 flags an entry nothing cites",
    citationProblems(cites, () => true, [{ file: "a.rs", cited: "docs/never.md", reason: "x" }]).some(
      (p) => p.rule === "stale-allowlist",
    ),
  );
  ok(
    "an entry for another file does not suppress this one",
    citationProblems(cites, (p) => p === "docs/here.md", [{ file: "b.rs", cited: "docs/gone.md", reason: "x" }]).some(
      (p) => p.rule === "missing",
    ),
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[doc-cite-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[doc-cite-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

// --- scan -------------------------------------------------------------------
function runScan() {
  const allowlist = loadAllowlist();
  const citations = [];
  let files = 0;
  for (const rel of sourceFiles()) {
    let text;
    try {
      text = readFileSync(join(ROOT, rel), "utf8");
    } catch (e) {
      // A file that vanished between the walk and the read is a live-tree race (an editor or a
      // test runner's temp artifact), not a citation defect — but an unreadable tree is never
      // silence, so it is an error with the path named.
      console.error(`[doc-cite-scan] FAIL — could not read ${rel}: ${e.message}`);
      process.exit(2);
    }
    files++;
    citations.push(...citationsIn(text, extname(rel), rel));
  }

  const problems = citationProblems(citations, (p) => existsSync(join(ROOT, p)), allowlist);
  const missing = problems.filter((p) => p.rule === "missing");
  const stale = problems.filter((p) => p.rule === "stale-allowlist");

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        { files, citations: citations.length, allowed: allowlist.length, missing, stale },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[doc-cite-scan] ${citations.length} document citation(s) in ${files} source file(s), ` +
        `${allowlist.length} allow-list entr(y/ies).`,
    );
    for (const p of missing) {
      console.error(`[doc-cite-scan] FAIL — ${p.file}:${p.line} cites \`${p.cited}\`, which is not in the tree`);
    }
    for (const p of stale) {
      console.error(
        `[doc-cite-scan] FAIL — allow-list entry \`${p.file}\` → \`${p.cited}\` matches no citation ` +
          "(a stale exemption reads as 'checked and fine')",
      );
    }
    if (problems.length === 0) console.log("[doc-cite-scan] OK — every cited document exists.");
  }

  process.exit(problems.length === 0 ? 0 : 1);
}

// Importing this module must not scan the tree and `process.exit()` as a side effect — the same
// latent hazard `docs-link-scan.mjs` records (F-DEV-094): a future script that imports
// `citationsIn` for its own guard would lose its exit code to this gate's verdict. The comparison
// is by basename, matching that precedent (`/tmp` is a symlink to `/private/tmp` on macOS, so a
// full-path compare makes the gate a silent no-op under a symlinked cwd).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  if (process.argv.includes("--selftest")) runSelftest();
  runScan();
}
