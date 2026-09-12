#!/usr/bin/env node
/**
 * store-scan.mjs — "a store key nobody classified" (backup completeness).
 *
 * Why: `lib/cloud.ts` snapshots the user-data stores into a local backup, and the
 * Settings hint promises that "data is snapshotted". Twice the *list* silently
 * drifted from the stores that exist — `amos.files.fav` never matched
 * `FILES_FAV_KEY`, the legacy `amos.messages` never matched `CONV_KEY` — so file
 * favourites and every message thread were missing from every backup (Round 20).
 * Round 50 found the mirror failure: the list was **incomplete**, with contacts,
 * calendar events, alarms, the call log, voice memos, in-app captures, SMS drafts
 * and the interpreter transcript all omitted while the copy promised the user's
 * "data".
 *
 * The durable fix is a classification gate: every `amos.*` store key that appears
 * in production must be **either**
 *
 *   1. in `SYNC_STORES` (content the user created — the constant its own module
 *      exports, never a re-spelled literal), **or**
 *   2. in `scripts/store-allowlist.json` under a named `kind` whose reason is
 *      recorded once (configuration / derived / device-state / meta).
 *
 * A **new** store key therefore fails `make lint` until someone decides which it
 * is — it cannot silently miss every backup. Allow-list entries whose key no
 * longer exists are reported as `[stale]` so the list cannot rot.
 *
 * Usage (from frontend-ts):
 *   node scripts/store-scan.mjs              # gate
 *   node scripts/store-scan.mjs --json       # machine-readable
 *   node scripts/store-scan.mjs --selftest   # pin the extractor
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src");
const ALLOWLIST = join(root, "scripts", "store-allowlist.json");

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

/** Strip `//…` and block comments (a key named in a comment is not a store). */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * `[{ name, key, file }]` — every `export const X_KEY = "amos.…"` in the corpus.
 * These constants are the store keys' single source of truth (repo convention).
 */
export function keyConstants(sources) {
  const out = [];
  for (const { file, src } of sources) {
    const clean = stripComments(src);
    for (const m of clean.matchAll(/export const ([A-Z0-9_]*KEY[A-Z0-9_]*)\s*=\s*"(amos[.-][^"]*)"/g)) {
      out.push({ name: m[1], key: m[2], file });
    }
  }
  return out;
}

/** Every `"amos.…"` literal anywhere in production (inline keys have no constant). */
export function inlineKeys(sources) {
  const out = new Map(); // key -> Set(files)
  for (const { file, src } of sources) {
    const clean = stripComments(src);
    // Dot form only: `amos-media` / `amos-svelte-locale` are DOM event names, not
    // store keys, and `amos-store-changed` is a same-window change notification.
    for (const m of clean.matchAll(/"((?:amos|amos-ui)\.[A-Za-z0-9._-]+)"/g)) {
      if (!out.has(m[1])) out.set(m[1], new Set());
      out.get(m[1]).add(file);
    }
  }
  return out;
}

/**
 * The keys `SYNC_STORES` actually lists, resolved through the constant table — the
 * gate reads the real list, never a copy of it.
 */
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
    .map((e) => (byName.has(e) ? byName.get(e) : e.startsWith('"') ? e.slice(1, -1) : `<unresolved:${e}>`));
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const sources = [
    { file: "lib/a.ts", src: 'export const A_KEY = "amos.alpha";\n// "amos.commented"\n' },
    { file: "lib/b.ts", src: 'export const B_KEY = "amos.beta";\nconst x = "amos.inline.key";' },
  ];
  const consts = keyConstants(sources);
  ok("reads exported key constants", consts.length === 2 && consts[0].key === "amos.alpha");
  ok("ignores a key named in a comment", !consts.some((c) => c.key === "amos.commented"));
  const inline = inlineKeys(sources);
  ok("finds inline keys too", inline.has("amos.inline.key") && inline.get("amos.alpha").has("lib/a.ts"));

  const cloud = 'export const SYNC_STORES = [A_KEY, "amos.literal",] as const;';
  const resolved = syncStores(cloud, consts);
  ok("resolves a constant entry to its key", resolved.includes("amos.alpha"));
  ok("accepts a literal entry", resolved.includes("amos.literal"));
  ok("a non-constant entry is flagged unresolved", syncStores("const SYNC_STORES = [MYSTERY];", consts)[0].startsWith("<"));
  ok("missing SYNC_STORES → empty", syncStores("export const x = 1;", consts).length === 0);

  const invoked = "file:///x/store-scan.mjs";
  ok(
    "invokedDirectly only matches this script",
    invokedDirectly(invoked, "/x/store-scan.mjs") && !invokedDirectly(invoked, "/x/other-scan.mjs"),
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[store-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[store-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}


// --- scan -------------------------------------------------------------------
function runScan() {
  const sources = walk(SRC)
    .filter((f) => /\.(ts|svelte)$/.test(f))
    .filter((f) => !TEST_RE.test(f))
    .filter((f) => !/\/i18n\/locales\//.test(f))
    .map((f) => ({ file: relative(root, f), src: readFileSync(f, "utf8") }));

  const consts = keyConstants(sources);
  const cloudSrc = sources.find((s) => s.file.endsWith("lib/cloud.ts"))?.src ?? "";
  const listed = syncStores(cloudSrc, consts);
  const synced = new Set(listed.filter((k) => !k.startsWith("<")));
  const unresolvedSync = listed.filter((k) => k.startsWith("<"));

  const all = inlineKeys(sources);
  const keys = [...all.keys()].sort();

  let allow;
  try {
    allow = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  } catch (e) {
    console.error(`[store-scan] allowlist is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const kinds = allow.kinds ?? {};
  for (const k of Object.keys(kinds)) {
    if (!String(kinds[k]).trim()) {
      console.error(`[store-scan] allowlist kind \`${k}\` has no reason`);
      process.exit(2);
    }
  }
  const byKey = new Map((allow.keys ?? []).map((e) => [e.key, e.kind]));

  const unclassified = [];
  for (const key of keys) {
    if (synced.has(key)) continue;
    const kind = byKey.get(key);
    if (kind !== undefined) {
      if (!kinds[kind]) {
        unclassified.push({ key, why: `kind \`${kind}\` is not defined in "kinds"` });
      }
      continue;
    }
    unclassified.push({ key, why: "not in SYNC_STORES and not allow-listed", files: [...all.get(key)].slice(0, 3) });
  }
  const stale = (allow.keys ?? [])
    .filter((e) => !all.has(e.key))
    .map((e) => e.key)
    .sort();
  const syncMissing = [...synced].filter((k) => !all.has(k));

  const failures = unclassified.length + stale.length + syncMissing.length + unresolvedSync.length;

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          keys: keys.length,
          synced: [...synced].sort(),
          unclassified,
          stale,
          syncMissing,
          unresolvedSync,
          kinds,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[store-scan] ${keys.length} store key(s); ${synced.size} in SYNC_STORES; ${byKey.size} allow-listed in ${Object.keys(kinds).length} kind(s).`,
    );
    for (const u of unclassified) {
      console.error(`[store-scan] FAIL — \`${u.key}\` ${u.why}${u.files ? ` (${u.files.join(", ")})` : ""}`);
    }
    for (const k of syncMissing) {
      console.error(
        `[store-scan] FAIL — SYNC_STORES lists \`${k}\` but no store key uses it (a stale entry backs up nothing and lies about the snapshot)`,
      );
    }
    for (const k of unresolvedSync) {
      console.error(`[store-scan] FAIL — SYNC_STORES entry \`${k}\` does not resolve to a key constant`);
    }
    for (const k of stale) {
      console.log(`[store-scan] allow-list: stale entry (no such store key) — shrink with a reason: ${k}`);
    }
    if (failures === 0) {
      console.log("[store-scan] OK — every store key is either backed up or classified with a reason.");
    } else {
      console.error(
        "\nClassify it: add the store's own key constant to `SYNC_STORES` (content the user\n" +
          "created) or list the key in scripts/store-allowlist.json under a kind whose reason\n" +
          "says why losing it is acceptable.",
      );
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

/**
 * True when this file is the process entry point, so the selftest/scan dispatch
 * never fires when another script imports the extractors.
 */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();


