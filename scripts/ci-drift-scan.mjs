#!/usr/bin/env node
/**
 * ci-drift-scan.mjs — "the CI config may not float, and it may not hold a second
 * copy of a pin".
 *
 * Why: `docs/ci-engineering.md` records that the recurring red on
 * `lint-and-test` / `gated-native-backends` was **environment drift**, not a logic
 * bug — and the fix (pin `ubuntu-24.04`, pin the NDK, pin `cargo-ndk`) was applied
 * by hand, in several files, with nothing stopping it from drifting back. Two
 * classes survived that pass, and both are *exactly* the recorded failure shape:
 *
 *   1. **A floating runner image.** `runs-on: ubuntu-latest` / `macos-latest` moves
 *      underneath us (22.04 → 24.04 removed `libappindicator3-dev`, which broke the
 *      Tauri jobs *silently*). A workflow that pins 24.04 in one job and floats in
 *      another has not fixed drift, it has postponed it — `license.yml` /
 *      `stale.yml` did exactly that.
 *
 *   2. **A floating / duplicated Rust toolchain.** `rustfmt` and `clippy` change
 *      between Rust releases, so two machines on "stable" (a maintainer's Mac on
 *      the version they installed last month, a runner that fetched today's) can
 *      disagree about `cargo fmt --check` and about which lints exist — the
 *      "make lint's fmt check was failing" commits in this repository's history.
 *      `dtolnay/rust-toolchain@stable` *also* overrides `rust-toolchain.toml`, so
 *      CI and the local machine were **guaranteed** to be different toolchains.
 *      The rule here: `rust-toolchain.toml` is the single source, every job reads
 *      it, and the container image mirrors it (checked for equality).
 *
 * What it checks (all offline, no YAML dependency — line-based on purpose, the
 * same discipline as the rest of `scripts/*.mjs`):
 *   R1  `rust-toolchain.toml` pins a concrete `channel = "X.Y.Z"` (not
 *       `stable`/`beta`/`nightly`, which float).
 *   R2  no workflow/action job may use a floating runner label (`*-latest`), and a
 *       `runs-on: ${{ matrix.runner }}` must have every `- runner:` entry pinned.
 *   R3  every `dtolnay/rust-toolchain@…` use must be `@master` **and** take its
 *       `toolchain:` from a step that reads `rust-toolchain.toml` (so there is one
 *       source, not two).
 *   R4  `ARG RUST_CHANNEL=` in the container Dockerfile must equal R1's channel and
 *       must actually be used (the image is the *mirror* of the pin, not a
 *       replacement).
 *
 * Suppressions live in `scripts/ci-drift-allowlist.json` and each one needs a
 * non-empty `reason`; an entry that stops matching anything is reported as stale
 * (a suppression that outlives its cause hides the next regression).
 *
 * Usage (from the repo root):
 *   node scripts/ci-drift-scan.mjs              # gate (non-zero on drift)
 *   node scripts/ci-drift-scan.mjs --json
 *   node scripts/ci-drift-scan.mjs --selftest   # pin the rules, incl. must-fails
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(root, ".github", "workflows");
const ACTION_DIR = join(root, ".github", "actions");
const DOCKERFILE = join(root, ".github", "docker", "ci-android", "Dockerfile");
const TOOLCHAIN_FILE = join(root, "rust-toolchain.toml");

/** A concrete `channel = "1.98.0"` (a floating channel is reported by R1). */
export function parseToolchainChannel(text) {
  const m = /^\s*channel\s*=\s*"([^"]*)"/m.exec(text);
  return m ? m[1] : null;
}

/** `1.98.0` is a pin; `stable`, `beta`, `nightly`, `nightly-2025-01-01` float. */
export function isPinnedChannel(channel) {
  return typeof channel === "string" && /^\d+\.\d+\.\d+$/.test(channel);
}

const FLOATING_RUNNER = /^[a-z0-9._-]+-latest$/;

/**
 * Runner labels a YAML text declares. Both shapes matter: a literal
 * `runs-on:` and the matrix legs (`- runner: <label>`) the release workflow uses.
 */
export function runnerLabels(text) {
  const out = [];
  for (const m of text.matchAll(/^(\s*)runs-on:\s*(.+?)\s*$/gm)) {
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!value.startsWith("${{")) out.push({ line: lineOf(text, m.index), label: value });
  }
  for (const m of text.matchAll(/^(\s*)-\s*runner:\s*(.+?)\s*$/gm)) {
    out.push({ line: lineOf(text, m.index), label: m[2].replace(/^["']|["']$/g, "") });
  }
  return out;
}

/** Every `uses: dtolnay/rust-toolchain@<rev>` with its `with:` block text. */
export function rustToolchainUses(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-?\s*uses:\s*(dtolnay\/rust-toolchain@\S+)\s*$/.exec(lines[i]);
    if (!m) continue;
    const [action, rev] = m[1].split("@");
    // The step's own keys are the following lines **at the same or deeper indent**
    // (`uses:` and `with:` are siblings in GitHub's YAML — assuming "deeper only"
    // made every real workflow look like it had no `toolchain:` input). The block
    // ends at a new list item (`- …`) at the step's indent or any shallower line.
    const indent = lines[i].search(/\S/);
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") continue;
      const ind = l.search(/\S/);
      if (ind < indent) break;
      if (ind === indent && /^\s*-\s/.test(l)) break;
      block.push(l);
    }
    out.push({ line: i + 1, action, rev, block: block.join("\n") });
  }
  return out;
}

/** Does the file's toolchain source come from `rust-toolchain.toml` (R3's second half)? */
export function readsToolchainFile(text) {
  return /rust-toolchain\.toml/.test(text);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * The drift rules over already-read texts (pure — the selftest drives this directly).
 *
 * `files` is `[{ path, text }]` (workflows + composite actions), `dockerfile` and
 * `toolchain` are raw texts. Returns the findings; allow-list entries that carry no
 * `reason` and entries that match nothing (stale) are findings of their own.
 */
export function scan({ files, dockerfile, toolchain, allow = [] }) {
  const findings = [];
  const candidates = [];
  const add = (rule, file, line, detail) => candidates.push({ rule, file, line, detail });

  // R1 — the pin is concrete.
  const channel = parseToolchainChannel(toolchain);
  if (channel === null) {
    add("toolchain-unpinned", "rust-toolchain.toml", 1, 'no `channel = "…"` line');
  } else if (!isPinnedChannel(channel)) {
    add(
      "toolchain-unpinned",
      "rust-toolchain.toml",
      1,
      `channel = "${channel}" floats (rustfmt/clippy move between releases) — pin X.Y.Z`,
    );
  }

  for (const { path, text } of files) {
    // R2 — no floating runner.
    for (const { line, label } of runnerLabels(text)) {
      if (FLOATING_RUNNER.test(label)) {
        add("floating-runner", path, line, `runs-on: ${label} (pin the major, e.g. ubuntu-24.04)`);
      }
    }
    // R3 — one toolchain source.
    for (const use of rustToolchainUses(text)) {
      if (use.rev !== "master") {
        add(
          "toolchain-second-source",
          path,
          use.line,
          `${use.action}@${use.rev} — use @master plus a toolchain: input fed from the pin step so rust-toolchain.toml stays the only source`,
        );
        continue;
      }
      const toolchainInput = /toolchain:\s*(.+?)\s*$/m.exec(use.block)?.[1] ?? "";
      if (!/steps\.[A-Za-z0-9_.-]+\.outputs\.channel/.test(toolchainInput)) {
        add(
          "toolchain-second-source",
          path,
          use.line,
          `dtolnay/rust-toolchain@master without a pinned toolchain: input (got ${toolchainInput || "none"}; it must read the channel produced from rust-toolchain.toml)`,
        );
      } else if (!readsToolchainFile(text)) {
        add(
          "toolchain-second-source",
          path,
          use.line,
          "toolchain: is fed from a step output but this file never reads rust-toolchain.toml",
        );
      }
    }
  }

  // R4 — the image mirrors the pin (and actually uses it).
  const dockerChannel = /^\s*ARG\s+RUST_CHANNEL=(\S+)/m.exec(dockerfile)?.[1] ?? null;
  if (dockerChannel === null) {
    add("image-channel-missing", ".github/docker/ci-android/Dockerfile", 1, "no `ARG RUST_CHANNEL=`");
  } else if (channel !== null && dockerChannel !== channel) {
    add(
      "image-channel-mismatch",
      ".github/docker/ci-android/Dockerfile",
      lineOf(dockerfile, dockerfile.search(/ARG\s+RUST_CHANNEL=/)),
      `RUST_CHANNEL=${dockerChannel} but rust-toolchain.toml pins ${channel} — the image must mirror the pin`,
    );
  } else if (!/--default-toolchain\s+"?\$\{?RUST_CHANNEL/.test(dockerfile)) {
    add(
      "image-channel-unused",
      ".github/docker/ci-android/Dockerfile",
      1,
      "RUST_CHANNEL is declared but never passed to rustup",
    );
  }

  // Suppressions: each needs a reason; an unused one is stale (it would hide the
  // next regression of the same class while looking like a deliberate decision).
  const used = new Set();
  for (const a of allow) {
    const key = `${a.file}|${a.rule}|${a.match ?? ""}`;
    if (!a.reason || String(a.reason).trim() === "") {
      findings.push({
        rule: "allowlist-no-reason",
        file: "scripts/ci-drift-allowlist.json",
        line: 1,
        detail: `${a.file} / ${a.rule} is suppressed without a reason`,
      });
      continue;
    }
    const hit = candidates.some(
      (c) =>
        c.file === a.file &&
        c.rule === a.rule &&
        (a.match === undefined || c.detail.includes(a.match)),
    );
    if (hit) used.add(key);
    else {
      findings.push({
        rule: "allowlist-stale",
        file: "scripts/ci-drift-allowlist.json",
        line: 1,
        detail: `${a.file} / ${a.rule} no longer matches anything — delete the suppression`,
      });
    }
  }
  for (const c of candidates) {
    const hit = allow.some(
      (a) =>
        a.file === c.file &&
        a.rule === c.rule &&
        a.reason &&
        (a.match === undefined || c.detail.includes(a.match)),
    );
    if (!hit) findings.push(c);
  }
  return findings;
}


// --- inputs ------------------------------------------------------------------

function relativeToRoot(p) {
  return p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
}

/** Every workflow + every composite action, as `{ path, text }`. */
function ciFiles() {
  const out = [];
  const push = (p) => out.push({ path: relativeToRoot(p), text: readFileSync(p, "utf8") });
  if (existsSync(WORKFLOW_DIR)) {
    for (const name of readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n))) {
      push(join(WORKFLOW_DIR, name));
    }
  }
  if (existsSync(ACTION_DIR)) {
    for (const dir of readdirSync(ACTION_DIR)) {
      const p = join(ACTION_DIR, dir, "action.yml");
      if (existsSync(p)) push(p);
    }
  }
  return out;
}

function allowList() {
  const p = join(root, "scripts", "ci-drift-allowlist.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(raw.entries) ? raw.entries : [];
}

// --- main --------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const findings = scan({
  files: ciFiles(),
  dockerfile: readFileSync(DOCKERFILE, "utf8"),
  toolchain: readFileSync(TOOLCHAIN_FILE, "utf8"),
  allow: allowList(),
});

if (args.includes("--json")) {
  console.log(JSON.stringify(findings, null, 2));
  process.exit(findings.length === 0 ? 0 : 1);
}
if (findings.length > 0) {
  console.log(
    `[ci-drift-scan] FAIL — ${findings.length} CI-config drift finding(s); a floating toolchain/runner is the recorded cause of this repo's recurring red:`,
  );
  for (const f of findings) console.log(`  ${f.file}:${f.line} [${f.rule}] ${f.detail}`);
  console.log(
    "  Fix: pin it (see docs/ci-engineering.md), or excuse it in scripts/ci-drift-allowlist.json with a reason.",
  );
  process.exit(1);
}
console.log(
  "[ci-drift-scan] OK — every CI job pins its runner, and every Rust toolchain comes from rust-toolchain.toml (the image mirrors it).",
);

// --- selftest (hoisted; `--selftest` above uses it) --------------------------

/** 20+ rule cases, **including must-fail ones** — a gate that cannot fail is not a gate. */
function runSelfTest() {
  const cases = [];
  const check = (name, ok) => cases.push([name, ok]);
  const findingsFor = (files, dockerfile, toolchain) =>
    scan({ files, dockerfile, toolchain, allow: [] });
  const wf = (text) => [{ path: ".github/workflows/x.yml", text }];

  const PIN = `[toolchain]\nchannel = "1.98.0"\ncomponents = ["rustfmt", "clippy"]\n`;
  const DOCKER = `ARG RUST_CHANNEL=1.98.0\nRUN rustup-init -y --default-toolchain "\${RUST_CHANNEL}"\n`;
  const PIN_STEP = `      - name: Read the pinned toolchain (source: rust-toolchain.toml)\n        id: rust-pin\n        run: |\n          channel="$(sed -n 's/^channel *= *"\\(.*\\)"/\\1/p' rust-toolchain.toml)"\n          echo "channel=$channel" >> "$GITHUB_OUTPUT"\n`;
  const USE_FROM_PIN = `      - uses: dtolnay/rust-toolchain@master\n        with:\n          toolchain: \${{ steps.rust-pin.outputs.channel }}\n          components: rustfmt, clippy\n`;

  // R1 — the pin itself.
  check("R1 a concrete channel parses", parseToolchainChannel(PIN) === "1.98.0");
  check("R1 x.y.z is a pin", isPinnedChannel("1.98.0"));
  check("R1 stable is not a pin", !isPinnedChannel("stable"));
  check("R1 a nightly date is not a pin", !isPinnedChannel("nightly-2025-01-01"));
  check(
    "R1 a floating channel is a finding",
    findingsFor([], DOCKER, '[toolchain]\nchannel = "stable"\n').some(
      (f) => f.rule === "toolchain-unpinned",
    ),
  );
  check(
    "R1 a missing channel line is a finding",
    findingsFor([], DOCKER, "[toolchain]\n").some((f) => f.rule === "toolchain-unpinned"),
  );

  // R2 — runners (must-fail first).
  check(
    "R2 ubuntu-latest is a finding",
    findingsFor(wf("jobs:\n  a:\n    runs-on: ubuntu-latest\n"), DOCKER, PIN).some(
      (f) => f.rule === "floating-runner",
    ),
  );
  check(
    "R2 macos-latest is a finding",
    findingsFor(wf("jobs:\n  a:\n    runs-on: macos-latest\n"), DOCKER, PIN).some(
      (f) => f.rule === "floating-runner",
    ),
  );
  check(
    "R2 a floating matrix leg is a finding",
    findingsFor(
      wf(
        "jobs:\n  a:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - runner: ubuntu-24.04\n          - runner: macos-latest\n",
      ),
      DOCKER,
      PIN,
    ).some((f) => f.rule === "floating-runner"),
  );
  check(
    "R2 both runner shapes are seen",
    runnerLabels("    runs-on: ubuntu-24.04\n          - runner: macos-14\n").length === 2,
  );
  check(
    "R2 pinned literal runners are clean",
    findingsFor(wf("jobs:\n  a:\n    runs-on: ubuntu-24.04\n"), DOCKER, PIN).length === 0,
  );
  check(
    "R2 a pinned matrix is clean",
    findingsFor(
      wf(
        "jobs:\n  a:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - runner: ubuntu-24.04\n          - runner: macos-14\n",
      ),
      DOCKER,
      PIN,
    ).length === 0,
  );

  // R3 — one toolchain source (must-fail first).
  check(
    "R3 @stable is a finding",
    findingsFor(wf("jobs:\n  a:\n    steps:\n      - uses: dtolnay/rust-toolchain@stable\n"), DOCKER, PIN).some(
      (f) => f.rule === "toolchain-second-source",
    ),
  );
  check(
    "R3 a hard-coded version rev is a finding (second source of truth)",
    findingsFor(wf("jobs:\n  a:\n    steps:\n      - uses: dtolnay/rust-toolchain@1.98.0\n"), DOCKER, PIN).some(
      (f) => f.rule === "toolchain-second-source",
    ),
  );
  check(
    "R3 @master with a literal toolchain: is a finding",
    findingsFor(
      wf(`jobs:\n  a:\n    steps:\n${PIN_STEP}${USE_FROM_PIN.replace("${{ steps.rust-pin.outputs.channel }}", "stable")}`),
      DOCKER,
      PIN,
    ).some((f) => f.rule === "toolchain-second-source"),
  );
  check(
    "R3 a pin feed with no toolchain file read is a finding",
    findingsFor(wf(`jobs:\n  a:\n    steps:\n${USE_FROM_PIN}`), DOCKER, PIN).some(
      (f) => f.rule === "toolchain-second-source",
    ),
  );
  check(
    "R3 @master fed from the pin step is clean",
    findingsFor(wf(`jobs:\n  a:\n    steps:\n${PIN_STEP}\n${USE_FROM_PIN}`), DOCKER, PIN).length === 0,
  );
  check(
    "R3 the with: block is only the use's own block",
    rustToolchainUses(
      "      - uses: dtolnay/rust-toolchain@master\n        with:\n          toolchain: x\n      - name: next\n        run: echo\n",
    )[0].block.includes("toolchain: x") &&
      !rustToolchainUses(
        "      - uses: dtolnay/rust-toolchain@master\n        with:\n          toolchain: x\n      - name: next\n        run: echo\n",
      )[0].block.includes("next"),
  );

  // R4 — the image mirrors the pin.
  check(
    "R4 a mismatched Dockerfile channel is a finding",
    findingsFor(
      [],
      'ARG RUST_CHANNEL=1.90.0\nRUN rustup-init -y --default-toolchain "${RUST_CHANNEL}"\n',
      PIN,
    ).some((f) => f.rule === "image-channel-mismatch"),
  );
  check(
    "R4 a declared-but-unused channel is a finding",
    findingsFor([], "ARG RUST_CHANNEL=1.98.0\nRUN rustup-init -y\n", PIN).some(
      (f) => f.rule === "image-channel-unused",
    ),
  );
  check("R4 a matching mirror is clean", findingsFor([], DOCKER, PIN).length === 0);

  // Suppressions: a reason is mandatory, and a stale entry is a finding too.
  const floating = wf("jobs:\n  a:\n    runs-on: ubuntu-latest\n");
  check(
    "a suppression without a reason is a finding",
    scan({
      files: floating,
      dockerfile: DOCKER,
      toolchain: PIN,
      allow: [{ file: ".github/workflows/x.yml", rule: "floating-runner" }],
    }).some((f) => f.rule === "allowlist-no-reason"),
  );
  check(
    "a suppression with a reason suppresses",
    scan({
      files: floating,
      dockerfile: DOCKER,
      toolchain: PIN,
      allow: [
        { file: ".github/workflows/x.yml", rule: "floating-runner", reason: "upstream-owned" },
      ],
    }).length === 0,
  );
  check(
    "a stale suppression is a finding",
    scan({
      files: [],
      dockerfile: DOCKER,
      toolchain: PIN,
      allow: [{ file: ".github/workflows/x.yml", rule: "floating-runner", reason: "gone" }],
    }).some((f) => f.rule === "allowlist-stale"),
  );

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  const mustFail = cases.filter(([, ok]) => !ok).length;
  if (failed > 0) {
    console.log(`[ci-drift-scan] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  if (mustFail !== 0) process.exit(1); // unreachable; keeps the intent explicit
  console.log(`[ci-drift-scan] selftest OK — ${cases.length} rule case(s), incl. must-fail ones.`);
}

