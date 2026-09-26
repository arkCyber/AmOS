#!/usr/bin/env node
/**
 * docs-link-scan.mjs — every relative Markdown link in the repo must resolve.
 *
 * Why: docs move (`GETTING_STARTED.md` and `CODE_AUDIT_REPORT.md` were lifted out
 * of `docs/` to the repo root, and the GitHub issue templates sit two levels
 * down) and their **relative links are not rewritten**, so the onboarding guide,
 * the audit report and the security template 404 on GitHub. Nothing else checks
 * this: `cargo`/`tsc`/the proto and dictionary gates never read Markdown.
 *
 * What counts as a link: inline `[text](target)` and `![alt](target)` where the
 * target is **relative** (a path). `http(s):` / `mailto:` / `tel:` / `#anchor` /
 * protocol-relative `//…` links are out of scope (no network access here), and
 * so are links to a bare `#fragment`.
 *
 * Correctness details that matter:
 *   • **Code is stripped first** — fenced (``` / ~~~) blocks and inline `` `code` ``,
 *     so transcript markers like `` `[译](auto->zh)` `` are not read as links. The
 *     inline pairing is **per paragraph** and by **equal run length**: a code span is
 *     phrase-level content, so it cannot cross a blank line, and a run with no
 *     same-length partner in its own paragraph renders as a literal backtick instead
 *     of opening a span (REQ-A791 — pairing document-wide let one stray run blank out
 *     whole files; see [`stripInline`]).
 *   • An optional `"title"` is allowed: `[x](path "Title")`.
 *   • A `#fragment` is split off before resolving; the **file** part must exist
 *     (fragment slugs are not validated — GitHub's slug rules are a separate job).
 *   • `%20` / encoded characters are decoded before the filesystem check.
 *   • A link may point at a **directory** (e.g. `docs/`), which is fine.
 *
 * The scan is a **hard gate** (no baseline): a broken link is a defect.
 *
 * **Current state (measured 2026-09-17, REQ-A381): the gate is GREEN again — 438 markdown
 * files judged, 656 relative links resolved, 0 broken — and it got there by *deciding* two
 * things rather than by weakening the check.** ①`docs/archive/` is now out of scope **with a
 * reason** (`SKIP_PATHS` below): it is a committed frozen snapshot whose links describe the
 * tree as it was when the document was written, and the measurement behind that decision is
 * in the comment — 40 of its 53 files have no identical copy anywhere else, i.e. they are the
 * only surviving copy of that content; ②the 6 remaining findings were in three *untracked*
 * root documents that had been copied out of `docs/` / `frontend-ts/` and kept the original
 * directory's relative paths; those were fixed as link hygiene (`./docs/X.md` → `docs/X.md`,
 * `./src/lib/Y.ts` → the real frontend path, and two links that pointed at documents marked
 * `待创建` / at the placeholder word `计划中` became plain text — a link to something that does
 * not exist is a promise the document cannot keep).
 *
 * The exclusion is **reported on every run** ("N markdown file(s) … were NOT judged") and by
 * `--json` (`skipped`), because a silent skip is the very defect this gate exists to prevent.
 *
 * Usage (repo root):
 *   node scripts/docs-link-scan.mjs             # gate (exit 1 on any break)
 *   node scripts/docs-link-scan.mjs --json      # machine-readable report
 *   node scripts/docs-link-scan.mjs --selftest  # pin strip/extract/classify
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

const SKIP_DIRS = new Set(["node_modules", "target", ".git", "dist"]);

/**
 * Paths whose markdown is **not a live index** and is therefore out of scope (REQ-A381).
 *
 * `docs/archive/` is a frozen snapshot: its relative links describe the tree **as it was when
 * the document was written**, not as it is today. Measured on 2026-09-17: the 12 archived
 * files with broken links held 119 of them — 111 point at a file that exists today *outside*
 * the archive (the document has since moved), 3 at a sibling inside the archive, and 5 at
 * targets that no longer exist anywhere; the archived copies themselves are not duplicates
 * (40 of the 53 files in `docs/archive/2026-09/zh/` have no identical copy elsewhere, i.e.
 * they are the only surviving copy of that content).
 *
 * Rewriting those links to today's paths would make an archived audit report cite **current**
 * documents it never referenced — a false claim about what it documented — so the exclusion
 * is a **recorded decision** rather than a rewrite. It is *reported on every run* (a silent
 * skip is the very defect this gate exists to prevent): the script prints how many markdown
 * files it did not judge, and `--json` carries them.
 */
const SKIP_PATHS = ["docs/archive/"];

/** Markdown files under a deliberately skipped path (counted, never silently dropped). */
function countMarkdown(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) countMarkdown(p, acc);
    else if (ent.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

/**
 * Remove the inline code spans of **one paragraph**.
 *
 * A run is paired with the next unused run of **exactly the same backtick length**
 * (`` `` `x` `` `` is how a document quotes a backtick), left to right. A run with no
 * such partner *in its own paragraph* is **not** code — a renderer emits it as a
 * literal backtick — so it is left in place instead of opening a span.
 *
 * That last rule is the whole point (REQ-A791). Pairing **document-wide** meant one
 * stray run stole the judgement of everything after it: `CHANGELOG.md` reported five
 * dead links that do not exist, and `docs/TRACEABILITY_MATRIX.md` ended up with a
 * single 422,061-character "code span" — i.e. that file's links were never judged at
 * all, which is exactly the silent blindness this gate exists to prevent. The
 * trigger was prose carrying an *odd* number of equal-length runs (a `String?\``
 * written with a backslash escape, which does **not** work inside a code span).
 *
 * Bounding the span to its paragraph is not a weakening of the rule, it *is* the
 * rule: an inline code span is phrase-level content, and a blank line ends the
 * paragraph, so a span cannot cross one. (A single newline can — CommonMark folds it
 * into the span as a space — so only blank lines split.)
 *
 * The opposite trade is deliberate: if a document *intends* a span and loses a
 * backtick, the leftover text is now read as prose and a `[x](y)` inside it can be
 * reported as a dead link. A visible false positive on the one broken line is
 * recoverable; a gate that silently judges nothing is not.
 */
function stripInline(para) {
  const runs = [...para.matchAll(/`+/g)];
  const cut = [];
  for (let a = 0; a < runs.length; a++) {
    const len = runs[a][0].length;
    let b = -1;
    for (let c = a + 1; c < runs.length; c++) {
      if (runs[c][0].length === len) {
        b = c;
        break;
      }
    }
    if (b < 0) continue; // no partner in this paragraph: a literal backtick
    cut.push([runs[a].index, runs[b].index + len]);
    // Resume **after** the span: everything between the two runs is its content, so a
    // backtick inside it is text, not a second opener. (Matching runs of *different*
    // lengths independently lets two spans **overlap**, and an overlapping cut list
    // made the emitter walk `at` backwards and re-emit a region that was already
    // removed — that leak is how a `[x](y)` inside a code span came back as a link.)
    a = b;
  }
  let out = "";
  let at = 0;
  for (const [s, e] of cut) {
    out += para.slice(at, s) + " ";
    at = e;
  }
  return out + para.slice(at);
}

/**
 * Remove fenced + inline code so `[x](y)` inside code is not a link.
 *
 * Fences are **line-anchored** (``` / ~~~ must open a line) — a literal run of
 * backticks mid-sentence (e.g. prose documenting ```` ```/~~~ ````) is *not* a
 * fence and must not swallow the rest of the document. Inline code is then removed
 * **paragraph by paragraph** ([`stripInline`]) for the same reason one level down:
 * bounding a construct to the text it can actually cover, instead of letting one
 * unpaired delimiter reach across the file.
 */
export function stripCode(text) {
  const fenced = text.replace(
    /^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gm,
    " ",
  );
  return fenced
    .split(/(\n[ \t]*\n)/)
    // Which piece is a separator is decided by the **split's own structure** (the
    // capture group lands on the odd indices), not by looking at the text: with three
    // consecutive newlines the regex consumes two and the *content* piece that follows
    // starts with the third, so a `/^\n/` test silently classified a whole paragraph as
    // a separator and left its inline code **entirely unstripped** — the links inside
    // it came back as live links.
    .map((p, i) => (i % 2 === 0 ? stripInline(p) : p))
    .join("");
}

/** Inline link/image targets, in document order (`[x](t "title")` → `t`). */
export function extractLinks(text) {
  const out = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  return out;
}

/** Non-file links: schemes and pure fragments. */
export function isExternal(target) {
  return /^(https?:|mailto:|tel:|#|\/\/)/.test(target);
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  ok("stripCode removes fenced blocks", stripCode("a\n```\n[x](gone.md)\n```\nb") === "a\n \nb");
  ok(
    "stripCode removes inline code",
    !stripCode("see `[译](auto->zh)` end").includes("auto->zh"),
  );
  ok(
    "stripCode removes double-backtick code (quoting backticks)",
    !stripCode("otherwise `` `[译](auto->zh)` `` end").includes("auto->zh"),
  );
  ok(
    "stripCode does not treat a mid-sentence ``` as a fence",
    stripCode("prose ```/~~~ and [x](real.md)").includes("real.md"),
  );
  ok("stripCode keeps real links", stripCode("see [x](real.md)").includes("real.md"));

  // REQ-A791 — the pairing is bounded to a paragraph. Each of the next two cases is
  // red on the document-wide pairing (the run reaches across the blank line and eats
  // the link), which is how one stray backtick blanked out whole files.
  ok(
    "stripCode does not let a code span cross a blank line",
    stripCode("a `run\n\n[real](r.md) and ` end").includes("r.md"),
  );
  ok(
    "a run must find its partner in its own paragraph",
    stripCode("tail: ``broken\n\n[x](real.md)\n\nhead: ``other").includes("real.md"),
  );
  ok(
    "a stray run with no partner in its paragraph does not open a code span",
    stripCode("a stray ` here and [x](real.md) after it").includes("real.md"),
  );
  ok(
    "a single newline is inside the paragraph, so a span may fold it",
    !stripCode("see `[a](auto->zh)\nstill code` end").includes("auto->zh"),
  );
  // The interior of a span is content: a backtick inside it is text, not a second
  // opener. Matching each run length independently let two spans **overlap**, and the
  // overlapping cut list made the emitter walk `at` backwards and re-emit a region it
  // had already removed — a `[x](y)` inside the outer span came back out as a link.
  ok(
    "a span inside a longer span does not leak its content back out",
    !stripCode("``start `x` [a](auto->zh) end``").includes("auto->zh"),
  );
  ok(
    "a run of three newlines does not hide the paragraph after it",
    !stripCode("a\n\n\nsee `[a](auto->zh)` end").includes("auto->zh"),
  );

  const links = extractLinks("[a](a.md) and ![img](img/b.png \"T\") and [c](c.md#sec)");
  ok("extractLinks finds all three", links.join(",") === "a.md,img/b.png,c.md#sec");

  ok("isExternal scheme", isExternal("https://x") && isExternal("mailto:a@b"));
  ok("isExternal fragment", isExternal("#section"));
  ok("relative is not external", !isExternal("../docs/") && !isExternal("a.md"));

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[docs-link-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[docs-link-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

// --- scan -------------------------------------------------------------------
/** Markdown files found under an out-of-scope path, so the run can report them. */
const skipped = [];

function walk(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = join(dir, ent.name);
    const rel = p.slice(repo.length + 1).split(sep).join("/");
    if (SKIP_PATHS.some((s) => rel.startsWith(s))) {
      countMarkdown(p, skipped);
      continue;
    }
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

function runScan() {
  skipped.length = 0;
  const mdFiles = walk(repo).sort();
  const broken = [];
  let checked = 0;
  for (const file of mdFiles) {
    const text = stripCode(readFileSync(file, "utf8"));
    for (const raw of extractLinks(text)) {
      if (isExternal(raw)) continue;
      const pathPart = raw.split("#")[0];
      if (!pathPart) continue; // `[x](#frag)` handled by isExternal, but be safe
      let decoded;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        decoded = pathPart;
      }
      checked++;
      if (!existsSync(resolve(dirname(file), decoded))) {
        broken.push({ file: file.slice(repo.length + 1), link: raw });
      }
    }
  }

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify({ files: mdFiles.length, skipped: skipped.length, checked, broken }, null, 2),
    );
  } else {
    console.log(
      `[docs-link-scan] ${mdFiles.length} markdown file(s), ${checked} relative link(s) checked.`,
    );
    if (skipped.length > 0) {
      console.log(
        `[docs-link-scan] note — ${skipped.length} markdown file(s) under ${SKIP_PATHS.join(", ")} were NOT judged: ` +
          "an archived snapshot's relative links describe the tree as it was, and rewriting them to today's paths would " +
          "make it cite documents it never referenced (recorded decision, REQ-A381).",
      );
    }
    if (broken.length === 0) {
      console.log("[docs-link-scan] OK — every relative link resolves.");
    }
    for (const b of broken) console.error(`[docs-link-scan] FAIL — ${b.file}  ->  ${b.link}`);
  }

  process.exit(broken.length === 0 ? 0 : 1);
}

// Importing this module must not scan the repo and `process.exit()` as a side effect
// — the same latent hazard fixed in `tauri-command-scan.mjs` (F-DEV-094): a future
// script that imports `stripCode`/`extractLinks` (the module exports both) would lose
// its own exit code to this gate's verdict.
//
// The comparison is by **basename**, matching that precedent, and deliberately not by
// resolved path: `/tmp` is a symlink to `/private/tmp` on macOS, so a full-path compare
// makes this script a **silent no-op** (exit 0, no output) whenever it is invoked
// through a symlinked directory — a gate that reports nothing and says nothing is the
// exact failure this file exists to prevent.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  if (process.argv.includes("--selftest")) runSelftest();
  runScan();
}

