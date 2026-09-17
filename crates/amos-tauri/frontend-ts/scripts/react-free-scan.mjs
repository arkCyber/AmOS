#!/usr/bin/env node
/**
 * react-free-scan.mjs — "the shell is Svelte-only, and stays that way".
 *
 * Motivation: the React→Svelte migration is **finished** (no `.tsx`, no `react` dependency,
 * every registry loader is a `.svelte`), but nothing *said* so. The audit that recorded the
 * plan (`SVELTE_MIGRATION_AUDIT.md`) still listed eleven screens as "still React" and the
 * bundle as "not yet slimmed" — so the next session could have re-done work that was
 * already done, or trusted a number that no longer exists. A migration whose completion is
 * only recorded in prose is one `git revert` away from being silently undone: a `.tsx`
 * coming back with React in `package.json` looks exactly like a working tree.
 *
 * This gate is the missing sentence, and it is deliberately about the **shell's own
 * composition** rather than about style:
 *   1. no `.tsx`/`.jsx` anywhere in the frontend (node_modules excluded) — a React
 *      component cannot reappear unnoticed;
 *   2. no `react`/`react-dom` in any dependency bucket of `package.json` — a re-added
 *      dependency is the usual way it comes back;
 *   3. no React import in `src/**` or `svelte-tests/**` (static, `require`, or dynamic);
 *   4. every `import("…")` in `src/svelte/appRegistry.ts` resolves to a **`.svelte`** file —
 *      the property the migration's whole value rests on (the shell mounts Svelte screens).
 *
 * Rules 1–3 are exact (a file extension, a dependency name, an import specifier). Rule 4 is
 * a syntax-scan of one known file, not a resolver: it reads the string literals inside
 * `import(...)` and requires the `.svelte` suffix, so a loader that quietly starts importing
 * a `.ts` module fails here even if the app still "works".
 *
 * `--selftest` pins the three extractors against inline samples.
 *
 * Usage:
 *   node scripts/react-free-scan.mjs             # the gate
 *   node scripts/react-free-scan.mjs --selftest  # pin the extractors
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // frontend-ts/
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".vite"]);

/** Every file under `dir`, skipping the build/dependency directories. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** The specifiers of every `import(...)` in `src` — static or dynamic, both share this text. */
export function importSpecifiers(src) {
  return [...src.matchAll(/import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
}

/** Every module a file imports from, for the three React import forms. */
export function importSources(src) {
  const hits = [];
  for (const m of src.matchAll(/from\s*["']([^"']+)["']/g)) hits.push(m[1]);
  for (const m of src.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)) hits.push(m[1]);
  for (const m of src.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) hits.push(m[1]);
  return hits;
}

/** Is this specifier React itself (not `react-something-else`)? */
export function isReactSpecifier(spec) {
  return spec === "react" || spec === "react-dom" || spec.startsWith("react/") || spec.startsWith("react-dom/");
}

function selftest() {
  const problems = [];
  const want = (label, got, expected) => {
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    }
  };

  want("importSpecifiers: dynamic", importSpecifiers(`const x = () => import("./PhotosApp.svelte");`), ["./PhotosApp.svelte"]);
  want("importSpecifiers: ignores a static import", importSpecifiers(`import { t } from "./locale";`), []);
  want("importSources: static", importSources(`import { useState } from "react";`), ["react"]);
  want("importSources: require", importSources(`const React = require('react-dom');`), ["react-dom"]);
  want("importSources: dynamic", importSources(`const A = await import("react");`), ["react"]);

  // The React test must not swallow a look-alike package: `react-router` is not React, and
  // a false positive here would block a legitimate dependency.
  want("isReactSpecifier: react", isReactSpecifier("react"), true);
  want("isReactSpecifier: react-dom/client", isReactSpecifier("react-dom/client"), true);
  want("isReactSpecifier: look-alike", isReactSpecifier("react-router"), false);
  want("isReactSpecifier: preact", isReactSpecifier("preact/compat"), false);

  if (problems.length > 0) {
    console.error(`[react-free-scan] selftest FAIL:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[react-free-scan] selftest: 9 assertion(s), 0 failure(s).`);
}

if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

const files = walk(ROOT);
const problems = [];

// 1. No React source file may exist.
for (const f of files) {
  if (f.endsWith(".tsx") || f.endsWith(".jsx")) {
    problems.push(`React source file is back: ${relative(ROOT, f)}`);
  }
}

// 2. No React dependency in any bucket.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
for (const bucket of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  for (const name of Object.keys(pkg[bucket] ?? {})) {
    if (isReactSpecifier(name)) problems.push(`React dependency is back: ${bucket}.${name}`);
  }
}

// 3. No React import in the shell or its tests.
for (const f of files) {
  if (!/\.(ts|svelte)$/.test(f)) continue;
  if (!(f.startsWith(join(ROOT, "src")) || f.startsWith(join(ROOT, "svelte-tests")))) continue;
  const src = readFileSync(f, "utf8");
  for (const spec of importSources(src)) {
    if (isReactSpecifier(spec)) problems.push(`React import is back: ${relative(ROOT, f)} imports ${spec}`);
  }
}

// 4. Every registry loader must import a Svelte screen.
const registry = readFileSync(join(ROOT, "src/svelte/appRegistry.ts"), "utf8");
const loaders = importSpecifiers(registry);
if (loaders.length === 0) problems.push("appRegistry.ts has no loaders — did the registry shape change?");
for (const spec of loaders) {
  if (!spec.endsWith(".svelte")) {
    problems.push(`registry loader is not a Svelte screen: appRegistry.ts imports ${spec}`);
  }
}

if (problems.length > 0) {
  console.error(`[react-free-scan] FAIL — ${problems.length} trace(s) of React coming back:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nThe shell is Svelte-only (see docs/SVELTE_MIGRATION_AUDIT.md §\"状态校正\").\n" +
      "If a React screen is genuinely being added back, say so in that document and this\n" +
      "gate's rules — do not let it return silently.",
  );
  process.exit(1);
}
console.log(
  `[react-free-scan] OK — Svelte-only shell: 0 .tsx, no react dependency, ` +
    `${loaders.length} registry loader(s) all .svelte.`,
);

