#!/usr/bin/env node
/**
 * tauri-reply-scan.mjs — "the reply the shell reads cannot be the reply the
 * command sends".
 *
 * Why: `tauri-command-scan.mjs` checks the command *name* and `tauri-args-scan.mjs`
 * the *arguments*. Nothing checked the **return value**, and the SMS trash panel
 * was dead on device because of it (Round 47):
 *
 *   * `sms_trash_list` returns `Vec<TrashOut>` (`thread_id`, `message_id`,
 *     `ts_ms`, `trashed_ms`), but the shell declared `SmsTrashEntryOut` with
 *     camelCase fields — every read was `undefined` (blank rows, a `each` keyed on
 *     `"undefined/undefined"`, restore sending blank ids).
 *   * `sms_trash_restore` returns a **bool** and `sms_trash_purge` a **usize**, yet
 *     both wrappers compared the value to a string (`=== "restored"`), so a
 *     successful restore/purge was reported as a failure.
 *
 * Tauri serializes a command's return value with **serde's own rules** (this
 * workspace sets no `rename_all = "camelCase"` anywhere), so the wire shape is the
 * Rust struct/enum/scalar as written. This gate compares, per `invoke<T>("cmd")`:
 *
 *   1. **scalar kinds** — Rust `bool` ⇒ TS `boolean`, numeric ⇒ `number`,
 *      `String`/`&str` ⇒ `string`, `Vec<T>` ⇒ `T[]`, `Option<T>` ⇒ `T | null`;
 *   2. **object fields** — every field the TS type declares must exist in the Rust
 *      struct/enum's serialized field set (the camelCase-vs-snake_case class);
 *   3. a Rust field the shell never reads is reported as **informational** only
 *      (the shell need not model every wire field).
 *
 * Honest boundary: only *statically nameable* pairs are checked — the invoke
 * generic must be a local interface/type name or an inline object type, and the
 * Rust return type must resolve (`Result<T, E>`/`Option<T>`/`Vec<T>` unwrapped to a
 * local struct or a known scalar). A union alias, `unknown`, a generic parameter, a
 * struct with `#[serde(flatten)]`/`skip_serializing`, or a serde-`Value` return is
 * **skipped, never guessed** — a missed finding is quieter than a false CI failure.
 *
 * Usage (repo root):
 *   node scripts/tauri-reply-scan.mjs              # gate
 *   node scripts/tauri-reply-scan.mjs --json       # machine-readable
 *   node scripts/tauri-reply-scan.mjs --selftest   # pin the extractors
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_SRC = join(root, "crates/amos-tauri/src");
const FE_SRC = join(root, "crates/amos-tauri/frontend-ts/src");

const SKIP = new Set(["node_modules", "target", ".git", "gen", "dist"]);

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

/** Strip `//…` and block comments. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g).replace(/\/\/[^\n]*/g, "");
}

export function matchBracket(src, open, lifetimes = false) {
  const pairs = { "(": ")", "{": "}", "[": "]", "<": ">" };
  const close = pairs[src[open]];
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
      const isLifetime = lifetimes && /[A-Za-z_]/.test(src[i + 1] ?? "") && src[i + 2] !== "'";
      if (!isLifetime) quote = "'";
    } else if (c === opener) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split `a, b` (or `a; b` in a TS interface) on top-level separators. */
export function splitTopLevel(src) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of src) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if ((ch === "," || ch === ";") && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Rust structs/enums with their **serialized** field names:
 * `Map<name, { fields: string[], opaque: boolean }>`. `opaque` marks a type whose
 * field set we cannot trust (`#[serde(flatten)]`, `skip_serializing*`, custom
 * `Serialize`, `serde_json::Value`) — those are never compared.
 */
export function parseRustShapes(src) {
  const clean = stripComments(src);
  const out = new Map();
  const re = /#\[derive\([^)]*Serialize[^)]*\)\]\s*((?:#\[[^\]]*\]\s*)*)pub\s+(struct|enum)\s+([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(clean))) {
    const attrs = m[1];
    const kind = m[2];
    const name = m[3];
    const brace = clean.indexOf("{", re.lastIndex);
    if (brace < 0) continue;
    const close = matchBracket(clean, brace);
    if (close < 0) continue;
    const body = clean.slice(brace + 1, close);
    const renameAll = /rename_all\s*=\s*"([A-Za-z_]+)"/.exec(attrs)?.[1] ?? "";
    let opaque = /flatten|skip_serializing|serde\(into|with\s*=|serialize_with/.test(attrs + body);
    const fields = [];
    const renameOf = (field) => {
      if (!renameAll) return field;
      if (renameAll === "camelCase") {
        return field.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      }
      return field; // snake_case / lowercase: the Rust spelling
    };
    if (kind === "struct") {
      for (const part of splitTopLevel(body)) {
        const fm = /^\s*(?:pub\s+)?([a-z_]\w*)\s*:/.exec(part);
        if (fm) fields.push(renameOf(fm[1]));
        else if (part.trim().startsWith("//") === false && part.includes(":")) opaque = true;
      }
    } else {
      // Enum variants: serde's default external tagging serializes a unit variant as
      // a bare string and a struct/tuple variant as `{"Variant": …}`.
      for (const part of splitTopLevel(body)) {
        const vm = /^\s*([A-Z]\w*)\s*[({]?/.exec(part);
        if (vm) fields.push(vm[1]);
        else if (part.trim() !== "") opaque = true;
      }
    }
    out.set(name, { fields, opaque });
  }
  return out;
}

/**
 * Rust command return types: `Map<command, typeText>` (`Result<T, E>` unwrapped).
 */
export function parseReturns(src) {
  const clean = stripComments(src);
  const out = new Map();
  const re = /#\[tauri::command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const name = m[1];
    const open = re.lastIndex - 1;
    const close = matchBracket(clean, open, true);
    if (close < 0) continue;
    const arrow = clean.slice(close + 1).match(/^\s*->\s*([^{]+?)\s*\{/);
    out.set(name, arrow ? arrow[1].trim() : "()");
  }
  return out;
}



/**
 * TS object shapes: `Map<name, string[] fields>` for both `interface X { … }` and
 * `type X = { … }` (camelCase or snake_case as written — the point is to compare
 * them with the wire). A union/mapped/generic alias is not an object shape and is
 * left out (its uses then resolve to `unknown`, i.e. unverifiable).
 */
export function parseTsInterfaces(src) {
  const clean = stripComments(src);
  const out = new Map();
  const re = /(?:export\s+)?(?:interface\s+([A-Za-z_]\w*)\s*|type\s+([A-Za-z_]\w*)\s*=\s*)\{/g;
  let m;
  while ((m = re.exec(clean))) {
    const name = m[1] ?? m[2];
    const close = matchBracket(clean, re.lastIndex - 1);
    if (close < 0) continue;
    const fields = [];
    for (const part of splitTopLevel(clean.slice(re.lastIndex, close))) {
      const fm = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(part);
      if (fm) fields.push(fm[1]);
    }
    out.set(name, fields);
    re.lastIndex = close;
  }
  return out;
}

/** `invoke<T>("cmd")` call sites: `[{ typeText, command }]` (T may be inline). */
export function parseInvokeGenerics(src) {
  const clean = stripComments(src);
  const out = [];
  const re = /\binvoke\s*</g;
  let m;
  while ((m = re.exec(clean))) {
    const open = re.lastIndex - 1;
    const close = matchBracket(clean, open);
    if (close < 0) continue;
    const typeText = clean.slice(open + 1, close).trim();
    const after = clean.slice(close + 1).match(/^\s*\(\s*"([a-z0-9_]+)"/);
    if (after) out.push({ typeText, command: after[1] });
    re.lastIndex = close;
  }
  return out;
}

const SCALAR = {
  bool: "boolean",
  String: "string",
  "&str": "string",
  str: "string",
  i8: "number",
  i16: "number",
  i32: "number",
  i64: "number",
  isize: "number",
  u8: "number",
  u16: "number",
  u32: "number",
  u64: "number",
  usize: "number",
  f32: "number",
  f64: "number",
  "()": "null",
};

/** Peek past `Result<…>`/`Option<…>`: returns the inner text, or null. */
export function unwrapGeneric(typeText, name) {
  const t = typeText.trim();
  if (!t.startsWith(name + "<")) return null;
  const close = matchBracket(t, name.length);
  if (close < 0) return null;
  const inner = t.slice(name.length + 1, close);
  return t.slice(close + 1).trim() === "" ? inner : null;
}

/**
 * Resolve a Rust type to `{ kind, inner?, shape? }` where `kind` is
 * `boolean | number | string | array | null | object | unknown`.
 */
export function resolveRustType(typeText, shapes) {
  let t = typeText.trim();
  const fromResult = unwrapGeneric(t, "Result");
  // `Result<T, E>` → the **Ok** type (the first top-level segment).
  if (fromResult !== null) t = splitTopLevel(fromResult)[0].trim();
  const opt = unwrapGeneric(t, "Option");
  if (opt !== null) t = opt;
  const vec = unwrapGeneric(t, "Vec");
  if (vec !== null) {
    const inner = resolveRustType(vec, shapes);
    return inner.kind === "unknown" ? { kind: "unknown" } : { kind: "array", inner };
  }
  if (SCALAR[t]) return { kind: SCALAR[t] };
  if (t.includes("<")) return { kind: "unknown" }; // HashMap/tuple/… we do not model
  if (/^[A-Za-z_]\w*$/.test(t)) {
    const shape = shapes.get(t);
    if (!shape || shape.opaque) return { kind: "unknown" };
    return { kind: "object", shape: t };
  }
  return { kind: "unknown" };
}

/** Resolve a TS type text to `{ kind, fields?, typeName? }` the same way. */
export function resolveTsType(typeText, interfaces) {
  let t = typeText.trim();
  while (t.endsWith("| null") || t.endsWith("| undefined")) {
    t = t.slice(0, t.lastIndexOf("|")).trim();
  }
  if (/^(void|undefined)$/.test(t)) return { kind: "null" };
  if (t === "boolean") return { kind: "boolean" };
  if (t === "number") return { kind: "number" };
  if (t === "string") return { kind: "string" };
  if (/^(unknown|any)$/.test(t)) return { kind: "unknown" };
  const arr = /^([A-Za-z_]\w*)\[\]$/.exec(t) ?? /^Array<([A-Za-z_]\w*)>$/.exec(t);
  if (arr) {
    const inner = resolveTsType(arr[1], interfaces);
    return inner.kind === "unknown" ? { kind: "unknown" } : { kind: "array", inner };
  }
  if (t.startsWith("{")) {
    const close = matchBracket(t, 0);
    if (close < 0) return { kind: "unknown" };
    const fields = [];
    for (const part of splitTopLevel(t.slice(1, close))) {
      const fm = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(part);
      if (fm) fields.push(fm[1]);
      else if (part.trim() !== "") return { kind: "unknown" };
    }
    return { kind: "object", fields, typeName: "<inline>" };
  }
  if (/^[A-Za-z_]\w*$/.test(t)) {
    const fields = interfaces.get(t);
    if (!fields) return { kind: "unknown" };
    return { kind: "object", fields, typeName: t };
  }
  return { kind: "unknown" }; // unions, generics, mapped types — out of scope
}

/** Compare one resolved pair (pure). Empty when they agree or are unverifiable. */
export function compareReply(command, rust, ts, rustShapes) {
  if (rust.kind === "unknown" || ts.kind === "unknown") return [];
  if (rust.kind !== ts.kind) {
    return [
      {
        kind: "value-kind",
        command,
        detail: `the shell reads the reply as ${ts.kind} (${ts.typeName ?? "scalar"}), the command returns ${rust.kind}`,
      },
    ];
  }
  if (rust.kind === "array") return compareReply(command, rust.inner, ts.inner, rustShapes);
  if (rust.kind !== "object") return [];
  const shape = rustShapes.get(rust.shape);
  if (!shape) return [];
  const known = new Set(shape.fields);
  const stray = ts.fields.filter((f) => !known.has(f));
  if (stray.length === 0) return [];
  return [
    {
      kind: "field-name",
      command,
      detail:
        `\`${ts.typeName}\` declares ${stray.map((f) => `\`${f}\``).join(", ")} — absent from the reply's ` +
        `\`${rust.shape}\` (which serializes: ${shape.fields.join(", ") || "no fields"})`,
    },
  ];
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const shapes = parseRustShapes(
    [
      "#[derive(Clone, Debug, PartialEq, Serialize)]",
      "pub struct TrashOut {",
      "    pub thread_id: String,",
      "    pub message_id: String,",
      "    pub ts_ms: i64,",
      "    pub trashed_ms: i64,",
      "}",
      "#[derive(Serialize)]",
      '#[serde(rename_all = "camelCase")]',
      "pub struct Camel { pub display_name: String }",
      "#[derive(Serialize)]",
      "#[serde(flatten)]",
      "pub struct Flattened { pub a: String }",
    ].join("\n"),
  );
  ok("parses snake_case struct fields", shapes.get("TrashOut").fields.join(",") === "thread_id,message_id,ts_ms,trashed_ms");
  ok("honours serde rename_all = camelCase", shapes.get("Camel").fields[0] === "displayName");
  ok("a flattened struct is opaque, never compared", shapes.get("Flattened").opaque === true);

  const returns = parseReturns(
    [
      "#[tauri::command]",
      "pub fn sms_trash_purge() -> usize {",
      "    0",
      "}",
      "#[tauri::command]",
      "pub async fn sms_trash_list() -> Vec<TrashOut> {",
      "    Vec::new()",
      "}",
      "#[tauri::command]",
      "pub async fn sms_status(state: State<'_, SmsBridge>) -> SmsStatusOut {",
      "    todo!()",
      "}",
    ].join("\n"),
  );
  ok("reads a scalar return", returns.get("sms_trash_purge") === "usize");
  ok("reads a Vec return", returns.get("sms_trash_list") === "Vec<TrashOut>");
  ok("reads a struct return past an injected State", returns.get("sms_status") === "SmsStatusOut");

  const ifaces = parseTsInterfaces(
    [
      "export interface SmsTrashEntryOut {",
      "  thread_id: string;",
      "  message_id: string;",
      "}",
      "interface Bad { threadId: string }",
    ].join("\n"),
  );
  ok("parses TS interface fields", ifaces.get("SmsTrashEntryOut").join(",") === "thread_id,message_id");
  ok("parses a private interface too", ifaces.get("Bad").join(",") === "threadId");

  const generics = parseInvokeGenerics(
    [
      'invoke<SmsTrashEntryOut[]>("sms_trash_list");',
      'invoke<number>("sms_trash_purge");',
      'invoke<{ due: string[] }>("scheduler_alarm_poll", { nowMs });',
      "invoke(cmd, {});",
    ].join("\n"),
  );
  ok("reads an array generic", generics.find((g) => g.command === "sms_trash_list")?.typeText === "SmsTrashEntryOut[]");
  ok("reads an inline object generic", generics.find((g) => g.command === "scheduler_alarm_poll")?.typeText === "{ due: string[] }");
  ok("ignores an untyped invoke", !generics.some((g) => g.typeText === "cmd"));

  const r = (t) => resolveRustType(t, shapes);
  ok("Result<T, E> unwraps to T", resolveRustType("Result<Vec<TrashOut>, String>", shapes).kind === "array");
  ok("Option<T> unwraps", resolveRustType("Option<u64>", shapes).kind === "number");
  ok("bool → boolean", r("bool").kind === "boolean");
  ok("usize/u64 → number", r("usize").kind === "number" && r("u64").kind === "number");
  ok("String → string", r("String").kind === "string");
  ok("a known struct → object", r("TrashOut").kind === "object");
  ok("() → null", r("()").kind === "null");
  ok("an unknown name → unknown", r("HashMap<String, u32>").kind === "unknown");
  ok("a flattened struct → unknown", r("Flattened").kind === "unknown");

  const ts = (t) => resolveTsType(t, ifaces);
  ok("TS boolean → boolean", ts("boolean").kind === "boolean");
  ok("TS number → number", ts("number").kind === "number");
  ok("TS string → string", ts("string").kind === "string");
  ok("TS array of a known interface", ts("SmsTrashEntryOut[]").kind === "array");
  ok("TS union alias → unknown", ts("SmsTrashAddResult").kind === "unknown");
  ok("TS | null is unwrapped", ts("TelephonyCall | null").kind === "unknown" && ts("number | null").kind === "number");

  // The two real defects this gate was built from, as pure negative controls.
  const trashList = compareReply(
    "sms_trash_list",
    resolveRustType("Vec<TrashOut>", shapes),
    resolveTsType("SmsTrashEntryOut[]", ifaces),
    shapes,
  );
  ok("a snake_case TS type agrees with the same-named Rust fields", trashList.length === 0);
  const camelIfaces = parseTsInterfaces("export interface Entry { threadId: string; messageId: string }");
  const camelFinding = compareReply(
    "sms_trash_list",
    resolveRustType("Vec<TrashOut>", shapes),
    resolveTsType("Entry[]", camelIfaces),
    shapes,
  );
  ok(
    "a camelCase TS type is a finding (the Round-47 defect)",
    camelFinding.length === 1 && camelFinding[0].kind === "field-name" && camelFinding[0].detail.includes("threadId"),
  );
  const kindFinding = compareReply(
    "sms_trash_restore",
    resolveRustType("bool", shapes),
    resolveTsType("string", ifaces),
    shapes,
  );
  ok(
    "reading a bool reply as string is a finding (the other Round-47 defect)",
    kindFinding.length === 1 && kindFinding[0].kind === "value-kind",
  );
  ok(
    "an unverifiable pair is skipped, not guessed",
    compareReply("x", resolveRustType("serde_json::Value", shapes), resolveTsType("unknown", ifaces), shapes).length === 0,
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[tauri-reply-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[tauri-reply-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
/**
 * True when this file is the process entry point. Guards the selftest/scan
 * dispatch so another script may `import` the extractors without side effects
 * (see `scripts/tauri-event-scan.mjs`, which reuses them).
 */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();




// --- scan -------------------------------------------------------------------
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();

function runScan() {
  const rustFiles = walk(RUST_SRC, ".rs");
  const shapes = new Map();
  const returns = new Map();
  for (const f of rustFiles) {
    const src = readFileSync(f, "utf8");
    const cut = src.indexOf("#[cfg(test)]");
    const prod = cut < 0 ? src : src.slice(0, cut);
    for (const [k, v] of parseRustShapes(prod)) shapes.set(k, v);
    for (const [k, v] of parseReturns(prod)) returns.set(k, v);
  }

  const feFiles = walk(FE_SRC, ".ts")
    .concat(walk(FE_SRC, ".svelte"))
    .filter((f) => !f.includes("/__tests__/") && !/\.test\.[cm]?[jt]sx?$/.test(f));

  const findings = [];
  let checked = 0;
  let skipped = 0;
  for (const f of feFiles) {
    const src = readFileSync(f, "utf8");
    const interfaces = parseTsInterfaces(src);
    for (const call of parseInvokeGenerics(src)) {
      const returnType = returns.get(call.command);
      if (!returnType) {
        skipped++;
        continue;
      }
      const rust = resolveRustType(returnType, shapes);
      const ts = resolveTsType(call.typeText, interfaces);
      if (rust.kind === "unknown" || ts.kind === "unknown") {
        skipped++;
        continue;
      }
      checked++;
      for (const finding of compareReply(call.command, rust, ts, shapes)) {
        findings.push({ file: relative(root, f), ...finding });
      }
    }
  }

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          shapes: shapes.size,
          commandsWithReturns: returns.size,
          repliesChecked: checked,
          repliesSkipped: skipped,
          findings,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[tauri-reply-scan] ${returns.size} command(s) with a return type; ${shapes.size} serializable shape(s); ` +
        `${checked} typed reply(ies) checked, ${skipped} unverifiable (skipped).`,
    );
    for (const f of findings) {
      console.error(`[tauri-reply-scan] FAIL — ${f.file}: \`${f.command}\` ${f.detail}`);
    }
    if (findings.length > 0) {
      console.error(
        "\nFix by reading what the command actually returns: Tauri serializes the reply\n" +
          "with serde's own rules (a struct's fields keep their Rust spelling unless the\n" +
          "struct sets `rename_all`; a `bool`/`usize` is a boolean/number, never a string).",
      );
    } else {
      console.log(
        "[tauri-reply-scan] OK — every statically readable reply type matches the command's return shape.",
      );
    }
  }

  process.exit(findings.length === 0 ? 0 : 1);
}
