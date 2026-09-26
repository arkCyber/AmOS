#!/usr/bin/env node
/**
 * committed-manifest-scan.mjs — "the workspace is parseable on disk but not in the commit".
 *
 * Why: every other gate in this repo reads the **working tree**, and a round's fix is usually
 * staged while its defect is already committed. When those two differ, the working tree is green
 * and the commit cannot even be *parsed*. That is not hypothetical: commit `24bc9703` landed
 * `crates/amos-ai`'s `amos-notifier = { workspace = true, optional = true }` without landing
 * either half of the provider (the crate's entry in `members`, or the key in
 * `[workspace.dependencies]`), and it stayed that way through HEAD (`5468c5b3`). `cargo metadata
 * --no-deps` on a clean checkout of HEAD exits **101**:
 *
 *     error inheriting `amos-notifier` from workspace root manifest's
 *     `workspace.dependencies.amos-notifier` … not found in `workspace.dependencies`
 *
 * Nothing was red, because the repairing edit to the root `Cargo.toml` was sitting **staged** —
 * `git show :Cargo.toml` had it, `git show HEAD:Cargo.toml` did not, and every `cargo` invocation
 * a gate makes reads the former. Adding the two missing lines to HEAD's root manifest is the whole
 * fix (`cargo metadata` → EXIT=0), which is what makes this a *scan* rather than a repair: the
 * defect recurs silently on the next batch commit that stages a crate directory and forgets
 * `git add`.
 *
 * So the corpus here is the committed tree, never the working tree. `AMOS_MANIFEST_REV` overrides
 * the revision (default `HEAD`) so the rule can be exercised against a consistent commit — which
 * is also how the two-sided control runs: `AMOS_MANIFEST_REV=796bf387` passes, `HEAD` fails.
 *
 * Rules:
 *   R1 `missing-member`     — a `members` entry whose `Cargo.toml` is not in the tree. Cargo
 *                             cannot load the workspace at all; the member list outran a `git add`.
 *   R2 `undeclared-dep`     — a member says `X = { workspace = true }` and the root does not
 *                             declare `X` in `[workspace.dependencies]`. The exact HEAD defect.
 *   R3 `phantom-path-dep`   — a `[workspace.dependencies]` entry with `path = "…"` pointing at a
 *                             directory the tree does not have.
 *   R4 `orphan-crate`       — a `crates/*` dir in the tree that is neither a member nor a path-dep
 *                             target. **A note, not a verdict**: a crate can be legitimately
 *                             excluded (`amos-link-py` is built by maturin, not cargo).
 *
 * A read that *fails* is never silence: if the root manifest cannot be read the scan exits 2, and
 * an unreadable member manifest is R1. (The failure this file exists for was invisible precisely
 * because an absence read as "nothing to report".)
 *
 * Usage (from the repo root):
 *   node scripts/committed-manifest-scan.mjs              # gate
 *   node scripts/committed-manifest-scan.mjs --json       # machine-readable
 *   node scripts/committed-manifest-scan.mjs --selftest   # pin the parsers/classifier
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REV = process.env.AMOS_MANIFEST_REV || "HEAD";

/** Read a blob out of the committed tree. Returns `null` when the path is not in that tree. */
export function gitShow(rev, path) {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], {
      cwd: root,
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return null;
  }
}

/** The directory names directly under `dir` in the committed tree (empty when absent). */
export function gitListDirs(rev, dir) {
  try {
    const out = execFileSync("git", ["ls-tree", "--name-only", `${rev}:${dir}`], {
      cwd: root,
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** The `members = [ … ]` list. Commented-out entries (`# "crates/amos-link-py"`) are not members. */
export function parseMembers(manifest) {
  const open = manifest.indexOf("members = [");
  if (open < 0) return [];
  const close = manifest.indexOf("]", open);
  if (close < 0) return [];
  return manifest
    .slice(open, close)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#"))
    .map((l) => l.match(/^"([^"]+)"/))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** Keys of `[workspace.dependencies]`, with the `path` value when the entry is path-based. */
export function parseWorkspaceDeps(manifest) {
  const at = manifest.indexOf("[workspace.dependencies]");
  if (at < 0) return new Map();
  const rest = manifest.slice(at + "[workspace.dependencies]".length);
  const end = rest.search(/^\[/m);
  const body = end < 0 ? rest : rest.slice(0, end);
  const out = new Map();
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const path = m[2].match(/path\s*=\s*"([^"]+)"/);
    out.set(m[1], path ? path[1] : null);
  }
  return out;
}

/**
 * The `{ workspace = true }` requirements of one member manifest — **dependencies only**.
 *
 * This is the rule that has to be right, and the first version of it was wrong in the way this
 * repository keeps re-learning: `version.workspace = true` and `edition.workspace = true` in
 * `[package]` are *inheritance* from `[workspace.package]`, not dependency resolution, and reading
 * them as the latter made the scan report four undeclared deps in a dozen healthy members. So the
 * table is tracked, and the two spellings are separated by what they actually are:
 *
 *   * the inline form `name = { workspace = true }` is never a `[package]` key (cargo's manifest
 *     inheritance uses the dotted form), so it counts wherever it appears;
 *   * the dotted form `name.workspace = true` counts only inside a `*dependencies` table — which
 *     covers `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]` and every
 *     `[target.'cfg(…)'.dependencies]`, since all four mean "resolve this through the root".
 */
export function requiredWorkspaceDeps(manifest) {
  const out = new Set();
  let table = "";
  for (const line of manifest.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const header = t.match(/^\[([^\]]+)\]/);
    if (header) {
      table = header[1];
      continue;
    }
    const inline = t.match(/^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bworkspace\s*=\s*true\b/);
    if (inline) {
      out.add(inline[1]);
      continue;
    }
    if (/(^|\.)dependencies$/.test(table)) {
      const dotted = t.match(/^([A-Za-z0-9_-]+)\.workspace\s*=\s*true\b/);
      if (dotted) out.add(dotted[1]);
    }
  }
  return out;
}

/**
 * The rules, over an injected tree reader so the selftest needs no git.
 * `read(path)` → text or null; `listDirs(dir)` → names.
 */
export function scanTree({ read, listDirs, rootManifest = "Cargo.toml", crateDir = "crates" }) {
  const findings = [];
  const notes = [];
  const root = read(rootManifest);
  if (root === null) {
    return { fatal: `the root manifest ${rootManifest} is not in the committed tree`, findings, notes };
  }
  const members = parseMembers(root);
  const deps = parseWorkspaceDeps(root);
  if (!members.length) notes.push({ rule: "R0", detail: "the root manifest lists no members" });

  const required = new Map();
  for (const member of members) {
    const manifest = read(`${member}/Cargo.toml`);
    if (manifest === null) {
      findings.push({
        rule: "R1",
        id: `missing-member:${member}`,
        detail: `\`members\` lists ${member}, but ${member}/Cargo.toml is not in the committed tree`,
      });
      continue;
    }
    for (const name of requiredWorkspaceDeps(manifest)) {
      if (!required.has(name)) required.set(name, []);
      required.get(name).push(member);
    }
  }

  for (const [name, usedBy] of [...required].sort()) {
    if (!deps.has(name)) {
      findings.push({
        rule: "R2",
        id: `undeclared-dep:${name}`,
        detail: `a member asks for \`${name} = { workspace = true }\` but [workspace.dependencies] does not declare it (required by ${usedBy.join(", ")})`,
      });
    }
  }

  for (const [name, path] of [...deps].sort()) {
    if (path === null) continue;
    if (read(`${path}/Cargo.toml`) === null) {
      findings.push({
        rule: "R3",
        id: `phantom-path-dep:${name}`,
        detail: `[workspace.dependencies] declares ${name} at path ${path}, which is not in the committed tree`,
      });
    }
  }

  const memberSet = new Set(members);
  const depPaths = new Set([...deps.values()].filter(Boolean));
  for (const dir of listDirs(crateDir).sort()) {
    const rel = `${crateDir}/${dir}`;
    if (!memberSet.has(rel) && !depPaths.has(rel)) {
      notes.push({ rule: "R4", detail: `${rel} is in the tree but is neither a member nor a path dependency` });
    }
  }

  return { fatal: null, findings, notes, members: members.length, declared: deps.size };
}

function liveScan() {
  return scanTree({
    read: (p) => gitShow(REV, p),
    listDirs: (d) => gitListDirs(REV, d),
  });
}

function selftest() {
  const problems = [];
  let checks = 0;
  const eq = (label, got, want) => {
    checks++;
    const a = JSON.stringify(got);
    const b = JSON.stringify(want);
    if (a !== b) problems.push(`${label}: got ${a}, want ${b}`);
  };

  const ROOT = [
    "[workspace]",
    "members = [",
    '    "crates/amos-ai",',
    '    "crates/amos-supervisor",',
    '    # "crates/amos-link-py",  # built by maturin',
    "]",
    "",
    "[workspace.dependencies]",
    'serde = { version = "1" }',
    'amos-ai = { path = "crates/amos-ai" }',
    'amos-supervisor = { path = "crates/amos-supervisor" }',
    "",
    "[profile.dev]",
    "opt-level = 1",
  ].join("\n");
  const AI = [
    "[package]",
    'name = "amos-ai"',
    "version.workspace = true",
    "edition.workspace = true",
    "[dependencies]",
    "serde = { workspace = true }",
    "amos-notifier = { workspace = true, optional = true }",
    "# amos-ghost = { workspace = true }",
    "[target.'cfg(unix)'.dependencies]",
    "amos-supervisor.workspace = true",
  ].join("\n");
  const SUP = [
    "[package]",
    'name = "amos-supervisor"',
    "rust-version.workspace = true",
    "[dependencies]",
    "amos-notifier = { workspace = true, optional = true }",
  ].join("\n");

  eq("parseMembers skips comments and reads the list", parseMembers(ROOT), ["crates/amos-ai", "crates/amos-supervisor"]);
  eq("parseMembers: no members table → empty", parseMembers('[package]\nname = "x"'), []);
  eq("parseWorkspaceDeps stops at the next table", [...parseWorkspaceDeps(ROOT).keys()], [
    "serde",
    "amos-ai",
    "amos-supervisor",
  ]);
  eq("parseWorkspaceDeps reads the path", parseWorkspaceDeps(ROOT).get("amos-ai"), "crates/amos-ai");
  eq("parseWorkspaceDeps: external dep has no path", parseWorkspaceDeps(ROOT).get("serde"), null);
  // The guard that the first version of this scan got wrong: `version.workspace = true` in
  // `[package]` is inheritance from `[workspace.package]`, not a dependency — reading it as one
  // reported four undeclared deps across a dozen healthy members.
  eq("requiredWorkspaceDeps finds dependencies but not [package] inheritance", [...requiredWorkspaceDeps(AI)], [
    "serde",
    "amos-notifier",
    "amos-supervisor",
  ]);
  eq("…and the same for a package-only manifest", [...requiredWorkspaceDeps(SUP)], ["amos-notifier"]);

  const tree = (files, dirs) => ({
    read: (p) => (p in files ? files[p] : null),
    listDirs: () => dirs,
  });
  const full = { "Cargo.toml": ROOT, "crates/amos-ai/Cargo.toml": AI, "crates/amos-supervisor/Cargo.toml": SUP };

  // The defect this scan exists for: the provider half is missing. Both members ask for it, which
  // is exactly what HEAD looks like.
  const broken = scanTree(tree(full, ["amos-ai", "amos-supervisor"]));
  eq("R2 fires on the undeclared workspace dep", broken.findings.map((f) => f.id), ["undeclared-dep:amos-notifier"]);
  eq("…and names every member that requires it", broken.findings[0].detail.includes("crates/amos-ai, crates/amos-supervisor"), true);
  eq("R1 does not fire when every member is present", broken.findings.filter((f) => f.rule === "R1").length, 0);

  // R1: a member whose manifest never made it into the commit.
  const gone = scanTree(
    tree({ "Cargo.toml": ROOT, "crates/amos-ai/Cargo.toml": AI }, ["amos-ai"]),
  );
  eq("R1 fires on a member absent from the tree", gone.findings.filter((f) => f.rule === "R1").map((f) => f.id), [
    "missing-member:crates/amos-supervisor",
  ]);

  // R3: a path dependency pointing at nothing.
  const ROOT2 = ['[workspace]', "members = []", "", "[workspace.dependencies]", 'amos-ai = { path = "crates/amos-ai" }'].join("\n");
  const phantom = scanTree(tree({ "Cargo.toml": ROOT2 }, []));
  eq("R3 fires on a phantom path dep", phantom.findings.filter((f) => f.rule === "R3").map((f) => f.id), [
    "phantom-path-dep:amos-ai",
  ]);

  // R4 is a note, and must never be a finding — an excluded crate is legitimate.
  const orphan = scanTree(tree(full, ["amos-ai", "amos-supervisor", "amos-link-py"]));
  eq("R4 never produces a finding", orphan.findings.filter((f) => f.rule === "R4").length, 0);
  eq("R4 names the orphan", orphan.notes.filter((n) => n.rule === "R4").map((n) => n.detail), [
    "crates/amos-link-py is in the tree but is neither a member nor a path dependency",
  ]);

  // A failed read is never silence: no root manifest is fatal, not clean.
  const noRoot = scanTree(tree({}, []));
  checks++;
  if (!noRoot.fatal) problems.push("a missing root manifest must be fatal, not a clean pass");

  // The negative control, in-process: add ONLY the two missing lines and R2 must go quiet.
  const fixed = ROOT.replace("]", '    "crates/amos-notifier",\n]').replace(
    'amos-ai = { path = "crates/amos-ai" }',
    'amos-ai = { path = "crates/amos-ai" }\namos-notifier = { path = "crates/amos-notifier" }',
  );
  const repaired = scanTree(
    tree(
      { "Cargo.toml": fixed, "crates/amos-ai/Cargo.toml": AI, "crates/amos-supervisor/Cargo.toml": SUP, "crates/amos-notifier/Cargo.toml": "" },
      ["amos-ai", "amos-supervisor", "amos-notifier"],
    ),
  );
  eq("adding the provider quiets R2 (two-sided control)", repaired.findings, []);

  if (problems.length) {
    console.error(`committed-manifest-scan selftest FAILED (${problems.length}):`);
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log(`committed-manifest-scan selftest OK (${checks} properties)`);
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const out = liveScan();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ rev: REV, ...out }, null, 2));
    process.exit(out.fatal || out.findings.length ? 1 : 0);
  }
  if (out.fatal) {
    console.error(`committed-manifest-scan FATAL: ${out.fatal} (rev ${REV})`);
    process.exit(2);
  }
  for (const n of out.notes) console.log(`[note] ${n.rule} ${n.detail}`);
  if (out.findings.length) {
    console.error(
      `committed-manifest-scan FAIL: ${out.findings.length} inconsistency(ies) in the committed ` +
        `tree at ${REV} (${out.members} members, ${out.declared} workspace deps). ` +
        `The working tree can be green while this is red — the fix must be *committed*, not staged:`,
    );
    for (const f of out.findings) console.error(`  - ${f.rule} ${f.id}: ${f.detail}`);
    process.exit(1);
  }
  console.log(
    `committed-manifest-scan OK: ${out.members} members and ${out.declared} workspace deps are ` +
      `consistent in the committed tree at ${REV}`,
  );
}
