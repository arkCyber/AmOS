#!/usr/bin/env node
/**
 * device-ui-eval.mjs — evaluate JavaScript inside the running AmOS WebView on a
 * connected device, through the Chrome DevTools Protocol.
 *
 * Why: the System UI is a Tauri WebView. On device its DOM is invisible to
 * `uiautomator` (a single WebView node) and to `adb shell input tap` (no
 * coordinates a test can derive), so every device check used to stop at "the app
 * launched". A **debuggable** build exposes the WebView's devtools socket
 * (`@webview_devtools_remote_<pid>`), and `Runtime.evaluate` over it drives the
 * *real* UI: whether a control exists, what it renders, and what the real bridge
 * returns — the same path a finger would take.
 *
 * Usage:
 *   node scripts/device-ui-eval.mjs 'document.title'
 *   node scripts/device-ui-eval.mjs --await 'await window.__probe()'
 *   node scripts/device-ui-eval.mjs --file probe.js
 *   node scripts/device-ui-eval.mjs --list          # devtools targets
 *   node scripts/device-ui-eval.mjs --help
 *
 * Requirements: `adb` on PATH, exactly one device (or `--serial <id>`), and an
 * app build with `debuggable true` (debug APK / `android:debuggable`).
 * The script sets up `adb forward tcp:<port>` itself; nothing is installed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const has = (name) => args.includes(name);

/**
 * Run adb and report its exit status without judging it.
 *
 * `pidof` **exits 1 when the process does not exist** — which is the single most common device
 * state (the app was killed; on the S5 it happened under load). Treating that as "adb is broken"
 * hid the real cause behind a stack trace from this script, so the tolerant form is used
 * wherever a non-zero exit is an *answer* rather than a failure (REQ-A365, F-DEV-003).
 */
function adbRaw(...a) {
  const serial = opt("--serial");
  const full = serial ? ["-s", serial, ...a] : a;
  const out = spawnSync("adb", full, { encoding: "utf8" });
  return {
    status: out.status,
    stdout: (out.stdout ?? "").trim(),
    stderr: (out.stderr ?? "").trim(),
    cmd: `adb ${full.join(" ")}`,
  };
}

/** Run adb and throw on a non-zero exit, naming the command, its status and its stderr. */
function adb(...a) {
  const r = adbRaw(...a);
  if (r.status !== 0) {
    throw new Error(`${r.cmd} exited ${r.status}${r.stderr ? `: ${r.stderr}` : ""}`);
  }
  return r.stdout;
}

/** The debuggable WebView's devtools socket, forwarded to a local port. */
function targets(port) {
  const pkg = opt("--package", "com.amos.ai");
  const pid = adbRaw("shell", "pidof", pkg).stdout;
  if (!pid) {
    throw new Error(
      `app is not running (no process for ${pkg}) — launch it first:\n` +
        `  adb shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`,
    );
  }
  const socket = adb("shell", "cat", "/proc/net/unix").split("\n").find((l) => l.includes("webview_devtools_remote"));
  if (!socket) throw new Error("no webview_devtools_remote socket — is this build debuggable?");
  adb("forward", `tcp:${port}`, `localabstract:${socket.trim().split(/\s+/).pop().replace(/^@/, "")}`);
  return { pid, socket: socket.trim().split(/\s+/).pop() };
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  return res.json();
}

/** Evaluate `expression` in the first page target; resolves await when asked. */
/**
 * Wait until the page can actually answer (REQ-A365).
 *
 * A cold-started WebView on a loaded device keeps the devtools socket open while the document is
 * still booting — `document.title` is empty and the shell has painted nothing — and in that state
 * `Runtime.evaluate` simply never comes back, which reads as a tool failure. So we ask the page a
 * trivial question in a bounded loop first and only then run the caller's expression. Readiness
 * means: the document is complete, the host bridge is injected, and the shell has painted at least
 * one button (a blank page has none).
 */
async function waitForPage(port, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "(never asked)";
  for (;;) {
    try {
      const probe = `document.readyState + '|' + (typeof window.__TAURI_INTERNALS__?.invoke === 'function' ? 'bridge' : 'no-bridge') + '|' + document.querySelectorAll('button').length`;
      const state = String(
        (await evaluate(port, probe, {
          timeoutMs: Math.max(1000, Math.min(4000, deadline - Date.now())),
        })) ?? "",
      );
      last = state;
      const [readyState, bridge, buttons] = state.split("|");
      if (readyState === "complete" && bridge === "bridge" && Number(buttons) > 0) return state;
    } catch (e) {
      last = String((e && e.message) || e);
    }
    if (Date.now() >= deadline) {
      throw new Error(`page never became ready within ${timeoutMs}ms (last: ${last})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function evaluate(port, expression, { awaitPromise = false, timeoutMs = 15000 } = {}) {
  const list = await listTargets(port);
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target in the WebView");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("devtools evaluate timed out")), timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise, returnByValue: true, userGesture: true },
        }),
      );
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      resolve(msg.result);
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`devtools socket error: ${e.message ?? e}`));
    });
  });
  ws.close();
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result?.value;
}

const HELP = `device-ui-eval.mjs — run JS in the on-device AmOS WebView (CDP).

  node scripts/device-ui-eval.mjs '<js expression>'   evaluate (sync)
  node scripts/device-ui-eval.mjs --await '<js>'      evaluate and await a promise
  node scripts/device-ui-eval.mjs --file <path>       evaluate a file
  node scripts/device-ui-eval.mjs --list              list devtools targets
  options: --serial <adb-serial> --package <pkg> --port <tcp-port> --json
`;

if (has("--help") || args.length === 0) {
  console.log(HELP);
  process.exit(args.length === 0 ? 2 : 0);
}

const PORT = Number(opt("--port", "9222"));
const info = targets(PORT);
if (has("--list")) {
  const list = await listTargets(PORT);
  console.log(JSON.stringify({ pid: info.pid, socket: info.socket, targets: list.map((t) => ({ title: t.title, url: t.url, type: t.type })) }, null, 2));
  process.exit(0);
}

const file = opt("--file");
const expression = file ? readFileSync(file, "utf8") : args.find((a) => !a.startsWith("--") && a !== opt("--serial") && a !== opt("--package") && a !== opt("--port"));
if (!expression) {
  console.error("[device-ui-eval] no expression given\n" + HELP);
  process.exit(2);
}
try {
  // Cold-start robustness: never run the caller's expression against a page that is still booting
  // (that produced a bare "devtools evaluate timed out" with no hint about the real state).
  const ready = await waitForPage(PORT, {
    timeoutMs: Number(opt("--wait", "30000")) || 30000,
  });
  const value = await evaluate(PORT, expression, { awaitPromise: has("--await") });
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, has("--json") ? 2 : 0));
  if (process.env.AMOS_EVAL_VERBOSE) console.error(`[device-ui-eval] page ready as ${ready}`);
} catch (err) {
  console.error(`[device-ui-eval] ${err.message}`);
  process.exit(1);
}
