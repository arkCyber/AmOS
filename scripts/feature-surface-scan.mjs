#!/usr/bin/env node
/**
 * feature-surface-scan.mjs — "a feature-gated surface no gate compiles".
 *
 * Why: `make lint`'s `cargo clippy --workspace --all-targets` builds the *default*
 * features only. Two kinds of code are therefore invisible to it — and to every other
 * gate, since a skipped build is indistinguishable from a successful one in the output:
 *
 *   * code behind a feature nobody enables (`#[cfg(feature = "…")]` modules), and
 *   * a cargo target whose `required-features` are unmet — cargo **skips it silently**
 *     rather than erroring (the same blind spot A187 found for clippy, twice removed).
 *
 * Measured when this gate was added (REQ-A191): of the workspace's **35 non-default
 * features, 5 were enabled by no step anywhere** — `amos-network-guard/{nftables,vpn}`
 * (the real nftables/VPN guard backends), `amos-tauri/{appstore-live,tcp,terminal-pty}`
 * (the live store bridge, the retail-Android TCP transport that `AMOS_TCP_ADDR` selects,
 * and the PTY shell). And of 7 targets requiring a feature, exactly one — the
 * `live_spy` example of `amos-telemetry-spy` (`audit`) — was compiled by nothing, while
 * `docs/telemetry-spy.md` documents running it.
 *
 * The rule: every non-default feature, and every target with a non-empty
 * `required-features`, must be compiled by some `cargo` step on the shipped surface (the
 * Makefile, `.github/**`, `scripts/**`, `deploy.sh`) — explicitly, or by a run that
 * enables the feature *and* builds all targets. Anything else needs a reason in
 * `scripts/feature-surface-allowlist.json`, where a stale entry FAILS.
 *
 * Scope boundaries: the surface is parsed *syntactically* (a `cargo` word plus its flags
 * on one joined line), so a feature enabled only by an exotic wrapper (`cargo ndk …` is
 * recognized; a feature baked into a build script's env is not) reads as uncovered — the
 * gate errs toward reporting, and the fix is a visible step. `default` features are out
 * of scope (the workspace keeps them empty), and `dep:` items in a feature list are
 * dependency enablers, not features.
 *
 * Usage (from the repo root):
 *   node scripts/feature-surface-scan.mjs              # gate
 *   node scripts/feature-surface-scan.mjs --json
 *   node scripts/feature-surface-scan.mjs --selftest   # pin the parser/coverage rules
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
// The feature graph (features + transitive enablement) is shared with feature-test-scan.mjs.
import { crateManifests, coveredFeatures } from "./feature-graph.mjs";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(root, "scripts", "feature-surface-allowlist.json");
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build"]);

/** Drop comments before reading a surface file (see unwired-script-scan for the rationale). */
export function stripComments(text, kind) {
  if (kind === "js") return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return text
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line.replace(/(\s)#.*$/, "$1")))
    .join("\n");
}

function kindOf(path) {
  if (/\.(mjs|js|cjs)$/.test(path)) return "js";
  return "hash";
}

/** Makefile + `.github/**` + `scripts/**` + `deploy.sh`: every file that can run cargo. */
export function surfaceFiles(dir = root) {
  const out = [join(dir, "Makefile")];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (SKIP_DIRS.has(e)) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  for (const d of [".github", "scripts"]) if (existsSync(join(dir, d))) walk(join(dir, d));
  for (const e of readdirSync(dir)) {
    if (e.endsWith(".sh") && statSync(join(dir, e)).isFile()) out.push(join(dir, e));
  }
  return out.filter((p) => existsSync(p));
}


/**
 * Every `cargo` invocation on a surface text, with the flags this gate reasons about.
 * Line continuations are joined and the `cd <dir> &&` prefix is irrelevant here (cargo
 * resolves packages by name, not by cwd).
 */
export function cargoInvocations(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/\bcargo\s+[\w-]/.test(lines[i])) continue;
    let joined = lines[i].trim();
    while (joined.endsWith("\\") && i + 1 < lines.length) {
      joined = `${joined.slice(0, -1).trim()} ${lines[++i].trim()}`;
    }
    const from = joined.search(/\bcargo\s+[\w-]/);
    const args = joined.slice(from).split(/\s+/).slice(1); // drop the `cargo` word
    const inv = {
      packages: [],
      features: [],
      workspace: false,
      allFeatures: false,
      broadTargets: false,
      named: [],
      text: joined,
    };
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      const val = (flag) =>
        a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : (args[++j] ?? "");
      if (a === "-p" || a === "--package") inv.packages.push(args[++j] ?? "");
      else if (a.startsWith("--package=")) inv.packages.push(a.slice("--package=".length));
      else if (a === "--workspace" || a === "--all") inv.workspace = true;
      else if (a === "--all-features") inv.allFeatures = true;
      else if (a === "--all-targets" || a === "--examples" || a === "--bins") inv.broadTargets = true;
      else if (a === "--features" || a === "-F") inv.features.push(...val("").split(/[,\s]+/));
      else if (a.startsWith("--features=")) inv.features.push(...a.slice("--features=".length).split(/[,\s]+/));
      else if (/^--(example|bin|test|bench)(=|$)/.test(a)) {
        inv.named.push(a.includes("=") ? a.split("=")[1] : (args[++j] ?? ""));
      }
    }
    inv.features = inv.features.filter(Boolean);
    out.push(inv);
  }
  return out;
}

/**
 * Which features the invocations enable, transitively: a covered feature enables the
 * items of its own definition (`dep:` entries are dependency enablers and are ignored;
 * `other/feat` and a bare `feat` resolve to the declaring crate, or to every crate that
 * declares it when the invocation is workspace-wide — the permissive direction).
 */
/**
 * Targets with `required-features` that no invocation builds: a run must either name the
 * target (`--example x`) or build every target *and* enable all of that crate's required
 * features in the same invocation (the feature has to be on for cargo to include it).
 */
export function uncoveredTargets(manifests, invocations) {
  const out = [];
  for (const t of manifests.targets) {
    if (!t.requires || t.requires.length === 0) continue; // built by every default run
    const requires = (inv) =>
      t.requires.every((f) => {
        const set = coveredFeatures(manifests, [inv]);
        return set.has(`${t.crate}/${f}`) || (manifests.owners.get(f) ?? []).some((c) => set.has(`${c}/${f}`));
      });
    const named = invocations.some((inv) => inv.named.includes(t.name));
    const broad = invocations.some((inv) => inv.broadTargets && requires(inv));
    if (!named && !broad) out.push(t);
  }
  return out;
}


/** The scan proper: manifests + the shipped surface → what nothing compiles. */
export function scan(dir = root) {
  const manifests = crateManifests(dir);
  const invocations = [];
  for (const file of surfaceFiles(dir)) {
    invocations.push(...cargoInvocations(stripComments(readFileSync(file, "utf8"), kindOf(file))));
  }
  const covered = coveredFeatures(manifests, invocations);
  const declared = [...manifests.features.keys()].filter((k) => !k.endsWith("/default"));
  return {
    declared: declared.length,
    covered: covered.size,
    uncoveredFeatures: declared.filter((k) => !covered.has(k)).sort(),
    uncoveredTargets: uncoveredTargets(manifests, invocations),
    invocations: invocations.length,
  };
}

function runSelfTest() {
  const cases = [];
  const check = (name, ok) => cases.push([name, ok]);

  const manifests = {
    crates: ["a", "b"],
    features: new Map([
      ["a/android", ["dep:jni"]],
      ["a/tcp", []],
      ["a/live", ["b/live"]],
      ["b/live", ["dep:ureq"]],
      ["b/sherpa", []],
    ]),
    owners: new Map([
      ["android", ["a"]],
      ["tcp", ["a"]],
      ["live", ["a", "b"]],
      ["sherpa", ["b"]],
    ]),
    targets: [
      { crate: "b", kind: "example", name: "probe", requires: ["sherpa"] },
      { crate: "a", kind: "example", name: "free", requires: [] },
    ],
  };

  const inv1 = cargoInvocations("\tcargo build -p a --features tcp,android\n");
  check("packages and features are read", inv1[0].packages[0] === "a");
  check("comma-separated features are split", inv1[0].features.join(",") === "tcp,android");
  check("a bare feature counts for the named package", coveredFeatures(manifests, inv1).has("a/tcp"));
  check(
    "`pkg/feat` counts anywhere",
    coveredFeatures(manifests, cargoInvocations("\tcargo test -p x --features a/tcp\n")).has("a/tcp"),
  );
  check(
    "transitive enablement counts (a/live → b/live)",
    coveredFeatures(manifests, cargoInvocations("\tcargo build -p x --features a/live\n")).has("b/live"),
  );
  check(
    "`--all-features` covers the workspace",
    coveredFeatures(manifests, cargoInvocations("\tcargo clippy --workspace --all-features\n")).has("b/sherpa"),
  );
  check(
    "a comment is not an invocation (comments are stripped before parsing)",
    cargoInvocations(stripComments("# cargo build --features tcp\n", "hash")).length === 0,
  );
  check(
    "a named target is covered",
    !uncoveredTargets(manifests, cargoInvocations("\tcargo build -p b --features sherpa --example probe\n")).some(
      (t) => t.name === "probe",
    ),
  );
  check(
    "a target nobody names and nobody broad-builds is uncovered",
    uncoveredTargets(manifests, cargoInvocations("\tcargo clippy --workspace --all-targets\n")).some(
      (t) => t.name === "probe",
    ),
  );
  check(
    "`--all-targets` *with* the feature covers it",
    !uncoveredTargets(manifests, cargoInvocations("\tcargo build -p b --all-targets --features sherpa\n")).some(
      (t) => t.name === "probe",
    ),
  );
  check(
    "a target with no required-features is never a finding",
    !uncoveredTargets(manifests, []).some((t) => t.name === "free"),
  );

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[feature-surface-scan] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[feature-surface-scan] selftest OK — ${cases.length} parser/coverage case(s).`);
}


const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const result = scan();
const allow = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, "utf8")) : {};
const allowFeatures = allow.features ?? {};
const allowTargets = allow.targets ?? {};
const features = result.uncoveredFeatures.filter((k) => !(k in allowFeatures));
const targets = result.uncoveredTargets.filter(
  (t) => !(`${t.crate}:${t.kind}:${t.name}` in allowTargets),
);
const stale = [
  ...Object.keys(allowFeatures).filter((k) => !result.uncoveredFeatures.includes(k)),
  ...Object.keys(allowTargets).filter(
    (k) => !result.uncoveredTargets.some((t) => `${t.crate}:${t.kind}:${t.name}` === k),
  ),
];

if (args.includes("--json")) {
  console.log(JSON.stringify({ ...result, uncoveredFeatures: features, uncoveredTargets: targets, stale }, null, 2));
  process.exit(features.length === 0 && targets.length === 0 && stale.length === 0 ? 0 : 1);
}

for (const k of features) {
  console.log(
    `  never enabled: ${k} — add a step, e.g. cargo clippy -p ${k.split("/")[0]} --features ` +
      `${k.split("/")[1]} -- -D warnings`,
  );
}
for (const t of targets) {
  console.log(
    `  never built: ${t.crate} [[${t.kind}]] ${t.name} (requires ${t.requires.join(",")}) — ` +
      `add a step, e.g. cargo build -p ${t.crate} --features ${t.requires.join(",")} --${t.kind} ${t.name}`,
  );
}
for (const k of stale) console.log(`  stale allow-list entry: ${k} (now compiled by a gate step)`);
if (features.length > 0 || targets.length > 0 || stale.length > 0) {
  console.log(
    `[feature-surface-scan] FAIL — ${features.length} feature(s) and ${targets.length} ` +
      "feature-gated target(s) are compiled by no gate step" +
      `${stale.length > 0 ? `, ${stale.length} stale allow-list entry(ies)` : ""}. A default-features ` +
      "`--all-targets` run compiles neither, and cargo *skips* a target whose `required-features` " +
      "are unmet — so that code can rot with every gate green.",
  );
  process.exit(1);
}
console.log(
  `[feature-surface-scan] OK — all ${result.declared} non-default feature(s) (${result.covered} ` +
    `enabled transitively) and every feature-gated target are compiled by the shipped surface ` +
    `(${result.invocations} cargo invocation(s) read).`,
);

