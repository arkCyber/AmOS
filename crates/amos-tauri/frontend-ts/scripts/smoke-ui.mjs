#!/usr/bin/env node
/**
 * smoke-ui.mjs — repeatable LOCAL UI smoke test (exit 0/1).
 *
 *   node scripts/smoke-ui.mjs [--skip-build]
 *
 * What it does:
 *   1. ensures a production build exists (dist/) — `vite build` writes it;
 *   2. starts `vite preview` (or reuses one already on the port);
 *   3. drives headless Chrome to load the home screen;
 *   4. asserts the Svelte HomeDock actually rendered by polling the dumped DOM
 *      for the launcher markers (grid / page dots / bottom dock bar / search);
 *   5. tears everything down and exits 0 on success, 1 on any failure.
 *
 * The PRODUCTION build (import.meta.env.PROD=true) routes home to Svelte via
 * `svelteEnabled()`, so this exercises the Svelte path with no localStorage.
 *
 * Env knobs:
 *   CHROME_BIN   – path to a Chrome/Chromium binary (auto-detects macOS default)
 *   PORT         – preview port (default 4173)
 *   UI_SMOKE_MAX_SEC – how long to wait for the markers before failing (default 45)
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const port = Number(process.env.PORT ?? 4173);
const maxMs = Number(process.env.UI_SMOKE_MAX_SEC ?? 45) * 1000;
const base = `http://localhost:${port}/`;

// Markers that must ALL be present in the rendered home DOM (Svelte HomeDock).
const MARKERS = [
  'data-testid="home-grid"', // paged icon grid
  "home-dot", // page dots (multi-page layout)
  "dock-mag", // single-row bottom dock bar
  'aria-label="search"', // search pill
];

// Strict mode (UI_SMOKE_STRICT=1) additionally requires bespoke first-party
// tile art (an <svg> glyph rendered by svelte/AppIcon from lib/appIcon) to be
// present — proving the framework-agnostic icon pipeline renders, not just the
// shell skeleton.
if (process.env.UI_SMOKE_STRICT === "1") MARKERS.push("<svg");

// Runs under Node or Bun (both execute this .mjs and expose fetch/process).
const isBun = typeof Bun !== "undefined";

const skipBuild = process.argv.includes("--skip-build");

function log(...a) {
  console.log(`[smoke-ui${isBun ? "/bun" : "/node"}]`, ...a);
}

function chromeBin() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("no Chrome/Chromium found (set CHROME_BIN)");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpOk(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not ready yet */
    }
    await sleep(250);
  }
  return false;
}

function killTree(proc) {
  try {
    process.kill(-proc.pid, "SIGKILL"); // detached process group
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function spawnDetached(cmd, args, outFd, errFd) {
  return spawn(cmd, args, { detached: true, stdio: ["ignore", outFd, errFd] });
}

async function main() {
  let exitCode = 1;
  let preview = null;
  const work = mkdtempSync(join(tmpdir(), "amos-smoke-"));

  try {
    if (!skipBuild) {
      log("building production bundle (dist/)…");
      await new Promise((resolve, reject) => {
        const b = spawn(process.execPath, [viteBin, "build"], { stdio: "inherit" });
        b.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`vite build exited ${c}`))));
        b.on("error", reject);
      });
    } else if (!existsSync(join(root, "dist", "index.html"))) {
      throw new Error("dist/ missing — run without --skip-build (or `vite build`) first");
    }

    log(`starting preview on :${port}…`);
    if (await httpOk(base, 6)) {
      log(`port ${port} already serving — reusing it`);
    } else {
      const out = openSync(join(work, "preview.out"), "w");
      const err = openSync(join(work, "preview.err"), "w");
      preview = spawnDetached(process.execPath, [viteBin, "preview", "--port", String(port), "--strictPort"], out, err);
      closeSync(out);
      closeSync(err);
      if (!(await httpOk(base))) {
        log("preview did not become ready in time");
        log(readFileSync(join(work, "preview.err"), "utf8").slice(-2000));
        throw new Error("preview not ready");
      }
    }
    log("preview ready");

    log("loading home in headless Chrome and dumping DOM…");
    const domFd = openSync(join(work, "dom.html"), "w");
    const errFd = openSync(join(work, "chrome.err"), "w");
    const chrome = spawnDetached(chromeBin(), [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--user-data-dir=" + join(work, "profile"),
      "--virtual-time-budget=9000",
      "--dump-dom",
      base,
    ], domFd, errFd);
    closeSync(domFd);
    closeSync(errFd);

    // The app keeps live timers (home clock), so Chrome may not exit by itself.
    // Poll the DOM dump until all markers appear (or timeout), then kill it.
    const domPath = join(work, "dom.html");
    let text = "";
    const start = Date.now();
    const found = new Set();
    while (Date.now() - start < maxMs) {
      await sleep(600);
      if (existsSync(domPath)) text = readFileSync(domPath, "utf8");
      for (const m of MARKERS) if (text.includes(m)) found.add(m);
      if (found.size === MARKERS.length) break;
    }
    killTree(chrome);

    log(`markers found: ${found.size}/${MARKERS.length} in ${Math.round((Date.now() - start) / 1000)}s`);
    let ok = true;
    for (const m of MARKERS) {
      const hit = text.includes(m);
      ok = ok && hit;
      log(`  ${hit ? "PASS" : "FAIL"}  ${m}`);
    }
    if (ok) {
      log("UI smoke OK");
      exitCode = 0;
    } else {
      log("UI smoke FAILED — Svelte home did not render the expected markers");
      log("dom bytes: " + text.length);
      exitCode = 1;
    }
  } catch (e) {
    log("error:", e && e.message);
    exitCode = 1;
  } finally {
    if (preview) killTree(preview);
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main();

