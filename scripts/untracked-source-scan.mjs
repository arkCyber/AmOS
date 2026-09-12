#!/usr/bin/env node
/**
 * untracked-source-scan.mjs — "the work is in the working tree, not in the deliverable".
 *
 * Why: this project's recurring defect is not a wrong line of code, it is a **missing
 * file**. Three rounds in a row found the same shape, each time in a different place:
 *   • R74 — the whole gate layer (`scripts/*-scan.mjs`) was untracked, so `make lint`
 *     passed here while a clean checkout ran nothing;
 *   • R75 — 34 source files were untracked while *tracked* importers referenced them;
 *   • R81 — the new end-to-end test written to close a gap was untracked (found by
 *     reading `git status`, i.e. by hand — nothing failed).
 * The first two got their own gates (`lint-inputs-scan`, `dangling-source-scan`), but both
 * only see a file that something **tracked** points at. A brand-new test/module/gate that
 * nothing references yet is invisible to them: it simply will not be in the commit, and
 * the round's evidence ("test passes") rests on a file CI never runs.
 *
 * This gate closes that hole the blunt way: any file that exists in the working tree but
 * not in the index is a finding, unless it is excused in
 * `scripts/untracked-allowlist.json` **with a reason**. The rule is deliberate: what is
 * not tracked does not exist for a clean checkout, and a silent exception is how the two
 * earlier rounds happened.
 *
 * It checks the mirror direction too, because the same principle reads backwards: a file
 * that is **gone on disk but still in the index** (a deletion nobody staged) *is* shipped
 * by a clean checkout even though its author removed it. That is not hypothetical — when
 * this gate was written, `crates/amos-ai/src/config.rs` was in exactly that state (no
 * longer referenced by any `mod`, still in the deliverable). Staged deletions are fine;
 * *unstaged* ones are reported. Content changes are never findings: a staged-but-uncommitted
 * tree is this repository's normal state.
 *
 * Honest boundaries:
 *   • it reads the git *index*, not the commit — staged-but-uncommitted is accepted by
 *     design (this repository has been deliberately staged-not-committed for many rounds;
 *     whether to commit is a human decision, not something this gate can judge);
 *   • `--exclude-standard` means an untracked file matched by `.gitignore` is **not**
 *     reported — a real source file hidden behind an ignore pattern is outside this gate;
 *   • outside a git work tree there is nothing to check: it says so and skips (never
 *     "fine"), and in a clean checkout it is trivially green;
 *   • an allow-list entry that is no longer untracked is reported as stale, so excuses
 *     decay instead of accumulating.
 *
 * Usage (from the repo root):
 *   node scripts/untracked-source-scan.mjs              # gate
 *   node scripts/untracked-source-scan.mjs --json
 *   node scripts/untracked-source-scan.mjs --selftest   # pin the parser/rules
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = "scripts/untracked-allowlist.json";

/**
 * `git status --porcelain -uall` output, one `XY path` record per line. git quotes paths
 * containing special characters (`"a b.rs"`) with C-style escapes, so unquote them.
 *
 * Two record shapes matter here, both about **file existence**, not content:
 *   • `?? path`  — untracked: a clean checkout will **not** have it (work would be lost);
 *   • ` D path`  — deleted in the working tree, deletion not staged: a clean checkout
 *     **will** have it (the removal is not part of the deliverable).
 * Content differences (` M`, `A `) are normal in a staged-not-committed repository and
 * are deliberately not findings.
 */
export function parseStatus(text) {
  const untracked = [];
  const unstagedDeletions = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const code = raw.slice(0, 2);
    if (code === "??") {
      untracked.push(unquotePath(raw.slice(3)));
      continue;
    }
    // Second column is the work-tree state; `D` there with the index not at `D` means the
    // file is gone on disk but still in the index.
    if (code[1] === "D" && code[0] !== "D") unstagedDeletions.push(unquotePath(raw.slice(3)));
  }
  return { untracked, unstagedDeletions };
}

function unquotePath(raw) {
  const line = raw.trimEnd();
  const quoted = line.match(/^"(.*)"$/);
  return quoted ? quoted[1].replace(/\\(.)/g, "$1") : line;
}

/**
 * Findings for a `git status --porcelain -uall` listing against the allow-list.
 *
 * An allow-list entry that is not currently untracked is stale — the excuse outlived the
 * reason, so it is reported for removal.
 */
export function scan({ status, allow }) {
  const findings = [];
  const byPath = new Map();
  for (const entry of allow) {
    if (!entry || typeof entry.path !== "string" || entry.path === "") {
      findings.push({ kind: "bad-allow-entry", path: JSON.stringify(entry) });
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      findings.push({ kind: "no-reason", path: entry.path });
    }
    byPath.set(entry.path, entry);
  }

  const { untracked, unstagedDeletions } = parseStatus(status);
  for (const path of untracked) {
    if (!byPath.has(path)) findings.push({ kind: "untracked", path });
  }
  for (const path of unstagedDeletions) {
    findings.push({ kind: "unstaged-deletion", path });
  }
  for (const path of byPath.keys()) {
    if (!untracked.includes(path)) findings.push({ kind: "stale-allow", path });
  }
  return findings;
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
  } catch {
    return null;
  }
}

/** `null` means "no work tree / git unavailable" — never silently treated as empty. */
function listStatus() {
  return git(["status", "--porcelain", "-uall"]);
}

function loadAllow() {
  try {
    const raw = JSON.parse(readFileSync(join(root, ALLOWLIST), "utf8"));
    return Array.isArray(raw) ? raw : (raw.entries ?? []);
  } catch {
    return [];
  }
}

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);

function runSelfTest() {
  let failures = 0;
  let assertions = 0;
  const check = (name, ok) => {
    assertions += 1;
    if (!ok) {
      failures += 1;
      console.error(`[untracked-source-scan] selftest FAIL: ${name}`);
    }
  };
  const kinds = (f) => f.map((x) => `${x.kind}:${x.path}`).sort();

  check("clean status ⇒ no findings", scan({ status: "", allow: [] }).length === 0);
  check(
    "an untracked file is reported",
    JSON.stringify(kinds(scan({ status: "?? crates/a/src/new.rs\n", allow: [] }))) ===
      JSON.stringify(["untracked:crates/a/src/new.rs"]),
  );
  check(
    "an excused file with a reason passes",
    scan({
      status: "?? .github/workflows/release.yml\n",
      allow: [
        {
          path: ".github/workflows/release.yml",
          reason: "committing a workflow triggers publish",
        },
      ],
    }).length === 0,
  );
  check(
    "an excuse without a reason is itself a finding",
    JSON.stringify(kinds(scan({ status: "?? x.rs\n", allow: [{ path: "x.rs", reason: "   " }] }))) ===
      JSON.stringify(["no-reason:x.rs"]),
  );
  check(
    "a malformed allow entry is reported, not ignored",
    scan({ status: "", allow: [{ nope: 1 }] }).some((f) => f.kind === "bad-allow-entry"),
  );
  check(
    "an excuse that outlived the file is stale",
    scan({ status: "", allow: [{ path: "y.rs", reason: "was untracked" }] }).some(
      (f) => f.kind === "stale-allow",
    ),
  );
  check(
    "quoted (space-containing) paths are unquoted",
    JSON.stringify(kinds(scan({ status: '?? "crates/a b c.rs"\n', allow: [] }))) ===
      JSON.stringify(["untracked:crates/a b c.rs"]),
  );
  check(
    "several files ⇒ several findings, sorted deterministically",
    kinds(scan({ status: "?? b.rs\n?? a.rs\n", allow: [] })).join(",") ===
      "untracked:a.rs,untracked:b.rs",
  );

  // The mirror direction: the removal exists on disk but is not in the index, so a clean
  // checkout still ships the file the author deleted.
  check(
    "a deletion left unstaged is reported",
    JSON.stringify(kinds(scan({ status: " D crates/ai/src/config.rs\n", allow: [] }))) ===
      JSON.stringify(["unstaged-deletion:crates/ai/src/config.rs"]),
  );
  check(
    "a *staged* deletion is fine",
    scan({ status: "D  crates/ai/src/gone.rs\n", allow: [] }).length === 0,
  );
  check(
    "content changes are not findings",
    scan({ status: " M crates/ai/src/lib.rs\nA  crates/ai/src/new.rs\nMM x.rs\n", allow: [] })
      .length === 0,
  );

  console.log(
    `[untracked-source-scan] selftest: ${assertions} assertion(s), ${failures} failure(s).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function main() {
  const status = listStatus();
  const allow = loadAllow();
  if (status === null) {
    console.log(
      "[untracked-source-scan] no git work tree (or git unavailable): cannot tell what is tracked — SKIPPED, not verified.",
    );
    return 0;
  }
  const findings = scan({ status, allow });
  const { untracked } = parseStatus(status);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ untracked: untracked.length, allow: allow.length, findings }, null, 2));
  }
  if (findings.length === 0) {
    console.log(
      `[untracked-source-scan] ${untracked.length} untracked file(s), ${allow.length} excused, no unstaged deletion: OK — the deliverable matches the working tree.`,
    );
    return 0;
  }
  for (const f of findings) {
    if (f.kind === "untracked") {
      console.error(
        `[untracked-source-scan] UNTRACKED ${f.path} — a clean checkout will not have this file (stage it, or excuse it in ${ALLOWLIST} with a reason).`,
      );
    } else if (f.kind === "unstaged-deletion") {
      console.error(
        `[untracked-source-scan] UNSTAGED DELETION ${f.path} — the file is gone on disk but still in the index, so a clean checkout still ships it; stage the removal (\`git add -u ${f.path}\`) or restore the file.`,
      );
    } else if (f.kind === "no-reason") {
      console.error(`[untracked-source-scan] EXCUSE WITHOUT REASON for ${f.path} in ${ALLOWLIST}`);
    } else if (f.kind === "stale-allow") {
      console.error(
        `[untracked-source-scan] STALE EXCUSE for ${f.path} in ${ALLOWLIST} — it is no longer untracked; remove the entry.`,
      );
    } else {
      console.error(`[untracked-source-scan] MALFORMED allow entry: ${f.path}`);
    }
  }
  return 1;
}

if (args.includes("--selftest")) {
  runSelfTest();
} else {
  process.exit(main());
}

