#!/usr/bin/env node
/**
 * gate-index-scan.mjs — "the instruments this repository runs, and what each one answers".
 *
 * Why (REQ-A483): the *wiring* of the executable layer is already gated — `unwired-script-scan.mjs`
 * proves every script is reachable from the Makefile / CI / another reachable script — but nothing
 * said **what the set of instruments is**. That knowledge lived in ~600 lines of `Makefile`
 * comments, so the only way to learn it was to read the whole build or to re-derive a gate from
 * scratch. Two consecutive rounds of this session did exactly that:
 *
 *   * REQ-A480 added a Rust **module-level orphan** pass — the frontend had had the equivalent
 *     (`frontend-ts/scripts/unwired-scan.mjs`: module reachability + unmounted components) all along;
 *   * REQ-A483 began with a hand-written sweep for "a `#[tauri::command]` no screen calls" —
 *     `tauri-command-scan.mjs` already answered exactly that, with an allowlist and stale checks.
 *
 * Both were found by *doing the work twice*. That is the defect this file closes: `docs/GATES.md` is
 * the index, and this scan fails when the index and the tree disagree in either direction.
 *
 * Checks:
 *   R1 `undocumented` — a script under `scripts/` or `frontend-ts/scripts/` with no row in the index
 *                       (a new instrument nobody can find);
 *   R2 `phantom`      — an index row naming a script that does not exist;
 *   R3 `no-selftest`  — a row that claims a `--selftest` the script does not have (a claimed selftest
 *                       is a promise; the index must not invent it).
 *
 * `--emit` drafts rows from the scripts' own headers, so the "question" column quotes the instrument
 * instead of paraphrasing it; `--selftest` pins the parsers with fixtures.
 *
 * Usage (repo root):
 *   node scripts/gate-index-scan.mjs              # gate
 *   node scripts/gate-index-scan.mjs --emit       # draft rows from the scripts' headers
 *   node scripts/gate-index-scan.mjs --selftest   # pin the parsers
 *   node scripts/gate-index-scan.mjs --json
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const INDEX = join(ROOT, "docs", "GATES.md");

/**
 * The corpus — **the same one `unwired-script-scan.mjs` protects**, on purpose: that gate asks "is
 * this script wired?" and this one asks "is it in the index?", and a script that passes one and
 * fails the other is a reader's trap. (Its own corpus is `shippedScripts()`; it runs its scan on
 * import, so the rule is mirrored here verbatim instead of imported — `scripts/*.{sh,mjs,js,cjs}`,
 * the repository root `*.sh`, and the frontend's `scripts/*.{sh,mjs,js,cjs}`.)
 */
const SCRIPT_EXTS = /\.(sh|mjs|js|cjs)$/;

/** Every script the repository ships, as `dir/name.ext`. */
export function scriptInventory(root = ROOT) {
  const out = [];
  const push = (dir, name) => out.push(dir ? `${dir}/${name}` : name);
  const scriptsDir = join(root, "scripts");
  if (existsSync(scriptsDir)) {
    for (const e of readdirSync(scriptsDir)) if (SCRIPT_EXTS.test(e)) push("scripts", e);
  }
  for (const e of readdirSync(root)) {
    if (e.endsWith(".sh") && existsSync(join(root, e)) && !readdirSync(root).includes(e + "/")) push("", e);
  }
  const feDir = join(root, "crates", "amos-tauri", "frontend-ts", "scripts");
  if (existsSync(feDir)) {
    for (const e of readdirSync(feDir)) if (SCRIPT_EXTS.test(e)) {
      push("crates/amos-tauri/frontend-ts/scripts", e);
    }
  }
  return out.sort();
}

/** The first sentence of a script's header comment — the instrument's own words. */
export function headerQuestion(text) {
  const lines = text.split("\n").slice(0, 40);
  for (const line of lines) {
    const raw = line.trim();
    if (raw.startsWith("#!")) continue; // a shebang, not prose
    const m = line.match(/^\s*(?:\/\*\*|\*|\/\/|#)\s*(\S.*)$/);
    if (!m) continue;
    const body = m[1].trim();
    if (!body || body.startsWith("*/") || body.startsWith("@")) continue;
    if (/\.(mjs|sh|js|cjs)/.test(body) && /—/.test(body)) return body.split("—").slice(1).join("—").trim();
    return body;
  }
  return "(no header)";
}

/**
 * Does the script expose a selftest? **Both spellings are in use in this repository** (`--selftest`
 * in most scanners, `--self-test` in `fmea-gen.mjs`, `hot-loop-scan.mjs`, `rust-macro-scan.mjs`,
 * `rust-discard-scan.mjs`, `env-doc-gen.mjs`), and the index claims one or the other — so a detector
 * that knew only the first spelling would print `—` for a script that has a selftest, which is a
 * wrong claim in the table (the safe direction, but still wrong).
 */
export function hasSelftest(text) {
  return /--self-?test/.test(text);
}

/**
 * Rows of `docs/GATES.md`: `| \`name.mjs\` | … |` — the first cell is the script's basename, and the
 * row records whether it claims a `--selftest` (R3 needs the claim, not the whole table). Other
 * tables in the document are ignored because their first cell does not end in `.mjs`.
 */
export function indexRows(docText) {
  const rows = [];
  for (const line of docText.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const m = cells[1]?.match(/^`([A-Za-z0-9._-]+\.(mjs|sh|js|cjs))`$/);
    if (!m) continue;
    rows.push({ name: m[1], claimsSelftest: cells.slice(2).some((c) => /^yes$/i.test(c)) });
  }
  return rows;
}

/** R1/R2/R3 over the inventory and the index. */
export function indexProblems(inventory, rows, { selftests = new Map() } = {}) {
  const problems = [];
  const named = new Set(rows.map((r) => r.name));
  const byBase = new Map(inventory.map((p) => [p.split("/").pop(), p]));
  for (const path of inventory) {
    const base = path.split("/").pop();
    if (!named.has(base)) problems.push({ rule: "undocumented", detail: base });
  }
  for (const row of rows) {
    if (!byBase.has(row.name)) {
      problems.push({ rule: "phantom", detail: row.name });
      continue;
    }
    // R3 only fires on a *claim*: a row that says `yes` for a script with no `--selftest` is
    // inventing a promise the instrument cannot keep.
    if (row.claimsSelftest && selftests.get(row.name) === false) {
      problems.push({ rule: "no-selftest", detail: row.name });
    }
  }
  return problems;
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const inv = ["scripts/a-scan.mjs", "scripts/helper.mjs", "crates/x/scripts/b-scan.mjs"];
  ok(
    "headerQuestion takes the instrument's own words",
    headerQuestion('/**\n * x-scan.mjs — "the thing is wrong".\n *\n * more\n */') === '"the thing is wrong".',
  );
  ok("headerQuestion survives a header with no em dash", headerQuestion("/**\n * just words\n */") === "just words");
  ok("headerQuestion reports a headerless script", headerQuestion("const x = 1;\n") === "(no header)");
  ok(
    "headerQuestion skips a shebang and reads the line below",
    headerQuestion("#!/usr/bin/env bash\n# deploy.sh — the gate that does not drift.\n") === "the gate that does not drift.",
  );
  ok("hasSelftest finds the flag", hasSelftest('if (process.argv.includes("--selftest"))'));
  ok("hasSelftest finds the hyphenated spelling too", hasSelftest('if (process.argv.includes("--self-test"))'));
  ok("hasSelftest rejects a script without one", !hasSelftest("console.log('hi')"));
  const fixtureRows = indexRows(
    "| `a-scan.mjs` | q | r | yes |\n| `b-scan.mjs` | q | r | — |\n| not-a-script | x | y | |\n| `dir/x.mjs` | q | r | |",
  );
  ok("indexRows reads the first cell only", fixtureRows.length === 2 && fixtureRows[0].name === "a-scan.mjs");
  ok("indexRows reads the selftest claim", fixtureRows[0].claimsSelftest === true && fixtureRows[1].claimsSelftest === false);
  ok(
    "R1 flags a script with no row",
    indexProblems(inv, indexRows("| `a-scan.mjs` | q |\n| `b-scan.mjs` | q |")).some(
      (p) => p.rule === "undocumented" && p.detail === "helper.mjs",
    ),
  );
  ok(
    "R2 flags a row with no script",
    indexProblems(inv, indexRows("| `a-scan.mjs` | q |\n| `ghost.mjs` | q |")).some(
      (p) => p.rule === "phantom" && p.detail === "ghost.mjs",
    ),
  );
  ok(
    "a complete index has no problems",
    indexProblems(inv, indexRows("| `a-scan.mjs` | q | yes |\n| `helper.mjs` | q | — |\n| `b-scan.mjs` | q | — |")).length === 0,
  );
  ok(
    "R3 flags a row that claims a selftest the script lacks",
    indexProblems(inv, indexRows("| `a-scan.mjs` | q | yes |"), { selftests: new Map([["a-scan.mjs", false]]) }).some(
      (p) => p.rule === "no-selftest",
    ),
  );
  ok(
    "R3 does not fire when the row does not claim a selftest",
    !indexProblems(inv, indexRows("| `a-scan.mjs` | q | — |"), {
      selftests: new Map([["a-scan.mjs", false]]),
    }).some((p) => p.rule === "no-selftest"),
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[gate-index-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[gate-index-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  return failed === 0;
}

// --- scan -------------------------------------------------------------------
export function runScan({ emit = false, json = false } = {}) {
  const inventory = scriptInventory();
  const texts = new Map(inventory.map((p) => [p, readFileSync(join(ROOT, p), "utf8")]));
  const selftests = new Map(inventory.map((p) => [p.split("/").pop(), hasSelftest(texts.get(p))]));

  if (emit) {
    for (const path of inventory) {
      const base = path.split("/").pop();
      const q = headerQuestion(texts.get(path)).replace(/\|/g, "\\|");
      console.log(`| \`${base}\` | ${q} | ${hasSelftest(texts.get(path)) ? "yes" : "—"} |`);
    }
    return 0;
  }

  if (!existsSync(INDEX)) {
    console.error(
      `[gate-index-scan] FAIL — ${INDEX} does not exist; ${inventory.length} script(s) have nowhere to be listed.`,
    );
    return 1;
  }
  const rows = indexRows(readFileSync(INDEX, "utf8"));
  const problems = indexProblems(inventory, rows, { selftests });

  if (json) {
    console.log(JSON.stringify({ scripts: inventory.length, rows: rows.length, problems }, null, 2));
    return problems.length === 0 ? 0 : 1;
  }
  console.log(`[gate-index-scan] ${inventory.length} script(s) shipped; ${rows.length} row(s) in docs/GATES.md.`);
  for (const p of problems) {
    console.error(`[gate-index-scan] FAIL — ${p.rule}: ${p.detail}`);
  }
  if (problems.length > 0) {
    console.error(
      "\nFix by adding the row to docs/GATES.md (`--emit` drafts one from the script's own header),\n" +
        "or by removing the row for a script that no longer exists. The index is how the next reader\n" +
        "finds out which question is already answered by which instrument.",
    );
  }
  return problems.length === 0 ? 0 : 1;
}

const asMain = process.argv[1]?.endsWith("gate-index-scan.mjs") ?? false;
if (asMain) {
  if (process.argv.includes("--selftest")) process.exit(runSelftest() ? 0 : 1);
  process.exit(runScan({ emit: process.argv.includes("--emit"), json: process.argv.includes("--json") }));
}

