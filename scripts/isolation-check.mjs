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
 * Rule 2, same root cause seen from the other side (REQ-A465): a **workspace build is not N
 * independent builds**. Cargo also merges the members' *output paths*: a `bin` named `foo` in
 * two packages both want `target/<profile>/foo`, and an `example` named `foo` in two packages
 * both want `target/<profile>/examples/foo`. Cargo prints `warning: output filename collision
 * … this may become a hard error in the future` and links whichever runs last, so the by-path
 * artefact is ambiguous (measured on this tree: `status_once` in `amos-ai` *and*
 * `amos-translate`, `embed_commands` in `amos-appstore-cli` *and* `amos-link-cli` — and a
 * script that executes `target/debug/examples/status_once` by path is relying on an accident).
 * Read from `cargo metadata` (cargo's own model — no manifest parsing) for the kinds whose
 * output path is *not* hashed: `bin` and `example`. Tests and benchmarks land in
 * `deps/<name>-<hash>`, where the hash makes a repeated name harmless.
 *
 * Even a clean warning is worth failing on here: `-D warnings` is clippy's, not cargo's, and
 * `cargo build -q` (what `scripts/examples-smoke.mjs` runs) hides this one entirely.
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

/**
 * Target kinds whose output path is **not** hashed, so two packages cannot both use the name:
 * a `bin` lands at `target/<profile>/<name>` and an `example` at
 * `target/<profile>/examples/<name>`. Everything else (lib kinds, tests, benches) lands under
 * `deps/<name>-<metadata-hash>`, where the hash keeps same-named targets apart.
 */
export const UNSHARED_KINDS = ["bin", "example"];

/**
 * `[{ kind, name, packages }]` for every `(kind, name)` that more than one package declares in
 * an unhashed output kind — i.e. exactly the set cargo warns about as an "output filename
 * collision". `metadata` is `cargo metadata --no-deps`'s parsed JSON (cargo's own model of the
 * workspace, so this needs no manifest parsing and cannot disagree with cargo).
 */
export function outputCollisions(metadata) {
  const seen = new Map();
  for (const pkg of metadata?.packages ?? []) {
    for (const target of pkg.targets ?? []) {
      for (const kind of target.kind ?? []) {
        if (!UNSHARED_KINDS.includes(kind)) continue;
        const key = `${kind}\u241f${target.name}`;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(pkg.name);
      }
    }
  }
  const out = [];
  for (const [key, packages] of seen) {
    if (packages.length < 2) continue;
    const [kind, name] = key.split("\u241f");
    out.push({ kind, name, packages: [...packages].sort() });
  }
  return out.sort((a, b) => `${a.kind}\u241f${a.name}`.localeCompare(`${b.kind}\u241f${b.name}`));
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

/** Parsed `cargo metadata --no-deps`, or `null` when cargo could not answer (rule 2 needs it). */
function loadMetadata() {
  const r = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
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

  // Rule 2: output-path collisions, read from `cargo metadata`'s target list.
  const pkg = (name, targets) => ({ name, targets });
  const tgt = (name, kind) => ({ name, kind });
  ok(
    "collisions: two packages' examples with one name collide",
    outputCollisions({
      packages: [
        pkg("a", [tgt("status_once", ["example"])]),
        pkg("b", [tgt("status_once", ["example"])]),
      ],
    }).length === 1,
  );
  ok(
    "collisions: the entry names the kind, the name and both packages, sorted",
    (() => {
      const [c] = outputCollisions({
        packages: [
          pkg("b", [tgt("status_once", ["example"])]),
          pkg("a", [tgt("status_once", ["example"])]),
        ],
      });
      return c.kind === "example" && c.name === "status_once" && c.packages.join() === "a,b";
    })(),
  );
  ok(
    "collisions: one name in two different kinds is not a collision",
    outputCollisions({
      packages: [pkg("a", [tgt("embed", ["bin"])]), pkg("b", [tgt("embed", ["example"])])],
    }).length === 0,
  );
  ok(
    "collisions: a repeated test/bench name is harmless (hashed under deps/)",
    outputCollisions({
      packages: [
        pkg("a", [tgt("e2e", ["test"]), tgt("bench_x", ["bench"])]),
        pkg("b", [tgt("e2e", ["test"]), tgt("bench_x", ["bench"])]),
      ],
    }).length === 0,
  );
  ok(
    "collisions: a repeated library name is harmless",
    outputCollisions({
      packages: [pkg("a", [tgt("amos-lib", ["lib"])]), pkg("b", [tgt("amos-lib", ["lib"])])],
    }).length === 0,
  );
  ok(
    "collisions: three packages yield one entry naming all three",
    (() => {
      const c = outputCollisions({
        packages: [
          pkg("a", [tgt("dup", ["bin"])]),
          pkg("b", [tgt("dup", ["bin"])]),
          pkg("c", [tgt("dup", ["bin"])]),
        ],
      });
      return c.length === 1 && c[0].packages.length === 3;
    })(),
  );
  ok(
    "collisions: a unique name is not reported",
    outputCollisions({ packages: [pkg("a", [tgt("only_here", ["example"])])] }).length === 0,
  );
  ok("collisions: absent metadata is empty, not a throw", outputCollisions(undefined).length === 0);

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

// Rule 1: every active member must `check --all-targets` **on its own**.
const results = members.map((m) => checkPackage(m, timeoutMs));
const failures = results.filter((r) => r.outcome !== "ok");

// Rule 2: no two members may write a `bin`/`example` to the same (unhashed) output path.
const metadata = loadMetadata();
if (metadata === null) {
  console.error(
    "[isolation-check] `cargo metadata --no-deps` failed, so the output-path rule cannot be\n" +
      "      evaluated — refusing to print OK rather than report a check that did not run.",
  );
  process.exit(2);
}
const collisions = outputCollisions(metadata);

if (flags.includes("--json")) {
  console.log(
    JSON.stringify(
      { members: members.length, results, failures: failures.length, collisions },
      null,
      2,
    ),
  );
  process.exit(failures.length === 0 && collisions.length === 0 ? 0 : 1);
}

let failed = false;

if (failures.length > 0) {
  failed = true;
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
}

if (collisions.length > 0) {
  failed = true;
  console.log(
    `[isolation-check] FAIL — ${collisions.length} target name(s) are declared by more than one package:`,
  );
  for (const c of collisions) {
    console.log(`  ${c.kind}: ${c.name}  ← ${c.packages.join(", ")}`);
  }
  console.log(
    "  Fix: cargo writes both to one path (`target/<profile>/<name>` for a bin,\n" +
      "       `target/<profile>/examples/<name>` for an example), warns about it today and\n" +
      "       promises a hard error tomorrow; the by-path artefact is ambiguous in the meantime.\n" +
      "       Rename one target (or its file), or give it an explicit `[[example]] name = \"…\"`.",
  );
}

if (failed) process.exit(1);
console.log(
  `[isolation-check] OK — all ${members.length} workspace member(s) check --all-targets on their\n` +
    "  own, and no two members share a `bin`/`example` output path.",
);
