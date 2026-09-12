#!/usr/bin/env node
/**
 * rust-panic-scan.mjs — "a crate root without the P0-1 panic gate".
 *
 * Why: P0-1 is "production Rust must not panic on programmer error". The mechanism
 * (from the first P0-1 batch) is an inner attribute on every crate root:
 *
 *     #![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]
 *
 * Tests stay exempt (assertions/unwrap are idiomatic there). 34 of the 39 workspace
 * members had it and **five were missed entirely** — nobody noticed because nothing
 * checked. This scan reads the workspace member list and requires the full gate on
 * every crate root that exists (`src/lib.rs`, `src/main.rs`, `src/bin/*.rs`), with an
 * allow-list (`scripts/rust-panic-allowlist.json`) for any deliberate exception and a
 * `[stale]` report so the list cannot rot.
 *
 * Usage (from the repo root):
 *   node scripts/rust-panic-scan.mjs              # gate
 *   node scripts/rust-panic-scan.mjs --json       # machine-readable
 *   node scripts/rust-panic-scan.mjs --selftest   # pin the parser/classifier
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(root, "scripts", "rust-panic-allowlist.json");

/** The crate roots of one member directory that need the gate, as paths. */
export function crateRoots(dir) {
  const out = [];
  for (const rel of ["src/lib.rs", "src/main.rs"]) {
    if (existsSync(join(dir, rel))) out.push(join(dir, rel));
  }
  const binDir = join(dir, "src", "bin");
  if (existsSync(binDir)) {
    for (const f of readdirSync(binDir).sort()) {
      if (f.endsWith(".rs")) out.push(join(dir, "src", "bin", f));
    }
  }
  return out;
}

/** The `members = [ … ]` list of the workspace manifest. */
export function workspaceMembers(manifest) {
  const start = manifest.indexOf("members");
  const open = manifest.indexOf("[", start);
  const close = manifest.indexOf("]", open);
  if (start < 0 || open < 0 || close < 0) return [];
  return manifest
    .slice(open + 1, close)
    .split(",")
    .map((m) => m.trim().replace(/^"|"$/g, ""))
    .filter((m) => m !== "" && m !== "#");
}

/** True when `src` carries the whole P0-1 gate (all three lints, not just one). */
export function gated(src) {
  return (
    /deny\s*\(/.test(src) &&
    src.includes("clippy::unwrap_used") &&
    src.includes("clippy::expect_used") &&
    src.includes("clippy::panic")
  );
}

export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

// --- scan -------------------------------------------------------------------
function runScan() {
  const members = workspaceMembers(readFileSync(join(root, "Cargo.toml"), "utf8"));
  if (members.length === 0) {
    console.error("[rust-panic-scan] could not read the workspace members from Cargo.toml");
    process.exit(1);
  }

  let allow;
  try {
    allow = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  } catch (e) {
    console.error(`[rust-panic-scan] allowlist is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const kinds = allow.kinds ?? {};
  for (const k of Object.keys(kinds)) {
    if (!String(kinds[k]).trim()) {
      console.error(`[rust-panic-scan] allowlist kind \`${k}\` has no reason`);
      process.exit(2);
    }
  }
  const listed = new Map((allow.files ?? []).map((f) => [f.file, f.kind]));

  const roots = [];
  for (const m of members) for (const p of crateRoots(join(root, m))) roots.push(p);

  const used = new Set();
  const ungated = [];
  for (const p of roots) {
    const rel = p.slice(root.length + 1);
    if (gated(readFileSync(p, "utf8"))) continue;
    const kind = listed.get(rel);
    if (kind === undefined) {
      ungated.push({ file: rel, why: "no P0-1 gate" });
      continue;
    }
    used.add(rel);
    if (!kinds[kind]) ungated.push({ file: rel, why: `kind \`${kind}\` is not defined` });
  }
  const stale = [...listed.keys()].filter((f) => !used.has(f)).sort();
  const failures = ungated.length + stale.length;

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify({ members: members.length, roots: roots.length, ungated, stale }, null, 2),
    );
  } else {
    console.log(
      `[rust-panic-scan] ${roots.length} crate root(s) across ${members.length} workspace member(s).`,
    );
    for (const u of ungated) {
      console.error(
        `[rust-panic-scan] FAIL — ${u.file} has no P0-1 panic gate (${u.why}). Add:\n` +
          "  #![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]",
      );
    }
    for (const f of stale) {
      console.log(
        `[rust-panic-scan] allow-list: stale entry (no such crate root) — shrink it: ${f}`,
      );
    }
    if (failures === 0) {
      console.log(
        "[rust-panic-scan] OK — every crate root denies unwrap/expect/panic in production.",
      );
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const members = workspaceMembers(
    '[workspace]\nmembers = [\n  "crates/a",\n  "crates/b",\n]\n\n[workspace.package]\n',
  );
  ok("reads the workspace member list", members.length === 2 && members[0] === "crates/a");
  ok("stops at the closing bracket", !members.includes("workspace.package"));
  ok("a missing members list yields none", workspaceMembers("[package]\nname = 'x'\n").length === 0);

  ok(
    "the full gate is recognised",
    gated("#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]"),
  );
  ok("one lint alone is not the gate", !gated("#![deny(clippy::unwrap_used)]"));
  ok("a doc comment mentioning a lint is not the gate", !gated("// clippy::unwrap_used"));
  ok("finds lib/main roots", crateRoots(join(root, "crates", "amos-wm")).length >= 1);
  ok("a member with no src has no roots", crateRoots(join(root, "crates", "__nope")).length === 0);

  const invoked = "file:///x/scripts/rust-panic-scan.mjs";
  ok(
    "invokedDirectly only matches this script",
    invokedDirectly(invoked, "scripts/rust-panic-scan.mjs") &&
      !invokedDirectly(invoked, "scripts/other.mjs"),
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[rust-panic-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[rust-panic-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
