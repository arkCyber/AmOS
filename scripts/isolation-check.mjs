#!/usr/bin/env node
/**
 * isolation-check.mjs — every workspace member must build **on its own**.
 *
 * Why (REQ-A464, closing the class F-DEV-055 recorded): cargo **unifies features across the
 * workspace**, so a `--workspace` build turns on features that a package does not enable for
 * itself. That is how `crates/amos-monitor/examples/sample_health.rs` came to compile in CI
 * while `cargo build -p amos-monitor --all-targets` failed with E0432: `amos-ai` depends on
 * `amos-monitor` with `features = ["linux"]`, so the workspace build turned the feature on for
 * everyone — including the one target that never declared it needed the feature.
 *
 * `make lint` / `make test` are both workspace-wide, so neither can see this class. The only
 * instrument that can is one `cargo` invocation **per package**, which is what this is.
 *
 * What it runs: `cargo check -p <member> --all-targets` for every active member. `check` (not
 * `build`) because the class is name-resolution/type-level — an unresolved import fails the
 * check — and it is several times cheaper (no codegen, no linking).
 *
 * The member list is parsed from the workspace `Cargo.toml` **skipping comments**: the ad-hoc
 * harness that produced this gate's first measurement did not, and reported a failure for
 * `amos-link-py` — a member that is commented out on purpose (PyO3, built with maturin) and
 * that cargo refuses with "did not match any packages". A gate that reds on a package that
 * does not exist is worse than no gate, so the parser is pinned by `--selftest`.
 *
 * Usage (repo root):
 *   node scripts/isolation-check.mjs                 # gate (exit 1 on any failure)
 *   node scripts/isolation-check.mjs --json
 *   node scripts/isolation-check.mjs --selftest      # pin the member parser + classifier
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The **active** entries of `[workspace] members` in a `Cargo.toml`'s text.
 *
 * Comment-aware (a `#` before the entry, or trailing after it, drops it) and additive-aware
 * (`members` may be spelled across several lines). Returns the entries in file order, with
 * the leading `crates/` kept — the caller maps them to package names.
 */
export function workspaceMembers(text) {
  const out = [];
  let inMembers = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "");
    if (/^\s*members\s*=\s*\[/.test(line)) {
      inMembers = true;
    }
    if (!inMembers) continue;
    for (const m of line.matchAll(/"([^"]+)"/g)) out.push(m[1]);
    if (/\]/.test(line)) inMembers = false;
  }
  return out;
}

/** `crates/amos-monitor` → `amos-monitor` (cargo selects packages by name, not by path). */
export function packageOf(memberPath) {
  const parts = memberPath.split("/").filter((p) => p !== "");
  return parts[parts.length - 1];
}

/**
 * What a finished `cargo check` means. `status === null` with a signal is not "zero", and a
 * spawn-level timeout has to be reported as such — "it was killed" is a different statement
 * from "it failed to compile".
 */
export function outcomeOf({ status, signal, timedOut }) {
  if (timedOut) return "timeout";
  if (signal) return "signal";
  return status === 0 ? "ok" : "exit";
}

/** The last few non-empty lines — enough to name the cause in the report. */
export function tailOf(s, n = 6) {
  return s
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-n)
    .join("\n");
}

function checkPackage(name, timeoutMs) {
  const r = spawnSync("cargo", ["check", "-p", name, "--all-targets", "-q"], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    name,
    outcome: outcomeOf({
      status: r.status,
      signal: r.signal,
      timedOut: r.error?.code === "ETIMEDOUT",
    }),
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

// --- main --------------------------------------------------------------------
const argv = process.argv.slice(2);
let timeoutMs = 300_000;
const flags = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--timeout") {
    timeoutMs = Number(argv[i + 1]);
    i += 1;
    continue;
  }
  flags.push(argv[i]);
}
const unknown = flags.filter((f) => !["--selftest", "--json"].includes(f));
if (unknown.length > 0) {
  console.error(`[isolation-check] unknown flag(s): ${unknown.join(" ")}`);
  console.error("Usage: node scripts/isolation-check.mjs [--json] [--selftest] [--timeout <ms>]");
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("[isolation-check] --timeout must be a positive number of milliseconds");
  process.exit(2);
}

if (flags.includes("--selftest")) {
  const cases = [];
  const ok = (name, cond) => cases.push([name, cond]);

  const toml = [
    "[workspace]",
    "resolver = \"2\"",
    "members = [",
    "    \"crates/amos-proto\",",
    "    \"crates/amos-audio\",",
    "    # \"crates/amos-link-py\",  # PyO3 extension - build with maturin, not cargo",
    "    \"crates/amos-config\",",
    "]",
    "",
    "[workspace.dependencies]",
    "amos-proto = { path = \"crates/amos-proto\" }",
    "",
  ].join("\n");
  const members = workspaceMembers(toml);
  ok("members: three active entries are read", members.length === 3);
  ok("members: a commented entry is skipped", !members.includes("crates/amos-link-py"));
  ok("members: order is preserved", members[0] === "crates/amos-proto");
  ok("members: parsing stops at the closing bracket", members.every((m) => m.startsWith("crates/")));
  ok("members: nothing outside the array leaks in", !members.includes("crates/amos-proto\") }"));

  ok(
    "members: a one-line array works",
    workspaceMembers('members = ["crates/a", "crates/b"]').join() === "crates/a,crates/b",
  );
  ok("members: no array means no members", workspaceMembers("[package]\nname = \"x\"\n").length === 0);
  ok(
    "members: a trailing comment after a real entry keeps the entry",
    workspaceMembers('members = [\n  "crates/a", # keep me\n]').join() === "crates/a",
  );

  ok("packageOf takes the last path segment", packageOf("crates/amos-monitor") === "amos-monitor");
  ok("packageOf tolerates a trailing slash", packageOf("crates/amos-monitor/") === "amos-monitor");

  ok("outcome: zero exit is ok", outcomeOf({ status: 0 }) === "ok");
  ok("outcome: non-zero exit", outcomeOf({ status: 101 }) === "exit");
  ok("outcome: a signal is its own outcome", outcomeOf({ status: null, signal: "SIGKILL" }) === "signal");
  ok("outcome: a timeout is its own outcome", outcomeOf({ timedOut: true, status: null }) === "timeout");

  ok("tailOf keeps the last non-empty lines", tailOf("a\n\nb\nc\n", 2) === "b\nc");

  const failed = cases.filter(([, cond]) => !cond);
  if (failed.length > 0) {
    console.log(`[isolation-check] selftest FAILED — ${failed.length} case(s):`);
    for (const [name] of failed) console.log(`  ✗ ${name}`);
    process.exit(1);
  }
  console.log(`[isolation-check] selftest OK — ${cases.length} parser/classifier case(s).`);
  process.exit(0);
}

const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");
const members = workspaceMembers(manifest).map(packageOf);
if (members.length === 0) {
  console.error("[isolation-check] no workspace members found — the parser or the manifest is wrong");
  process.exit(2);
}
for (const m of members) {
  if (!existsSync(join(root, "crates", m, "Cargo.toml"))) {
    console.error(`[isolation-check] member \`${m}\` has no crates/${m}/Cargo.toml`);
    process.exit(2);
  }
}

const results = members.map((m) => checkPackage(m, timeoutMs));
const failures = results.filter((r) => r.outcome !== "ok");

if (flags.includes("--json")) {
  console.log(JSON.stringify({ members: members.length, results, failures: failures.length }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

if (failures.length > 0) {
  console.log(
    `[isolation-check] FAIL — ${failures.length} of ${members.length} package(s) do not build on their own:`,
  );
  for (const r of failures) {
    console.log(`  ${r.outcome}: ${r.name}`);
    for (const line of tailOf(r.output).split("\n")) console.log(`    ${line}`);
  }
  console.log(
    "  Fix: cargo unifies features across the workspace, so `--workspace` can build a package\n" +
      "       that fails alone (a target using a feature-gated item without `required-features`\n" +
      "       is the usual cause). Declare the requirement, or enable the feature explicitly.",
  );
  process.exit(1);
}
console.log(`[isolation-check] OK — all ${members.length} workspace member(s) check --all-targets on their own.`);
