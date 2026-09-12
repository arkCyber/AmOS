#!/usr/bin/env node
/**
 * blocking-in-async-scan.mjs — "blocking work inside an `async fn`".
 *
 * Why: the daemon, the supervisor and the Tauri bridge are async (tokio). A blocking
 * call inside an `async fn` — filesystem I/O, `std::process`, `std::thread::sleep` —
 * does not merely make *that* task slow: it occupies a runtime worker, so unrelated
 * requests queue behind it. The first pass over this repo found the **durable audit
 * sink** (`AuditFile::log`, awaited by every security and privacy decision) doing
 * `create_dir_all` + open/append + `metadata` under a `std::sync::Mutex` directly on
 * the runtime, and `SessionManager::save` doing `fs::write` + `rename`. Both now hand
 * the synchronous half to `tokio::task::spawn_blocking`; this gate keeps it that way.
 *
 * Rules:
 *   1. Inside a brace-matched `async fn` body (test code excluded), a call to
 *      `std::fs::…`, `std::thread::sleep`, `std::process::Command` (only when the file
 *      imports **std**'s `Command`) or `std::net::` is a finding — *unless* it sits
 *      inside a `spawn_blocking` / `block_in_place` closure in the same body.
 *   2. Findings are allow-listed by `file::fn` with a written reason
 *      (`scripts/blocking-async-allowlist.json`): the accepted cases here are
 *      **startup/shutdown** paths (socket prep, permission hardening, stale-socket and
 *      session cleanup) that run before the server starts serving or after it stops, so
 *      they cannot delay a request. A new blocking call in an allow-listed *function*
 *      is still accepted — the reason describes the function's phase, not one line — so
 *      keep such functions strictly phase-bound.
 *
 * Deliberately **not** matched (documented boundaries): `Command::output()`/`status()`
 * on an unknown receiver (a domain `status()` method looks identical), blocking behind
 * a non-`spawn_blocking` helper, and `std::sync::Mutex` held across an `await`.
 *
 * Usage (from the repo root):
 *   node scripts/blocking-in-async-scan.mjs              # gate
 *   node scripts/blocking-in-async-scan.mjs --json
 *   node scripts/blocking-in-async-scan.mjs --selftest   # pin the finder
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(root, "scripts", "blocking-async-allowlist.json");
const SKIP_DIRS = new Set(["target", "node_modules", ".git", "dist"]);

const BLOCKING = [
  [/\bstd::fs::/, "std::fs"],
  [/\bstd::thread::sleep\b/, "std::thread::sleep"],
  [/\bstd::net::/, "std::net"],
  [/\bCommand::new\b/, "std::process::Command::new"],
];

/** Rust sources under `crates/**\/src` (test directories excluded). */
export function productionSources(dir = join(root, "crates")) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (SKIP_DIRS.has(e) || e === "tests") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".rs") && p.includes("/src/")) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** Blank out comment text (keeping indices) so prose can't look like code. */
export function codeOnly(src) {
  return src
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t.startsWith("//")) return " ".repeat(line.length); // line/doc comment
      const i = line.indexOf("//");
      if (i >= 0) return line.slice(0, i) + " ".repeat(line.length - i);
      return line;
    })
    .join("\n");
}

/** `{ name, body, startLine }` for every `async fn` in a production-only source. */
export function asyncFns(src) {
  const code = codeOnly(src);
  const out = [];
  const re = /\basync\s+fn\s+([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    let i = m.index;
    let depth = 0;
    let started = false;
    for (; i < src.length; i++) {
      if (src[i] === "{") {
        depth++;
        started = true;
      } else if (src[i] === "}") {
        depth--;
        if (started && depth === 0) break;
      }
    }
    out.push({
      name: m[1],
      body: src.slice(m.index, i),
      startLine: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/** Cut a file at its first `#[cfg(test)]` (production-only view). */
export function productionView(raw) {
  const cut = raw.split("\n").findIndex((l) => l.trim().startsWith("#[cfg(test)]"));
  return cut === -1 ? raw : raw.split("\n").slice(0, cut).join("\n");
}

/** The blocking calls in one `async fn` body that are not inside a blocking closure. */
export function blockingIn(fn, src) {
  const usesStdCommand = /use\s+std::process::[^;]*\bCommand\b/.test(src);
  const hits = [];
  fn.body.split("\n").forEach((line, k) => {
    const t = line.trim();
    if (t.startsWith("//")) return;
    for (const [rx, label] of BLOCKING) {
      if (label.startsWith("std::process::Command") && !usesStdCommand) continue;
      if (!rx.test(t)) continue;
      // "Already handed to a blocking thread": a `spawn_blocking`/`block_in_place`
      // closure opened at or above this line and not yet closed. The current line counts
      // too — `spawn_blocking(move || fs::write(…))` puts both on one line.
      const upToHere = fn.body.split("\n").slice(0, k + 1).join("\n");
      const aboveOnly = fn.body.split("\n").slice(0, k).join("\n");
      const opens = (upToHere.match(/spawn_blocking|block_in_place/g) ?? []).length;
      const closes = (aboveOnly.match(/\{\s*\}\)/g) ?? []).length;
      if (opens > closes) continue;
      hits.push({ line: fn.startLine + k, label, fn: fn.name });
      continue;
    }
  });
  return hits;
}

export function scan() {
  const findings = [];
  for (const abs of productionSources()) {
    const rel = abs.replace(root + "/", "");
    const src = productionView(readFileSync(abs, "utf8"));
    for (const fn of asyncFns(src)) {
      for (const hit of blockingIn(fn, src)) findings.push({ file: rel, ...hit });
    }
  }
  return findings;
}

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);

function runSelfTest() {
  const cases = [];
  const fns = (s) => asyncFns(s);

  cases.push(["no async fn ⇒ nothing", fns("fn sync() {}").length === 0]);
  cases.push([
    "async fn body matched",
    fns("async fn a() { work(); }")[0]?.body.includes("work()"),
  ]);
  cases.push([
    "nested braces stay inside one body",
    fns("async fn a() { if x { y(); } }").length === 1,
  ]);

  const hot = productionView("async fn a() {\n  let s = std::fs::read_to_string(p)?;\n}");
  cases.push([
    "std::fs in async is a finding",
    blockingIn(asyncFns(hot)[0], hot).length === 1,
  ]);

  const wrapped = productionView(
    "async fn a() {\n  tokio::task::spawn_blocking(move || std::fs::write(p, b))\n    .await?;\n}",
  );
  cases.push([
    "inside spawn_blocking is fine",
    blockingIn(asyncFns(wrapped)[0], wrapped).length === 0,
  ]);

  const stdCmd = productionView("use std::process::Command;\nasync fn a() {\n  Command::new(\"x\");\n}");
  cases.push([
    "std Command counts when imported",
    blockingIn(asyncFns(stdCmd)[0], stdCmd).length === 1,
  ]);

  const tokioCmd = productionView(
    "use tokio::process::{Child, Command};\nuse std::process::Stdio;\nasync fn a() {\n  Command::new(\"x\");\n}",
  );
  cases.push([
    "tokio Command does NOT count",
    blockingIn(asyncFns(tokioCmd)[0], tokioCmd).length === 0,
  ]);

  const statusMethod = productionView("async fn a() {\n  Ok(session.status())\n}");
  cases.push([
    "a domain .status() is not matched",
    blockingIn(asyncFns(statusMethod)[0], statusMethod).length === 0,
  ]);

  const cut = productionView(
    "async fn a() { std::fs::read(p); }\n#[cfg(test)]\n#[tokio::test]\nasync fn t() { std::fs::read(p); }",
  );
  cases.push(["tests are cut", scan === undefined ? false : asyncFns(cut).length === 1]);

  cases.push([
    "sleep matched",
    blockingIn(
      asyncFns(productionView("async fn a() {\n  std::thread::sleep(d);\n}"))[0],
      productionView("async fn a() {\n  std::thread::sleep(d);\n}"),
    ).length === 1,
  ]);

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[blocking-in-async-scan] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[blocking-in-async-scan] selftest OK — ${cases.length} finder case(s).`);
}

if (args.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const findings = scan();
const allow = existsSync(ALLOWLIST)
  ? JSON.parse(readFileSync(ALLOWLIST, "utf8")).sites ?? {}
  : {};
const unexpected = findings.filter((f) => !allow[`${f.file}::${f.fn}`]);
const staleAllow = Object.entries(allow).filter(
  ([site]) => !findings.some((f) => `${f.file}::${f.fn}` === site),
);

if (args.includes("--json")) {
  console.log(JSON.stringify({ findings, unexpected, staleAllow }, null, 2));
  process.exit(unexpected.length === 0 ? 0 : 1);
}
for (const f of unexpected) {
  console.log(`  ${f.file}:${f.line}  ${f.label}  in async fn ${f.fn}()`);
}
if (unexpected.length > 0) {
  console.log(
    `[blocking-in-async-scan] FAIL — ${unexpected.length} blocking call(s) on the async runtime. Hand the work to \`tokio::task::spawn_blocking\`, or allow-list the site in scripts/blocking-async-allowlist.json with a reason.`,
  );
}
if (staleAllow.length > 0) {
  console.log("[blocking-in-async-scan] note — stale allow-list entries (remove them):");
  for (const [site] of staleAllow) console.log("  " + site);
}
if (unexpected.length === 0) {
  console.log(
    `[blocking-in-async-scan] OK — ${findings.length} known blocking-in-async site(s), all allow-listed (startup/shutdown paths).`,
  );
}
process.exit(unexpected.length === 0 ? 0 : 1);

