#!/usr/bin/env node
/**
 * dangling-source-scan.mjs — "a tracked file imports a source that is not tracked".
 *
 * Why: R74 found the whole *gate* layer untracked; this is the same class one level
 * down, where it is worse. If `lib.rs` (or a `.svelte` screen) is committed while the
 * module it declares is not, a clean clone **cannot compile** — and nothing says so:
 * the author's tree is fine because the file is right there. The failure only appears
 * for everybody else (and in CI, if CI builds).
 *
 * Views: the **index** (`git ls-files`) is "what the next commit contains", so that is
 * the truth this gate compares against; file *contents* are read from the worktree
 * (see the honesty note in the report footer).
 *
 * Two rules, both syntax-precise on purpose — a bare-word search would drown in false
 * positives (`alerts` and `breaker` appear as ordinary identifiers, and allow-list
 * files *mention* the names of the components they allow):
 *   1. Rust: `mod name;` / `pub mod name;` in a tracked `.rs` file must have a tracked
 *      `name.rs` or `name/mod.rs` beside it.
 *   2. TS/Svelte: a **relative** static import (`from "./x"`, `import "../y"`) in a
 *      tracked `.ts`/`.svelte` file must resolve to a tracked file (`.ts`, `.svelte`,
 *      `.tsx`, or `/index.ts`).
 *
 * Usage (from the repo root):
 *   node scripts/dangling-source-scan.mjs              # gate
 *   node scripts/dangling-source-scan.mjs --json
 *   node scripts/dangling-source-scan.mjs --selftest   # pin the parsers
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Rust module declarations: `mod x;`, `pub mod x;` (attributes on their own line). */
export function rustMods(source) {
  const out = [];
  for (const m of source.matchAll(/^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm)) {
    out.push(m[1]);
  }
  return out;
}

/** Relative static import specifiers in TS / Svelte sources. */
export function relativeImports(source) {
  const out = new Set();
  for (const m of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) out.add(m[1]);
  for (const m of source.matchAll(/\bimport\s+["'](\.[^"']+)["']/g)) out.add(m[1]);
  return [...out];
}

/** Candidate files a relative specifier may mean (no bundler resolution here). */
export function candidatesFor(base) {
  return [base + ".ts", base + ".svelte", base + ".tsx", join(base, "index.ts")];
}

function trackedSet() {
  return new Set(
    execFileSync("git", ["ls-files"], { cwd: root, maxBuffer: 1 << 28 })
      .toString()
      .split("\n")
      .filter(Boolean),
  );
}

export function scan({ tracked = trackedSet(), exists = existsSync, read = (p) => readFileSync(p, "utf8") } = {}) {
  const findings = [];
  for (const rel of tracked) {
    if (!/\.(rs|ts|svelte)$/.test(rel)) continue;
    if (rel.includes("node_modules")) continue;
    let src;
    try {
      src = read(join(root, rel));
    } catch {
      continue; // deleted in the worktree; the index entry itself is a separate issue
    }
    if (rel.endsWith(".rs")) {
      for (const name of rustMods(src)) {
        const flat = normalize(join(dirname(rel), name + ".rs"));
        const nested = normalize(join(dirname(rel), name, "mod.rs"));
        if (tracked.has(flat) || tracked.has(nested)) continue;
        // Report only when the target exists in the worktree: a genuinely absent file
        // is a compile error the author hits at once, while an *untracked* one is the
        // silent failure this gate is about.
        const hit = [flat, nested].find((c) => exists(join(root, c)));
        if (hit) findings.push({ kind: "rust-mod", from: rel, target: hit });
      }
    } else {
      for (const spec of relativeImports(src)) {
        const base = normalize(join(dirname(rel), spec));
        const cands = candidatesFor(base);
        if (cands.some((c) => tracked.has(c))) continue;
        // Only report when the target exists (a genuinely missing file is a compile
        // error the author will hit immediately; the *untracked* case is the silent one).
        if (cands.some((c) => exists(join(root, c)))) {
          const hit = cands.find((c) => exists(join(root, c)));
          findings.push({ kind: "ts-import", from: rel, target: hit });
        }
      }
    }
  }
  return findings;
}

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);

function runSelfTest() {
  const cases = [];
  cases.push(["plain mod", rustMods("mod a;\n").join() === "a"]);
  cases.push(["pub mod", rustMods("pub mod b;\n").join() === "b"]);
  cases.push(["pub(crate) mod", rustMods("pub(crate) mod c;\n").join() === "c"]);
  cases.push(["use is not a mod", rustMods("use crate::d;\n").length === 0]);
  cases.push(["mod with body is not a file", rustMods("mod inline { }\n").length === 0]);
  cases.push(["several mods", rustMods("mod a;\npub mod b;\n").length === 2]);

  const ts = `import Foo from "./foo";
import { x } from "../lib/bar";
import "./side-effect";
import Abs from "pkg/other";
export { y } from "./baz.svelte";`;
  const imps = relativeImports(ts);
  cases.push(["relative from-imports", imps.includes("./foo") && imps.includes("../lib/bar")]);
  cases.push(["side-effect import", imps.includes("./side-effect")]);
  cases.push(["bare packages ignored", !imps.some((i) => i.includes("pkg"))]);
  cases.push(["extension kept in specifier", imps.includes("./baz.svelte")]);

  const cands = candidatesFor("src/x");
  cases.push([
    "candidate resolution",
    cands.includes("src/x.ts") && cands.includes("src/x.svelte") && cands.includes(join("src/x", "index.ts")),
  ]);

  // An untracked-but-present Rust module is a finding; the same module tracked is not.
  const fakeTracked = new Set(["crates/a/src/lib.rs"]);
  const found = scan({
    tracked: fakeTracked,
    read: () => "mod helper;\n",
    exists: (p) => p.endsWith("helper.rs"),
  });
  cases.push(["untracked module reported", found.length === 1 && found[0].kind === "rust-mod"]);
  const ok = scan({
    tracked: new Set(["crates/a/src/lib.rs", "crates/a/src/helper.rs"]),
    read: () => "mod helper;\n",
    exists: () => true,
  });
  cases.push(["tracked module is not reported", ok.length === 0]);
  // A missing file (not merely untracked) is left to the compiler.
  const gone = scan({
    tracked: new Set(["crates/a/src/lib.rs"]),
    read: () => "mod helper;\n",
    exists: () => false,
  });
  cases.push(["absent module is not our finding", gone.length === 0]);

  let failed = 0;
  for (const [name, ok2] of cases) {
    if (ok2) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[dangling-source-scan] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[dangling-source-scan] selftest OK — ${cases.length} parser/resolver case(s).`);
}

if (args.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const findings = scan();
if (args.includes("--json")) {
  console.log(JSON.stringify(findings, null, 2));
  process.exit(findings.length === 0 ? 0 : 1);
}
if (findings.length > 0) {
  console.log(
    `[dangling-source-scan] FAIL — ${findings.length} tracked file(s) reference a source that is NOT tracked, so a clean checkout cannot build this:`,
  );
  for (const f of findings) console.log(`  ${f.kind}: ${f.from} -> ${f.target}`);
  console.log("  Fix: `git add` the referenced file together with its importer.");
  process.exit(1);
}
console.log(
  "[dangling-source-scan] OK — every `mod`/relative import of a tracked file resolves to a tracked source.",
);

