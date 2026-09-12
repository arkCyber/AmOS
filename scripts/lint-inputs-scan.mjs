#!/usr/bin/env node
/**
 * lint-inputs-scan.mjs — "a lint step whose inputs are not in the repository".
 *
 * Why: every round of this project reports `make lint` EXIT=0, and that claim rests on
 * a layer of gate scripts (`scripts/*-scan.mjs`, `scripts/proto-doc.mjs`, …) plus their
 * allow-list/baseline JSON. The compiler and CI only see what is **tracked by git**:
 * a gate that lives solely in someone's working tree makes `make lint` pass locally
 * while a clean checkout runs *nothing* — CI green, repository blind. That is the
 * inverse of the "file exists locally but is not tracked" defect found in
 * `docs/api-grpc.md` (REQ-A132): here the whole gate layer was untracked.
 *
 * Two checks, both on the **committed** view:
 *   1. every `node <path>` invoked by the Makefile (comments excluded) must exist and
 *      be tracked by git;
 *   2. every `<name>.json` input a gate script loads from its own directory (the
 *      allow-lists and baselines — matched as a quoted `*.json` literal that exists on
 *      disk) must be tracked too.
 *
 * Outside a git work tree check 1 still runs (existence) and check 2 is skipped —
 * "cannot tell" must never be reported as "fine".
 *
 * Usage (from the repo root):
 *   node scripts/lint-inputs-scan.mjs              # gate
 *   node scripts/lint-inputs-scan.mjs --json
 *   node scripts/lint-inputs-scan.mjs --selftest   # pin the parser/resolver
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `node <path>` invocations in a Makefile, resolving the `cd <dir> &&` prefix (which
 * recipe lines use). Comment lines and flags are dropped.
 */
export function nodeInvocations(makefile) {
  const out = [];
  for (const raw of makefile.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    const cd = line.match(/^cd\s+(\S+)\s*&&\s*(.*)$/);
    const dir = cd ? cd[1] : ".";
    const cmd = cd ? cd[2] : line;
    const m = cmd.match(/^node\s+(\S+)/);
    if (!m) continue;
    out.push(normalize(join(dir, m[1])));
  }
  return out;
}

/** Quoted `*.json` names a gate script reads from its own directory. */
export function jsonInputs(source) {
  const names = new Set();
  for (const m of source.matchAll(/["'`]([A-Za-z0-9_./-]+\.json)["'`]/g)) {
    // The gate loads these as siblings of the script, so only the basename matters
    // (a literal may be written `"./x.json"` or `join(dir, "x.json")`).
    names.add(m[1].split("/").pop());
  }
  return [...names].sort();
}

function tracked(abs) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", abs], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: root,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      return null; // no work tree: cannot tell
    }
    return false;
  }
}

export function scan({ makefile, readFile = (p) => readFileSync(p, "utf8"), exists = existsSync }) {
  const findings = [];
  const invocations = nodeInvocations(makefile);
  const scripts = [];
  for (const rel of invocations) {
    const abs = join(root, rel);
    if (!exists(abs)) {
      findings.push({ kind: "missing", path: rel });
      continue;
    }
    if (tracked(abs) === false) findings.push({ kind: "untracked", path: rel });
    scripts.push(abs);
  }
  // Inputs of the invoked gate scripts (deduped), resolved next to the script.
  const seen = new Set();
  for (const script of scripts) {
    let src;
    try {
      src = readFile(script);
    } catch {
      continue;
    }
    for (const name of jsonInputs(src)) {
      const abs = join(dirname(script), name);
      if (!exists(abs) || seen.has(abs)) continue;
      seen.add(abs);
      if (tracked(abs) === false) {
        findings.push({ kind: "untracked-input", path: abs.replace(root + "/", "") });
      }
    }
  }
  return { invocations: invocations.length, findings };
}

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);

function runSelfTest() {
  const cases = [];
  const mk = [
    "# node scripts/ignored.mjs",
    "lint:",
    "\tcargo fmt --all --check",
    "\tnode scripts/a.mjs",
    "\tnode scripts/b.mjs --selftest",
    "\tcd crates/x/y && node scripts/c.mjs --check",
    "\tcd crates/x/y && node ../scripts/d.mjs",
  ].join("\n");
  const inv = nodeInvocations(mk);
  cases.push(["comment-only lines are ignored", !inv.some((p) => p.includes("ignored"))]);
  cases.push(["4 invocations found", inv.length === 4]);
  cases.push(["plain path", inv.includes("scripts/a.mjs")]);
  cases.push(["flags are stripped", inv.includes("scripts/b.mjs")]);
  cases.push(["cd prefix is resolved", inv.includes(normalize("crates/x/y/scripts/c.mjs"))]);
  cases.push([
    "cd prefix + relative hop",
    inv.includes(normalize("crates/x/scripts/d.mjs")),
  ]);

  const src = `
const A = join(root, "scripts", "things-allowlist.json");
const B = readFileSync("./baseline.json", "utf8");
const C = "not-a-file.txt";
`;
  const inputs = jsonInputs(src);
  cases.push(["json inputs found", inputs.includes("things-allowlist.json")]);
  cases.push(["only .json", inputs.length === 2 && inputs.includes("baseline.json")]);

  const fake = scan({
    makefile: "\tnode scripts/definitely-not-tracked-xyz.mjs",
    exists: () => true,
    readFile: () => "",
  });
  cases.push([
    "an untracked invocation is reported",
    fake.findings.some((f) => f.kind === "untracked" || f.kind === "missing"),
  ]);
  const gone = scan({
    makefile: "\tnode scripts/definitely-missing-xyz.mjs",
    exists: () => false,
    readFile: () => "",
  });
  cases.push(["a missing invocation is reported", gone.findings[0]?.kind === "missing"]);

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[lint-inputs-scan] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[lint-inputs-scan] selftest OK — ${cases.length} parser/resolver case(s).`);
}

if (args.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const result = scan({ makefile: readFileSync(join(root, "Makefile"), "utf8") });
if (args.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.findings.length === 0 ? 0 : 1);
}
if (result.findings.length > 0) {
  console.log(
    `[lint-inputs-scan] FAIL — ${result.findings.length} lint input(s) are missing or NOT tracked by git, so a clean checkout cannot run them:`,
  );
  for (const f of result.findings) console.log(`  ${f.kind}: ${f.path}`);
  console.log("  Fix: `git add` the file(s) — otherwise CI enforces nothing.");
  process.exit(1);
}
console.log(
  `[lint-inputs-scan] OK — ${result.invocations} Makefile node invocation(s) and their JSON inputs exist and are tracked.`,
);

