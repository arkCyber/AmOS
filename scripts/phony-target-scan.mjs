#!/usr/bin/env node
/**
 * phony-target-scan.mjs — Makefile `.PHONY` hygiene.
 *
 * Why: this workspace's targets are all commands, so all of them must be declared
 * `.PHONY`. `e2e-local`, `sup-smoke` and `timesync-smoke` were not — and an
 * undeclared target is **silently skippable**: if a file or directory with that
 * name ever appears (a stray artifact, a checkout of a branch that added one),
 * `make` treats the target as up to date, prints nothing, and exits 0. That is the
 * "a gate that silently does nothing" failure this tree's scanners exist to catch
 * — `make verify` would report success *without* running the e2e/supervisor/time-sync
 * smokes. The reverse also rots: a `.PHONY` name with no rule is a dead declaration.
 *
 * Rule:
 *   • a rule whose name is NOT `.PHONY`d and has no file/dir of that exact name is a
 *     defect (declare it `.PHONY`). A genuine **file target** is allow-listed with a
 *     reason in `scripts/phony-allowlist.json` — it is the one case where the name is
 *     supposed to map to a file.
 *   • a `.PHONY` name that no rule defines is a defect (stale declaration).
 *
 * Usage (repo root):
 *   node scripts/phony-target-scan.mjs             # gate (exit 1 on any defect)
 *   node scripts/phony-target-scan.mjs --json
 *   node scripts/phony-target-scan.mjs --selftest  # pin parse/classify
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Rule names (`name:`) and `.PHONY:` names in a Makefile's text. */
export function parseMakefile(text) {
  const rules = new Set();
  const phony = new Set();
  for (const line of text.split("\n")) {
    const rule = line.match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?!=)/);
    if (rule) rules.add(rule[1]);
    if (line.startsWith(".PHONY:")) for (const n of line.slice(7).trim().split(/\s+/)) if (n) phony.add(n);
  }
  return { rules, phony };
}

/**
 * `{kind, name}` defects. `exists(name)` says whether a file/dir shadows the target.
 * `allowed` are rule names excused as genuine file targets (with a reason elsewhere).
 */
export function phonyIssues({ rules, phony }, exists, allowed = new Set()) {
  const out = [];
  for (const r of [...rules].sort()) {
    if (phony.has(r) || allowed.has(r) || exists(r)) continue;
    out.push({ kind: "undeclared", name: r });
  }
  for (const p of [...phony].sort()) {
    if (!rules.has(p)) out.push({ kind: "stale", name: p });
  }
  return out;
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);
  const none = () => false;

  const m = parseMakefile("lint:\n\tcargo clippy\nfmt:\n\tcargo fmt\n.PHONY: lint\nX := 1\n");
  ok("parses rules", m.rules.has("lint") && m.rules.has("fmt"));
  ok("parses .PHONY", m.phony.has("lint") && m.phony.size === 1);
  ok("ignores a variable assignment", !m.rules.has("X"));

  let iss = phonyIssues(m, none);
  ok("flags an undeclared target", iss.some((i) => i.kind === "undeclared" && i.name === "fmt"));
  ok("does not flag a declared target", !iss.some((i) => i.name === "lint"));

  ok("a real file target is not a defect", phonyIssues(m, (n) => n === "fmt").length === 0);
  ok(
    "an allow-listed file target is not a defect",
    phonyIssues(m, none, new Set(["fmt"])).length === 0,
  );

  const stale = phonyIssues(parseMakefile("a:\n\ttrue\n.PHONY: a gone\n"), none);
  ok("flags a stale .PHONY name", stale.some((i) => i.kind === "stale" && i.name === "gone"));
  ok("no false stale for a defined name", !stale.some((i) => i.name === "a"));
  ok("output is sorted", JSON.stringify(phonyIssues(parseMakefile("z:\n\ttrue\na:\n\ttrue\n"), none)).includes('"a"'));

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[phony-target-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[phony-target-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
if (process.argv.includes("--selftest")) runSelftest();

// --- allow-list -------------------------------------------------------------
const allowPath = join(root, "scripts", "phony-allowlist.json");
let allow = [];
if (existsSync(allowPath)) {
  allow = JSON.parse(readFileSync(allowPath, "utf8"));
  for (const e of allow) {
    if (!e.target || !e.reason || !String(e.reason).trim()) {
      console.error(`[phony-target-scan] allow-entry without target+reason: ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }
}
const allowed = new Set(allow.map((e) => e.target));

// --- scan -------------------------------------------------------------------
const parsed = parseMakefile(readFileSync(join(root, "Makefile"), "utf8"));
const issues = phonyIssues(parsed, (n) => existsSync(join(root, n)), allowed);

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({ rules: parsed.rules.size, phony: parsed.phony.size, allow: allow.length, issues }, null, 2),
  );
} else {
  console.log(
    `[phony-target-scan] ${parsed.rules.size} rule(s), ${parsed.phony.size} .PHONY name(s); ${issues.length} defect(s).`,
  );
  if (issues.length === 0) {
    console.log("[phony-target-scan] OK — every command target is .PHONY and every .PHONY name has a rule.");
  }
  for (const i of issues) {
    console.error(
      i.kind === "undeclared"
        ? `[phony-target-scan] FAIL — rule "${i.name}" is not declared .PHONY (a same-named file would silently skip it)`
        : `[phony-target-scan] FAIL — .PHONY names "${i.name}" but no rule defines it (stale declaration)`,
    );
  }
}

process.exit(issues.length === 0 ? 0 : 1);
