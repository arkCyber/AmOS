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

function adb(...a) {
  const serial = opt("--serial");
  const full = serial ? ["-s", serial, ...a] : a;
  const out = spawnSync("adb", full, { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`adb ${full.join(" ")} failed: ${out.stderr.trim()}`);
  return out.stdout.trim();
}

/** The debuggable WebView's devtools socket, forwarded to a local port. */
function targets(port) {
  const pid = adb("shell", "pidof", opt("--package", "com.amos.ai"));
  if (!pid) throw new Error("app is not running (adb shell pidof found nothing)");
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
  const value = await evaluate(PORT, expression, { awaitPromise: has("--await") });
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, has("--json") ? 2 : 0));
} catch (err) {
  console.error(`[device-ui-eval] ${err.message}`);
  process.exit(1);
}
