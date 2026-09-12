#!/usr/bin/env node
/**
 * tauri-args-scan.mjs — "the payload the shell sends cannot be what the command
 * declared".
 *
 * Why: `tauri-command-scan.mjs` proves a registered command **is asked for**, but
 * not that the call can succeed. Tauri's `#[tauri::command]` macro looks each
 * argument up by its **lowerCamelCase** name (tauri-macros `ArgumentCase::Camel`
 * is the default and this workspace sets no `rename_all`; the scan reads one if it
 * ever appears) and
 * `CommandItem::deserialize_json` does a plain `payload.get(key)` — a key that is
 * absent is an error for a non-optional parameter, and **silently `None` for an
 * `Option<_>` one** (tauri/src/ipc/command.rs). So:
 *
 *   * `invoke("rag_query", { top_k })` — the Rust parameter is `top_k`, the wire
 *     key is `topK`, so the key is missing → the command **always** failed. The
 *     retrieval path ("ask my notes") was dead while `tsc`, every unit test (the
 *     fake bridge only saw the command *name*) and the command scan stayed green.
 *   * `invoke("interpret_start", { source_lang })` — `Option<String>` → the
 *     interpreter **silently ignored** the language the user picked and always
 *     ran the `auto`/`zh` default.
 *
 * Both defects are one shape: **a frontend payload key that no Rust parameter can
 * ever match**. Per `invoke` call this gate checks:
 *
 *   1. every literal key of the payload is one of the command's argument keys
 *      (a stray key is never read by anything — a typo or a stale spelling);
 *   2. every **required** (non-`Option`) argument key is present;
 *   3. the command name itself exists (`#[tauri::command]` + registered).
 *
 * Scope and honest boundary: only a **quoted literal** command name with an
 * **object-literal** payload is checked. A computed name (`invoke(NAME)`), a
 * payload built elsewhere (`invoke("x", opts)`), a spread (`{ ...opts }`) or a
 * computed key makes the call **unverifiable** and is skipped — a missed finding
 * is quieter than a false CI failure. Plugin commands (`plugin:event|listen`) are
 * not `#[tauri::command]`s and are out of scope.
 *
 * Usage (repo root):
 *   node scripts/tauri-args-scan.mjs              # gate
 *   node scripts/tauri-args-scan.mjs --json       # machine-readable
 *   node scripts/tauri-args-scan.mjs --selftest   # pin the extractors
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_SRC = join(root, "crates/amos-tauri/src");
const LIB_RS = join(RUST_SRC, "lib.rs");
const FE_SRC = join(root, "crates/amos-tauri/frontend-ts/src");

const SKIP = new Set(["node_modules", "target", ".git", "gen", "dist"]);

/** Parameter types the host injects (never sent from JS), vs. ones the JS names. */
const INJECTED_TYPES = [/\bState</, /\bAppHandle\b/, /\bWindow</, /\bWebviewWindow\b/, /\bWebview</];

function walk(dir, ext, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, ext, acc);
    else if (p.endsWith(ext)) acc.push(p);
  }
  return acc;
}

/** Strip `//…` and block comments (a call named only in a comment is not a call). */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** `source_lang` → `sourceLang` (the `heck` conversion tauri-macros applies). */
export function lowerCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

const PAIRS = { "(": ")", "{": "}", "[": "]" };

/**
 * Index of the bracket matching the opener at `open`, or -1. Same quote handling
 * as [`matchBracket`]'s callers expect; with `lifetimes` (Rust), `'_`/`'a`/
 * `'static` are *lifetimes*, not the opening quote of a literal — misreading one
 * swallows the rest of the signature.
 */
export function matchBracket(src, open, lifetimes = false) {
  const close = PAIRS[src[open]];
  if (!close) return -1;
  const opener = src[open];
  let depth = 0;
  let quote = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "`") quote = c;
    else if (c === "'") {
      const isLifetime =
        lifetimes && /[A-Za-z_]/.test(src[i + 1] ?? "") && src[i + 2] !== "'";
      if (!isLifetime) quote = "'";
    } else if (c === opener) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `(` → the matching `)` (a Rust signature). */
export function matchParen(src, open, lifetimes = false) {
  return matchBracket(src, open, lifetimes);
}

/** Split `a: T, b: U` on top-level commas (generics/arrays/tuples stay intact). */
export function splitTopLevel(src) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of src) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * `#[tauri::command]` fns with their **wire** argument keys:
 * `[{ name, params: [{ rust, key, optional, injected }] }]`.
 */
export function parseCommandArgs(src) {
  const clean = stripComments(src);
  const out = [];
  const re =
    /#\[tauri::command\s*(?:\(([^)]*)\))?\][\s\S]{0,400}?\bfn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const snake = /rename_all\s*=\s*"snake_case"/.test(m[1] ?? "");
    const name = m[2];
    const open = re.lastIndex - 1;
    const close = matchParen(clean, open, true);
    if (close < 0) continue;
    const params = [];
    for (const part of splitTopLevel(clean.slice(open + 1, close))) {
      const pm = /^\s*(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(part);
      if (!pm) continue;
      const [, rust, rawType] = pm;
      const type = rawType.trim();
      params.push({
        rust,
        type,
        // `#[tauri::command(rename_all = "snake_case")]` keeps the Rust spelling.
        key: snake ? rust.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()) : lowerCamel(rust),
        optional: /^Option\s*</.test(type),
        injected: INJECTED_TYPES.some((r) => r.test(type)),
      });
    }
    out.push({ name, params });
  }
  return out;
}

/** Command names from a `generate_handler![…]` block (last path segment). */
export function parseRegistered(src) {
  const start = src.indexOf("generate_handler!");
  if (start < 0) return [];
  const open = src.indexOf("[", start);
  const close = src.indexOf("]", open);
  if (open < 0 || close < 0) return [];
  return stripComments(src.slice(open + 1, close))
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "")
    .map((e) => e.split("::").pop().trim())
    .filter((e) => /^[A-Za-z_]\w*$/.test(e));
}

/**
 * `invoke("cmd", { … })` call sites.
 * `payload.kind`: `"none"` (no second argument) | `"object"` (literal keys) |
 * `"opaque"` (an expression we cannot read). `opaque: true` also marks an object
 * whose keys are unreadable (spread / computed key). `name` is `null` for a
 * computed command name (out of scope).
 */
export function parseInvokeCalls(src) {
  const clean = stripComments(src);
  const out = [];
  const re = /\binvoke\s*(?:<[^>()]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const open = re.lastIndex - 1;
    let i = open + 1;
    const skipWs = () => {
      while (i < clean.length && /\s/.test(clean[i])) i++;
    };
    skipWs();
    const quote = clean[i];
    if (quote !== '"' && quote !== "'") continue; // computed name — out of scope
    const end = clean.indexOf(quote, i + 1);
    if (end < 0) continue;
    const lit = clean.slice(i + 1, end);
    // `plugin:event|listen` is not a `#[tauri::command]`; treat it as out of scope.
    const name = /^[A-Za-z_]\w*$/.test(lit) ? lit : null;
    i = end + 1;
    skipWs();
    let payload = { kind: "none", keys: [], opaque: false };
    if (clean[i] === ",") {
      i++;
      skipWs();
      if (clean[i] === "{") {
        const close = matchBracket(clean, i);
        if (close < 0) {
          // Unterminated object literal — unverifiable, but still counted.
          out.push({ name, payload: { kind: "opaque", keys: [], opaque: true } });
          continue;
        }
        const keys = [];
        let opaque = false;
        for (const seg of splitTopLevel(clean.slice(i + 1, close))) {
          const t = seg.trim();
          if (t === "") continue;
          if (t.startsWith("...") || t.startsWith("[")) {
            opaque = true; // spread / computed key — the key set is unknown
            continue;
          }
          const kv = /^([A-Za-z_$][\w$]*)\s*:/.exec(t);
          if (kv) keys.push(kv[1]);
          else if (/^[A-Za-z_$][\w$]*$/.test(t)) keys.push(t); // shorthand `{ query }`
          else if (/^["'][^"']*["']\s*:/.test(t)) keys.push(t.slice(1, t.indexOf(t[0], 1)));
          else opaque = true;
        }
        payload = { kind: "object", keys, opaque };
      } else if (clean[i] !== ")") {
        payload = { kind: "opaque", keys: [], opaque: true };
      }
    }
    out.push({ name, payload });
  }
  return out;
}

/** Findings for one call site against its command's declared argument keys (pure). */
export function checkCall(cmd, payload) {
  const findings = [];
  const expected = new Map(
    (cmd?.params ?? []).filter((p) => !p.injected).map((p) => [p.key, p]),
  );
  if (payload.kind === "object" && !payload.opaque) {
    for (const key of payload.keys) {
      if (!expected.has(key)) {
        findings.push({ kind: "unknown-key", key, expected: [...expected.keys()].sort() });
      }
    }
  }
  if (payload.kind !== "opaque" && !payload.opaque) {
    const present = new Set(payload.keys);
    for (const [key, p] of expected) {
      if (!p.optional && !present.has(key)) findings.push({ kind: "missing-required", key });
    }
  }
  return findings;
}


// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  ok("lowerCamel converts a snake_case key", lowerCamel("source_lang") === "sourceLang");
  ok("lowerCamel keeps a single word", lowerCamel("query") === "query");
  ok("lowerCamel keeps trailing digits", lowerCamel("top_k2") === "topK2");

  const cmds = parseCommandArgs(
    [
      "#[tauri::command]",
      "pub async fn rag_query(query: String, top_k: u32) -> Result<A, String> {",
      "  todo!()",
      "}",
      "#[tauri::command]",
      "pub async fn interpret_start(",
      "  app: AppHandle,",
      "  state: State<'_, Bridge>,",
      "  source_lang: Option<String>,",
      "  target_lang: Option<String>,",
      ") -> Result<u64, String> { todo!() }",
      "#[tauri::command]",
      "pub fn double_nested(v: Vec<HashMap<String, u32>>) {}",
    ].join("\n"),
  );
  const byName = new Map(cmds.map((c) => [c.name, c]));
  ok("parses every command", cmds.length === 3);
  ok(
    "argument keys are lowerCamelCase",
    byName.get("rag_query").params.map((p) => p.key).join(",") === "query,topK",
  );
  ok(
    "Option<T> is optional, others required",
    byName.get("interpret_start").params.filter((p) => !p.injected)[0].optional === true &&
      byName.get("rag_query").params[1].optional === false,
  );
  ok(
    "AppHandle/State are injected, not wire args",
    byName.get("interpret_start").params.filter((p) => p.injected).length === 2,
  );
  ok("a generic with a comma stays one parameter", byName.get("double_nested").params.length === 1);
  const snakeCmd = parseCommandArgs(
    [
      '#[tauri::command(rename_all = "snake_case")]',
      "pub fn snake_lang(source_lang: Option<String>, top_k: u32) {}",
    ].join("\n"),
  )[0];
  ok(
    "rename_all = snake_case keeps the Rust key spelling",
    snakeCmd.params.map((p) => p.key).join(",") === "source_lang,top_k",
  );

  const calls = parseInvokeCalls(
    [
      'invoke("a", { query, topK: 3 });',
      'invoke("b", { top_k: 3 });',
      'invoke("c");',
      'invoke("d", opts);',
      'invoke("e", { ...opts });',
      'invoke("f", { ["k" + n]: 1 });',
      'invoke(NAME, { x: 1 });',
      'invoke("plugin:event|listen", { event: "x" });',
      'invoke<Foo>("g", { a: 1, b: { nested: true } });',
    ].join("\n"),
  );
  const find = (n) => calls.find((c) => c.name === n);
  ok("reads a literal command name", !!find("a") && !!find("b"));
  ok("reads a generic call", !!find("g"));
  ok(
    "a computed name yields no call site and a plugin command is out of scope",
    calls.length === 8 && calls.filter((c) => c.name === null).length === 1,
  );
  ok(
    "short + named keys are both read",
    JSON.stringify(find("a").payload.keys) === '["query","topK"]',
  );
  ok("a snake_case key is read verbatim", find("b").payload.keys[0] === "top_k");
  ok("no second argument → kind none", find("c").payload.kind === "none");
  ok("an identifier payload → opaque", find("d").payload.kind === "opaque");
  ok("a spread → opaque object", find("e").payload.opaque === true);
  ok("a computed key → opaque object", find("f").payload.opaque === true);
  ok(
    "nested braces do not leak a key",
    JSON.stringify(find("g").payload.keys) === '["a","b"]',
  );

  const ragQuery = byName.get("rag_query");
  const bad = checkCall(ragQuery, { kind: "object", keys: ["query", "top_k"], opaque: false });
  ok("an unknown key is a finding", bad.some((f) => f.kind === "unknown-key" && f.key === "top_k"));
  ok(
    "a present required key is not reported missing",
    !bad.some((f) => f.kind === "missing-required" && f.key === "query"),
  );
  const missing = checkCall(ragQuery, { kind: "object", keys: ["query"], opaque: false });
  ok(
    "a missing required key is a finding",
    missing.some((f) => f.kind === "missing-required" && f.key === "topK"),
  );
  ok("a correct payload has no finding", checkCall(ragQuery, { kind: "object", keys: ["query", "topK"], opaque: false }).length === 0);
  ok("an arg-less call to a required-arg command is a finding", checkCall(ragQuery, { kind: "none", keys: [], opaque: false }).length === 2);
  ok("all-optional args make an arg-less call fine", checkCall(byName.get("interpret_start"), { kind: "none", keys: [], opaque: false }).length === 0);
  ok("an opaque payload is skipped, not guessed", checkCall(ragQuery, { kind: "object", keys: [], opaque: true }).length === 0);

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[tauri-args-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[tauri-args-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
if (process.argv.includes("--selftest")) runSelftest();

// --- scan -------------------------------------------------------------------
// The extractors above are importable for tests/selftests without side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) runScan();

function runScan() {
  const libSrc = existsSync(LIB_RS) ? readFileSync(LIB_RS, "utf8") : "";
  const registered = new Set(parseRegistered(libSrc));

  const commands = new Map();
  for (const f of walk(RUST_SRC, ".rs")) {
    for (const cmd of parseCommandArgs(readFileSync(f, "utf8"))) {
      commands.set(cmd.name, { ...cmd, file: relative(root, f) });
    }
  }

  const feFiles = walk(FE_SRC, ".ts").concat(walk(FE_SRC, ".svelte"));
  const prod = feFiles.filter(
    (f) => !f.includes("/__tests__/") && !/\.test\.[cm]?[jt]sx?$/.test(f),
  );

  const findings = [];
  let checked = 0;
  let skipped = 0;
  for (const f of prod) {
    const rel = relative(root, f);
    for (const call of parseInvokeCalls(readFileSync(f, "utf8"))) {
      if (call.name === null) {
        skipped++;
        continue;
      }
      const cmd = commands.get(call.name);
      if (!cmd) {
        findings.push({ file: rel, command: call.name, kind: "unknown-command" });
        continue;
      }
      if (!registered.has(call.name)) {
        findings.push({ file: rel, command: call.name, kind: "not-registered" });
      }
      if (call.payload.kind === "opaque") {
        skipped++;
        continue;
      }
      checked++;
      for (const finding of checkCall(cmd, call.payload)) {
        findings.push({ file: rel, command: call.name, ...finding });
      }
    }
  }

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          commands: commands.size,
          productionFiles: prod.length,
          invocationsChecked: checked,
          invocationsSkipped: skipped,
          findings,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[tauri-args-scan] ${commands.size} command(s); ${prod.length} production file(s); ` +
        `${checked} invocation(s) checked, ${skipped} unverifiable (skipped).`,
    );
    for (const f of findings) {
      const what =
        f.kind === "unknown-key"
          ? `key \`${f.key}\` matches no argument of \`${f.command}\` (expected: ${f.expected.join(", ") || "none"})`
          : f.kind === "missing-required"
            ? `required argument \`${f.key}\` of \`${f.command}\` is never sent`
            : f.kind === "unknown-command"
              ? `\`${f.command}\` is not a #[tauri::command] in this workspace`
              : `\`${f.command}\` is declared but NOT registered (unreachable)`;
      console.error(`[tauri-args-scan] FAIL — ${f.file}: ${what}`);
    }
    if (findings.length > 0) {
      console.error(
        "\nFix by sending the key Tauri actually looks up — the Rust parameter in\n" +
          "lowerCamelCase (a snake_case key is silently ignored for Option<T> and a hard\n" +
          "`missing required key` error for every other type; see tauri-macros\n" +
          "ArgumentCase::Camel) — or by declaring the parameter the payload names.",
      );
    } else {
      console.log(
        "[tauri-args-scan] OK — every readable invoke payload names only real arguments and sends every required one.",
      );
    }
  }

  process.exit(findings.length === 0 ? 0 : 1);
}


