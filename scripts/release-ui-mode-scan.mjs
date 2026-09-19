#!/usr/bin/env node
/**
 * release-ui-mode-scan.mjs — "a release UI build that does not embed the UI".
 *
 * Why: `tauri` chooses **at compile time** between the embedded `frontendDist` and
 * `build.devUrl`:
 *
 *     tauri/src/lib.rs:   pub const fn is_dev() -> bool { !cfg!(feature = "custom-protocol") }
 *     tauri/build.rs:     let dev = !has_feature("custom-protocol");  println!("cargo:dev={dev}");
 *
 * so a `cargo build --release -p amos-tauri` that forgets `--features custom-protocol`
 * (or `tauri/custom-protocol`) produces a *production-looking* binary whose WebView points
 * at `http://localhost:1420`. Measured on this machine (2026-09-18, REQ-A421):
 * `scripts/run-ui-release.sh` — the script whose whole documented purpose is "embeds dist,
 * ignores devUrl" — launched exactly such a binary; with nothing serving port 1420 the
 * window rendered **1 176 colours** (a blank page), the main frame failed with `-1004`
 * and not one `[csp-probe]` line appeared. Every gate stayed green, because nothing in
 * this tree asked the question. `make app-open` was unaffected only because the Tauri CLI
 * adds `tauri/custom-protocol` itself.
 *
 * The rule (syntactic, like the other scanners in `scripts/`):
 *   1. `crates/amos-tauri/Cargo.toml` must declare a `custom-protocol` feature that
 *      enables `tauri/custom-protocol` — that is what lets a plain cargo step ask for the
 *      production build, and it is the feature this scan keys on.
 *   2. Every `cargo build`/`cargo run` command on the shipped surface (Makefile,
 *      `scripts/**`, `.github/**`, `deploy.sh`) that builds **`amos-tauri`** in release
 *      mode must enable `custom-protocol` or `tauri/custom-protocol`.
 *   3. `cargo tauri build` is the Tauri CLI's own path: it appends
 *      `tauri/custom-protocol` itself (the string is in the CLI binary), so it is counted
 *      as production — but the *bundle* it produces is only verified by running it, which
 *      this scan cannot do.
 *   4. A debug build is legitimate (it is the Vite-dev-server path); only `--release` /
 *      `-r` is in scope.
 *
 * Usage (from the repo root):
 *   node scripts/release-ui-mode-scan.mjs             # gate (exit 1 on any defect)
 *   node scripts/release-ui-mode-scan.mjs --json
 *   node scripts/release-ui-mode-scan.mjs --selftest  # pin parse/classify
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_MANIFEST = join(root, "crates", "amos-tauri", "Cargo.toml");
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", "gen"]);

/** The feature the app manifest must declare, and the dependency feature it must enable. */
export const FEATURE = "custom-protocol";
export const ENABLES = "tauri/custom-protocol";

/**
 * Does `Cargo.toml` declare `custom-protocol = ["tauri/custom-protocol", …]`?
 * Comments are stripped first: the feature's own documentation in this repo names both
 * strings, and a *comment* must never satisfy a gate (the same rule
 * `unwired-script-scan.mjs` applies to its surface files).
 */
export function manifestDeclaresFeature(text) {
  const body = text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  const m = body.match(new RegExp(`^\\s*${FEATURE}\\s*=\\s*\\[([^\\]]*)\\]`, "m"));
  if (!m) return false;
  return m[1].split(",").some((f) => f.trim().replace(/^"|"$/g, "") === ENABLES);
}

/** One `cargo …` command per line, comments stripped (a commented-out command is noise). */
export function cargoCommands(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#"))
    .filter((l) => /(^|[;&|]\s*)cargo\s/.test(l));
}

/**
 * Which build a `cargo …` line performs. Only `build`/`run`/`install` count: a `cargo test
 * --release` never launches the UI, and a `cargo check` produces no binary to run.
 */
export function classifyCargoLine(line) {
  if (/\bcargo\s+tauri\s+build\b/.test(line)) {
    return { kind: "tauri-cli", covers: true };
  }
  if (!/\bcargo\s+(build|run|install)\b/.test(line)) {
    return { kind: "out-of-scope", covers: false };
  }
  const release = /(^|\s)(--release|-r)(\s|$)/.test(line);
  const buildsApp =
    /(^|\s)-p\s+amos-tauri(\s|$)/.test(line) ||
    /--manifest-path[= ]\S*amos-tauri/.test(line);
  if (!release || !buildsApp) return { kind: "out-of-scope", covers: false };
  const covers =
    line.includes(ENABLES) || new RegExp(`(^|[ ,=])${FEATURE}($|[ ,])`).test(line);
  return { kind: covers ? "ok" : "missing-feature", covers };
}

/** Every file that can hold a shipped cargo command (comments are stripped per line later). */
export function surfaceFiles() {
  const out = [join(root, "Makefile"), join(root, "deploy.sh")];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(join(root, "scripts"));
  walk(join(root, ".github"));
  return out.filter((f) => /\.(sh|mjs|js|yml|yaml|toml|md)$|Makefile$/.test(f));
}

/** All findings for the tree: the manifest rule plus one per uncovered release command. */
export function findings(readFile) {
  const out = [];
  const manifest = readFile(APP_MANIFEST);
  if (!manifestDeclaresFeature(manifest)) {
    out.push({
      kind: "feature-missing",
      file: relative(root, APP_MANIFEST),
      detail: `no \`${FEATURE} = ["${ENABLES}"]\` — a plain \`cargo build --release\` cannot ask for the embedded UI`,
    });
  }
  for (const file of surfaceFiles()) {
    const text = readFile(file);
    text.split("\n").forEach((line, i) => {
      for (const cmd of cargoCommands(line)) {
        const c = classifyCargoLine(cmd);
        if (c.kind === "missing-feature") {
          out.push({
            kind: "missing-feature",
            file: relative(root, file),
            line: i + 1,
            detail: `release build of amos-tauri without \`--features ${FEATURE}\` — its WebView would load build.devUrl, not the embedded bundle`,
            command: cmd,
          });
        }
      }
    });
  }
  return out;
}

// --- selftest ---------------------------------------------------------------
function selftest() {
  const cases = [
    // The defect this file exists for (scripts/run-ui-release.sh, before REQ-A421).
    ["cargo build --release -p amos-tauri", "missing-feature"],
    ["cargo build --release -p amos-tauri --features custom-protocol", "ok"],
    ["cargo build --release -p amos-tauri --features tauri/custom-protocol", "ok"],
    ["cargo build --release -p amos-tauri --features custom-protocol,tcp", "ok"],
    ["cargo build --release --manifest-path crates/amos-tauri/Cargo.toml", "missing-feature"],
    // The CLI adds the feature itself.
    ["cd crates/amos-tauri && cargo tauri build --bundles app", "tauri-cli"],
    // Debug builds are the Vite-dev-server path on purpose.
    ["cargo build -p amos-tauri", "out-of-scope"],
    // Other crates, and non-building cargo verbs, are not this scan's business.
    ["cargo build --release -p amos-ai", "out-of-scope"],
    ["cargo test --release -p amos-tauri --lib", "out-of-scope"],
    ["cargo check -p amos-tauri --features custom-protocol", "out-of-scope"],
  ];
  let failed = 0;
  for (const [line, want] of cases) {
    const got = classifyCargoLine(line).kind;
    if (got !== want) {
      failed++;
      console.error(`  ✗ ${line}\n      expected ${want}, got ${got}`);
    }
  }
  if (!manifestDeclaresFeature(`[features]\ncustom-protocol = ["tauri/custom-protocol"]\n`)) {
    failed++;
    console.error("  ✗ a declared feature was not recognized");
  }
  if (manifestDeclaresFeature(`[features]\n# custom-protocol = ["tauri/custom-protocol"]\n`)) {
    failed++;
    console.error("  ✗ a commented-out feature satisfied the manifest rule");
  }
  if (manifestDeclaresFeature(`[features]\ncustom-protocol = []\n`)) {
    failed++;
    console.error("  ✗ a feature that enables nothing satisfied the manifest rule");
  }
  if (failed) {
    console.error(`release-ui-mode-scan selftest: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log(`release-ui-mode-scan selftest: OK (${cases.length} classifications pinned)`);
}

// --- main -------------------------------------------------------------------
const args = new Set(process.argv.slice(2));
if (args.has("--selftest")) {
  selftest();
} else {
  const readFile = (p) => readFileSync(p, "utf8");
  const issues = findings(readFile);
  if (args.has("--json")) {
    console.log(JSON.stringify({ issues }, null, 2));
  } else if (issues.length === 0) {
    console.log(
      `release-ui-mode-scan: OK — \`${FEATURE}\` is declared and every release amos-tauri build asks for it`,
    );
  } else {
    for (const i of issues) {
      console.error(`✗ ${i.file}${i.line ? `:${i.line}` : ""} — ${i.detail}`);
      if (i.command) console.error(`      ${i.command}`);
    }
    console.error(
      `release-ui-mode-scan: ${issues.length} defect(s). A release UI build without ` +
        `\`${FEATURE}\` renders a blank window (nothing serves build.devUrl) while every ` +
        `other gate stays green.`,
    );
    process.exit(1);
  }
}
