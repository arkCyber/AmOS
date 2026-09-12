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
 * Usage (from frontend-ts):
 *   node scripts/write-scan.mjs              # gate
 *   node scripts/write-scan.mjs --json       # machine-readable
 *   node scripts/write-scan.mjs --selftest   # pin the extractor
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
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

export function resolveKey(arg, consts) {
  const byName = new Map(consts.map((c) => [c.name, c.key]));
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
  const byName = new Map(consts.map((c) => [c.name, c.key]));
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

  const consts = keyConstants(sources);
  const cloudSrc = sources.find((s) => s.file.endsWith("lib/cloud.ts"))?.src ?? "";
  const content = new Set(syncStores(cloudSrc, consts).filter((k) => !k.startsWith("<")));

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

  const sites = writeSites(sources).map((s) => classify(s, content, consts));
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

  const failures =
    unclassified.length +
    stale.length +
    badLocal.length +
    staleLocal.length +
    badIgnored.length +
    staleIgnored.length;

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
    console.log(
      `[write-scan] ${direct.size} file(s) write localStorage directly (${localKind.size} classified).`,
    );
    console.log(
      `[write-scan] ${ignored.length} verified write(s) discard their answer (${ignoredList.size} allow-listed).`,
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
