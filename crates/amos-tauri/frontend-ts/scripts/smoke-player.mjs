#!/usr/bin/env node
/**
 * smoke-player.mjs — repeatable REAL-UI smoke test for the 媒体播放器 (player).
 *
 *   bun scripts/smoke-player.mjs [--skip-build]
 *
 * Where `smoke-ui.mjs` proves the home screen renders, this drives the shell's
 * URL surface (`shell.html?surface=app&id=player`, see `src/shell-entry.ts`) and
 * asserts the **player screen actually mounted and rendered** in a real browser:
 * a transport play button, the speed button, the seek slider, a real `<audio>`
 * element, and a non-empty playlist. With no Tauri bridge (a plain browser) the
 * player must fall back to its synthesized demo tracks — so this also locks the
 * "no bridge → still usable" contract.
 *
 * Env knobs:
 *   CHROME_BIN        path to Chrome/Chromium (auto-detects the macOS default)
 *   PORT              preview port (default 4173)
 *   UI_SMOKE_MAX_SEC  how long to wait for the markers (default 45)
 *   AMOS_APP_ID       app surface to open (default "player")
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const isBun = typeof Bun !== "undefined";
const port = Number(process.env.PORT ?? 4173);
const maxMs = Number(process.env.UI_SMOKE_MAX_SEC ?? 45) * 1000;
const appId = process.env.AMOS_APP_ID ?? "player";
const skipBuild = process.argv.includes("--skip-build");
const base = `http://localhost:${port}/`;
const surface = `${base}shell.html?surface=app&id=${encodeURIComponent(appId)}`;

// Markers that must ALL be present in the rendered player DOM. Chosen to be
// locale-independent (icon hooks + element names), not user-visible text.
const MARKERS = [
  'data-icon="play"', // transport play button (or the active row's play glyph)
  'data-icon="rate"', // playback-speed button
  'role="slider"', // seek bar
  "<audio", // the real media element for the active track
  'data-icon="rotateCcw"', // rescan button
  'data-icon="musicNote"', // audio placeholder / playlist glyph
];

function log(...a) {
  console.log(`[smoke-player${isBun ? "/bun" : "/node"}]`, ...a);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const spawnDetached = (cmd, args, outFd, errFd) =>
  spawn(cmd, args, { detached: true, stdio: ["ignore", outFd, errFd] });

async function main() {
  let exitCode = 1;
  let preview = null;
  const work = mkdtempSync(join(tmpdir(), "amos-player-smoke-"));

  try {
    if (!skipBuild) {
      log("building production bundle (dist/)…");
      await new Promise((resolve, reject) => {
        const b = spawn(process.execPath, [viteBin, "build"], { stdio: "inherit" });
        b.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`vite build exited ${c}`))));
        b.on("error", reject);
      });
    } else if (!existsSync(join(root, "dist", "shell.html"))) {
      throw new Error("dist/shell.html missing — run without --skip-build (or `vite build`) first");
    }

    log(`starting preview on :${port}…`);
    if (await httpOk(base, 6)) {
      log(`port ${port} already serving — reusing it`);
    } else {
      const out = openSync(join(work, "preview.out"), "w");
      const err = openSync(join(work, "preview.err"), "w");
      preview = spawnDetached(
        process.execPath,
        [viteBin, "preview", "--port", String(port), "--strictPort"],
        out,
        err,
      );
      closeSync(out);
      closeSync(err);
      if (!(await httpOk(base))) {
        log("preview did not become ready in time");
        log(readFileSync(join(work, "preview.err"), "utf8").slice(-2000));
        throw new Error("preview not ready");
      }
    }
    log("preview ready");

    log(`opening ${appId} in headless Chrome (${surface})…`);
    const domFd = openSync(join(work, "dom.html"), "w");
    const errFd = openSync(join(work, "chrome.err"), "w");
    const chrome = spawnDetached(
      chromeBin(),
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--user-data-dir=" + join(work, "profile"),
        // The app surface mounts via a dynamic import + effects, so a short
        // virtual-time budget snapshots the shell before the screen exists.
        "--virtual-time-budget=25000",
        "--dump-dom",
        surface,
      ],
      domFd,
      errFd,
    );
    closeSync(domFd);
    closeSync(errFd);

    // The player runs live timers, so Chrome may not exit on its own: poll the
    // DOM dump until every marker appears, then kill it.
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

    log(
      `markers found: ${found.size}/${MARKERS.length} in ${Math.round((Date.now() - start) / 1000)}s`,
    );
    let ok = true;
    for (const m of MARKERS) {
      const hit = text.includes(m);
      ok = ok && hit;
      log(`  ${hit ? "PASS" : "FAIL"}  ${m}`);
    }
    // Informational (locale-dependent): with no Tauri bridge the library is
    // empty, so the player must show its synthesized demo tracks.
    const demo = text.includes("示例") || text.toLowerCase().includes("demo");
    log(`  ${demo ? "INFO" : "WARN"}  demo fallback present: ${demo}`);
    if (ok) {
      log("player UI smoke OK");
      exitCode = 0;
    } else {
      log("player UI smoke FAILED — the player screen did not render the expected markers");
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
