#!/usr/bin/env node
/**
 * jni-boolean-scan.mjs — "the platform's answer, thrown away".
 *
 * Why: the JNI glue in this workspace calls platform methods whose `boolean` return
 * is not a value but an **answer** — `WifiManager#setWifiEnabled`,
 * `BluetoothAdapter#enable/disable`, `TetheringGlue#setWifiTethering`: *did you
 * accept this request?* The hotspot path already honoured it (REQ-A174: a `false`
 * becomes a provider error, "so the UI never claims an AP the platform refused"),
 * while **two neighbours in the same file discarded it** (REQ-A184):
 *
 *   * `AndroidRadioProvider::set_wifi` — `setWifiEnabled` → `.and_then(|v| v.z())
 *     .map_err(jerr)?;` then `Ok(())`. On API 29+ that call is restricted to
 *     system/device-owner callers and answers `false`, so a refusal was
 *     indistinguishable from a switch: the Airplane cascade could not roll back
 *     (its error never fired) and nothing was reported.
 *   * `bluetooth_set` — its doc comment said "Returns the boolean it reported" while
 *     the body dropped it, so `set_bluetooth` always claimed success.
 *
 * A dropped `Z` return is decidable statically, which is what this gate does: for
 * every `call_method`/`call_static_method` whose signature ends in `Z`, the
 * statement must **use** the boolean — bind it, return it, test it, compare it. The
 * discard shape is a bare expression statement that extracts `.z()` and ends at
 * `?;` (`env.call_method(…).map_err(jerr)?;`).
 *
 * Scope, honestly: only `Z` returns are gated (an object/int return is usually a
 * *value* a caller may legitimately ignore; a boolean from these methods is a
 * verdict). A boolean **bound** to a variable and then unused is left to the
 * compiler — an unused binding is a warning, and `make lint` compiles every
 * `--features android` crate. Non-JNI `.z()` calls (`jni::objects::JValue` outside
 * a `call_*` statement) are out of scope.
 *
 * Usage (from the repo root):
 *   node scripts/jni-boolean-scan.mjs              # gate
 *   node scripts/jni-boolean-scan.mjs --json       # machine-readable
 *   node scripts/jni-boolean-scan.mjs --selftest   # pin the parser/classifier
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `argv[1]` names this file (so the module can also be imported by a test). */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

/**
 * `src` with comments blanked to spaces — offsets and line numbers preserved, string
 * literals respected (a `//` inside a string is not a comment).
 *
 * Why this exists: the first version of this scan split statements on the nearest `;`
 * and therefore **missed the very defect it was written for** — the comment above
 * `set_wifi` contains a semicolon ("…into an error; this is the same contract…"), so
 * the statement started mid-comment and the classifier saw prose instead of the
 * chain. Caught by the negative control (reverting the fix left the gate green).
 */
export function stripComments(src) {
  const out = [...src];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
    } else if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < src.length) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/**
 * Every `call_method` / `call_static_method` call in `src`, with its JNI signature
 * and that signature's **return** type. String/bracket aware, so a `;` or `)` inside
 * a literal (or inside the signature itself) never ends the call early.
 */
export function jniCalls(src) {
  const out = [];
  for (const m of src.matchAll(/\b(call_method|call_static_method)\s*\(/g)) {
    const open = src.indexOf("(", m.index);
    const args = [];
    let start = open + 1;
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i += 1) {
      const c = src[i];
      if (c === '"') {
        i += 1;
        while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      } else if (c === "(" || c === "{" || c === "[") depth += 1;
      else if (c === ")" || c === "}" || c === "]") {
        if (depth === 0) {
          args.push(src.slice(start, i).trim());
          end = i;
          break;
        }
        depth -= 1;
      } else if (c === "," && depth === 0) {
        args.push(src.slice(start, i).trim());
        start = i + 1;
      }
    }
    if (end < 0) continue;
    const sig = /^"([^"]*)"$/.exec(args[2] ?? "");
    if (sig === null) continue;
    out.push({
      method: m[1],
      signature: sig[1],
      ret: sig[1].match(/\)\s*([^)]*)$/)?.[1] ?? "",
      index: m.index,
      end,
    });
  }
  return out;
}

/**
 * `true` when `from` starts a **macro invocation** (`name!(…`).
 *
 * Why the statement walk needs to know: REQ-A186 wrapped every JNI call in
 * `jni!(env, <call>)` so a failed call clears the pending Java exception. That wrapper
 * put the call inside a macro's argument list — and the walk below used to bail on the
 * first closer at depth 0, which is exactly the macro's own `)`. So a boolean extracted
 * from a wrapped call and then thrown away read as "not a finding", and this gate was
 * blind to the discard shape it exists to catch at every call site the wrapper touches.
 */
function startsMacroInvocation(src, from) {
  return /^\s*[A-Za-z_$][\w$]*\s*!/.test(src.slice(from, from + 80));
}

/**
 * The Rust statement containing the call at `index`: from the previous `;`/`{`/`}`
 * (that is *not* inside a string literal) to the next `;` at bracket depth ≤ 0, also
 * string aware. `null` when unterminated.
 */
export function statementAt(src, index) {
  const inString = (i) => (src.slice(0, i).match(/"/g)?.length ?? 0) % 2 === 1;
  let from = 0;
  for (let i = index; i > 0; i -= 1) {
    const c = src[i];
    if ((c === ";" || c === "{" || c === "}") && !inString(i)) {
      from = i + 1;
      break;
    }
  }
  // The call may sit inside a macro's argument list (`jni!(env, env.call_method(…))`),
  // whose closing `)` is a depth-0 closer that ends the *macro*, not the statement.
  let insideMacro = startsMacroInvocation(src, from);
  let depth = 0;
  for (let i = index; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    } else if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") {
      // A closer at depth 0 ends the enclosing construct: the call was a **tail
      // expression** (its value is returned, e.g. inside an `Ok(…)`), so there is no
      // statement to judge. A macro's own closing `)` is the one exception — the
      // statement continues after it (see `startsMacroInvocation`).
      if (depth === 0) {
        if (insideMacro) {
          insideMacro = false;
          continue;
        }
        return null;
      }
      depth -= 1;
    } else if (c === ";" && depth <= 0) return { text: src.slice(from, i + 1) };
  }
  return null;
}

/**
 * A statement that extracts the platform's boolean (`.z()`) and then throws it away.
 *
 * The rule reads the **tail** of the statement: it must be a bare expression
 * statement (it starts with a receiver chain, so no `let`/`if`/`return`/`assert`
 * binds or tests the value) and everything after the last `.z()` must be only an
 * error map plus `?;`/`;` — i.e. the boolean was converted into "it worked" and
 * discarded. `.z()` used for anything else (a binding, a test, a comparison,
 * a further call, a tail expression) is not a finding.
 */
export function dropsBoolean(statement) {
  const s = statement.replace(/\s+/g, " ").trim();
  if (!s.endsWith(";")) return false;
  const lastZ = s.lastIndexOf(".z()");
  if (lastZ < 0) return false;
  // A bare expression statement — a receiver chain, or the repo's `jni!(env, call)`
  // wrapper macro expanding into one — not a binding/test/return.
  if (!/^[A-Za-z_$][\w$]*\s*(?:!\(|[.(])/.test(s)) return false;
  if (/^(let|return|if|while|match|for|const|static|assert|debug_assert)\b/.test(s)) return false;
  // Everything after the extraction: at most one more call (`.map_err(…)`) and the
  // `?;`/`;` — leading closers belong to the enclosing closure (`|v| v.z())`).
  const tail = s.slice(lastZ + 4).replace(/^[\s)\]},]+/, "");
  return /^(?:\.[\w$]+\(.*\))?\s*\?;$/.test(tail) || tail === ";";
}



/** Findings for one source: JNI calls whose `Z` return is dropped. */
export function droppedBooleans(src) {
  const out = [];
  const code = stripComments(src);
  for (const call of jniCalls(code)) {
    if (call.ret !== "Z") continue;
    const stmt = statementAt(code, call.index);
    if (stmt === null || !dropsBoolean(stmt.text)) continue;
    out.push({
      method: call.method,
      signature: call.signature,
      line: src.slice(0, call.index).split("\n").length,
      statement: stmt.text.replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

/** Every production Rust source under `crates/` (tests/examples/benches excluded). */
function rustFiles() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (["target", "node_modules", ".git"].includes(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.endsWith(".rs") && !/\/(tests|examples|benches)\//.test(p)) out.push(p);
    }
  };
  walk(join(root, "crates"));
  return out.sort();
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const discarded = [
    '    env.call_method(&mgr, "setWifiEnabled", "(Z)Z", &[JValue::from(on)])',
    "        .and_then(|v| v.z())",
    "        .map_err(jerr)?;",
    "    Ok(())",
  ].join("\n");
  const found = droppedBooleans(discarded);
  ok("a dropped Z return is found", found.length === 1);
  ok("the signature is reported", found[0]?.signature === "(Z)Z");
  ok("the statement is reported", found[0]?.statement.startsWith("env.call_method"));
  ok("the line number is reported", found[0]?.line === 1);

  ok(
    "a bound + returned boolean is not a finding",
    droppedBooleans('let accepted = env.call_method(&m, "x", "(Z)Z", &[]).map_err(jerr)?.z()?;\nOk(accepted)')
      .length === 0,
  );
  ok(
    "a test (if/while) is not a finding",
    droppedBooleans('if !env.call_method(&m, "x", "()Z", &[]).map_err(jerr)?.z()? { return Ok(()); }').length === 0,
  );
  ok(
    "a comparison is not a finding",
    droppedBooleans('while env.call_method(&m, "x", "()Z", &[]).map_err(jerr)?.z()? {}').length === 0,
  );
  ok("a void call is not a finding", droppedBooleans('env.call_method(&m, "x", "()V", &[]).map_err(jerr)?;').length === 0);
  ok(
    "an object return is out of scope",
    droppedBooleans('env.call_method(&m, "x", "()Ljava/lang/Object;", &[]).map_err(jerr)?;').length === 0,
  );
  ok("a `.z()` that is not a JNI call is out of scope", droppedBooleans("v.z()?;").length === 0);

  const withComment = [
    "        // a comment with a semicolon; must not end the statement",
    '        env.call_method(&mgr, "setWifiEnabled", "(Z)Z", &[JValue::from(on)])',
    "            .and_then(|v| v.z())",
    "            .map_err(jerr)?;",
  ].join("\n");
  ok("a `;` in a comment does not split the statement", droppedBooleans(withComment).length === 1);
  ok("a `;` in a block comment does not split the statement", droppedBooleans("/* x; y */\nenv.call_method(&m, \"x\", \"()Z\", &[]).map_err(jerr)?.z()?;").length === 1);
  ok("a `//` inside a string is not a comment", dropsBoolean('env.call_method(&m, "http://x;a", "()Z", &[]).map_err(jerr)?.z()?;'));
  ok("stripComments preserves offsets", stripComments("a // b\nc").length === "a // b\nc".length);

  const sigSrc = 'env.call_method(&m, "x", "(Ljava/lang/String;)Z", &[]).map_err(jerr)?;';
  const sigCall = jniCalls(sigSrc)[0];
  ok("the return type after a `;`-bearing signature is read", sigCall?.ret === "Z");
  ok(
    "a `;` inside the signature does not split the call",
    statementAt(sigSrc, sigCall.index)?.text === sigSrc,
  );
  const withStringSemi = droppedBooleans(
    'env.call_method(&m, "x;y", "(Z)Z", &[]).map_err(|e| format!("a; b"))?.z()?;',
  );
  ok("a `;` inside a string does not split the call", withStringSemi.length === 1);
  ok("an unterminated call yields nothing", droppedBooleans('env.call_method(&m, "x", "(Z)Z", &[]').length === 0);
  ok(
    "a tail expression (no `;`) yields nothing",
    droppedBooleans('fn f() -> Result<bool> {\n  env.call_method(&m, "x", "()Z", &[]).map_err(jerr)?.z().map_err(jerr)\n}').length === 0,
  );

  // The macro wrapper (REQ-A186's `jni!(env, <call>)`) is how nearly every call in this
  // tree is written, and the walk used to stop at the macro's own `)` — so a discarded
  // boolean inside it was invisible. Pinned from both sides (REQ-A199).
  const wrappedDiscard = [
    "        jni!(",
    "            env,",
    '            env.call_method(&adapter, "setName", "(Ljava/lang/String;)Z", &[JValue::Object(&jname)]),',
    "        )?",
    "        .z()",
    "        .map_err(jerr)?;",
  ].join("\n");
  const wrappedFound = droppedBooleans(wrappedDiscard);
  ok("a boolean discarded through the `jni!` wrapper is found", wrappedFound.length === 1);
  ok(
    "the wrapped statement is reported",
    wrappedFound[0]?.statement.startsWith("jni!("),
  );
  ok(
    "a boolean bound through the `jni!` wrapper is not a finding",
    droppedBooleans(
      'let accepted = jni!(\n    env,\n    env.call_method(&a, "setName", "(Ljava/lang/String;)Z", &[JValue::Object(&n)]),\n)?\n.z()\n.map_err(jerr)?;\nif !accepted { return Err(x); }',
    ).length === 0,
  );
  ok(
    "a boolean returned inside `Ok(…)` is still out of scope",
    droppedBooleans(
      'Ok(jni!(\n    env,\n    env.call_method(&a, "isEnabled", "()Z", &[]),\n)?\n.z()\n.map_err(jerr)?)',
    ).length === 0,
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[jni-boolean-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[jni-boolean-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

// --- scan -------------------------------------------------------------------
function runScan() {
  const findings = [];
  let scanned = 0;
  let booleanCalls = 0;
  for (const file of rustFiles()) {
    const src = readFileSync(file, "utf8");
    scanned++;
    const rel = file.slice(root.length + 1);
    booleanCalls += jniCalls(stripComments(src)).filter((c) => c.ret === "Z").length;
    for (const f of droppedBooleans(src)) findings.push({ file: rel, ...f });
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ files: scanned, booleanCalls, findings }, null, 2));
  } else {
    console.log(
      `[jni-boolean-scan] ${scanned} production Rust source(s); ${booleanCalls} JNI call(s) returning a boolean.`,
    );
    for (const f of findings) {
      console.error(
        `[jni-boolean-scan] FAIL — ${f.file}:${f.line} throws the platform's answer away: ` +
          `${f.signature} → ${f.statement} (bind it, or turn a refusal into an error)`,
      );
    }
    if (findings.length === 0) {
      console.log("[jni-boolean-scan] OK — every JNI boolean return is used; no platform verdict is discarded.");
    }
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();
