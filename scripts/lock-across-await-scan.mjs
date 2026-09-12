#!/usr/bin/env node
/**
 * lock-across-await-scan.mjs — "a `std` lock guard held across an `.await`".
 *
 * Why: a `std::sync::Mutex`/`RwLock` guard is neither `Send`-friendly nor cooperative —
 * holding one across a suspension point can serialize unrelated tasks, risk a deadlock
 * with the same lock on another path, and (in a wider async graph) fail to compile only
 * once something that matters moves. The first pass over this repo found **one
 * candidate, and it was a false positive of the *probe*, not of the code**: the guard
 * was declared inside a `let o = { … }` block and dropped before the `.await`; a naive
 * scan matched a *different* variable with the same name in a later block. That is why
 * this gate tracks **scope**, not just names.
 *
 * Rule: inside a production `async fn`, a binding assigned from a synchronous lock
 * (`.lock()` / `.read()` / `.write()` / `.borrow_mut()` with no `.await` on that line —
 * `tokio`'s async locks end in `.await` and are fine) must not be **used after an
 * `.await` within its own scope**. `drop(x)` ends it early; a new `let x` starts a new
 * one; leaving the enclosing block ends it.
 *
 * Not covered (documented boundaries): a guard moved into another function or returned
 * out of its scope (the scan is per-body), `&mut` reborrows stored in structs, guards
 * taken inside a closure invoked later, and `parking_lot` without a `use` line naming
 * it as a lock type — all of those need a type checker, not a scanner.
 *
 * Usage (from the repo root):
 *   node scripts/lock-across-await-scan.mjs              # gate
 *   node scripts/lock-across-await-scan.mjs --json
 *   node scripts/lock-across-await-scan.mjs --selftest   # pin the scope tracker
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["target", "node_modules", ".git", "dist"]);

/** Production Rust sources (`crates/**\/src`, test dirs excluded). */
export function productionSources() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (SKIP_DIRS.has(e) || e === "tests") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".rs") && p.includes("/src/")) out.push(p);
    }
  };
  walk(join(root, "crates"));
  return out.sort();
}

/** Cut a file at its first `#[cfg(test)]` (production-only view). */
export function productionView(raw) {
  const cut = raw.split("\n").findIndex((l) => l.trim().startsWith("#[cfg(test)]"));
  return cut === -1 ? raw : raw.split("\n").slice(0, cut).join("\n");
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

/** The bodies of every `async fn` in a source, with their starting line. */
export function asyncBodies(src) {
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

/** Depth change contributed by a line's braces. */
function depthDelta(line) {
  let d = 0;
  for (const c of line) {
    if (c === "{") d++;
    else if (c === "}") d--;
  }
  return d;
}

/**
 * Guards used after an `.await` inside their own scope, in one async body.
 * Returns `[{ line, name }]`.
 */
export function guardsAcrossAwait(body) {
  const lines = body.split("\n");
  /** @type {{name: string, depth: number, line: number, used: boolean}[]} */
  const live = [];
  const findings = [];
  let depth = 0;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const code = line.replace(/\/\/.*$/, "");

    // Is this line an await? Any live guard referenced *after* it is a finding.
    const hasAwait = /\.await/.test(code);
    if (hasAwait) {
      for (const g of live) {
        if (!g.used) g.awaitSeen = k;
      }
    }

    // A guard declaration (synchronous lock: no `.await` on the line).
    const decl = code.match(/let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (
      decl &&
      /\.lock\(\)|\.read\(\)|\.write\(\)|\.borrow_mut\(\)/.test(decl[2]) &&
      !/\.await/.test(decl[2])
    ) {
      live.push({ name: decl[1], depth, line: k, awaitSeen: null });
    }

    // Uses of a live guard *after* an await inside its scope.
    for (const g of live) {
      if (g.awaitSeen !== null && k > g.awaitSeen && new RegExp(`\\b${g.name}\\b`).test(code)) {
        // An explicit early end is not a use of the guard.
        if (!new RegExp(`\\bdrop\\s*\\(\\s*${g.name}\\s*\\)`).test(code)) {
          findings.push({ line: k, name: g.name, since: g.line });
        }
        g.awaitSeen = null; // report once per guard
      }
    }

    // Scope bookkeeping: leaving the declaring block ends the guard.
    depth += depthDelta(code);
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].depth > depth) live.splice(i, 1);
    }
  }
  return findings;
}

export function scan() {
  const findings = [];
  for (const abs of productionSources()) {
    const rel = abs.replace(root + "/", "");
    const src = productionView(readFileSync(abs, "utf8"));
    for (const fn of asyncBodies(src)) {
      for (const f of guardsAcrossAwait(fn.body)) {
        findings.push({ file: rel, fn: fn.name, line: fn.startLine + f.line, name: f.name });
      }
    }
  }
  return findings;
}

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);

function runSelfTest() {
  const cases = [];
  const fns = (s) => asyncBodies(productionView(s));
  const scan1 = (s) => guardsAcrossAwait(fns(s)[0].body);

  // (a) The real defect: a guard held across an await and used afterwards.
  const real = `
async fn f() {
    let g = m.lock().unwrap_or_else(|p| p.into_inner());
    do_something().await;
    g.record();
}
`;
  cases.push(["guard used after an await is flagged", scan1(real).length === 1]);
  cases.push(["…and it names the binding", scan1(real)[0]?.name === "g"]);

  // (b) The false positive that motivated the scope tracker: the guard is declared in a
  // nested block and dropped before the await; the name reappears later in another scope.
  const scoped = `
async fn f() {
    let o = {
        let mut g = gov.lock().unwrap_or_else(|p| p.into_inner());
        g.observe()
    };
    drive(&o).await;
    if let Some(x) = y {
        let g = gov.lock().unwrap_or_else(|p| p.into_inner());
        g.freq_plan();
    }
}
`;
  cases.push(["a guard scoped away from the await is NOT flagged", scan1(scoped).length === 0]);

  // (c) An explicit `drop` before the await ends the guard.
  const dropped = `
async fn f() {
    let g = m.lock().unwrap();
    g.push(1);
    drop(g);
    later().await;
}
`;
  cases.push(["drop before the await is not a finding", scan1(dropped).length === 0]);

  // (d) tokio's async locks end in `.await` — not synchronous guards at all.
  const tokioLock = `
async fn f() {
    let g = m.read().await;
    later().await;
    g.len();
}
`;
  cases.push(["tokio `.read().await` is not a std guard", scan1(tokioLock).length === 0]);

  // (e) A guard used after an await *inside a deeper block of its own scope* still counts.
  const nestedUse = `
async fn f() {
    let g = m.lock().unwrap();
    if cond {
        later().await;
        g.record();
    }
}
`;
  cases.push(["use inside a nested block after the await counts", scan1(nestedUse).length === 1]);

  // (f) Two guards, one fine and one not, are distinguished.
  const two = `
async fn f() {
    let a = m.lock().unwrap();
    a.push(1);
    drop(a);
    let b = m.lock().unwrap();
    later().await;
    b.push(2);
}
`;
  const hits = scan1(two);
  cases.push(["only the offending guard is reported", hits.length === 1 && hits[0].name === "b"]);

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[lock-across-await-scan] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[lock-across-await-scan] selftest OK — ${cases.length} scope case(s).`);
}

if (args.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const findings = scan();
if (args.includes("--json")) {
  console.log(JSON.stringify(findings, null, 2));
  process.exit(findings.length === 0 ? 0 : 1);
}
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}  guard \`${f.name}\` used after an .await in ${f.fn}()`);
}
if (findings.length > 0) {
  console.log(
    `[lock-across-await-scan] FAIL — ${findings.length} std lock guard(s) held across an .await. Scope the guard in a block, or use a tokio async lock.`,
  );
  process.exit(1);
}
console.log(
  "[lock-across-await-scan] OK — no std lock guard is held across an .await in production async code.",
);

