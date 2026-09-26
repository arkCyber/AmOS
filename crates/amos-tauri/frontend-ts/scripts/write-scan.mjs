#!/usr/bin/env node
/**
 * write-scan.mjs — "a user's content written without asking whether it landed".
 *
 * Why: `localStorage` fails silently when it is full or unavailable, and `writeJson`
 * used to swallow that, so screens could apply a change the store never accepted (a
 * row that vanishes on reload) or claim "已保存到相册" for a photo that was lost.
 * Rounds 53–58 converted every **real user path** to `writeStoreValueChecked`, which
 * returns whether the value landed, and made each screen act on the answer.
 *
 * The durable part is this classification gate: every production
 * `writeStoreValue(<content key>)` call site must be **either**
 *
 *   1. `writeStoreValueChecked` (the caller asks and acts), **or**
 *   2. listed in `scripts/write-allowlist.json` under a named `kind` whose reason is
 *      recorded once (demo seed / derived tick / generic wrapper).
 *
 * A **new** unverified content write therefore fails `make lint` until someone decides
 * which it is — it cannot quietly become a row the user believes is stored. Writes of
 * configuration/derived keys (notifications, settings, device mirrors) are ignored:
 * they carry no claim about the user's content. Allow-list entries that no longer
 * match a site are reported as `[stale]` so the list cannot rot.
 *
 * **What "content" means here** (stated, not left to be inferred): the keys in
 * `lib/cloud.ts`'s `SYNC_STORES` — the stores the back-up promises. Everything else is
 * configuration or derived, and `store-scan` is the gate that makes that call
 * explicit, one key at a time, each with a reason in `store-allowlist.json`. A key that
 * is neither backed up nor allow-listed fails *that* gate, so nothing falls between the
 * two by accident.
 *
 * **Key names are resolved per file, never from one corpus-wide table.** A name is
 * resolved through the module that declares it (see `buildScopes`), because the answer
 * decides the classification above: `SETTINGS_KEY` is `amos.settings` in
 * `lib/settings.ts` and `amos.webman.settings` in `lib/webman.ts`, and reading those
 * through a flat last-wins table classified every settings page against the browser's
 * key. See REQ-A812.
 *
 * Usage (from frontend-ts):
 *   node scripts/write-scan.mjs              # gate
 *   node scripts/write-scan.mjs --json       # machine-readable
 *   node scripts/write-scan.mjs --selftest   # pin the extractor
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src");
const ALLOWLIST = join(root, "scripts", "write-allowlist.json");

const TEST_RE = /(\.test\.|\.spec\.|\/__tests__\/)/;

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "target" || ent.name === ".git") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/**
 * Blank out `//…` and block comments, **keeping every newline** so reported line
 * numbers still point at the real line (a comment named in a comment is not a call
 * site, but the code below it must keep its line).
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/**
 * `[{ name, key }]` — every `const X_KEY = "amos.…"` in the corpus (exported or local,
 * as plenty of screens declare theirs locally), so a key constant is resolved through
 * the table instead of being re-spelled here.
 */
export function keyConstants(sources) {
  const out = [];
  for (const { src } of sources) {
    for (const m of stripComments(src).matchAll(
      /(?:export\s+)?const ([A-Z0-9_]*KEY[A-Z0-9_]*)\s*=\s*"((?:amos|amos-ui)\.[^"]*)"/g,
    )) {
      out.push({ name: m[1], key: m[2] });
    }
  }
  return out;
}

/** The `const X_KEY = "amos.…"` declarations of ONE file: `Map(name → key)`. */
export function localKeyConstants(src) {
  const out = new Map();
  for (const m of stripComments(src).matchAll(
    /(?:export\s+)?const ([A-Z0-9_]*KEY[A-Z0-9_]*)\s*=\s*"((?:amos|amos-ui)\.[^"]*)"/g,
  )) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Named imports of ONE file: `Map(localName → { spec, name })`, where `name` is what the
 * module exports (`import { A as B }` binds `B` locally to the module's `A`).
 */
export function importBindings(src) {
  const out = new Map();
  for (const m of stripComments(src).matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(t);
      out.set(as ? as[2] : t, { spec: m[2], name: as ? as[1] : t });
    }
  }
  return out;
}

/** `src/lib/settings.ts` → `src/lib/settings`; the identity of a module by import path. */
export function moduleId(file) {
  return file.replace(/\.(ts|svelte|js)$/, "");
}

/** Resolve a relative import specifier against the importing file's directory. */
export function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // a bare specifier is not one of ours
  const dir = fromFile.slice(0, fromFile.lastIndexOf("/"));
  return moduleId(normalize(join(dir, spec)));
}

/**
 * The key table **in scope at each file**, built once from the module graph rather than
 * from one flat name→key map. A file's scope is: every name the corpus declares with a
 * single agreed value, then the bindings the file actually imports (each read out of the
 * module that declares it), then the file's own declarations — which win, because those
 * are the ones the call site lexically sees.
 *
 * `keyConstants`'s flat table is why this exists: `SETTINGS_KEY` is `amos.settings` in
 * `lib/settings.ts` and `lib/cloud.ts` but `amos.webman.settings` in `lib/webman.ts`, and
 * a flat last-wins map silently resolved **every** `SETTINGS_KEY` call site — the settings
 * pages included — to whichever file the directory walk happened to reach last. Scope is
 * not a detail here: this table decides which store key a write is about, and therefore
 * whether the write is the user's content or configuration.
 */
export function buildScopes(sources) {
  const byModule = new Map(); // moduleId -> Map(name → key) declared there
  const seen = new Map(); // name -> Set(keys) across the corpus
  for (const { file, src } of sources) {
    const local = localKeyConstants(src);
    byModule.set(moduleId(file), local);
    for (const [name, key] of local) {
      if (!seen.has(name)) seen.set(name, new Set());
      seen.get(name).add(key);
    }
  }
  const unambiguous = new Map();
  for (const [name, keys] of seen) if (keys.size === 1) unambiguous.set(name, [...keys][0]);

  const scopes = new Map();
  for (const { file, src } of sources) {
    const scope = new Map(unambiguous);
    for (const [local, binding] of importBindings(src)) {
      const id = resolveSpecifier(file, binding.spec);
      const mod = id && byModule.get(id);
      if (mod && mod.has(binding.name)) scope.set(local, mod.get(binding.name));
    }
    for (const [name, key] of localKeyConstants(src)) scope.set(name, key);
    scopes.set(file, scope);
  }
  return scopes;
}

/** The argument expression of a call whose `(` is at `open` (index of `(`). */
function firstArg(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i).trim();
    } else if (ch === "," && depth === 1) return src.slice(open + 1, i).trim();
  }
  return "";
}

/** The index of the `)` that closes the call whose `(` is at `open`, or -1. */
export function callEnd(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}


/**
 * Balance braces from `open` to its close; `-1` when unbalanced. Comment-stripped input is assumed,
 * and braces inside string literals are not modelled — the functions this reads are write helpers,
 * not template-heavy renderers.
 */
export function blockEnd(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The names of functions declared `: boolean` whose body returns a **write's own answer**
 * (`writeStoreValueChecked`, or another name from this set — e.g. `writeKeyboardConfig` returns it,
 * and `resetKeyboardConfig` returns *that*). Their return value exists so a caller can act on it, so
 * a call whose result is thrown away is the F-SH-043 shape: the screen asked whether the write landed
 * and then ignored the answer. (The gate already gated the `writeStoreValue*` names themselves; a
 * *wrapper* was invisible to it, which is how the page shipped a green 「已保存」 over a refused write.)
 */
export function writeAnswerFns(sources) {
  const decls = [];
  for (const { file, src } of sources) {
    const clean = stripComments(src);
    const re = /export\s+function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*:\s*boolean\s*\{/g;
    for (const m of clean.matchAll(re)) {
      const open = clean.indexOf("{", m.index + m[0].length - 1);
      const end = blockEnd(clean, open);
      decls.push({ name: m[1], body: clean.slice(open, end < 0 ? clean.length : end + 1) });
    }
  }
  // Two passes: a wrapper of a wrapper resolves in the second (writeKeyboardConfig ← checked write,
  // resetKeyboardConfig ← writeKeyboardConfig).
  const names = new Set();
  for (let pass = 0; pass < 2; pass += 1) {
    for (const d of decls) {
      const returnsChecked = /\breturn\s+writeStoreValueChecked\s*\(/.test(d.body);
      const returnsKnown = [...names].some((n) =>
        new RegExp(`\\breturn\\s+${n}\\s*\\(`).test(d.body),
      );
      if (returnsChecked || returnsKnown) names.add(d.name);
    }
  }
  return names;
}

/**
 * Calls to a write-answer function whose result is **thrown away** (`f(x);`, `void f(x);`).
 * Consuming shapes are deliberately not flagged: `if (!f(x))`, `const ok = f(x)`, `return f(x)`,
 * `ok: f(x)` and `(key, value) => f(key, value)` all pass the answer on (the predicate is the same
 * `resultDiscarded` the checked-write rule uses, so the two cannot drift).
 */
export function discardedWriteAnswers(sources, names) {
  const out = [];
  for (const { file, src } of sources) {
    const clean = stripComments(src);
    for (const name of names) {
      for (const m of clean.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
        const before = clean.slice(Math.max(0, m.index - 30), m.index);
        if (/(\bfunction\s+|\bconst\s+|\blet\s+|\bvar\s+)$/.test(before)) continue; // declaration
        const open = m.index + m[0].length - 1;
        if (!resultDiscarded(clean, m.index, open)) continue;
        out.push({ file, line: clean.slice(0, m.index).split("\n").length, fn: name });
      }
    }
  }
  return out;
}

/**
 * True when a call's result is **thrown away**: a bare expression statement (`f(x);`,
 * or `void f(x);` which discards on purpose). A caller that asked whether a write
 * landed and then ignored the answer is no better than one that never asked — this is
 * what stops the rule being satisfied by swapping the function name.
 */
export function resultDiscarded(src, callIndex, open) {
  const end = callEnd(src, open);
  if (end < 0) return false;
  const before = src.slice(0, callIndex);
  const prefix = before.slice(before.lastIndexOf("\n") + 1).trim();
  const m = /^[^\S\n]*([^\s\n]?)/.exec(src.slice(end + 1));
  const nextChar = m ? m[1] : "";
  if (nextChar !== ";") return false;
  return prefix === "" || prefix === "void" || /[;{}]$/.test(prefix);
}

/**
 * Every `writeStoreValue` / `writeStoreValueChecked` **call** in the corpus:
 * `[{ file, line, fn, arg }]`. Declarations (`export function writeStoreValue(...)`)
 * are not call sites and are skipped.
 */
export function writeSites(sources) {
  const out = [];
  const callRe = /\b(writeStoreValueChecked|writeStoreValue)\s*(?:<[^(]*>)?\s*\(/g;
  for (const { file, src } of sources) {
    const clean = stripComments(src);
    for (const m of clean.matchAll(callRe)) {
      const before = clean.slice(Math.max(0, m.index - 30), m.index);
      if (/(\bfunction\s+|\bconst\s+|\blet\s+|\bvar\s+)$/.test(before)) continue; // declaration
      const open = m.index + m[0].length - 1;
      out.push({
        file,
        line: clean.slice(0, m.index).split("\n").length,
        fn: m[1],
        arg: firstArg(clean, open),
        discarded:
          m[1] === "writeStoreValueChecked" && resultDiscarded(clean, m.index, open),
      });
    }
  }
  return out;
}

/**
 * Production files that write `localStorage` **directly** (bypassing the `amosStore`
 * seam, so no write-through to the Rust store and no `amos-store-changed` event).
 * Three of these are deliberate raw-string stores (theme/locale/session ids are read
 * before the JSON layer exists at boot); the rest must be allow-listed with a reason.
 */
export function directLocalWrites(sources) {
  const out = new Map(); // file -> Set(op)
  const re = /(?:window\.)?localStorage\.(setItem|removeItem)\s*\(/g;
  for (const { file, src } of sources) {
    const clean = stripComments(src);
    for (const m of clean.matchAll(re)) {
      if (!out.has(file)) out.set(file, new Set());
      out.get(file).add(m[1]);
    }
  }
  return out;
}

/**
 * The store key an argument expression names, or `null` when it cannot be resolved
 * statically. `scope` is the name→key table in scope at the call site: a `Map` (from
 * `buildScopes`) or, for callers holding the corpus-wide table, a `[{ name, key }]` list.
 */
export function resolveKey(arg, scope) {
  const byName = scope instanceof Map ? scope : new Map(scope.map((c) => [c.name, c.key]));
  const a = arg.trim();
  const lit = /^"((?:amos|amos-ui)\.[^"]*)"$/.exec(a);
  if (lit) return lit[1];
  if (/^[A-Z0-9_]+$/.test(a) && byName.has(a)) return byName.get(a);
  return null;
}

/** The keys `SYNC_STORES` actually lists, read out of `lib/cloud.ts` (never copied). */
export function syncStores(cloudSrc, consts) {
  const clean = stripComments(cloudSrc);
  const start = clean.indexOf("SYNC_STORES");
  const open = clean.indexOf("[", start);
  const close = clean.indexOf("]", open);
  if (start < 0 || open < 0 || close < 0) return [];
  const byName = consts instanceof Map ? consts : new Map(consts.map((c) => [c.name, c.key]));
  return clean
    .slice(open + 1, close)
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "")
    .map((e) =>
      byName.has(e) ? byName.get(e) : e.startsWith('"') ? e.slice(1, -1) : `<unresolved:${e}>`,
    );
}

/**
 * Classify one call site. A site needs an allow-list entry when it is an **unverified
 * write of a content key**, or an unverified write whose key cannot be resolved
 * statically (the caller decides it). Everything else — verified writes, and writes of
 * configuration/derived keys — carries no claim about the user's content.
 */
export function classify(site, content, consts) {
  const key = resolveKey(site.arg, consts);
  const verified = site.fn === "writeStoreValueChecked";
  let needsEntry = false;
  let kind = "ignored";
  if (!verified && key === null) {
    needsEntry = true;
    kind = "unresolved";
  } else if (!verified && content.has(key)) {
    needsEntry = true;
    kind = "content";
  } else if (!verified) {
    kind = "non-content";
  } else {
    kind = "verified";
  }
  return { ...site, key, kind, needsEntry };
}

/**
 * The second dimension of an allow-list: a `kind` that no entry references.
 *
 * A stale **site** is reported by the scan (`stale`) and shrunk with a reason, but a
 * `kind` whose last member left was invisible: `kinds` is read only as a lookup table
 * for the sites, so an entry nothing points at stayed on file holding a reason that
 * described code no longer shaped that way — and *that reason is the permission a
 * future site leans on*. The live instance: `derived-tick` described `lib/alarmCore.ts`'s
 * `amos.alarms` write ("a rejected write only degrades the ring UI until the next tick
 * recomputes it") long after that write became `writeStoreValueChecked` whose verdict
 * bounds the day marker (REQ-A1392) — the site entry shrank, the kind did not.
 *
 * So a memberless kind has to declare *itself*: the retire/defer reason is the only thing
 * left to read, and "no members and no explanation" is indistinguishable from rot. Accepted
 * spellings: a reason beginning `RETIRED` (the classification lost its last member) or
 * `UNUSED` ∕ `KEPT` (it never had one, kept so adding the first is an explicit act), or a
 * non-empty `note` on an object-shaped kind (the spelling `void-cmd-allowlist.json` and
 * `perf-budget-allowlist.json` already use).
 */
export function memberlessKinds(kinds, referenced) {
  const refs = new Set(referenced);
  return Object.keys(kinds ?? {})
    .filter((k) => !refs.has(k) && !declaresMemberless(kinds[k]))
    .sort();
}

function declaresMemberless(spec) {
  if (spec && typeof spec === "object") {
    return typeof spec.note === "string" && spec.note.trim() !== "";
  }
  return /^(RETIRED|UNUSED|KEPT)\b/.test(String(spec ?? "").trim());
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const sources = [
    {
      file: "lib/a.ts",
      src: 'export const NOTES_KEY = "amos.notes";\nexport const CFG_KEY = "amos.cfg";\n',
    },
    {
      file: "svelte/B.svelte",
      src: [
        "writeStoreValue(NOTES_KEY, list);",
        "writeStoreValueChecked(NOTES_KEY, list);",
        "writeStoreValue<Thing>(CFG_KEY, { a: 1 });",
        'writeStoreValue("amos.photos", [p, ...list]);',
        "// writeStoreValue(NOTES_KEY, commentedOut);",
        "export function writeStoreValue(key: string, value: unknown): void {}",
        "const save = (v) => writeStoreValue(key, v);",
        "writeStoreValue(NOTES_KEY, list.map((x) => x.id));",
      ].join("\n"),
    },
  ];
  // --- the write-answer rule (REQ-A492) --------------------------------------
  // The negative control is the **historical shape** that shipped: a screen calls a wrapper that
  // returns "did it land?" in statement position. Every consuming form must stay clean, or the rule
  // would push callers to write the answer into a dummy variable to satisfy it.
  const answerSources = [
    {
      file: "lib/writes.ts",
      src: [
        "export function writeThing(t: Thing): boolean {",
        "  return writeStoreValueChecked(T_KEY, t);",
        "}",
        "export function resetThing(): boolean {",
        "  return writeThing({});",
        "}",
        "export function notAWrite(t: Thing): boolean {",
        "  return t !== undefined;",
        "}",
      ].join("\n"),
    },
    {
      file: "svelte/Historical.svelte",
      src: [
        "  writeThing(thing);",
        "  void resetThing();",
        "  const ok = writeThing(thing);",
        "  if (ok) {}",
        "  ok: writeThing(thing),",
        "  return writeThing(thing);",
        "  notAWrite(thing);",
      ].join("\n"),
    },
  ];
  {
    const names = writeAnswerFns(answerSources);
    const found = discardedWriteAnswers(answerSources, names);
    ok("a wrapper of a checked write is a write-answer function", names.has("writeThing"));
    ok("…and so is a wrapper of a wrapper", names.has("resetThing"));
    ok("a boolean function that never writes is not", !names.has("notAWrite"));
    ok(
      "the historical shape (a discarded answer) is reported",
      found.some((f) => f.file.endsWith("Historical.svelte") && f.fn === "writeThing"),
    );
    ok("`void f(x);` counts as discarding too", found.some((f) => f.fn === "resetThing"));
    ok(
      "consuming forms are not reported",
      found.length === 2,
    );
  }

  const consts = keyConstants(sources);
  const content = new Set(["amos.notes", "amos.photos"]);

  ok("reads exported key constants", consts.length === 2 && consts[0].name === "NOTES_KEY");
  const sites = writeSites(sources);
  ok("finds every write call, declarations excluded", sites.length === 6);
  ok("ignores a commented-out call", !sites.some((s) => s.arg === "commentedOut"));
  ok(
    "a generic call's type arguments do not hide it",
    sites.some((s) => s.fn === "writeStoreValue" && s.arg === "CFG_KEY"),
  );
  ok(
    "a nested call in the second argument is not mistaken for the key",
    sites.filter((s) => s.line === 8)[0]?.arg === "NOTES_KEY",
  );
  ok("records the line number", sites[0].line === 1);
  ok(
    "a block comment does not shift later line numbers",
    writeSites([{ file: "f.ts", src: "/* one\n   two\n*/\nwriteStoreValue(NOTES_KEY, x);" }])[0]
      .line === 4,
  );

  ok("resolves a constant argument", resolveKey("NOTES_KEY", consts) === "amos.notes");
  ok("resolves a literal argument", resolveKey('"amos.photos"', consts) === "amos.photos");
  ok("a parameter is not statically resolvable", resolveKey("key", consts) === null);

  // --- a key name reused by two modules (REQ-A812) ---------------------------
  // Scope, not a corpus-wide table: `K_KEY` is `amos.alpha` in `lib/a.ts` and `amos.beta`
  // in `lib/b.ts`. A flat last-wins table answers one of those two for BOTH, so whichever
  // file the walk reached last decides what every call site is about — and the answer
  // decides content-vs-configuration. Each file must be read through its own bindings.
  const collided = [
    { file: "lib/a.ts", src: 'export const K_KEY = "amos.alpha";\n' },
    { file: "lib/b.ts", src: 'export const K_KEY = "amos.beta";\n' },
    {
      file: "lib/importer.ts",
      src: 'import { K_KEY } from "./a";\nwriteStoreValue(K_KEY, x);\n',
    },
    {
      file: "lib/renamer.ts",
      src: 'import { K_KEY as RENAMED } from "./b";\nwriteStoreValue(RENAMED, y);\n',
    },
    { file: "lib/local.ts", src: 'const K_KEY = "amos.beta";\nwriteStoreValue(K_KEY, z);\n' },
  ];
  const cs = buildScopes(collided);
  ok(
    "a colliding name resolves through the file's import",
    resolveKey("K_KEY", cs.get("lib/importer.ts")) === "amos.alpha",
  );
  ok("an `as`-renamed import resolves too", resolveKey("RENAMED", cs.get("lib/renamer.ts")) === "amos.beta");
  ok(
    "a local declaration outranks the corpus",
    resolveKey("K_KEY", cs.get("lib/local.ts")) === "amos.beta",
  );
  ok(
    "the flat corpus table cannot tell them apart (why scope is required)",
    new Map(collided.flatMap((c) => [...localKeyConstants(c.src)])).get("K_KEY") === "amos.beta" &&
      resolveKey("K_KEY", collided.flatMap((c) => [...localKeyConstants(c.src)].map(([name, key]) => ({ name, key })))) ===
        "amos.beta",
  );
  ok(
    "an imported name shadows an unambiguous corpus name",
    resolveKey(
      "K_KEY",
      buildScopes([{ file: "lib/a.ts", src: 'export const K_KEY = "amos.alpha";' },
        { file: "lib/i.ts", src: 'import { K_KEY } from "./a";' }]).get("lib/i.ts"),
    ) === "amos.alpha",
  );

  const cls = Object.fromEntries(
    sites.map((s) => [`${s.fn}:${s.arg}`, classify(s, content, consts)]),
  );
  ok(
    "a verified write needs no entry",
    cls["writeStoreValueChecked:NOTES_KEY"].needsEntry === false,
  );
  ok(
    "an unverified content write needs an entry",
    cls["writeStoreValue:NOTES_KEY"].needsEntry &&
      cls["writeStoreValue:NOTES_KEY"].kind === "content",
  );
  ok("a literal content write is caught too", cls['writeStoreValue:"amos.photos"'].needsEntry);
  ok(
    "a non-content key is ignored",
    cls["writeStoreValue:CFG_KEY"].needsEntry === false &&
      cls["writeStoreValue:CFG_KEY"].kind === "non-content",
  );
  ok("an unresolved key needs an entry", cls["writeStoreValue:key"].kind === "unresolved");

  const disc = writeSites([
    {
      file: "svelte/C.svelte",
      src: [
        "writeStoreValueChecked(NOTES_KEY, a);",
        "void writeStoreValueChecked(NOTES_KEY, b);",
        "if (!writeStoreValueChecked(NOTES_KEY, c)) return;",
        "const ok = writeStoreValueChecked(NOTES_KEY, d);",
        "storeErr = writeStoreValueChecked(NOTES_KEY, e) ? '' : 'x';",
        "return writeStoreValueChecked(NOTES_KEY, f);",
        "writeStoreValue(NOTES_KEY, g);",
      ].join("\n"),
    },
  ]);
  const bare = (n) => disc[n].discarded;
  ok("a bare checked write is a discarded answer", bare(0));
  ok("`void` discards on purpose too", bare(1));
  ok("an `if (!…)` uses the answer", !bare(2));
  ok("an assignment uses the answer", !bare(3));
  ok("a ternary uses the answer", !bare(4));
  ok("a `return` uses the answer", !bare(5));
  ok("the unchecked write is classified separately", disc[6].discarded === false);


  const cloud = 'export const SYNC_STORES = [NOTES_KEY, "amos.photos"] as const;';
  ok("SYNC_STORES is read, not copied", syncStores(cloud, consts).includes("amos.notes"));

  // The content set is resolved through the same table, so it inherits the same hazard —
  // and this is the one where a collision costs something the user can see. `cloud.ts`
  // imports each back-up name from the module that owns the store; resolve it through a
  // flat corpus table instead and a second `NOTES_KEY` anywhere in the tree silently
  // swaps the user's notes out of the back-up set — and the gate still reports OK.
  {
    const cloudSrc = [
      'import { NOTES_KEY } from "./notes";',
      "export const SYNC_STORES = [NOTES_KEY] as const;",
    ].join("\n");
    const corpus = [
      { file: "lib/notes.ts", src: 'export const NOTES_KEY = "amos.notes";' },
      { file: "lib/cloud.ts", src: cloudSrc },
      { file: "lib/scratch.ts", src: 'export const NOTES_KEY = "amos.scratch";' },
    ];
    const scopes = buildScopes(corpus);
    ok(
      "SYNC_STORES resolves through the importing module, not the corpus",
      syncStores(cloudSrc, scopes.get("lib/cloud.ts"))[0] === "amos.notes",
    );
    ok(
      "the flat table would have swapped the notes out of the content set",
      syncStores(cloudSrc, keyConstants(corpus))[0] === "amos.scratch",
    );
  }

  const direct = directLocalWrites([
    {
      file: "lib/x.ts",
      src: [
        "window.localStorage.setItem(k, v);",
        "localStorage.removeItem(k);",
        "const x = localStorage.getItem(k); // a read is not a write",
        "// localStorage.setItem(commented, out);",
      ].join("\n"),
    },
  ]);
  ok("finds direct localStorage writes", direct.get("lib/x.ts")?.has("setItem"));
  ok("finds direct removals too", direct.get("lib/x.ts")?.has("removeItem"));
  ok("a read is not a direct write", direct.get("lib/x.ts")?.size === 2);

  const invoked = "file:///x/write-scan.mjs";
  ok(
    "invokedDirectly only matches this script",
    invokedDirectly(invoked, "/x/write-scan.mjs") && !invokedDirectly(invoked, "/x/other.mjs"),
  );

  // --- the allow-list's second dimension: a kind with no members (REQ-A1492) ----
  // A stale *site* is reported; a kind whose last member left was not, so `derived-tick`
  // described `alarmCore`'s `amos.alarms` write two rounds after it became a checked write.
  // The rule has to accept each declared-memberless spelling without teaching authors to
  // append a magic word to a live kind — hence the referenced-kind control.
  ok(
    "a kind a site references is covered",
    memberlessKinds({ "demo-seed": "why" }, ["demo-seed"]).length === 0,
  );
  ok(
    "a kind only a direct-localStorage file references is covered",
    memberlessKinds({ "store-seam": "why" }, ["store-seam"]).length === 0,
  );
  ok(
    "a memberless kind that explains nothing is reported",
    memberlessKinds({ "derived-tick": "Derived, self-healing state …" }, []).length === 1,
  );
  ok(
    "a RETIRED memberless kind is accepted",
    memberlessKinds({ x: "RETIRED (REQ-A1392, round N). …" }, []).length === 0,
  );
  ok(
    "an UNUSED memberless kind is accepted",
    memberlessKinds({ x: "UNUSED — never had a member; kept so the first is an explicit act." }, []).length === 0,
  );
  ok(
    "a KEPT memberless kind is accepted",
    memberlessKinds({ x: "KEPT — no member today." }, []).length === 0,
  );
  ok(
    "an object kind with a note is accepted",
    memberlessKinds({ x: { reason: "why", note: "kept deliberately" } }, []).length === 0,
  );
  ok(
    "an object kind with a blank note is reported",
    memberlessKinds({ x: { reason: "why", note: "   " } }, []).length === 1,
  );
  ok(
    "a `RETIREDLY` prefix is not the RETIRED marker",
    memberlessKinds({ x: "RETIREDLY…" }, []).length === 1,
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[write-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[write-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * True when this file is the process entry point, so the selftest/scan dispatch never
 * fires when another script imports the extractors.
 */
// --- scan -------------------------------------------------------------------
function runScan() {
  const sources = walk(SRC)
    .filter((f) => /\.(ts|svelte)$/.test(f))
    .filter((f) => !TEST_RE.test(f))
    .filter((f) => !/\/i18n\/locales\//.test(f))
    .map((f) => ({ file: relative(root, f), src: readFileSync(f, "utf8") }));

  const scopes = buildScopes(sources);
  const cloudFile = sources.find((s) => s.file.endsWith("lib/cloud.ts"))?.file ?? "";
  const cloudSrc = sources.find((s) => s.file === cloudFile)?.src ?? "";
  const content = new Set(
    syncStores(cloudSrc, scopes.get(cloudFile) ?? new Map()).filter((k) => !k.startsWith("<")),
  );

  let allow;
  try {
    allow = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  } catch (e) {
    console.error(`[write-scan] allowlist is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const kinds = allow.kinds ?? {};
  for (const k of Object.keys(kinds)) {
    if (!String(kinds[k]).trim()) {
      console.error(`[write-scan] allowlist kind \`${k}\` has no reason`);
      process.exit(2);
    }
  }
  const listed = new Map(
    (allow.sites ?? []).map((s) => [`${s.file}::${s.key ?? "<unresolved>"}`, s.kind]),
  );

  const sites = writeSites(sources).map((s) =>
    classify(s, content, scopes.get(s.file) ?? new Map()),
  );
  const needing = sites.filter((s) => s.needsEntry);
  const used = new Set();
  const unclassified = [];
  for (const s of needing) {
    const id = `${s.file}::${s.key ?? "<unresolved>"}`;
    const kind = listed.get(id);
    if (kind === undefined) {
      unclassified.push(s);
      continue;
    }
    used.add(id);
    if (!kinds[kind]) unclassified.push({ ...s, why: `kind \`${kind}\` is not defined in "kinds"` });
  }
  const stale = [...listed.keys()].filter((id) => !used.has(id)).sort();

  // --- direct localStorage writes (bypassing the seam) -----------------------
  const localKind = new Map((allow.localWrites ?? []).map((s) => [s.file, s.kind]));
  const direct = directLocalWrites(sources);
  const badLocal = [...direct.keys()]
    .filter((f) => !localKind.has(f))
    .sort()
    .map((f) => ({ file: f, ops: [...(direct.get(f) ?? [])].sort() }));
  const staleLocal = [...localKind.keys()].filter((f) => !direct.has(f)).sort();

  // --- a verified write whose answer was thrown away --------------------------
  const ignoredList = new Map(
    (allow.ignoredResults ?? []).map((s) => [`${s.file}::${s.key ?? "<unresolved>"}`, s.kind]),
  );
  const ignored = sites.filter((s) => s.fn === "writeStoreValueChecked" && s.discarded);
  const badIgnored = [];
  const usedIgnored = new Set();
  for (const s of ignored) {
    const id = `${s.file}::${s.key ?? "<unresolved>"}`;
    const kind = ignoredList.get(id);
    if (kind === undefined || !kinds[kind]) {
      badIgnored.push(s);
      continue;
    }
    usedIgnored.add(id);
  }
  const staleIgnored = [...ignoredList.keys()].filter((id) => !usedIgnored.has(id)).sort();

  // --- a write helper's answer thrown away (F-SH-043) --------------------------
  // The rule above covers `writeStoreValueChecked` itself; this one covers the **wrappers** that
  // return its answer (`writeKeyboardConfig`, `resetKeyboardConfig`, …). The keyboard page's green
  // 「已保存」 over a refused write is exactly this shape, and the gate could not see it.
  const prod = sources.filter((s) => !TEST_RE.test(s.file));
  const answerFns = writeAnswerFns(prod);
  const answersList = new Map(
    (allow.answeredResults ?? []).map((s) => [`${s.file}::${s.fn}`, s.kind]),
  );
  const discardedAnswers = discardedWriteAnswers(prod, answerFns);
  const badAnswers = [];
  const usedAnswers = new Set();
  for (const a of discardedAnswers) {
    const id = `${a.file}::${a.fn}`;
    const kind = answersList.get(id);
    if (kind === undefined || !kinds[kind]) {
      badAnswers.push(a);
      continue;
    }
    usedAnswers.add(id);
  }
  const staleAnswers = [...answersList.keys()].filter((id) => !usedAnswers.has(id)).sort();

  // --- a kind nothing references (see memberlessKinds) -------------------------
  // Every dimension that can name an entry counts as a reference: the classified sites,
  // the direct-localStorage files, and the two discarded-answer lists.
  const memberless = memberlessKinds(kinds, [
    ...listed.values(),
    ...localKind.values(),
    ...ignoredList.values(),
    ...answersList.values(),
  ]);

  const failures =
    unclassified.length +
    stale.length +
    badLocal.length +
    staleLocal.length +
    badIgnored.length +
    staleIgnored.length +
    badAnswers.length +
    staleAnswers.length +
    memberless.length;

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          sites: sites.length,
          needsEntry: needing.length,
          unclassified,
          stale,
          directLocalWrites: badLocal,
          staleLocalWrites: staleLocal,
          ignoredResults: badIgnored,
          staleIgnoredResults: staleIgnored,
          discardedWriteAnswers: badAnswers,
          staleWriteAnswers: staleAnswers,
          memberlessKinds: memberless,
          kinds,
        },
        null,
        2,
      ),
    );
  } else {
    const counts = {};
    for (const s of sites) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
    console.log(
      `[write-scan] ${sites.length} write call(s): ${counts.verified ?? 0} verified, ` +
        `${needing.length} classified, ${counts["non-content"] ?? 0} non-content.`,
    );
    for (const u of unclassified) {
      console.error(
        `[write-scan] FAIL — ${u.file}:${u.line} writes \`${u.key ?? "an unresolved key"}\` ` +
          `unverified${u.why ? ` (${u.why})` : " and is not listed in scripts/write-allowlist.json"}`,
      );
    }
    for (const id of stale) {
      console.log(
        `[write-scan] allow-list: stale entry (no such call site) — shrink with a reason: ${id}`,
      );
    }
    for (const b of badLocal) {
      console.error(
        `[write-scan] FAIL — ${b.file} writes localStorage directly (${b.ops.join("/")}) and is ` +
          "not listed in scripts/write-allowlist.json `localWrites`",
      );
    }
    for (const a of badAnswers) {
      console.error(
        `[write-scan] FAIL — ${a.file}:${a.line} calls \`${a.fn}()\` and throws its answer away. ` +
          "The function returns whether the write landed, so the caller must act on it " +
          "(report the failure, or re-read the store) — or list it in " +
          "scripts/write-allowlist.json `answeredResults` with a reason",
      );
    }
    for (const id of staleAnswers) {
      console.log(
        `[write-scan] allow-list: stale answeredResults entry (no such call site) — shrink it: ${id}`,
      );
    }
    for (const f of staleLocal) {
      console.log(
        `[write-scan] allow-list: stale localWrite entry (no direct write there) — shrink it: ${f}`,
      );
    }
    for (const s of badIgnored) {
      console.error(
        `[write-scan] FAIL — ${s.file}:${s.line} asks \`writeStoreValueChecked(${s.key ?? "…"})\` ` +
          "and **discards the answer**; act on it (or allow-list the site with a reason)",
      );
    }
    for (const id of staleIgnored) {
      console.log(
        `[write-scan] allow-list: stale ignored-result entry (nothing discards there) — shrink it: ${id}`,
      );
    }
    for (const k of memberless) {
      console.error(
        `[write-scan] FAIL — allow-list kind \`${k}\` is referenced by no entry and does not say ` +
          "why it is kept. Retire it (reason begins `RETIRED`), declare it unused (`UNUSED` ∕ `KEPT`), " +
          "or drop it — a kind with neither members nor an explanation is rot, and its reason is what " +
          "a future site will lean on",
      );
    }
    console.log(
      `[write-scan] ${direct.size} file(s) write localStorage directly (${localKind.size} classified).`,
    );
    console.log(
      `[write-scan] ${ignored.length} verified write(s) discard their answer (${ignoredList.size} allow-listed).`,
    );
    console.log(
      `[write-scan] ${discardedAnswers.length} write-answer call(s) discard their answer ` +
        `(${answersList.size} allow-listed); ${answerFns.size} function(s) return a write's answer.`,
    );
    if (failures === 0) {
      console.log(
        "[write-scan] OK — every content write either asks whether it landed or is classified.",
      );
    } else {
      console.error(
        "\nClassify it: use `writeStoreValueChecked` and act on the answer (a screen must not\n" +
          "apply a change the store rejected), or list the site in scripts/write-allowlist.json\n" +
          "under a kind whose reason says why the unverified write is acceptable.",
      );
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

/**
 * True when this file is the process entry point, so the selftest/scan dispatch never
 * fires when another script imports the extractors.
 */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();
