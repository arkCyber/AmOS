#!/usr/bin/env node
/**
 * crate-readme-scan.mjs — "a crate without a standard README (or an examples/ dir that
 * disagrees with it)".
 *
 * Why: the repo documents the *system* (root README + docs/*.md) but every crate was
 * undocumented at its own door — 43 of 43 had no README.md, so the only way to learn
 * what `amos-power` is was to read its `Cargo.toml` description and its source. Doc
 * claims rot silently, so this is a **gate**, not a convention:
 *
 *   • every workspace member has a `README.md`;
 *   • the title names the crate, and the README links back to the root README;
 *   • it carries the six standard sections (what / layout / build & test / examples /
 *     honest boundaries / related);
 *   • it names its own test command (`-p <crate>`), so a reader never guesses;
 *   • its `examples/` directory and the README **agree**: every example file is named
 *     in the README, and every `--example <name>` in the README exists;
 *   • a crate with no `examples/` says why in
 *     `scripts/crate-readme-allowlist.json` (an exemption needs a reason, and a
 *     reason that stops applying is reported `[stale]` so the list cannot rot).
 *
 * Deliberately out of scope: prose quality, section *order* beyond presence, and the
 * content of `docs/*.md` (the link checker owns those paths).
 *
 * Usage (repo root):
 *   node scripts/crate-readme-scan.mjs             # gate (exit 1 on any defect)
 *   node scripts/crate-readme-scan.mjs --json      # machine-readable
 *   node scripts/crate-readme-scan.mjs --selftest  # pin the parsers/classifier
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(root, "scripts", "crate-readme-allowlist.json");

/** The sections every crate README must carry (prose is free, headings are not). */
export const REQUIRED_SECTIONS = [
  "## What it is",
  "## Layout",
  "## Build & test",
  "## Examples",
  "## Honest boundaries",
  "## Related",
];

/** The `members = [ … ]` list of the workspace manifest (same parse as rust-panic-scan). */
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

/** The crate name a README's H1 claims (`# amos-x — …`), or null. */
export function titleCrate(readme) {
  const line = readme.split("\n").find((l) => l.startsWith("# "));
  if (!line) return null;
  const m = line.match(/^#\s+([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** The sections present in a README, in file order. */
export function headings(readme) {
  return readme
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.trimEnd());
}

/** Example names the README promises (`--example x` or `examples/x.rs`). */
///
/// Counted **everywhere**, including inside the shell blocks a README uses to show the
/// command: a `cargo run --example foo` line *is* the promise, whether or not it is
/// fenced. What this deliberately does not do is guess at prose (there is no attempt to
/// classify a sentence as "about" an example).
export function promisedExamples(readme) {
  const out = new Set();
  for (const m of readme.matchAll(/--example\s+([A-Za-z0-9_-]+)/g)) out.add(m[1]);
  for (const m of readme.matchAll(/examples\/([A-Za-z0-9_-]+)\.rs/g)) out.add(m[1]);
  return [...out].sort();
}

/** Every `.rs` file in one `examples/` directory, by stem. */
export function exampleFiles(dir) {
  const examples = join(dir, "examples");
  if (!existsSync(examples)) return [];
  return readdirSync(examples)
    .filter((f) => f.endsWith(".rs"))
    .map((f) => f.replace(/\.rs$/, ""))
    .sort();
}

export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

// --- scan -------------------------------------------------------------------
export function scan({ members, read, exists, listExamples, allow }) {
  const findings = [];
  const stale = [];
  for (const member of members) {
    const crate = member.split("/").pop();
    const dir = join(root, member);
    const readmePath = join(dir, "README.md");
    if (!exists(readmePath)) {
      findings.push({ crate, kind: "missing-readme" });
      continue;
    }
    const readme = read(readmePath);
    const title = titleCrate(readme);
    if (title !== crate) {
      findings.push({
        crate,
        kind: "title",
        detail: `H1 must name the crate (\`# ${crate} — …\`), got \`${title}\``,
      });
    }
    if (!readme.includes("../../README.md")) {
      findings.push({ crate, kind: "no-root-link", detail: "no link back to ../../README.md" });
    }
    if (!readme.includes(`-p ${crate}`)) {
      findings.push({
        crate,
        kind: "no-own-command",
        detail: `never names \`-p ${crate}\` (the reader's own test/run command)`,
      });
    }
    const has = new Set(headings(readme));
    for (const section of REQUIRED_SECTIONS) {
      if (!has.has(section)) {
        findings.push({ crate, kind: "missing-section", detail: section });
      }
    }

    const files = listExamples(dir);
    const promised = promisedExamples(readme);
    if (files.length === 0) {
      if (allow.no_examples?.[crate] === undefined) {
        findings.push({
          crate,
          kind: "no-examples-without-reason",
          detail: "no examples/ directory and no reason in crate-readme-allowlist.json",
        });
      }
      // A promise for an example in a crate that ships none is still a defect.
      for (const name of promised) {
        findings.push({
          crate,
          kind: "phantom-example",
          detail: `README promises --example ${name}, which does not exist`,
        });
      }
    } else {
      if (allow.no_examples?.[crate] !== undefined) {
        stale.push({ crate, kind: "no_examples", detail: "crate now ships examples/" });
      }
      for (const file of files) {
        if (!promised.includes(file)) {
          findings.push({
            crate,
            kind: "undocumented-example",
            detail: `examples/${file}.rs is not named in the README`,
          });
        }
      }
      for (const name of promised) {
        if (!files.includes(name)) {
          findings.push({
            crate,
            kind: "phantom-example",
            detail: `README promises --example ${name}, which does not exist`,
          });
        }
      }
    }
  }
  return { findings, stale };
}

// --- main -------------------------------------------------------------------
function runSelfTest() {
  const cases = [];
  const members = workspaceMembers('members = [\n  "crates/a",\n  "crates/b",\n]');
  cases.push(["members", members.length === 2 && members[1] === "crates/b"]);
  cases.push(["title", titleCrate("# amos-a — x\n") === "amos-a"]);
  cases.push(["title missing", titleCrate("## not a title\n") === null]);
  cases.push(["headings", headings("# t\n## What it is\n## Layout\n").includes("## Layout")]);
  cases.push([
    "promised examples",
    promisedExamples("cargo run --example one\nsee examples/two.rs\n").join() === "one,two",
  ]);
  cases.push([
    "example inside a shell block is a promise",
    promisedExamples("```bash\ncargo run --example one\n```\n").join() === "one",
  ]);
  cases.push(["no example promise", promisedExamples("plain prose").length === 0]);

  const readme = (crate, extra = "") => `# ${crate} — thing

See [Amos](../../README.md).

## What it is
x
## Layout
x
## Build & test
\`\`\`bash
cargo test -p ${crate}
\`\`\`
## Examples
x
## Honest boundaries
x
## Related
x
${extra}`;

  // The README above names no example, so `one` is undocumented.
  const clean = scan({
    members: ["crates/a"],
    read: () => readme("a"),
    exists: () => true,
    listExamples: () => ["one"],
    allow: { no_examples: {} },
  });
  cases.push([
    "undocumented example found",
    clean.findings.length === 1 && clean.findings[0].kind === "undocumented-example",
  ]);

  const good = scan({
    members: ["crates/a"],
    read: () => readme("a", "\ncargo run -p a --example one\n"),
    exists: () => true,
    listExamples: () => ["one"],
    allow: { no_examples: {} },
  });
  cases.push(["clean member passes", good.findings.length === 0]);

  const phantom = scan({
    members: ["crates/a"],
    read: () => readme("a", "\ncargo run -p a --example ghost\n"),
    exists: () => true,
    listExamples: () => ["one"],
    allow: { no_examples: {} },
  });
  cases.push([
    "phantom example found",
    phantom.findings.some((f) => f.kind === "phantom-example"),
  ]);

  const missing = scan({
    members: ["crates/a"],
    read: () => "",
    exists: () => false,
    listExamples: () => [],
    allow: { no_examples: {} },
  });
  cases.push([
    "missing readme found",
    missing.findings.length === 1 && missing.findings[0].kind === "missing-readme",
  ]);

  const wrongTitle = scan({
    members: ["crates/a"],
    read: () => readme("b"),
    exists: () => true,
    listExamples: () => ["one"],
    allow: { no_examples: {} },
  });
  cases.push(["wrong title found", wrongTitle.findings.some((f) => f.kind === "title")]);

  const exempt = scan({
    members: ["crates/a"],
    read: () => readme("a"),
    exists: () => true,
    listExamples: () => [],
    allow: { no_examples: { a: "reason" } },
  });
  cases.push(["exempt crate passes", exempt.findings.length === 0]);

  const staleReason = scan({
    members: ["crates/a"],
    read: () => readme("a", "\ncargo run -p a --example one\n"),
    exists: () => true,
    listExamples: () => ["one"],
    allow: { no_examples: { a: "reason" } },
  });
  cases.push(["stale reason reported", staleReason.stale.length === 1]);

  let failed = 0;
  for (const [name, ok] of cases) {
    if (!ok) {
      console.error(`  ✗ ${name}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`[crate-readme-scan] selftest: ${failed} of ${cases.length} failed`);
    process.exit(1);
  }
  console.log(`[crate-readme-scan] selftest: ${cases.length} assertion(s), 0 failure(s).`);
}

function runGate() {
  const members = workspaceMembers(readFileSync(join(root, "Cargo.toml"), "utf8"));
  if (members.length === 0) {
    console.error("[crate-readme-scan] could not read the workspace members from Cargo.toml");
    process.exit(1);
  }
  let allow = { no_examples: {} };
  if (existsSync(ALLOWLIST)) {
    allow = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  }
  const { findings, stale } = scan({
    members,
    read: (p) => readFileSync(p, "utf8"),
    exists: (p) => existsSync(p),
    listExamples: (dir) => exampleFiles(dir),
    allow,
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ members: members.length, findings, stale }, null, 2));
  }
  for (const s of stale) {
    console.log(
      `[crate-readme-scan] STALE — ${s.crate}: the \`no_examples\` reason no longer applies (${s.detail}); remove it.`,
    );
  }
  if (findings.length > 0) {
    console.error(
      `[crate-readme-scan] FAIL — ${findings.length} crate-doc defect(s); a reader cannot learn these crates from their own directory:`,
    );
    for (const f of findings) {
      const detail = f.detail ? `: ${f.detail}` : "";
      console.error(`  ${f.kind}: ${f.crate}${detail}`);
    }
    console.error(
      "  Fix: write crates/<name>/README.md in the standard shape (this script's header documents it),\n" +
        "       or record why a crate cannot ship examples/ in scripts/crate-readme-allowlist.json.",
    );
    process.exit(1);
  }
  if (stale.length > 0) process.exit(1);
  console.log(
    `[crate-readme-scan] OK — all ${members.length} workspace member(s) ship a standard README.md, and every examples/ dir agrees with it.`,
  );
}

if (invokedDirectly(import.meta.url, process.argv[1]) && process.argv.includes("--selftest")) {
  runSelfTest();
} else if (invokedDirectly(import.meta.url, process.argv[1])) {
  runGate();
}
