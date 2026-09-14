#!/usr/bin/env node
/**
 * make-target-doc-scan.mjs — every `make <target>` named in the **current docs**
 * must be a real Makefile target.
 *
 * Why: `GETTING_STARTED.md` hands a newcomer `make fmt` under "Format code" — and
 * there is no `fmt` rule, so `make` answers `No rule to make target 'fmt'`. The
 * sibling of `docs-link-scan` (a dead link) and `env-doc-scan` (a knob that does
 * nothing): a documented command that does not exist. Same failure shape as
 * REQ-A195's dead `cd` path — a first-run instruction that cannot run.
 *
 * Scope: a `make X` is counted when it is an **instruction** rather than prose —
 * either inside inline code (`` `make verify` ``) or on its own line of a fenced
 * block (`    make lint`, optionally `$ `-prefixed). Plain prose is ignored on
 * purpose: "make a decision" / "would make any…" are not commands, and matching
 * them would make the gate noisy (the first cut did, hence this scope).
 *
 * Corpus: every current doc — root `*.md`, `docs/**`, `.github/**` — **except
 * `CHANGELOG.md`**, which records what was true at each release rather than a
 * promise about today (same exclusion as `env-doc-scan`).
 *
 * Hard gate (no baseline): a reference to a missing target is a defect. If a
 * future doc must name a target that is deliberately absent (an external project,
 * a planned rule), add it to `scripts/make-target-allowlist.json` with a reason.
 *
 * Usage (repo root):
 *   node scripts/make-target-doc-scan.mjs             # gate (exit 1 on any miss)
 *   node scripts/make-target-doc-scan.mjs --json
 *   node scripts/make-target-doc-scan.mjs --selftest  # pin parse/extract
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "target", ".git", "dist"]);

/** Target names a Makefile defines: `name:` rules plus the `.PHONY:` list. */
export function parseTargets(makefileText) {
  const out = new Set();
  for (const line of makefileText.split("\n")) {
    const rule = line.match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?!=)/);
    if (rule) out.add(rule[1]);
    if (line.startsWith(".PHONY:")) for (const n of line.slice(7).trim().split(/\s+/)) if (n) out.add(n);
  }
  return out;
}

/**
 * `{target, line}` for every *instructional* `make <target>` in `text`: inline
 * code, or a line of a fenced block that starts with `make`.
 */
export function makeRefs(text) {
  const out = [];
  let inFence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      const m = line.match(/^\s*(?:\$\s*)?make\s+([A-Za-z0-9_][A-Za-z0-9_-]*)/);
      if (m) out.push({ target: m[1], line: i + 1 });
      return;
    }
    for (const m of line.matchAll(/`\s*make\s+([A-Za-z0-9_][A-Za-z0-9_-]*)/g)) {
      out.push({ target: m[1], line: i + 1 });
    }
  });
  return out;
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);
  const refs = (t) => makeRefs(t).map((r) => r.target);

  const t = parseTargets("lint:\n\tcargo clippy\nverify: lint test\n.PHONY: a b-c\nVAR := x\n");
  ok("parses a rule target", t.has("lint"));
  ok("parses a target with prerequisites", t.has("verify"));
  ok("parses .PHONY names", t.has("a") && t.has("b-c"));
  ok("ignores a variable assignment", !t.has("VAR"));

  ok("inline code is a reference", refs("run `make verify` now").includes("verify"));
  ok("fenced line is a reference", refs("```bash\nmake lint\n```").includes("lint"));
  ok("$ -prefixed fence line is a reference", refs("```\n$ make test\n```").includes("test"));
  ok("keeps hyphens/underscores", refs("`make sup-smoke`").includes("sup-smoke"));
  ok("ignores prose 'make a'", refs("we must make a decision").length === 0);
  ok("ignores prose 'make any'", refs("that would make any change risky").length === 0);
  ok("code inside a fence ignores inline scan", refs("```\nmake lint\n```").length === 1);
  ok("reports the line number", makeRefs("x\n\n`make verify`")[0].line === 3);

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[make-target-doc-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[make-target-doc-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
if (process.argv.includes("--selftest")) runSelftest();

// --- corpus -----------------------------------------------------------------
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (p.endsWith(".md")) acc.push(p);
  }
  return acc;
}
const docs = [
  ...readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "CHANGELOG.md")
    .map((e) => join(root, e.name)),
  ...walk(join(root, "docs")),
  ...walk(join(root, ".github")),
];

const targets = parseTargets(readFileSync(join(root, "Makefile"), "utf8"));

// --- allow-list -------------------------------------------------------------
const allowPath = join(root, "scripts", "make-target-allowlist.json");
let allow = [];
if (existsSync(allowPath)) {
  allow = JSON.parse(readFileSync(allowPath, "utf8"));
  for (const e of allow) {
    if (!e.target || !e.reason || !String(e.reason).trim()) {
      console.error(`[make-target-doc-scan] allow-entry without target+reason: ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }
}
const allowed = new Set(allow.map((e) => e.target));

// --- scan -------------------------------------------------------------------
const missing = [];
for (const f of docs) {
  for (const ref of makeRefs(readFileSync(f, "utf8"))) {
    if (targets.has(ref.target) || allowed.has(ref.target)) continue;
    missing.push({ file: relative(root, f), ...ref });
  }
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { docs: docs.length, targets: targets.size, allow: allow.length, missing },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[make-target-doc-scan] ${docs.length} doc(s), ${targets.size} Makefile target(s); "${missing.length}" reference(s) to a missing target.`,
  );
  if (missing.length === 0) {
    console.log("[make-target-doc-scan] OK — every `make <target>` named in the docs exists.");
  }
  for (const m of missing) {
    console.error(`[make-target-doc-scan] FAIL — ${m.file}:${m.line} names \`make ${m.target}\`, which is not a Makefile target`);
  }
}

process.exit(missing.length === 0 ? 0 : 1);
