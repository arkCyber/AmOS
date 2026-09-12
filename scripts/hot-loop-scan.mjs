#!/usr/bin/env node
/**
 * hot-loop-scan.mjs — static "no busy-wait / termination documented" scan for the
 * Rust workspace (audit P1-6, NASA Power of 10 rule 2: every loop statically bounded
 * or provably terminating).
 *
 * Why: the audit found `loop { … }` sites whose termination was never written down,
 * and the real hazard behind that question is a loop that **never waits and never
 * exits** — it pins a core (and can starve a watchdog) instead of failing loudly.
 * Both properties are visible statically, so they belong in a gate rather than in a
 * one-off review:
 *
 *   1. **Hot spin (hard gate, no baseline).** A production `loop { … }` whose body
 *      has neither a waiting/blocking construct (`.await`, `recv`, `select!`,
 *      `sleep`, `park`, `accept`, `read`, lock waits, …) nor an escape (`break`,
 *      `return`). Such a loop cannot block and cannot leave: it burns CPU forever.
 *      Allowing one requires an explicit, auditable entry in the baseline with a
 *      `reason` (e.g. a deliberate atomic spin — which should use `spin_loop()`).
 *   2. **Undocumented long-running loop (ratchet).** A loop that waits and has **no**
 *      escape runs until its task/process is aborted; who aborts it must be written
 *      next to it (a comment mentioning exit/stop/shutdown/signal/until/…). The
 *      pre-existing backlog lives in `scripts/hot-loop-baseline.json`; a **new**
 *      undocumented loop fails the scan with instructions.
 *
 * Scope: production Rust under `crates/<crate>/src` (recursively). `tests/`
 * directories and `#[cfg(test)]` sections are skipped — test loops are not
 * production behaviour.
 *
 * The scanner is deliberately dependency-free (regex + fs) and never executes or
 * imports the Rust it inspects.
 *
 * Usage (from the repo root):
 *   node scripts/hot-loop-scan.mjs                  # gate (non-zero on regression)
 *   node scripts/hot-loop-scan.mjs --json           # machine-readable report
 *   node scripts/hot-loop-scan.mjs --update-baseline
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cratesDir = join(repoRoot, "crates");
const baselinePath = join(repoRoot, "scripts", "hot-loop-baseline.json");

/**
 * Constructs that let a loop relinquish the CPU (or block until woken).
 *
 * Word-boundary discipline matters here: the *non-blocking* `try_recv` / `try_read` /
 * `try_lock` must NOT count as waiting, or a busy-poll loop would be misclassified as
 * a healthy long runner. A bare `spin_loop()` is deliberately excluded too — a
 * deliberate spin needs an explicit baseline entry with a reason.
 */
const WAIT_RE =
  /\.await|\brecv\b|recv_timeout|recv_async|select!|\bsleep\b|park_timeout|\bpark\b|yield_now|\baccept\(|\bblock_on\b|\btimeout\(|\bread_line|\bread_exact|\bread_to_end|\bread\(|\bwrite\(|\bflush\(|\bwait\(\)|wait_for|\bdelay\b|\bmsleep|\busleep|\bnanosleep|\.lock\(\)|\.join\(\)/;
/** Constructs that can leave the loop. */
const ESCAPE_RE = /\bbreak\b|\breturn\b/;
/** A comment near the loop that documents who/what ends it. */
const TERMINATION_NOTE_RE =
  /\/\/[^\n]*\b(exit|exit(s|ed)?\b|terminat|stop|shutdown|shut down|signal|until|forever|for the lifetime|abort|break|runs? until|never returns|Ctrl|SIGTERM|SIGINT|退出|终止|直到|直到进程)/i;

// --- file discovery ---------------------------------------------------------
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.name.endsWith(".rs")) acc.push(p);
  }
  return acc;
}

const rustFiles = readdirSync(cratesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(cratesDir, d.name, "src"))
  .flatMap((src) => walk(src))
  .filter((f) => !f.includes("/tests/"))
  .sort();

/** Drop everything from the first `#[cfg(test)]` (test modules hold loops too). */
function stripTestModules(src) {
  const i = src.indexOf("#[cfg(test)]");
  return i < 0 ? src : src.slice(0, i);
}

/**
 * Body of the braced block whose `{` sits at `open` — string-, char-, and
 * comment-aware (Rust block comments nest), so a `'{'` inside a char literal or a
 * `"// }"` inside a string cannot desynchronise the brace count.
 */
function bodyOf(src, open) {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let d = 1;
      i += 2;
      while (i < src.length && d > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          d++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          d--;
          i += 2;
        } else i++;
      }
      continue;
    }
    // Raw strings: r"…" / r#"…"# / br#"…"#
    const raw = /^(b?r)(#*)"/.exec(src.slice(i, i + 8));
    if (raw) {
      const close = '"' + raw[2];
      const start = i + raw[0].length;
      const end = src.indexOf(close, start);
      i = end < 0 ? src.length : end + close.length;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "'") {
      const ch = /^'(?:\\.|[^'\\])'/.exec(src.slice(i, i + 6));
      if (ch) {
        i += ch[0].length;
        continue;
      }
      i++; // a lifetime like 'a
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
    i++;
  }
  return src.slice(open + 1);
}

/** Nearest `fn name` above `index` (for a line-shift-proof baseline key). */
function enclosingFn(src, index) {
  const m = [...src.slice(0, index).matchAll(/\b(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g)].pop();
  return m ? m[1] : "<module>";
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

// --- scan -------------------------------------------------------------------
/** Classify every `loop { … }` in one already-test-stripped source string. */
function scanSource(src, rel) {
  const out = [];
  const seen = new Map(); // fn name -> count, to disambiguate multiple loops per fn
  for (const m of src.matchAll(/\bloop\s*\{/g)) {
    const open = src.indexOf("{", m.index);
    const body = bodyOf(src, open);
    const fn = enclosingFn(src, m.index);
    const n = (seen.get(fn) ?? 0) + 1;
    seen.set(fn, n);
    const key = `${rel}::${fn}${n > 1 ? `#${n}` : ""}`;
    const line = lineOf(src, m.index);
    const waits = WAIT_RE.test(body);
    const escapes = ESCAPE_RE.test(body);
    if (!waits && !escapes) {
      out.push({ key, rel, line, kind: "hot-spin", fn });
      continue;
    }
    if (waits && !escapes) {
      // Runs until aborted — who aborts it must be written down next to it.
      const context = src
        .split("\n")
        .slice(Math.max(0, line - 5), line)
        .join("\n");
      if (!TERMINATION_NOTE_RE.test(context)) out.push({ key, rel, line, kind: "undocumented", fn });
    }
  }
  return out;
}

const findings = []; // { key, rel, line, kind: "hot-spin" | "undocumented", fn }
const undocumentedKeys = new Set();

for (const file of rustFiles) {
  const rel = relative(repoRoot, file);
  const src = stripTestModules(readFileSync(file, "utf8"));
  for (const f of scanSource(src, rel)) {
    findings.push(f);
    if (f.kind === "undocumented") undocumentedKeys.add(f.key);
  }
}

// --- self-test --------------------------------------------------------------
/**
 * `--selftest` proves the classifier can actually *fail* (a gate that only ever
 * prints OK is worse than no gate) and that the brace/string/char handling cannot be
 * fooled. Wired into `make lint` next to the real scan.
 */
function runSelfTest() {
  const cases = [
    {
      name: "hot spin (no wait, no escape) is caught",
      src: "fn f() {\n    loop {\n        work();\n    }\n}\n",
      want: ["hot-spin"],
    },
    {
      name: "an escape (`break`) is not a hot spin",
      src: "fn f() {\n    loop {\n        if done() { break; }\n    }\n}\n",
      want: [],
    },
    {
      name: "waiting without an exit needs a termination comment",
      src: "fn f() {\n    loop {\n        let m = rx.recv().await;\n        use_msg(m);\n    }\n}\n",
      want: ["undocumented"],
    },
    {
      name: "…and is accepted once the comment says who ends it",
      src: "fn f() {\n    // Runs until the daemon shuts down.\n    loop {\n        let m = rx.recv().await;\n        use_msg(m);\n    }\n}\n",
      want: [],
    },
    {
      name: "a busy poll on `try_recv` (no wait, no exit) is a hot spin",
      src: "fn f() {\n    loop {\n        if let Ok(m) = rx.try_recv() { use_msg(m); }\n    }\n}\n",
      want: ["hot-spin"],
    },
    {
      name: "strings, char literals and nested comments cannot desync the braces",
      src:
        'fn f() {\n    loop {\n        let c = \'{\';\n        let s = "} not a brace";\n        /* { /* } */ */\n        if c == \'x\' { break; }\n    }\n}\n',
      want: [],
    },
    {
      name: "a loop inside #[cfg(test)] is not production",
      src: "fn f() {}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { loop { spin(); } }\n}\n",
      want: [],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = scanSource(stripTestModules(c.src), "<selftest>").map((f) => f.kind);
    const ok = JSON.stringify(got) === JSON.stringify(c.want);
    if (!ok) {
      failed++;
      console.log(`  [FAIL] ${c.name}: want ${JSON.stringify(c.want)}, got ${JSON.stringify(got)}`);
    } else {
      console.log(`  [ok] ${c.name}`);
    }
  }
  if (failed > 0) {
    console.log(`[hot-loop] selftest FAILED (${failed} case(s)).`);
    process.exit(1);
  }
  console.log(`[hot-loop] selftest OK — ${cases.length} classifier case(s), incl. 3 that must fail.`);
}

if (process.argv.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

// --- baseline ---------------------------------------------------------------
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : { undocumented: [] };
const baselinedUndocumented = new Map(
  (baseline.undocumented ?? []).map((e) => [e.key, e.reason ?? ""]),
);
const baselinedHotSpin = new Map((baseline.hotSpins ?? []).map((e) => [e.key, e.reason ?? ""]));

const newHotSpins = findings.filter((f) => f.kind === "hot-spin" && !baselinedHotSpin.has(f.key));
const newUndocumented = findings.filter(
  (f) => f.kind === "undocumented" && !baselinedUndocumented.has(f.key),
);
const stale = [...baselinedUndocumented.keys()].filter((k) => !undocumentedKeys.has(k));

// --- report -----------------------------------------------------------------
const json = process.argv.includes("--json");
const update = process.argv.includes("--update-baseline");
const undocumented = findings.filter((f) => f.kind === "undocumented");

if (update) {
  const out = {
    "$comment":
      "Baseline for scripts/hot-loop-scan.mjs. `undocumented`: long-running loops (wait, no escape) that predate the gate — they run until their task/process is aborted but do not yet say so. New loops must carry a termination comment instead of a baseline entry. `hotSpins`: deliberately exempted busy loops (should be empty; a real spin needs spin_loop() and a reason).",
    undocumented: undocumented.map((f) => ({
      key: f.key,
      reason:
        "pre-existing long-running loop (waits, no escape) without a termination comment; grandfathered when the P1-6 gate landed",
    })),
    hotSpins: [...baselinedHotSpin].map(([key, reason]) => ({ key, reason })),
  };
  writeFileSync(baselinePath, JSON.stringify(out, null, 2) + "\n");
  console.log(`[hot-loop] baseline written: ${out.undocumented.length} undocumented loop(s).`);
  process.exit(0);
}

if (json) {
  console.log(
    JSON.stringify(
      {
        scannedFiles: rustFiles.length,
        undocumented,
        hotSpins: findings.filter((f) => f.kind === "hot-spin"),
        newUndocumented: newUndocumented.map((f) => f.key),
        newHotSpins: newHotSpins.map((f) => f.key),
      },
      null,
      2,
    ),
  );
  process.exit(newHotSpins.length + newUndocumented.length > 0 ? 1 : 0);
}

console.log(`[hot-loop] ${rustFiles.length} production .rs file(s) scanned.`);
console.log(
  `[hot-loop] ${undocumented.length} long-running loop(s) (wait, no escape) — ${undocumented.length - newUndocumented.length} baselined, ${newUndocumented.length} new.`,
);
console.log(
  `[hot-loop] ${findings.filter((f) => f.kind === "hot-spin").length} hot-spin loop(s) (no wait, no escape).`,
);

for (const f of newHotSpins) {
  console.log(`  [FAIL] hot spin (cannot block, cannot exit): ${f.rel}:${f.line}  (${f.key})`);
}
for (const f of newUndocumented) {
  console.log(
    `  [FAIL] new long-running loop without a termination comment: ${f.rel}:${f.line}  (${f.key})`,
  );
}
for (const k of stale) {
  console.log(`  [..] baseline entry no longer matches any loop (remove it): ${k}`);
}

if (newHotSpins.length > 0) {
  console.log(
    "  fix: make the loop wait on something (channel/select/sleep) or give it an exit. A deliberate spin needs an auditable entry: `node scripts/hot-loop-scan.mjs --update-baseline` then write the `reason`.",
  );
}
if (newUndocumented.length > 0) {
  console.log(
    '  fix: add a comment above the loop saying who ends it (e.g. "// runs until the process is stopped (SIGTERM/SIGINT)"), or record it with `--update-baseline` plus a reason.',
  );
}

if (newHotSpins.length + newUndocumented.length > 0) {
  console.log("[hot-loop] FAIL — regressions above.");
  process.exit(1);
}
console.log("[hot-loop] OK — every production loop waits or has an exit; long runners are documented or baselined.");
