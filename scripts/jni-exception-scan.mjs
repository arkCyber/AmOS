#!/usr/bin/env node
/**
 * jni-exception-scan.mjs — "one failed JNI call must not be able to kill the app".
 *
 * Why: a device round proved the class (REQ-A185): `AndroidRadioProvider::snapshot`
 * read the hotspot on a tokio worker, `JNIEnv::find_class` failed with
 * `ClassNotFoundException` (that thread's loader is the bootstrap one), the exception
 * stayed **pending**, and the next JNI call on the same thread aborted the process
 * under CheckJNI (`JNI DETECTED ERROR IN APPLICATION: JNI NewStringUTF called with
 * pending exception …` → SIGABRT). Measured across the workspace at that time: **15
 * modules, 52 JNI call sites, and the exception was cleared in exactly one place**
 * (REQ-A186). So the two rules live in one crate (`crates/amos-jni`) and this gate
 * keeps every other module on them:
 *
 *   1. **`attach_current_thread*` must not appear outside `crates/amos-jni`** — every
 *      provider attaches through `amos_jni::attached`, which clears a pending
 *      exception *before* the first call of the operation (a pooled tokio thread can
 *      inherit one from the previous operation).
 *   2. **`find_class` must not appear outside `crates/amos-jni`** — it uses the
 *      *calling thread's* class loader, which is the bootstrap one on a tokio worker;
 *      the shared `resolve_class` goes through `Context#getClassLoader` instead.
 *      A site with no `Context` available (it only has the captured `JavaVM`) is
 *      recorded in `scripts/jni-allowlist.json` **with a reason**, and must at least
 *      wrap the call in `amos_jni::jni_call!` so a failure cannot poison the thread.
 *
 * Usage (from the repo root):
 *   node scripts/jni-exception-scan.mjs              # gate
 *   node scripts/jni-exception-scan.mjs --json       # machine-readable
 *   node scripts/jni-exception-scan.mjs --selftest   # pin the classifier
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(root, "scripts", "jni-allowlist.json");
/** The one crate allowed to call the raw JNI attachers / find_class. */
const HELPER_DIR = "crates/amos-jni/";

/** `argv[1]` names this file (so the module can also be imported by a test). */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

/** Production Rust sources (tests/examples excluded — they have no JVM duties). */
export function productionRust() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (["target", "node_modules", ".git"].includes(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.endsWith(".rs") && !/\/(tests|examples|benches)\//.test(p)) {
        out.push(p.slice(root.length + 1));
      }
    }
  };
  walk(join(root, "crates"));
  return out.sort();
}

/**
 * Findings for a `{ file: text }` map given the allow-list entries. Pure, so the
 * selftest drives it with fixtures.
 */
export function scanSources(sources, allow = []) {
  const allowed = new Set(allow.map((e) => `${e.file}::${e.token}`));
  const findings = [];
  const used = new Set();
  for (const [file, text] of Object.entries(sources)) {
    if (file.startsWith(HELPER_DIR)) continue;
    // Ignore comments: a mention in prose is not a call.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
    for (const token of ["attach_current_thread", "find_class("]) {
      if (!code.includes(token)) continue;
      for (const line of code.split("\n")) {
        if (!line.includes(token)) continue;
        const key = `${file}::${token}`;
        if (allowed.has(key)) {
          used.add(key);
          continue;
        }
        findings.push({
          file,
          token,
          kind: token === "attach_current_thread" ? "raw-attach" : "find_class",
          line: line.trim().slice(0, 90),
        });
      }
    }
  }
  const stale = allow.filter((e) => !used.has(`${e.file}::${e.token}`)).map((e) => `${e.file}::${e.token}`);
  return { findings, stale };
}


// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const raw = "let env = vm.attach_current_thread().map_err(jerr)?;";
  ok(
    "a raw attach outside the helper is a finding",
    scanSources({ "crates/amos-x/src/android.rs": raw }).findings.length === 1,
  );
  ok("the helper crate may attach raw", scanSources({ "crates/amos-jni/src/lib.rs": raw }).findings.length === 0);
  ok(
    "a comment mentioning attach does not count",
    scanSources({ "crates/amos-x/src/a.rs": "// we used to call attach_current_thread here" }).findings.length === 0,
  );

  const fc = { "crates/amos-y/src/b.rs": 'let c = env.find_class("com/amos/ai/glue/X")?;' };
  ok("find_class outside the helper is a finding", scanSources(fc).findings.length === 1);
  const allowEntry = [{ file: "crates/amos-y/src/b.rs", token: "find_class(", reason: "no Context here" }];
  ok("an allow-listed find_class passes", scanSources(fc, allowEntry).findings.length === 0);
  ok(
    "a stale allow entry is reported",
    scanSources({ "crates/amos-y/src/other.rs": "fn f() {}" }, allowEntry).stale.length === 1,
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[jni-exception-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[jni-exception-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

// --- scan -------------------------------------------------------------------
function runScan() {
  const allow = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, "utf8")) : [];
  for (const e of allow) {
    if (!e.file || !e.token || !String(e.reason ?? "").trim()) {
      console.error(`[jni-exception-scan] allow-entry without file+token+reason: ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }
  const sources = Object.fromEntries(productionRust().map((f) => [f, readFileSync(join(root, f), "utf8")]));
  const { findings, stale } = scanSources(sources, allow);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ files: Object.keys(sources).length, allow: allow.length, stale, findings }, null, 2));
  } else {
    console.log(
      `[jni-exception-scan] ${Object.keys(sources).length} production Rust source(s); ${allow.length} allow-listed site(s).`,
    );
    for (const f of findings) {
      const why =
        f.kind === "raw-attach"
          ? "attaches a thread without clearing a pending exception — use amos_jni::attached (a pooled thread can inherit one and the next JNI call would abort the app)"
          : "resolves a class through the calling thread's loader — use amos_jni::resolve_class, or allow-list it with a reason";
      console.error(`[jni-exception-scan] FAIL — ${f.file} ${f.token} ${why}`);
    }
    for (const s of stale) {
      console.error(`[jni-exception-scan] FAIL — stale allow-list entry (site no longer matches): ${s}`);
    }
    if (findings.length === 0 && stale.length === 0) {
      console.log("[jni-exception-scan] OK — every provider attaches through amos-jni and resolves classes the safe way.");
    }
  }
  process.exit(findings.length === 0 && stale.length === 0 ? 0 : 1);
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();
