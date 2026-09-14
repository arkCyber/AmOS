#!/usr/bin/env node
/**
 * onboarding-doc-scan.mjs — the **first-run docs** must not name something that
 * no longer exists.
 *
 * Why: two real drifts shipped in the onboarding docs and nothing caught them,
 * because `cargo`/`tsc`/the proto + dictionary gates never read Markdown and
 * `docs-link-scan` only checks `[text](path)` *links* (these are prose/code-fence
 * commands, not links):
 *
 *   • `CONTRIBUTING.md` / `GETTING_STARTED.md` told contributors to run
 *     `cd crates/amos-tauri/frontend && bun run test`. That directory is a
 *     leftover React host whose sources were removed (`docs/react-removal-plan.md`);
 *     on disk it holds only an ignored `node_modules`, so the command dies with
 *     `a package.json script "test" was not found`. The live SPA is `frontend-ts`.
 *   • Both also listed `libappindicator3-dev` in the Tauri apt block. Ubuntu 24.04
 *     **removed** that package (see `docs/ci-engineering.md`) — the exact failure
 *     the CI jobs were pinned to avoid. A newcomer on 24.04 gets a silent Tauri
 *     dependency failure.
 *
 * A first-run doc that sends someone to a missing path or a removed package is
 * worse than an undocumented one: they follow it, it breaks, and they conclude the
 * project is broken. This is the onboarding sibling of `env-doc-scan.mjs` (a
 * documented knob that does nothing) and `docs-link-scan.mjs` (a dead link).
 *
 * Corpus: the three files a newcomer is handed — `README.md`, `CONTRIBUTING.md`,
 * `GETTING_STARTED.md`. Deliberately narrow: elsewhere these identifiers are
 * *history* (`docs/ci-engineering.md` explains the removal, `CHANGELOG.md` records
 * it) and must be allowed to say so; in a first-run doc they are always an
 * instruction, and always wrong.
 *
 * Hard gate (no baseline): a hit is a defect. Each hit names the replacement.
 *
 * Usage (repo root):
 *   node scripts/onboarding-doc-scan.mjs             # gate (exit 1 on any hit)
 *   node scripts/onboarding-doc-scan.mjs --json
 *   node scripts/onboarding-doc-scan.mjs --selftest  # pin extract/classify
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The files a newcomer is handed, in the order they are usually read. */
export const ONBOARDING_DOCS = ["README.md", "CONTRIBUTING.md", "GETTING_STARTED.md"];

/**
 * Identifiers that no longer exist, with the replacement to point at and why.
 *
 * `pattern` keys on the **token**, never on a substring: `amos-tauri/frontend`
 * must not fire on `amos-tauri/frontend-ts`, and `libappindicator3-dev` must not
 * fire on `libayatana-appindicator3-dev`. `(?![\\w-])` / `(?<![\\w-])` do that
 * (the trailing `(?!-)` is what distinguishes `frontend` from `frontend-ts`).
 */
export const REMOVED = [
  {
    id: "crates/amos-tauri/frontend",
    pattern: "amos-tauri/frontend(?!-)",
    replace: "crates/amos-tauri/frontend-ts",
    reason: "the React host was removed; frontend-ts is the live SPA (docs/react-removal-plan.md)",
  },
  {
    id: "libappindicator3-dev",
    pattern: "(?<![\\w-])libappindicator3-dev(?![\\w-])",
    replace: "libayatana-appindicator3-dev",
    reason: "removed from Ubuntu 24.04; Tauri needs the ayatana package (docs/ci-engineering.md)",
  },
];

/** Every `{line, id, text, rule}` in `text` that names a removed identifier. */
export function findHits(text, rules = REMOVED) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const rule of rules) {
      if (new RegExp(rule.pattern).test(line)) {
        out.push({ line: i + 1, id: rule.id, text: line.trim(), rule });
      }
    }
  });
  return out;
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);
  const rule = (id) => REMOVED.find((r) => r.id === id);
  const hitsOf = (text, id) => findHits(text, [rule(id)]);

  ok(
    "flags the removed React path",
    hitsOf("cd crates/amos-tauri/frontend && bun run test", "crates/amos-tauri/frontend").length === 1,
  );
  ok(
    "leaves frontend-ts alone",
    hitsOf("cd crates/amos-tauri/frontend-ts && bun run test", "crates/amos-tauri/frontend").length === 0,
  );
  ok(
    "does not flag a longer path segment",
    hitsOf("crates/amos-tauri/frontend-tests/x", "crates/amos-tauri/frontend").length === 0,
  );
  ok("flags the removed apt package", hitsOf("  libappindicator3-dev \\", "libappindicator3-dev").length === 1);
  ok(
    "leaves the ayatana package alone",
    hitsOf("  libayatana-appindicator3-dev \\", "libappindicator3-dev").length === 0,
  );
  ok(
    "does not flag a longer package name",
    hitsOf("libappindicator3-dev-extra", "libappindicator3-dev").length === 0,
  );
  ok(
    "counts every hit",
    hitsOf("libappindicator3-dev\nlibappindicator3-dev", "libappindicator3-dev").length === 2,
  );
  ok(
    "reports the line number",
    hitsOf("a\ncd crates/amos-tauri/frontend\nb", "crates/amos-tauri/frontend")[0].line === 2,
  );
  ok(
    "a clean doc yields nothing",
    findHits("cd crates/amos-tauri/frontend-ts && bun run test\n  libayatana-appindicator3-dev \\").length === 0,
  );
  ok("every rule carries a replacement + reason", REMOVED.every((r) => r.replace && String(r.reason).trim()));

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[onboarding-doc-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[onboarding-doc-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
// Only run the scan when invoked directly; importing it must not exit.
if (process.argv.includes("--selftest")) runSelftest();

// --- scan -------------------------------------------------------------------
const files = ONBOARDING_DOCS.map((f) => join(root, f)).filter(existsSync);

const violations = [];
for (const f of files) {
  for (const hit of findHits(readFileSync(f, "utf8"))) {
    violations.push({ file: relative(root, f), ...hit });
  }
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        docs: files.map((f) => relative(root, f)),
        rules: REMOVED.map((r) => r.id),
        violations: violations.map(({ file, line, id, text }) => ({ file, line, id, text })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[onboarding-doc-scan] ${files.length} onboarding doc(s), ${REMOVED.length} removed identifier(s) checked.`,
  );
  if (violations.length === 0) {
    console.log("[onboarding-doc-scan] OK — no first-run doc names a removed path or package.");
  }
  for (const v of violations) {
    console.error(
      `[onboarding-doc-scan] FAIL — ${v.file}:${v.line} names "${v.id}" — use "${v.rule.replace}" (${v.rule.reason})`,
    );
    console.error(`[onboarding-doc-scan]        ${v.text}`);
  }
}

process.exit(violations.length === 0 ? 0 : 1);
