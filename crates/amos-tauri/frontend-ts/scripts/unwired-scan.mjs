#!/usr/bin/env node
/**
 * unwired-scan.mjs — static "defined but never used in production" scan.
 *
 * Motivation: this codebase has repeatedly shipped a module that is *defined*,
 * *unit-tested* and *documented* yet has **no production call site**
 * (keep-awake, wakeHome, RAG, clipboard-announce, telemetry-spy …). `tsc` cannot
 * catch it because `noUnusedLocals` exempts `export`s. So an export can be dead
 * in the running shell while a green unit test still passes against it directly.
 *
 * What it does:
 *   1. **Modules** — a `src/lib` module unreachable (directly or transitively) from
 *      any production root. Hard gate, no baseline: a whole dead module is the
 *      strongest form of this defect (e.g. `wm.ts` had a full bridge + tests and
 *      zero importers). Deliberate not-yet-wired modules must be allow-listed.
 *   2. **Value exports** — a function/const/class/enum with *zero* production
 *      references (its own file included, minus the declaration itself). The only
 *      remaining mentions are in tests, or nothing at all. Gated as a **ratchet**:
 *      the current backlog lives in `scripts/unwired-baseline.json`, so the check
 *      fails only when a *new* one appears (and nags when a baseline entry is now
 *      wired). This is the exact defect class of keep-awake / wakeHome / RAG /
 *      clipboard-announce / telemetry-spy: defined + tested + documented, no call
 *      site, and invisible to `tsc` because `noUnusedLocals` exempts `export`s.
 *      **Corpus**: `src/lib/**` **and `src/svelte/**` `.ts` helper modules** — the
 *      defect is not special to `lib/` (widening the corpus exposed dead/unwired
 *      exports in `svelte/appRegistry.ts`, `svelte/i18n.ts`,
 *      `svelte/osInputBridge.ts`, `svelte/propsBus.ts` …). Svelte **components**
 *      (`.svelte`) are mount points and are excluded.
 *   3. **Type exports** — reported for information only; an unused exported type
 *      is usually deliberate API surface and must not gate on its own.
 *   4. **Unmounted components** — a `src/**\/*.svelte` file that no production entry
 *      chain imports (statically **or** dynamically). Hard gate, no baseline: this
 *      is the `.svelte` analogue of check 1 and the historical "component + tests +
 *      docs, but never mounted" defect (`ClipboardAnnounce.svelte`). Mount roots are
 *      the true entries; a component is never its own root.
 *
 * Reachability uses **static `from "…"`, bare `import "…"`, and dynamic
 * `import("…")`** edges. Dynamic imports matter: `appRegistry` lazy-loads every app
 * screen through them, so missing that edge form made a module reachable only that
 * way a **false "unreachable module"** (a hard-gate failure with no baseline to
 * absorb it). `--selftest` pins the edge extractor against that regression.
 *
 * The scanner is deliberately dependency-free (regex + fs) so it runs anywhere
 * `node` does, and it never executes or imports the code it inspects.
 *
 * Allow-list: `scripts/unwired-allowlist.json` — entries
 *   { "path": "src/lib/foo.ts", "module": true, "reason": "…" }   (whole module / component)
 *   { "path": "src/lib/foo.ts", "name": "Bar", "reason": "…" }    (one symbol)
 * (`path` may also be a `src/svelte/*.ts` helper module or a `*.svelte` component.)
 * each accepted only with a non-empty `reason`, so every suppression is auditable.
 *
 * Usage (from frontend-ts):
 *   node scripts/unwired-scan.mjs                 # gate (non-zero on regression)
 *   node scripts/unwired-scan.mjs --json          # machine-readable report
 *   node scripts/unwired-scan.mjs --selftest      # pin the import-edge extractor
 *   node scripts/unwired-scan.mjs --update-baseline
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- file discovery ---------------------------------------------------------
function walk(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const TEST_RE = /(\.test\.|\.spec\.|\/__tests__\/|\/svelte-tests\/)/;
const isTestPath = (p) => TEST_RE.test(p);

const libFiles = walk(join(root, "src", "lib"))
  .filter((f) => /\.ts$/.test(f))
  .filter((f) => !isTestPath(f));

const PROD_RE = /\.(ts|svelte)$/;
const prodFiles = walk(join(root, "src")).filter((f) => PROD_RE.test(f) && !isTestPath(f));
const prodSet = new Set(prodFiles);

// Symbol-scan corpus: `src/lib/**` **and** `src/svelte/**` `.ts` helpers (e.g.
// `osInputBridge.ts`, `osAlarmArm.ts`, `appLinks.ts`). These carry the exact same
// defect class — "defined + tested + documented but no production call site" is
// not special to `lib/`, and helper modules under `svelte/` are *not* components,
// so an export here can be dead while every gate stays green. Svelte **components**
// (`.svelte`) are mount points and are intentionally excluded.
const symbolFiles = [
  ...libFiles,
  ...walk(join(root, "src", "svelte"))
    .filter((f) => /\.ts$/.test(f))
    .filter((f) => !isTestPath(f)),
];

/** `src/lib` as a lookup set (the dead-module gate is lib-only). */
const libFileSet = new Set(libFiles);

/** Production Svelte components — the mount-reachability corpus (check 4). */
const componentFiles = prodFiles.filter((f) => f.endsWith(".svelte"));

// --- export extraction ------------------------------------------------------
// Value exports carry *behaviour* (a function/const/class/enum) — the class of
// defect this scan exists to catch. Type exports (interface/type) are still
// reported, but as a separate informational bucket: an unused exported type is
// usually deliberate public API surface, so it must not gate CI on its own.
const VALUE_DECL_RE =
  /^[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
const TYPE_DECL_RE =
  /^[ \t]*export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm;
// Brace exports: export { a, b as c }; export type { X }.
const BRACE_RE = /^[ \t]*export\s+(type\s+)?\{([^}]*)\}/gm;

/** @returns {{ name: string, kind: "value" | "type" }[]} */
function extractExports(src) {
  const out = new Map();
  const add = (name, kind) => {
    if (name && name !== "default" && !out.has(name)) out.set(name, kind);
  };
  for (const m of src.matchAll(VALUE_DECL_RE)) add(m[1], "value");
  for (const m of src.matchAll(TYPE_DECL_RE)) add(m[1], "type");
  for (const m of src.matchAll(BRACE_RE)) {
    const groupIsType = Boolean(m[1]);
    for (const piece of m[2].split(",")) {
      const t = piece.trim();
      if (!t) continue;
      const asMatch = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const bare = t.replace(/^type\s+/, "").trim();
      const name = asMatch ? asMatch[1] : bare.split(/\s+/)[0];
      add(name, groupIsType ? "type" : "value");
    }
  }
  return [...out].map(([name, kind]) => ({ name, kind }));
}

const testFiles = [
  ...walk(join(root, "src")).filter((f) => /\.(ts|svelte)$/.test(f) && isTestPath(f)),
  ...walk(join(root, "svelte-tests")).filter((f) => /\.ts$/.test(f)),
];

// --- reference counting -----------------------------------------------------
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countIn(name, files, cache) {
  let hits = 0;
  const re = new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`, "g");
  for (const f of files) {
    const src = readProd(f);
    if (!src.includes(name)) continue;
    // The lookbehind exists to ignore *member access* (`obj.name`), which is not a
    // reference to the exported binding. But it also swallows a **spread call**
    // (`...name(...)`), whose preceding char is the third dot of the ellipsis — that
    // is a real call site (it once hid `calendar.expandOccurrences`, making the scan
    // report a wired helper as dead). Neutralise ellipses before matching.
    const probe = src.replace(/\.\.\./g, "  ");
    re.lastIndex = 0;
    for (const _ of probe.matchAll(re)) hits += 1;
  }
  return hits;
}

/**
 * Module-level reachability: a `src/lib` module that no production file imports
 * (directly, or transitively through other *reachable* modules) is dead as a
 * whole. This is a much smaller, higher-confidence signal than per-symbol usage
 * and therefore the only part of the scan that gates without a baseline.
 */
/**
 * Import edges of a production file: static `from "…"` (import/export), bare
 * `import "…"`, **and dynamic `import("…")`** — the lazy form `appRegistry` uses
 * to load every app screen. Dynamic imports were once missed, which made a module
 * reachable *only* through a lazy edge a **false "unreachable module"** (a
 * hard-gate failure with no baseline). Member access (`obj.import(…)`) and
 * `import()` with no string literal are not edges.
 */
function importSpecifiers(src) {
  const out = [];
  const re = /(?:^|[^\w.])(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of src.matchAll(/(?<![\w.])import\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(fromFile), spec);
  for (const cand of [`${base}.ts`, `${base}.svelte`, join(base, "index.ts"), base]) {
    if (prodSet.has(cand)) return cand;
  }
  return null;
}

/**
 * Reachable production files from a given root set, over the import graph.
 *
 * The two checks need **different roots**, which is why this is parameterised:
 *  • lib modules — every production file *outside* `src/lib` counts as a root, so
 *    a lib module is "used" if any production file imports it. A lib module is
 *    never its own root, or the dead-module gate could never fire.
 *  • components — the **true entries** (no other production file imports them),
 *    which is what a *mount* check needs: a component is reachable only if a real
 *    entry chain imports it.
 */
function reachable(cache, roots) {
  const edges = new Map(); // file -> Set<file>
  for (const f of prodFiles) {
    const set = new Set();
    for (const spec of importSpecifiers(readProd(f))) {
      const r = resolveSpec(f, spec);
      if (r) set.add(r);
    }
    edges.set(f, set);
  }
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const n of edges.get(f) ?? []) queue.push(n);
  }
  return seen;
}

/**
 * `--selftest`: assertions for the **edge extractor**, the part of this scanner
 * that decides reachability. It earns its own test because a silently-missed edge
 * form flips *real* wiring into a **false gate failure** — exactly what dynamic
 * `import()` did (Round 30): every app screen is loaded through it, so any module
 * reachable only that way was reported as an unreachable module, with no baseline
 * to absorb it. Run by `make lint`; extend it when a new edge form is supported.
 */
function runSelftest() {
  const positives = [
    ['import { a } from "./a";', "./a"],
    ["export { b } from './b';", "./b"],
    ['import "./side-effect";', "./side-effect"],
    ['const m = () => import("./Lazy.svelte");', "./Lazy.svelte"],
    ['const m = await import("../lib/x");', "../lib/x"],
  ];
  const negatives = ['obj.import("./not-an-edge")', "import(dynamicName)", 'importName("./x")'];
  let failed = 0;
  for (const [src, want] of positives) {
    const got = importSpecifiers(src);
    if (!got.includes(want)) {
      console.error(
        `[unwired-scan] selftest FAIL: ${JSON.stringify(src)} → ${JSON.stringify(got)} (missing ${want})`,
      );
      failed++;
    }
  }
  for (const src of negatives) {
    if (importSpecifiers(src).length !== 0) {
      console.error(`[unwired-scan] selftest FAIL: ${JSON.stringify(src)} produced an edge`);
      failed++;
    }
  }
  // The **comment stripper** is the other half of this scanner's window: the counter is a
  // regex over source text, so whatever the stripper leaves behind is what counts as a
  // reference. A `//`-comment mention used to survive (only `/* */` was stripped), which made
  // a symbol whose *only* mention is the comment explaining why it is no longer called read as
  // **wired** — the exact defect class this scan exists to catch (REQ-A1707 measured nine such
  // exports: `wmClose`/`wmFocus`/`wmMinimize`, the four plain `wmSplit*` wrappers,
  // `amosStore.saveLayout` and `dockConfig.isFullscreen`). The cases below pin both directions:
  // a mention inside either comment form must NOT survive, and text inside a string literal —
  // the stated reason line comments were kept (`content://…`) — must.
  const stripCases = [
    ["const a = 1; // wmClose(x)", false, "wmClose"], // line comment must not count
    ['const a = "content://wmClose";', true, "wmClose"], // `//` inside a string is not a comment
    ["const a = 1; /* wmClose(x) */", false, "wmClose"], // block comment must not count
    ['const a = `x ${"//wmClose"} y`;', true, "wmClose"], // `//` inside a template literal
    ["const a = 1; // trailing wmSplitMove", false, "wmSplitMove"],
  ];
  for (const [src, want, name] of stripCases) {
    const got = stripComments(src).includes(name);
    if (got !== want) {
      console.error(
        `[unwired-scan] selftest FAIL: stripComments(${JSON.stringify(src)}) ` +
          `${got ? "kept" : "dropped"} ${name}, expected it ${want ? "kept" : "dropped"}`,
      );
      failed++;
    }
  }
  const total = positives.length + negatives.length + stripCases.length;
  console.log(`[unwired-scan] selftest: ${total} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
if (process.argv.includes("--selftest")) runSelftest();

/**
 * Count how many times each exported name is *declared* in its own file, so the
 * declaration itself can be discounted when measuring real usage.
 */
function countDecls(src) {
  const counts = new Map();
  const bump = (n) => counts.set(n, (counts.get(n) ?? 0) + 1);
  for (const m of src.matchAll(VALUE_DECL_RE)) bump(m[1]);
  for (const m of src.matchAll(TYPE_DECL_RE)) bump(m[1]);
  for (const m of src.matchAll(BRACE_RE)) {
    for (const piece of m[2].split(",")) {
      const t = piece.trim();
      if (!t) continue;
      const asMatch = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const bare = t.replace(/^type\s+/, "").trim();
      const name = asMatch ? asMatch[1] : bare.split(/\s+/)[0];
      if (name && name !== "default") bump(name);
    }
  }
  return counts;
}

/**
 * Real production usage of `name`: occurrences across **all** production files
 * (the declaring file included — a helper wired only into its own module *is*
 * used) minus its own declaration. Zero means the only things that mention it are
 * tests (or nothing at all).
 */
function prodUsage(name, ownSrc, cache) {
  const total = countIn(name, prodFiles, cache);
  return total - (countDecls(ownSrc).get(name) ?? 0);
}

// --- allow-list -------------------------------------------------------------
// Entries are either a whole module ({ path, module: true, reason }) or one
// exported symbol ({ path, name, reason }). Every entry MUST carry a reason, so
// each exemption is a deliberate, reviewable decision rather than a silent hole.
const allowPath = join(root, "scripts", "unwired-allowlist.json");
let allow = [];
if (existsSync(allowPath)) {
  allow = JSON.parse(readFileSync(allowPath, "utf8"));
  for (const e of allow) {
    if (!e.reason || !String(e.reason).trim()) {
      console.error(`[unwired-scan] allow-entry without reason: ${e.path}:${e.name ?? "(module)"}`);
      process.exit(2);
    }
  }
}
const allowKey = (p, n) => `${p}::${n}`;
const allowed = new Set(allow.filter((e) => e.name).map((e) => allowKey(e.path, e.name)));
const allowedModules = new Set(allow.filter((e) => e.module).map((e) => e.path));

// --- scan -------------------------------------------------------------------
/**
 * Comments are stripped before any counting: a symbol mentioned only in a comment is a *claim*
 * about wiring, not a call site — and "the docs say it is used" is exactly the failure mode this
 * scan exists to catch (it once hid `loadStoreTiles`, whose only non-test mention was its own
 * JSDoc).
 *
 * The stripper used to handle **block comments only** (`/\/\*…\*\//`), and kept `//` because a
 * `//` can appear inside a string literal (`"content://…"`), so a blind strip would silently
 * *under*-count real references. That trade-off has a cost that was never measured: a symbol
 * whose only surviving mention is a line comment reads as **wired**, and the comments that
 * explain *why a call site was removed* are exactly the ones that name it — `dockConfig`'s
 * `isFullscreen` and the four plain `wmSplit*` wrappers are hidden by nothing but that
 * (REQ-A1707). The fix is to strip well instead of stripping less: a small string-aware
 * scanner that removes `//`-to-EOL and `/* *\/` **outside** string literals (and regex
 * literals, whose character classes may contain `/*`), so the string-literal worry is
 * answered rather than traded against correctness.
 *
 * Kept deliberately shallow like the rest of this dependency-free scanner: `${…}` inside a
 * template literal is *not* re-entered (a comment there survives), which errs toward
 * over-counting — the pre-existing behaviour — rather than inventing a false "unwired".
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let prev = ""; // last significant (non-space) char outside strings — for regex detection
  // A regex literal may only start where a value is expected (`/[/*]/` is legal; `a / b` is not).
  const regexOk = (c) => c === "" || "=(,:[!&|?{};".includes(c);
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === q) {
          i++;
          break;
        }
        i++;
      }
      prev = q;
      continue;
    }
    // A bare `/` where a value is expected opens a regex literal; copy it through verbatim so a
    // `/*` inside a character class is not mistaken for a comment opener.
    if (c === "/" && regexOk(prev)) {
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (src[i] === "\n") break; // an unterminated regex: bail (never spans lines)
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        out += src[i];
        if (src[i] === "/" && !inClass) {
          i++;
          break;
        }
        i++;
      }
      prev = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const cache = new Map();
const readProd = (f) => {
  if (!cache.has(f)) cache.set(f, stripComments(readFileSync(f, "utf8")));
  return cache.get(f);
};

const findings = []; // zero production usage → gated (testRefs > 0 means test-only)
const typeFindings = []; // unused type exports → informational
// Every symbol with **zero** production usage, *before* the allow-list filter — the set the
// allow-list staleness test needs. Testing membership in `findings` instead would be circular:
// `findings` excludes exactly the allowed symbols, so every allow-list entry would look stale
// (measured: 8 false positives on the first attempt).
const unwiredKeys = new Set();
for (const file of symbolFiles) {
  const rel = relative(root, file);
  const src = stripComments(readFileSync(file, "utf8"));
  for (const { name, kind } of extractExports(src)) {
    const used = prodUsage(name, src, cache);
    if (used === 0) unwiredKeys.add(allowKey(rel, name));
    if (used > 0 || allowed.has(allowKey(rel, name))) continue;
    const testRefs = countIn(name, testFiles, cache);
    if (kind === "type") typeFindings.push({ path: rel, name, kind, testRefs });
    else findings.push({ path: rel, name, kind, testRefs });
  }
}

const byPathName = (a, b) =>
  a.path === b.path ? a.name.localeCompare(b.name) : a.path.localeCompare(b.path);
findings.sort(byPathName);
typeFindings.sort(byPathName);

// Module-level: lib files unreachable from any production root. A lib module is
// reached when ANY production file outside `src/lib` imports it (transitively).
const libRoots = prodFiles.filter((f) => !libFileSet.has(f));
const libReachable = reachable(cache, libRoots);
const unreachableModules = libFiles
  .map((f) => relative(root, f))
  .filter((p) => !libReachable.has(join(root, p)))
  .sort();
const deadModules = unreachableModules.filter((p) => !allowedModules.has(p));

// Component-level: a `.svelte` file no production entry chain mounts. This is the
// `.svelte` analogue of the dead-module check and catches the historical
// "component + tests + docs, but never mounted" defect (e.g. ClipboardAnnounce).
//
// Mount roots are the TRUE entries — production files that nothing else imports,
// excluding `src/lib` (checked above) **and components themselves**: a component
// must never be its own root, or an orphan would trivially "reach" itself and the
// check could never fire. (Shell.svelte is not a root: `shell-entry.ts` imports it.)
const importedBy = new Set();
for (const f of prodFiles) {
  for (const spec of importSpecifiers(readProd(f))) {
    const r = resolveSpec(f, spec);
    if (r) importedBy.add(r);
  }
}
const mountRoots = prodFiles.filter(
  (f) => !importedBy.has(f) && !libFileSet.has(f) && !f.endsWith(".svelte"),
);
const mountReachable = reachable(cache, mountRoots);
const unmountedAll = componentFiles
  .map((f) => relative(root, f))
  .filter((p) => !mountReachable.has(join(root, p)))
  .sort();
const unmountedComponents = unmountedAll.filter((p) => !allowedModules.has(p));

// --- baseline ratchet -------------------------------------------------------
// `scripts/unwired-baseline.json` records the known backlog so the gate fails on
// *new* unwired exports (regressions) without forcing a big-bang cleanup. A
// stale entry (now wired) **fails too** (REQ-A447 — the ratchet must shrink, not
// rot; a note was not enough), and so does an allow-list entry whose hole has been
// filled.
const baselinePath = join(root, "scripts", "unwired-baseline.json");
let baseline = { values: [], modules: [], components: [] };
if (existsSync(baselinePath)) baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const baseValues = new Set(baseline.values ?? []);
const baseModules = new Set(baseline.modules ?? []);
const baseComponents = new Set(baseline.components ?? []);

const valueKey = (f) => `${f.path}::${f.name}`;
const newValues = findings.filter((f) => !baseValues.has(valueKey(f)));
const fixedValues = [...baseValues].filter((k) => !findings.some((f) => valueKey(f) === k));
const newModules = deadModules.filter((m) => !baseModules.has(m));
const newComponents = unmountedComponents.filter((m) => !baseComponents.has(m));
/**
 * Stale **whole-file** baseline entries (REQ-A502).
 *
 * The `values` list already had this check ("shrink the ratchet"), the allow-list had it
 * (REQ-A447), but the baseline's `modules` / `components` lists were **never** checked — so a
 * baselined module that gets wired (or a component that gets mounted) left an entry behind
 * with nothing reporting it. That is not cosmetic: `newModules` / `newComponents` filter
 * *through* these same sets, so the stale entry **hides the next real regression of that very
 * file** (it goes dead again and is never reported as new). Measured before the fix: wiring
 * `lib/mediaPaging.ts` into the photos screen removed it from `deadModules` while
 * `baseline.modules` still counted 2, and the gate reported only the three value entries.
 *
 * The predicate uses the **unfiltered** sets (`unreachableModules` / `unmountedAll`), for the
 * same reason the allow-list check does: an allow-listed file is absent from the *filtered*
 * lists even though it is still unwired, and flagging it here would be a false positive.
 */
const fixedModules = [...baseModules].filter((m) => !unreachableModules.includes(m));
const fixedComponents = [...baseComponents].filter((m) => !unmountedAll.includes(m));

const updateBaseline = process.argv.includes("--update-baseline");
const verbose = process.argv.includes("--verbose") || process.argv.includes("--json");

const printFindings = (list, stream) => {
  const byFile = new Map();
  for (const f of list) {
    if (!byFile.has(f.path)) byFile.set(f.path, []);
    byFile.get(f.path).push(f.name);
  }
  for (const [path, names] of byFile) {
    stream(`  ${path}`);
    stream(`    ${names.join(", ")}`);
  }
};

if (updateBaseline) {
  const next = {
    values: findings.map(valueKey).sort(),
    modules: deadModules,
    components: unmountedComponents,
  };
  const outPath = baselinePath;
  const fs = await import("node:fs");
  fs.writeFileSync(outPath, JSON.stringify(next, null, 2) + "\n");
  console.log(
    `[unwired-scan] baseline updated: ${next.values.length} value(s), ` +
      `${next.modules.length} module(s), ${next.components.length} unmounted component(s).`,
  );
  process.exit(0);
}

// An excuse that outlived its file (REQ-A447). Two kinds, and neither used to be checked at all:
//   • a baseline entry whose symbol is wired now (`fixedValues`) — the ratchet must shrink;
//   • an allow-list entry whose module became reachable, or whose symbol is wired now — an
//     exemption for a hole that has been filled is a licence nobody revoked.
// The header said "a stale entry is reported, so the baseline cannot rot"; reporting was not
// enough, so both are failures now (the same rule the Rust ratchets got).
const allowStale = allow
  .filter((e) => {
    // An allow-list entry is a claim that its subject is *still* unwired. The sets the gate
    // reports are filtered by this very list, so the test has to use the **unfiltered** ones
    // (see `unwiredKeys` / `unreachableModules` / `unmountedAll`) or it would flag every entry.
    if (e.module) {
      return !unreachableModules.includes(e.path) && !unmountedAll.includes(e.path);
    }
    return !unwiredKeys.has(allowKey(e.path, e.name));
  })
  .map((e) => `${e.path}${e.name ? `::${e.name}` : " (module)"}`);
const staleProblems = fixedValues.length + allowStale.length + fixedModules.length + fixedComponents.length;

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        deadModules,
        newModules,
        unmountedComponents,
        newComponents,
        findings,
        newValues,
        typeFindings,
        allowed: allow.length,
        allowStale,
        fixedValues,
        fixedModules,
        fixedComponents,
        scanned: symbolFiles.length,
        baseline: {
          values: baseValues.size,
          modules: baseModules.size,
          components: baseComponents.size,
        },
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[unwired-scan] ${symbolFiles.length} symbol file(s) (lib + svelte helpers), ` +
      `${libFiles.length} lib module(s), ${componentFiles.length} component(s), ` +
      `${prodFiles.length} prod + ${testFiles.length} test file(s) scanned.`,
  );
  if (deadModules.length === 0) {
    const excused = allow.filter((e) => e.module && unreachableModules.includes(e.path)).length;
    console.log(
      `[unwired-scan] OK — no unreachable src/lib module is unaccounted for ` +
        `(${excused} allow-listed with a reason).`,
    );
  }
  if (unmountedComponents.length === 0) {
    const excused = allow.filter((e) => e.module && unmountedAll.includes(e.path)).length;
    console.log(
      `[unwired-scan] OK — no unmounted production .svelte component is unaccounted for ` +
        `(${excused} allow-listed with a reason).`,
    );
  }
  if (fixedValues.length > 0) {
    console.error(
      `[unwired-scan] FAIL — ${fixedValues.length} baseline entr(y/ies) now wired; shrink the baseline with --update-baseline (the ratchet must shrink, not rot).`,
    );
  }
  // REQ-A502: the whole-file half of the same rule. A stale `modules` / `components` entry is
  // worse than a stale value entry — it filters *through* `newModules`/`newComponents`, so the
  // file going dead again would never be reported.
  if (fixedModules.length > 0 || fixedComponents.length > 0) {
    console.error(
      `[unwired-scan] FAIL — ${fixedModules.length} baseline module(s) and ${fixedComponents.length} baseline component(s) are no longer unwired (reachable, mounted, or the file is gone); shrink the baseline with --update-baseline (a stale whole-file entry hides the next regression of that very file).`,
    );
    for (const m of fixedModules) console.error(`       - module no longer unwired: ${m}`);
    for (const c of fixedComponents) console.error(`       - component no longer unwired: ${c}`);
  }
  if (allowStale.length > 0) {
    console.error(
      `[unwired-scan] FAIL — ${allowStale.length} allow-list entr(y/ies) no longer name a hole (the module is reachable / the symbol is wired): ${allowStale.join(", ")}`,
    );
  }
  const testOnly = findings.filter((f) => f.testRefs > 0).length;
  console.log(
    `[unwired-scan] ${findings.length} baselined value export(s) with no production call site ` +
      `(${testOnly} test-only, ${findings.length - testOnly} referenced nowhere).`,
  );
  if (typeFindings.length > 0) {
    console.log(`[unwired-scan] ${typeFindings.length} unused *type* export(s) (informational).`);
  }
  // The full backlog is only listed when it changed (or --verbose is asked), so a
  // passing lint run stays quiet.
  if (newValues.length > 0 || verbose) {
    printFindings(findings, (s) => console.log(s));
  }
  if (newModules.length > 0 || verbose) {
    for (const m of deadModules) console.log(`  unreachable module: ${m}`);
  }
  if (newComponents.length > 0 || verbose) {
    for (const c of unmountedComponents) console.log(`  unmounted component: ${c}`);
  }
  if (newModules.length > 0) {
    console.error(
      `[unwired-scan] FAIL — ${newModules.length} newly unreachable module(s): ${newModules.join(", ")}`,
    );
  }
  if (newComponents.length > 0) {
    console.error(
      `[unwired-scan] FAIL — ${newComponents.length} newly unmounted component(s): ${newComponents.join(", ")}`,
    );
  }
  if (newValues.length > 0) {
    console.error(
      `[unwired-scan] FAIL — ${newValues.length} newly unwired export(s):\n` +
        newValues.map((f) => `  ${valueKey(f)}`).join("\n"),
    );
    console.error(
      "\nFix by wiring the symbol into production, deleting it, or (if it is deliberate\n" +
        "API) recording it in scripts/unwired-baseline.json via `--update-baseline`.",
    );
  }
}

process.exit(
  newModules.length === 0 && newComponents.length === 0 && newValues.length === 0 && staleProblems === 0
    ? 0
    : 1,
);
