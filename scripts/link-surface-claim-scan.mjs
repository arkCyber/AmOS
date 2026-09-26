#!/usr/bin/env node
/**
 * link-surface-claim-scan.mjs — "the docs say the System UI cannot command robots, and the System
 * UI ships a robot command console" — and its mirror, "the docs advertise a command console while
 * the bridge behind it has no publishing command".
 *
 * Why (REQ-A896): the operator console landed on the *same* bridge as the read-only link panel.
 * `crates/amos-tauri/src/link.rs` now exposes `link_publish` / `link_topics` /
 * `link_watch_heartbeats` / `link_stop_heartbeats` beside `link_status`, and
 * `frontend-ts/src/svelte/RobotApp.svelte` is the screen that calls them (arm / e-stop / gaits).
 * Every narrative surface describing that bridge was left saying the opposite:
 *
 *   * the bridge's **own module doc** still opened with "this module exposes one read-only command"
 *     (and called `LinkPage.svelte` its "only consumer") — the file contradicting its own body, the
 *     write-side section of which opens 「The read side above observes; this side commands」;
 *   * `README.md` said it twice ("The System UI mirrors this read-only … the CLI owns publishing",
 *     and "There is no toggle — the page observes; the CLI owns publishing");
 *   * `docs/amos-link.md` §6 said 「**它只读、不指挥**（发布是 CLI/工具的事）」;
 *   * `LinkPage.svelte`'s header repeated it and cited §6 as its authority.
 *
 * Two of those cited each other, so nothing in the tree contradicted the other, and a reader of the
 * README, of §6, or of the bridge's module doc learns the System UI cannot command a robot at all —
 * including that it cannot **E-Stop** one. The console is documented nowhere outside the audit
 * ledgers (the `F-SH-*` rows), which are the one corpus a reader of *documentation* does not read.
 *
 * The two rules are one biconditional — the narrative's stance must equal the bridge's:
 *   R1 `stale-denial`    — the bridge exposes `link_publish`, and a narrative surface still says the
 *                          link UI is read-only / that publishing is the CLI's job.
 *   R2 `phantom-console` — a narrative surface says the UI owns a command console, and the bridge
 *                          exposes no `link_publish` to serve it.
 * Both directions are reachable in a real tree: R1 is where this round started; R2 is what reverting
 * the console would leave behind if the prose stayed. (`--selftest` pins both, plus the extractor.)
 *
 * Scope — and this is the gate's honest limit: the needles are **literal sentences**, the ones
 * corrected this round, not a general "does this doc sound read-only?" test. A narrative inventing a
 * *seventh* phrasing of the same false claim is not caught. A **true** statement must not be caught,
 * either: "the Settings panel is read-only" is exactly what `LinkPage` is, and the correction keeps
 * saying so — which is why R1 keys on phrases that claim the *whole surface* is observation-only
 * （「the CLI owns publishing」／「它只读、不指挥」), not on the word "read-only".
 *
 * Corpus: the narrative docs (every root `*.md` except `CHANGELOG.md`, plus `docs/**` except
 * `archive/**`) and the four source files whose prose describes the surface (the bridge itself,
 * `LinkPage.svelte`, and the two i18n locale files). The audit ledgers — `CHANGELOG.md`,
 * `docs/FMEA.md`, `docs/TRACEABILITY_MATRIX.md`, `docs/archive/**` — are **not** in the corpus on
 * purpose: they *quote* these sentences as the defect they record, and a gate that reddens on its own
 * defect entry could not be written at all.
 *
 * Usage (repo root):
 *   node scripts/link-surface-claim-scan.mjs              # gate
 *   node scripts/link-surface-claim-scan.mjs --json
 *   node scripts/link-surface-claim-scan.mjs --selftest   # pin the extractor and both rules
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
// The repo's one self-tested Rust comment stripper + `#[cfg(test)]` elider (shared with the tauri
// command/reply scans). `#[tauri::command]` never appears in prose we must read, so masking
// comments can only *remove* a match — the safe direction for extracting the command list.
import { stripTestRegions, maskProse } from "./tauri-reply-scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BRIDGE = "crates/amos-tauri/src/link.rs";
const LINK_PAGE = "crates/amos-tauri/frontend-ts/src/svelte/settings/LinkPage.svelte";
const I18N_EN = "crates/amos-tauri/frontend-ts/src/i18n/locales/en.ts";
const I18N_ZH = "crates/amos-tauri/frontend-ts/src/i18n/locales/zh.ts";

/** The command whose existence decides which way the narrative must lean. */
export const PUBLISH_COMMAND = "link_publish";

/** Ledgers and frozen snapshots: they quote the defect, they are not the defect. */
const SKIP_DOCS = new Set(["CHANGELOG.md", "FMEA.md", "TRACEABILITY_MATRIX.md"]);
const SKIP_DIRS = new Set(["archive", "node_modules", "target", ".git", "dist"]);

/**
 * The sentences that claim the **whole** link surface is observation-only. Each is a literal, and
 * the `file` (when given) scopes it — a phrase about the bridge belongs in the bridge.
 */
export const DENY = [
  { id: "bridge-module-doc", file: BRIDGE, needle: "one read-only command" },
  { id: "the-cli-owns-publishing", file: null, needle: "the CLI owns publishing" },
  { id: "zh-refuses-to-command", file: null, needle: "它只读、不指挥" },
  { id: "i18n-en-only-read-panel", file: null, needle: "read-only link panel copy" },
  { id: "i18n-zh-only-read-panel", file: null, needle: "只读链路面板文案" },
];

/** The marker that says the narrative knows about a console — the mirror direction's evidence. */
export const AFFIRM = [
  { id: "readme-console", file: "README.md", needle: "command console" },
  { id: "docs-console", file: "docs/amos-link.md", needle: "指挥台" },
];

/**
 * The registered `#[tauri::command]` names in a Rust source file (production region only: a
 * `#[cfg(test)]` module may declare a fixture command that is never registered).
 */
export function tauriCommands(src) {
  const prod = maskProse(stripTestRegions(src), { strings: false });
  const out = [];
  for (const m of prod.matchAll(
    /#\[tauri::command\]\s*pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g,
  )) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Collapse every whitespace run to one space, keeping each surviving character's original line.
 * The docs in this repo are hard-wrapped, so a sentence can straddle a line break —
 * `README.md` literally says "the CLI owns\npublishing", which a per-line `includes` misses.
 */
function flatten(text) {
  const chars = [];
  const lines = text.split("\n");
  let line = 1;
  let lastWasSpace = true;
  for (const ch of text) {
    if (ch === "\n") {
      line++;
      if (!lastWasSpace) chars.push({ c: " ", line });
      lastWasSpace = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (!lastWasSpace) chars.push({ c: " ", line });
      lastWasSpace = true;
      continue;
    }
    chars.push({ c: ch, line });
    lastWasSpace = false;
  }
  return { chars, lines };
}

/** `{id, needle, line, text}` for every occurrence of a needle, whitespace-tolerant. */
export function findNeedles(text, needles) {
  const { chars, lines } = flatten(text);
  const flat = chars.map((x) => x.c).join("");
  const out = [];
  for (const n of needles) {
    let idx = flat.indexOf(n.needle);
    while (idx !== -1) {
      const line = chars[idx].line;
      out.push({ id: n.id, needle: n.needle, line, text: (lines[line - 1] ?? "").trim() });
      idx = flat.indexOf(n.needle, idx + 1);
    }
  }
  return out;
}

/**
 * The one biconditional, as a pure function of the two stances, so `--selftest` can walk all four
 * states without a tree.
 */
export function verdict({ publishes, denies, affirms }) {
  const errors = [];
  if (publishes && denies.length) {
    errors.push({
      rule: "stale-denial",
      note: `the bridge exposes ${PUBLISH_COMMAND}, but the narrative still says the link surface cannot command: ${denies.map((d) => `${d.file}:${d.line} 「${d.needle}」`).join(", ")}`,
    });
  }
  if (!publishes && affirms.length) {
    errors.push({
      rule: "phantom-console",
      note: `the narrative advertises a command console (${affirms.map((a) => `${a.file}:${a.line} 「${a.needle}」`).join(", ")}), but the bridge exposes no ${PUBLISH_COMMAND}`,
    });
  }
  return errors;
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const bridgeSrc = [
    "//! A module doc that is prose.",
    "#[tauri::command]",
    "pub async fn link_status() -> Result<(), String> { Ok(()) }",
    "#[tauri::command]",
    "pub fn link_stop_heartbeats(w: State<'_, W>) {}",
    "#[cfg(test)]",
    "mod tests {",
    "  #[tauri::command]",
    "  pub fn a_fixture_command() {}",
    "}",
  ].join("\n");
  const names = tauriCommands(bridgeSrc);
  ok("extracts a `#[tauri::command] pub async fn`", names.includes("link_status"));
  ok("extracts a `#[tauri::command] pub fn`", names.includes("link_stop_heartbeats"));
  ok("ignores a command declared inside `#[cfg(test)]`", !names.includes("a_fixture_command"));
  ok("does not invent names", names.length === 2);
  ok(
    "a doc comment quoting the attribute is not a command",
    tauriCommands("/// #[tauri::command] pub fn nope() {}").length === 0,
  );

  const hits = findNeedles("a\nb the CLI owns publishing c\n", DENY);
  ok("finds a needle and reports its line", hits.length === 1 && hits[0].line === 2);
  ok("does not match a prefix of the needle", findNeedles("the CLI owns publish", DENY).length === 0);
  ok(
    "scoped needle is found in the bridge text",
    findNeedles("one read-only command", DENY.filter((d) => d.file === BRIDGE)).length === 1,
  );
  // README literally wraps the sentence this way; a per-line search misses it (measured).
  const wrapped = findNeedles("It has **no toggle** — the CLI owns\npublishing; the page observes.", DENY);
  ok("finds a needle split across a line break", wrapped.length === 1 && wrapped[0].line === 1);
  ok(
    "a double space between words is not a miss",
    findNeedles("the CLI owns  publishing", DENY).length === 1,
  );

  const d = (file) => [{ id: "x", file, needle: "n", line: 1 }];
  const a = (file) => [{ id: "y", file, needle: "m", line: 2 }];
  ok(
    "R1: publishes + denial is a defect",
    verdict({ publishes: true, denies: d("README.md"), affirms: [] })[0]?.rule === "stale-denial",
  );
  ok(
    "R2: no publish + console claim is a defect",
    verdict({ publishes: false, denies: [], affirms: a("README.md") })[0]?.rule === "phantom-console",
  );
  ok(
    "consistent (publishes, console named, no denial) is clean",
    verdict({ publishes: true, denies: [], affirms: a("README.md") }).length === 0,
  );
  ok(
    "consistent (no publish, no console claim, no denial) is clean",
    verdict({ publishes: false, denies: [], affirms: [] }).length === 0,
  );
  // The direction that keeps the gate from being a plain deny-list: a read-only-only tree may say
  // it is read-only. Without this, correcting R1 by deleting the sentences would look like the fix.
  ok(
    "consistent (no publish, denial present, no console claim) is clean",
    verdict({ publishes: false, denies: d("README.md"), affirms: [] }).length === 0,
  );
  // The two rules are exclusive by construction: they disagree about `publishes`. Walk all eight
  // states so a future edit that lets both fire (or neither, when it must) is caught here.
  let bothFired = 0;
  for (const publishes of [true, false]) {
    for (const denies of [[], d(BRIDGE)]) {
      for (const affirms of [[], a("README.md")]) {
        if (verdict({ publishes, denies, affirms }).length > 1) bothFired++;
      }
    }
  }
  ok("the two rules never fire together", bothFired === 0);

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[link-surface-claim-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(
    `[link-surface-claim-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

// --- corpus -----------------------------------------------------------------
function walkDocs(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walkDocs(join(dir, ent.name), acc);
      continue;
    }
    if (!ent.name.endsWith(".md") || SKIP_DOCS.has(ent.name)) continue;
    acc.push(relative(root, join(dir, ent.name)).split("\\").join("/"));
  }
  return acc;
}

function corpus() {
  const rootDocs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !SKIP_DOCS.has(e.name))
    .map((e) => e.name);
  const docsDir = join(root, "docs");
  return [
    ...rootDocs,
    ...(existsSync(docsDir) ? walkDocs(docsDir) : []),
    BRIDGE,
    LINK_PAGE,
    I18N_EN,
    I18N_ZH,
  ];
}

function main() {
  const files = corpus();
  const texts = new Map();
  for (const f of files) {
    const p = join(root, f);
    if (existsSync(p)) texts.set(f, readFileSync(p, "utf8"));
  }

  const publishes = tauriCommands(texts.get(BRIDGE) ?? "").includes(PUBLISH_COMMAND);

  const denies = [];
  const affirms = [];
  for (const [file, text] of texts) {
    denies.push(...findNeedles(text, DENY.filter((d) => d.file === null || d.file === file)).map((h) => ({ file, ...h })));
    affirms.push(...findNeedles(text, AFFIRM.filter((a) => a.file === file)).map((h) => ({ file, ...h })));
  }
  denies.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  affirms.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);

  const errors = verdict({ publishes, denies, affirms });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ files: files.length, publishes, denies, affirms, errors }, null, 2));
  } else {
    console.log(
      `[link-surface-claim-scan] ${files.length} file(s) read; bridge publishes=${publishes}; ${denies.length} denial(s), ${affirms.length} console marker(s).`,
    );
    for (const a of affirms) {
      console.log(`[link-surface-claim-scan] note — ${a.file}:${a.line} names the console: 「${a.needle}」`);
    }
    if (errors.length === 0) {
      console.log("[link-surface-claim-scan] OK — the narrative's stance matches the bridge's.");
    }
    for (const e of errors) console.error(`[link-surface-claim-scan] FAIL (${e.rule}) — ${e.note}`);
  }
  process.exit(errors.length === 0 ? 0 : 1);
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (process.argv.includes("--selftest")) runSelftest();
if (IS_MAIN) main();
