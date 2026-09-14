#!/usr/bin/env node
/**
 * dist-freshness.mjs — is the **embedded** frontend bundle newer than its sources?
 *
 * Why this exists: `crates/amos-tauri/tauri.conf.json` declares an **empty**
 * `beforeBuildCommand`, so the release desktop binary embeds whatever
 * `frontend-ts/dist` happens to contain at build time. `scripts/run-ui-release.sh`
 * builds that binary and launches it — and nothing ever asked whether `dist` is
 * *current*. On 2026-09-14 the tree held a `dist` ten hours older than the sources,
 * i.e. the "PC version" would have shipped a UI without the window/split work of
 * that whole session, with no signal anywhere (REQ-A228). The debug path
 * (`make run-ui-dev`) is not affected: it loads the Vite dev server from
 * `build.devUrl`, so it always shows the sources.
 *
 * What it compares: the newest mtime under the build **inputs** (`src/`, `public/`,
 * the HTML entries, the bundler/Tailwind/TS configs, the lockfile) against
 * `dist/index.html`. Nothing under `dist/` or `node_modules/` is ever an input — a
 * bundle cannot make itself stale.
 *
 * Usage (from the repo root, or from `frontend-ts`):
 *   node scripts/dist-freshness.mjs            # gate (exit 1 when stale/missing)
 *   node scripts/dist-freshness.mjs --json     # machine-readable
 *   node scripts/dist-freshness.mjs --selftest # pin the decision on a temp tree
 *
 * Env: `AMOS_UI_DIR` overrides the frontend directory (tests, unusual layouts).
 */
import { readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = process.env.AMOS_UI_DIR ?? join(repoRoot, "crates/amos-tauri/frontend-ts");

/** Files/dirs whose modification must be reflected in `dist`. */
export const BUILD_INPUTS = [
  "src",
  "public",
  "index.html",
  "shell.html",
  "package.json",
  "vite.config.ts",
  "svelte.config.js",
  "tailwind.config.js",
  "postcss.config.js",
  "tsconfig.json",
  "bun.lock",
];

/** Never inputs: build output, dependencies, tool caches. */
const NEVER_INPUTS = new Set(["dist", "node_modules", ".git", ".vite", ".svelte-kit"]);

/** Recursively collect `{ path, mtime }` for every existing input (sorted, stable). */
export function collectInputs(uiDir, inputs = BUILD_INPUTS) {
  const found = [];
  const walk = (abs, rel) => {
    let st;
    try {
      st = statSync(abs);
    } catch {
      return; // a checkout may legitimately lack `public/` or `bun.lock`
    }
    if (st.isDirectory()) {
      for (const ent of readdirSync(abs, { withFileTypes: true })) {
        if (NEVER_INPUTS.has(ent.name)) continue;
        walk(join(abs, ent.name), rel ? `${rel}/${ent.name}` : ent.name);
      }
      return;
    }
    if (st.isFile()) found.push({ path: rel, mtime: st.mtimeMs });
  };
  for (const rel of inputs) walk(join(uiDir, rel), rel);
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}

/**
 * The decision, pure over the collected evidence.
 *
 * `fresh` only when a bundle exists **and** no input is newer than it. A missing
 * bundle is stale by construction: the release binary would embed nothing.
 */
export function decide({ inputs, distMtime }) {
  const newest = inputs.reduce((acc, e) => (acc === null || e.mtime > acc.mtime ? e : acc), null);
  if (distMtime == null) {
    return { fresh: false, reason: "no-bundle", newest };
  }
  if (newest && newest.mtime > distMtime) {
    return { fresh: false, reason: "stale", newest, distMtime };
  }
  return { fresh: true, reason: "fresh", newest, distMtime };
}

function bundleMtime(uiDir) {
  try {
    return statSync(join(uiDir, "dist/index.html")).mtimeMs;
  } catch {
    return null;
  }
}

function stamp(ms) {
  return ms == null ? "(missing)" : new Date(ms).toISOString();
}

function report(uiDir) {
  const inputs = collectInputs(uiDir);
  const decision = decide({ inputs, distMtime: bundleMtime(uiDir) });
  return { uiDir, inputs: inputs.length, ...decision };
}

// --- CLI -------------------------------------------------------------------

const args = new Set(process.argv.slice(2));

if (args.has("--selftest")) {
  let failed = 0;
  const check = (name, cond) => {
    if (!cond) {
      failed += 1;
      console.error(`[dist-freshness] SELFTEST FAIL: ${name}`);
    }
  };
  const dir = mkdtempSync(join(tmpdir(), "amos-dist-fresh-"));
  const at = (rel, ms) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "x");
    const t = ms / 1000;
    utimesSync(abs, t, t);
  };
  const T0 = 1_700_000_000_000;
  // 1) no bundle at all ⇒ stale, and it says why.
  at("src/a.ts", T0);
  let d = decide({ inputs: collectInputs(dir), distMtime: bundleMtime(dir) });
  check("a missing bundle is not fresh", d.fresh === false && d.reason === "no-bundle");
  // 2) a source newer than the bundle ⇒ stale, and it names the newest input.
  at("dist/index.html", T0 + 1000);
  d = decide({ inputs: collectInputs(dir), distMtime: bundleMtime(dir) });
  check("a bundle newer than its source is fresh", d.fresh === true);
  at("src/b.ts", T0 + 2000);
  d = decide({ inputs: collectInputs(dir), distMtime: bundleMtime(dir) });
  check("a newer source makes it stale", d.fresh === false && d.reason === "stale");
  check("the newest input is reported", d.newest?.path === "src/b.ts");
  // 3) a changed config counts (it changes the output), a dist file never does.
  at("vite.config.ts", T0 + 3000);
  d = decide({ inputs: collectInputs(dir), distMtime: bundleMtime(dir) });
  check("a config change counts as an input change", d.newest?.path === "vite.config.ts");
  at("dist/assets/app.js", T0 + 9000);
  const paths = collectInputs(dir).map((e) => e.path);
  check(
    "nothing under dist/ is an input",
    !paths.some((p) => p === "dist" || p.startsWith(`dist${sep}`)),
  );
  d = decide({ inputs: collectInputs(dir), distMtime: bundleMtime(dir) });
  check("a dist-only change cannot refresh the decision", d.fresh === false);
  // 4) node_modules is ignored even when it is far newer.
  at("node_modules/dep/w.js", T0 + 99_000);
  check(
    "node_modules is not an input",
    !collectInputs(dir).some((e) => e.path.startsWith("node_modules")),
  );
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
  console.log("[dist-freshness] selftest OK — 8 assertion(s)");
  process.exit(0);
}

const result = report(UI_DIR);
if (args.has("--json")) {
  console.log(JSON.stringify(result, null, 1));
} else if (result.fresh) {
  console.log(
    `[dist-freshness] OK — dist is current (${result.inputs} input file(s); ` +
      `newest ${result.newest?.path ?? "—"} at ${stamp(result.newest?.mtime)})`,
  );
} else if (result.reason === "no-bundle") {
  console.error(
    "[dist-freshness] NO BUNDLE — `frontend-ts/dist/index.html` does not exist, so a\n" +
      "  release (embedded) build would ship an empty UI. Build it first:\n" +
      "      make frontend-dist       # = cd crates/amos-tauri/frontend-ts && bun run build",
  );
} else {
  console.error(
    "[dist-freshness] STALE — the embedded bundle is older than its sources, so the\n" +
      "  release desktop binary would ship a UI that does not match this tree:\n" +
      `      newest input   : ${result.newest.path}  (${stamp(result.newest.mtime)})\n` +
      `      dist/index.html: ${stamp(result.distMtime)}\n` +
      "  Rebuild it:\n" +
      "      make frontend-dist       # = cd crates/amos-tauri/frontend-ts && bun run build\n" +
      "  (The debug path — `make run-ui-dev` — loads the Vite dev server and is unaffected.)",
  );
}
process.exit(result.fresh ? 0 : 1);
