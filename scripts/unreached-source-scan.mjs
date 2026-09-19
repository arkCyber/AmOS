#!/usr/bin/env node
/**
 * unreached-source-scan.mjs — the reverse of `dangling-source-scan`: a file that
 * **is** in a crate's Rust source root, but that the compiler never reads.
 *
 * Why this exists (REQ-A459): `crates/amos-mdm/src/error.rs.tmp_tests` sat in
 * `src/` holding 14 tests — a byte-identical copy of the module already inside
 * `error.rs`, missing only the `#[cfg(test)] mod tests { … }` wrapper. The name
 * does not end in `.rs`, so **nothing** ever compiled it: `cargo test` reported
 * `error.rs`'s 14 green tests while a second, unreviewed copy rotted beside them.
 * Every gate in this tree was green. `untracked-source-scan` matches known source
 * extensions (`.tmp_tests` is not one), `lint-inputs-scan` only checks files a
 * step invokes, and `dangling-source-scan` walks references in the **other**
 * direction. A file nothing reads is invisible *by construction* — so the only
 * thing that can see it is a scan that starts from the directory and asks "who
 * reads you?".
 *
 * Corpus: every file under `crates/<crate>/src/**` (the Rust source root; the
 * generated Android tree under `crates/amos-tauri/gen/**` is not a Rust root).
 *
 * Rules:
 *   R1 `non-rust-source` — every file under a Rust source root must be `.rs`.
 *      Anything else is either a mistake or an asset the crate really embeds
 *      (`include_str!` / `include_bytes!`) — and then it is a **decision**, so it
 *      gets an allow-list entry with a reason.
 *   R2 `unreached-source` — every `.rs` file must be reachable from a crate root:
 *      `src/lib.rs`, `src/main.rs`, anything under `src/bin/`, and every
 *      `path = "src/…"` in that crate's `Cargo.toml` (a custom `[[test]]` /
 *      `[[example]]` root is a root). Reachability follows `mod` declarations —
 *      parsed by `rustMods` from `dangling-source-scan` (one rule, one parser) —
 *      plus `#[path = "…"]` attributes and `include!("….rs")`.
 *
 * Deliberately conservative (a false positive here would be worse than a missed
 * one — the same rule `rust-recursion-scan` applies to cycles): the candidate set
 * for a `mod name;` is `name.rs` **and** `name/mod.rs` *plus* whatever a `#[path]`
 * attribute names, so an attribute that redirects a module cannot produce a
 * phantom "unreached" file.
 *
 * Out of scope, recorded rather than guessed: modules a build script generates
 * into `OUT_DIR`, macro-generated `mod`s, and `include!` from a file outside
 * `crates/<crate>/src`. None of those exists in this tree today.
 *
 * Suppressions live in `scripts/unreached-src-allowlist.json` as
 * `{ "entries": [ { "path": "…", "reason": "…" } ] }`. A reason is required, and
 * an entry whose path is no longer reported is **stale** and fails the gate (a
 * suppression that outlives its cause hides the next regression — REQ-A447).
 *
 * Usage (repo root):
 *   node scripts/unreached-source-scan.mjs              # gate (exit 1 on any defect)
 *   node scripts/unreached-source-scan.mjs --json
 *   node scripts/unreached-source-scan.mjs --selftest   # pin the classifier
 */
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rustMods } from "./dangling-source-scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(root, "scripts", "unreached-src-allowlist.json");

const posix = (p) => p.split("\\").join("/");

/**
 * The directory a file's **child modules** live in. This is the Rust 2018 rule,
 * and getting it wrong produces false positives (worse than a miss): a `mod x;`
 * in `src/live.rs` looks for `src/live/x.rs`, **not** `src/imap.rs` — while in
 * `src/live/mod.rs` (and in the crate roots `lib.rs` / `main.rs`) children live
 * in the file's own directory.
 */
export function moduleDir(file) {
  const base = dirname(file);
  const stem = basename(file, ".rs");
  return stem === "mod" || stem === "lib" || stem === "main" ? base : posix(join(base, stem));
}

/**
 * Every source file a Rust file pulls in by path: `mod name;` (→ `name.rs` or
 * `name/mod.rs` in [`moduleDir`]), `#[path = "…"]` (→ exactly that file), and
 * `include!("….rs")`.
 *
 * Pure: `file` is a repo-relative path, `text` its contents. Returns repo-relative
 * candidates. The set is deliberately a **superset** — for a path-attribute target
 * both bases (the file's directory and its module directory) are offered, because
 * the reference is subtle there and a phantom "unreached" verdict would be a lie.
 */
export function referencedSources(file, text) {
  const dir = dirname(file);
  const modDir = moduleDir(file);
  const out = new Set();
  for (const name of rustMods(text)) {
    out.add(posix(join(modDir, `${name}.rs`)));
    out.add(posix(join(modDir, name, "mod.rs")));
  }
  for (const m of text.matchAll(/^[ \t]*#\[path[ \t]*=[ \t]*"([^"]+)"[ \t]*\]/gm)) {
    out.add(posix(join(dir, m[1])));
    out.add(posix(join(modDir, m[1])));
  }
  for (const m of text.matchAll(/\binclude![ \t]*\([ \t]*"([^"]+\.rs)"[ \t]*\)/g)) {
    out.add(posix(join(dir, m[1])));
    out.add(posix(join(modDir, m[1])));
  }
  return [...out];
}

/** True for a crate-relative path Rust compiles without anyone declaring it. */
export function isCrateRoot(file) {
  return (
    /^crates\/[^/]+\/src\/(lib|main)\.rs$/.test(file) ||
    /^crates\/[^/]+\/src\/bin\/.+\.rs$/.test(file)
  );
}

/**
 * Classify a file list. Pure (all I/O goes through `read`), so the selftest can
 * hand it a synthetic tree.
 *
 * `files` — repo-relative paths under `crates/<crate>/src/**`.
 * `read(file)` — contents of `file`.
 * `cargoRoots` — `path = "src/…"` values from the crates' `Cargo.toml`s.
 * `allowed` — paths excused by the allow-list (already validated for a reason).
 */
export function sourceIssues({ files, read, cargoRoots = [], allowed = new Set() }) {
  const rs = files.filter((f) => f.endsWith(".rs")).sort();
  const nonRust = files.filter((f) => !f.endsWith(".rs") && !allowed.has(f)).sort();

  const rootSet = [...new Set([...rs.filter(isCrateRoot), ...cargoRoots])]
    .filter((f) => rs.includes(f))
    .sort();

  const reached = new Set();
  const queue = [...rootSet];
  while (queue.length > 0) {
    const f = queue.shift();
    if (reached.has(f)) continue;
    reached.add(f);
    for (const target of referencedSources(f, read(f))) {
      if (rs.includes(target) && !reached.has(target)) queue.push(target);
    }
  }

  const unreached = rs.filter((f) => !reached.has(f) && !allowed.has(f));
  // The *raw* sets keep what the allow-list excused, so the caller can tell
  // "this suppression is still needed" from "this suppression is stale" — a
  // suppression that is compared against the already-filtered list would look
  // stale the moment it starts doing its job.
  return {
    nonRust,
    unreached,
    rawNonRust: files.filter((f) => !f.endsWith(".rs")).sort(),
    rawUnreached: rs.filter((f) => !reached.has(f)),
    roots: rootSet,
    reached: [...reached].sort(),
  };
}

/** Every file under `dir`, repo-relative, recursively. */
function walk(dir, acc = []) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = posix(join(dir, e.name));
    if (e.isDirectory()) walk(rel, acc);
    else acc.push(rel);
  }
  return acc;
}

/** `path = "src/…"` entries in a crate's `Cargo.toml` (custom lib/bin/test/example roots). */
export function cargoRootsOf(crateDir) {
  const toml = join(root, crateDir, "Cargo.toml");
  if (!existsSync(toml)) return [];
  const text = readFileSync(toml, "utf8");
  const out = [];
  for (const m of text.matchAll(/^[ \t]*path[ \t]*=[ \t]*"(src\/[^"]+\.rs)"/gm)) {
    out.push(posix(join(crateDir, m[1])));
  }
  return out;
}

/** Allow-list entries that carry a usable reason (a placeholder is not one). */
export function readAllowlist() {
  if (!existsSync(ALLOWLIST)) return { entries: [], problems: [] };
  const raw = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  const problems = [];
  for (const e of entries) {
    const why = String(e?.reason ?? "").trim();
    if (!e?.path) problems.push("entry without a path");
    else if (why.length < 20 || /^(todo|tbd|n\/a|unreviewed)$/i.test(why)) {
      problems.push(`${e.path}: no real reason ("${why}")`);
    }
  }
  return { entries, problems };
}

function scan() {
  const crates = readdirSync(join(root, "crates"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `crates/${e.name}`)
    .filter((c) => existsSync(join(root, c, "src")));

  const files = crates.flatMap((c) => walk(`${c}/src`));
  const cargoRoots = crates.flatMap((c) => cargoRootsOf(c).filter((p) => p.includes("/src/")));

  const { entries, problems } = readAllowlist();
  const allowed = new Set(entries.map((e) => e.path).filter(Boolean));

  const issues = sourceIssues({
    files,
    read: (f) => readFileSync(join(root, f), "utf8"),
    cargoRoots,
    allowed,
  });

  // A suppression that no longer suppresses anything is a defect of its own —
  // so it is checked against the **raw** findings (what the allow-list excused
  // is still raw evidence, it is just not reported as a defect).
  const stillNeeded = new Set([...issues.rawNonRust, ...issues.rawUnreached]);
  const stale = [...allowed].filter((p) => !stillNeeded.has(p)).sort();

  return { issues, problems, stale, files: files.length };
}

// --- main --------------------------------------------------------------------
const IS_MAIN = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (IS_MAIN) {
  const args = process.argv.slice(2);
  const known = ["--selftest", "--json"];
  const unknown = args.filter((a) => !known.includes(a));
  if (unknown.length > 0) {
    console.error(`[unreached-source-scan] unknown flag(s): ${unknown.join(" ")}`);
    console.error("Usage: node scripts/unreached-source-scan.mjs [--json] [--selftest]");
    process.exit(2);
  }

  if (args.includes("--selftest")) {
    const cases = [];
    const T = {
      "crates/a/src/lib.rs": 'mod top;\npub mod deep;\nmod live;\ninclude!("gen.rs");\n',
      "crates/a/src/top.rs": "mod leaf;\n",
      "crates/a/src/top/leaf.rs": "pub fn f() {}\n",
      "crates/a/src/deep/mod.rs": "pub fn g() {}\n",
      "crates/a/src/live.rs": "pub mod imap;\n",
      "crates/a/src/live/imap.rs": "// a child of a non-`mod.rs` file lives under `<stem>/`\n",
      "crates/a/src/gen.rs": "// generated\n",
      "crates/a/src/orphan.rs": "// nobody declares me\n",
      "crates/a/src/bin/tool.rs": "fn main() {}\n",
      "crates/a/src/notes.txt": "not rust\n",
    };
    const read = (f) => T[f] ?? "";
    const base = sourceIssues({ files: Object.keys(T), read });

    cases.push(["lib.rs is a root", base.roots.includes("crates/a/src/lib.rs")]);
    cases.push(["src/bin/*.rs is a root", base.roots.includes("crates/a/src/bin/tool.rs")]);
    cases.push(["`mod name;` reaches name.rs", base.reached.includes("crates/a/src/top.rs")]);
    cases.push(["the walk is transitive", base.reached.includes("crates/a/src/top/leaf.rs")]);
    cases.push(["`mod name;` reaches name/mod.rs", base.reached.includes("crates/a/src/deep/mod.rs")]);
    // The Rust 2018 rule the first version of this scan got wrong: a `mod x;` in
    // `src/live.rs` resolves to `src/live/x.rs`, not `src/x.rs`. Getting *this*
    // wrong produced 5 phantom findings on the real tree — a false positive is
    // worse than a miss, so it is pinned here.
    cases.push([
      "a child of src/live.rs lives in src/live/",
      base.reached.includes("crates/a/src/live/imap.rs"),
    ]);
    cases.push([
      "moduleDir: foo.rs → foo/",
      moduleDir("crates/a/src/live.rs") === "crates/a/src/live",
    ]);
    cases.push([
      "moduleDir: mod.rs / lib.rs / main.rs stay put",
      moduleDir("crates/a/src/deep/mod.rs") === "crates/a/src/deep" &&
        moduleDir("crates/a/src/lib.rs") === "crates/a/src",
    ]);
    cases.push(["include!(.rs) is a reference", base.reached.includes("crates/a/src/gen.rs")]);
    cases.push([
      "an undeclared .rs file is reported",
      base.unreached.join() === "crates/a/src/orphan.rs",
    ]);
    cases.push([
      "a non-Rust file in src/ is reported",
      base.nonRust.join() === "crates/a/src/notes.txt",
    ]);
    const excused = sourceIssues({
      files: Object.keys(T),
      read,
      allowed: new Set(["crates/a/src/orphan.rs", "crates/a/src/notes.txt"]),
    });
    cases.push([
      "an allow-listed path is reported nowhere",
      excused.unreached.length === 0 && excused.nonRust.length === 0,
    ]);
    // …but it is still *raw* evidence: a suppression that is doing its job must
    // not be reported as stale (the first version of this scan compared it
    // against the already-filtered list and called every live entry stale).
    cases.push([
      "an allow-listed path stays in the raw sets (not stale)",
      excused.rawUnreached.includes("crates/a/src/orphan.rs") &&
        excused.rawNonRust.includes("crates/a/src/notes.txt"),
    ]);

    // `#[path = "…"]` must reach the file it names *and* not orphan its module.
    const P = {
      "crates/b/src/lib.rs": '#[path = "weird.rs"]\nmod tests;\n',
      "crates/b/src/weird.rs": "// it is me\n",
    };
    const p = sourceIssues({ files: Object.keys(P), read: (f) => P[f] ?? "" });
    cases.push(["`#[path]` reaches the named file", p.reached.includes("crates/b/src/weird.rs")]);
    cases.push(["`#[path]` does not orphan its module", p.unreached.length === 0]);

    cases.push([
      "a crate with only a lib root is fine",
      sourceIssues({
        files: ["crates/c/src/lib.rs"],
        read: () => "pub fn f() {}\n",
      }).unreached.length === 0,
    ]);
    cases.push([
      "a root that does not exist invents nothing",
      sourceIssues({
        files: ["crates/c/src/lib.rs"],
        read: () => "pub fn f() {}\n",
        cargoRoots: ["crates/c/src/nope.rs"],
      }).unreached.length === 0,
    ]);

    const failed = cases.filter(([, ok]) => !ok);
    if (failed.length > 0) {
      console.log(`[unreached-source-scan] selftest FAILED — ${failed.length} case(s):`);
      for (const [name] of failed) console.log(`  ✗ ${name}`);
      process.exit(1);
    }
    console.log(`[unreached-source-scan] selftest OK — ${cases.length} classifier case(s).`);
    process.exit(0);
  }

  const { issues, problems, stale, files } = scan();

  if (args.includes("--json")) {
    console.log(
      JSON.stringify({ ...issues, problems, stale, files }, null, 2),
    );
    const defects =
      issues.nonRust.length + issues.unreached.length + problems.length + stale.length;
    process.exit(defects === 0 ? 0 : 1);
  }

  const defects =
    issues.nonRust.length + issues.unreached.length + problems.length + stale.length;
  if (defects > 0) {
    console.log(
      `[unreached-source-scan] FAIL — ${defects} problem(s) across ${files} file(s) under crates/*/src:`,
    );
    for (const f of issues.nonRust) console.log(`  non-rust-source: ${f}`);
    for (const f of issues.unreached) console.log(`  unreached-source: ${f}`);
    for (const p of problems) console.log(`  allow-list: ${p}`);
    for (const p of stale) console.log(`  stale allow-list entry: ${p}`);
    console.log(
      "  Fix: make the compiler read it (a `mod` declaration), delete it, or — for a real\n" +
        "       non-Rust asset — record it in scripts/unreached-src-allowlist.json with a reason.",
    );
    process.exit(1);
  }
  console.log(
    `[unreached-source-scan] OK — every file under crates/*/src is Rust source the compiler reads, or an allow-listed asset (${files} file(s) scanned).`,
  );
}
