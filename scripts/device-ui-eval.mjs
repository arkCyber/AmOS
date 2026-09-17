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
 *   node scripts/device-ui-eval.mjs --selftest      # device-free parser/decision tests
 *   node scripts/device-ui-eval.mjs --help
 *
 * **Why a stalled evaluation now names its cause** (REQ-A367, F-DEV-004). A page that never
 * answers used to be reported as a *symptom* — `devtools evaluate timed out` /
 * `page never became ready within 30000ms` — and a symptom with no cause reads like a broken
 * tool. The real state (measured on the S5) was a **window in front of the app**: the
 * notification shade was pulled down while `com.amos.ai/.MainActivity` was still the resumed
 * activity, and Android **pauses an obscured WebView**, so its JS stops and
 * `Runtime.evaluate` can never return. The failure path therefore reads `dumpsys window` /
 * `dumpsys activity activities` and prints `mCurrentFocus` / `mFocusedApp` / `ResumedActivity`
 * plus a decision from `explainUnready()`. That decision table is required to be able to
 * answer "the device state is **not** the reason" — an own-window focus (the app in front) or
 * an input-method window taking focus must never be blamed on the environment, or the next
 * debugging session gets sent the wrong way a second time. `--selftest` pins the parsers and
 * that table on captured device output, so both can be checked with no phone attached.
 *
 * **Correction, measured in the same session (REQ-A367).** The shade was *a* cause, not *the*
 * cause of the state REQ-A366 recorded. After the shade was collapsed (a swipe up — `cmd statusbar
 * collapse` had failed) and even after `force-stop` + relaunch, the page still never answered, and
 * `logcat` named it: `ActivityManager: Unable to launch app com.amos.ai/10172 for service Intent
 * { cmp=com.amos.ai/org.chromium.content.app.SandboxedProcessService0:0 }: process is bad` — **no
 * WebView renderer**, so the page has no JS engine at all (the app's process meanwhile burnt ~50%
 * of a core, and `ps -A` showed only the main process). That reading is in the table too, and it is
 * the reason the table must not stop at "another window is in front of the app".
 *
 * Requirements: `adb` on PATH, exactly one device (or `--serial <id>`), and an
 * app build with `debuggable true` (debug APK / `android:debuggable`).
 * The script sets up `adb forward tcp:<port>` itself; nothing is installed.
 * `--selftest` needs none of that.
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
 * The positional expression, with every option's **value** excluded.
 *
 * `--wait <ms>` (added in REQ-A366) exposed this: the previous
 * `args.find(a => !a.startsWith("--"))` takes the first non-flag token, which for
 * `--wait 5000 'document.title'` is `5000` — the tool then evaluated the *option's value* and
 * printed `5000` with a green exit code, a silent wrong answer (REQ-A367). Excluding the token
 * after any value-taking flag fixes it for every argument order.
 */
const VALUE_FLAGS = ["--serial", "--package", "--port", "--wait", "--file"];
export function expressionArg(argv) {
  return argv.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1]));
}

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

/**
 * `mCurrentFocus=Window{1fa0295 u0 NotificationShade}` → `{ kind: "window", title: "NotificationShade" }`.
 *
 * The three outcomes are kept apart on purpose: `mCurrentFocus=null` is a **reading** (nothing
 * holds focus — screen off / keyguard), a dump without the line is `unknown` (a late or
 * failed `dumpsys`). Merging them would let "could not tell" print as "fine" (REQ-A367).
 */
export function parseWindowFocus(dump) {
  const text = String(dump ?? "");
  if (/mCurrentFocus=null/.test(text)) return { kind: "none", title: null };
  const m = /mCurrentFocus=Window\{([^}]*)\}/.exec(text);
  if (!m) return { kind: "unknown", title: null };
  // `Window{<hash> u<userId> <title>}` — the title follows the user id and can itself be absent.
  const title = m[1].trim().split(/\s+/).slice(2).join(" ");
  return { kind: "window", title: title || null };
}

/** The first `pkg/.Activity` token inside a `…{…}` dumpsys record. */
function componentIn(text) {
  const m = /([A-Za-z0-9_.]+\/[\w.$]+)/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/** `mFocusedApp=ActivityRecord{42a6eff u0 com.amos.ai/.MainActivity t512}` → `com.amos.ai/.MainActivity`. */
export function parseFocusedApp(dump) {
  const m = /mFocusedApp=ActivityRecord\{([^}]*)\}/.exec(String(dump ?? ""));
  return m ? componentIn(m[1]) : null;
}

/** `ResumedActivity: ActivityRecord{42a6eff u0 com.amos.ai/.MainActivity t512}` → `com.amos.ai/.MainActivity`. */
export function parseResumed(dump) {
  const line = String(dump ?? "")
    .split("\n")
    .find((l) => l.includes("ResumedActivity:"));
  return line ? componentIn(line) : null;
}

/** Windows that take focus **without** obscuring the app — normal, and never a reason for a pause. */
const FOCUS_WITHOUT_OBSCURING = ["InputMethod"];
/** The expanded notification shade: a state that *can* pause the page (REQ-A366), verified twice. */
const SHADE_TITLES = ["NotificationShade"];

/**
 * The first logcat line saying the **renderer** could not be started for `pkg`.
 *
 * This is the cause that the shade turned out **not** to be (REQ-A367, measured): with the shade
 * collapsed and a freshly relaunched process the page still never answered, while this line sat in
 * logcat — `ActivityManager: Unable to launch app com.amos.ai/10172 for service Intent { cmp=…
 * org.chromium.content.app.SandboxedProcessService0:0 }: process is bad`. No renderer means no JS
 * engine for the page: the socket stays open, `mCurrentFocus` looks perfect, and `Runtime.evaluate`
 * can never return. Matching is deliberate (the package and the `process is bad` verdict), so a
 * line about some other app's service cannot be shown as ours.
 */
export function parseRendererLaunchFailure(logcat, pkg) {
  const line = String(logcat ?? "")
    .split("\n")
    .find((l) => l.includes(`Unable to launch app ${pkg}`) && /process is bad/.test(l));
  return line ? line.trim().slice(0, 200) : null;
}

/**
 * A renderer connection that **AMS itself** reports as `DEAD`, from `dumpsys activity processes`.
 *
 * This is the *current-state* reading of the same fault as `parseRendererLaunchFailure`: a logcat
 * line scrolls out of any window (measured: the 12 lines from the S5's launch attempt were gone
 * from `logcat -d -t 600` two minutes later — the F-DEV-001 family of instrument flaws), while this
 * line is present for exactly as long as the state is. Captured on the S5:
 * `ConnectionRecord{be7ee18 u0 CR DEAD com.amos.ai/org.chromium.content.app.SandboxedProcessService0:0:@5e09dfb flags=0x80000001}`.
 */
export function parseDeadRendererConnection(dump, pkg) {
  const line = String(dump ?? "")
    .split("\n")
    .find((l) => l.includes("CR DEAD") && l.includes(`${pkg}/org.chromium.content.app.SandboxedProcessService`));
  return line ? line.trim().slice(0, 200) : null;
}

/** Does a WebView renderer process (`<pkg>:sandboxed_process*`) show up in `ps -A`? */
export function hasSandboxedProcess(psOutput, pkg) {
  const escaped = String(pkg).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}:sandboxed_process`).test(String(psOutput ?? ""));
}

/**
 * The decision table over one device reading — pure, so `--selftest` can pin it.
 *
 * The property that matters is negative: this function must be **able to say the device state is
 * not the reason**. A diagnosis that always names one environment state is no better than the
 * symptom it replaced — it would send the next session after a window that is not there.
 */
export function explainUnready({ pkg, focus, focusedApp = null, resumed = null, last = null, renderer = null }) {
  const shown = focus.kind === "window" ? `Window{… ${focus.title ?? "(untitled)"}}` : focus.kind === "none" ? "null" : "(unreadable)";
  const state =
    `mCurrentFocus=${shown}` +
    `${focusedApp ? `, mFocusedApp=${focusedApp}` : ""}` +
    `${resumed ? `, ResumedActivity=${resumed}` : ""}`;

  // The strongest reading comes first: no renderer means no JS engine, whatever the focus says.
  if (renderer?.launchFailure || renderer?.deadConnection) {
    const evidence = [];
    if (renderer.deadConnection) evidence.push(`AMS reports its renderer connections DEAD: ${renderer.deadConnection}`);
    if (renderer.launchFailure) evidence.push(`AMS refused to start the renderer: ${renderer.launchFailure}`);
    return [
      `${state} — all of that looks healthy, and it is not what is wrong`,
      "the WebView **renderer** is not running:",
      ...evidence.map((e) => `  ${e}`),
      "⇒ the page cannot execute a single line of JS, which is why evaluate never returns and document.title stays empty — the focus readings cannot show this",
      "⇒ reboot the phone: this is ActivityManager bookkeeping for an app whose process kept dying, not an app defect — if the state survives a reboot, reinstall the APK",
    ];
  }
  if (focus.kind === "unknown") {
    return ["could not read `mCurrentFocus` from dumpsys — the device state is **unknown** here, not verified fine"];
  }
  if (focus.kind === "none") {
    return [
      `${state} — no window holds focus (screen off / keyguard?): a WebView in a hidden window stops running JS, so evaluate never returns; turn the screen on and unlock, then re-run`,
    ];
  }
  const title = focus.title ?? "";
  if (title.includes(pkg)) {
    return [
      `${state} — this app's own window holds focus, so the device state is **NOT** the reason: the page is still booting (or its script threw before painting)`,
    ];
  }
  if (FOCUS_WITHOUT_OBSCURING.some((t) => title.includes(t))) {
    return [
      `${state} — an input-method window holds focus, which does not obscure the app, so it is **NOT** the reason`,
    ];
  }
  const lines = [`${state} — a window that is not this app's is in front of ${pkg}`];
  lines.push(
    SHADE_TITLES.some((t) => title.includes(t))
      ? "that is the notification shade: Android **PAUSES** an obscured WebView, so its JS stops and Runtime.evaluate never returns — collapse the shade (swipe up) or reboot the phone, then re-run"
      : "an obscured WebView is **PAUSED** by Android, so its JS stops and Runtime.evaluate never returns — close that window, then re-run",
  );
  if (last) lines.push(`the last probe said: ${last}`);
  return lines;
}

/**
 * Read the state that decides whether a WebView can run JS at all. Best effort by construction:
 * it runs on the failure path, so a `dumpsys` that itself fails is reported as a gap in the
 * reading — it must never replace the original failure with a second one.
 */
function readDeviceState(pkg) {
  const win = adbRaw("shell", "dumpsys", "window");
  const act = adbRaw("shell", "dumpsys", "activity", "activities");
  const proc = adbRaw("shell", "dumpsys", "activity", "processes");
  const log = adbRaw("shell", "logcat", "-d", "-t", "2000");
  const ps = adbRaw("shell", "ps", "-A");
  return {
    pkg,
    focus: parseWindowFocus(win.stdout),
    focusedApp: parseFocusedApp(win.stdout),
    resumed: parseResumed(act.stdout),
    renderer: {
      launchFailure: parseRendererLaunchFailure(log.stdout, pkg),
      deadConnection: parseDeadRendererConnection(proc.stdout, pkg),
      sandboxed: hasSandboxedProcess(ps.stdout, pkg),
    },
    gaps: [win, act, proc, log, ps]
      .filter((r) => r.status !== 0)
      .map((r) => `${r.cmd} exited ${r.status}`),
  };
}

/** The cause lines a stall-shaped failure appends to its own symptom message. */
function stallDiagnosis(pkg) {
  const state = readDeviceState(pkg);
  const lines = explainUnready(state);
  // Only a *supporting* remark: on its own, "no sandboxed process in ps" cannot separate "the
  // renderer never started" from a device that renders in-process, so it is never the verdict.
  if (!state.renderer.launchFailure && !state.renderer.deadConnection && !state.renderer.sandboxed) {
    lines.push(`(no \`${pkg}:sandboxed_process*\` in \`ps -A\` — consistent with a renderer that never started, but that absence alone is not conclusive)`);
  }
  for (const gap of state.gaps) lines.push(`(the device reading is incomplete: ${gap})`);
  return lines;
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
  node scripts/device-ui-eval.mjs --selftest          device-free parser/decision tests
  options: --serial <adb-serial> --package <pkg> --port <tcp-port> --json --wait <ms>
  a stalled page now prints its cause (window focus, resumed activity, WebView renderer state).
`;

if (has("--help") || args.length === 0) {
  console.log(HELP);
  process.exit(args.length === 0 ? 2 : 0);
}

// Device-free: pins the parsers and the "must not blame the wrong window" branch of the
// diagnosis without adb, a phone, or a debug build (REQ-A367).
if (has("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const PORT = Number(opt("--port", "9222"));
const info = targets(PORT);
if (has("--list")) {
  const list = await listTargets(PORT);
  console.log(JSON.stringify({ pid: info.pid, socket: info.socket, targets: list.map((t) => ({ title: t.title, url: t.url, type: t.type })) }, null, 2));
  process.exit(0);
}

const file = opt("--file");
const expression = file ? readFileSync(file, "utf8") : expressionArg(args);
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
  let message = err.message;
  // A stall-shaped failure is the one that reads as "this tool is broken", so it carries its cause:
  // the device state, **read now** rather than inferred (REQ-A367, F-DEV-004). Failures that are
  // already specific (the app is not running, no devtools socket) deliberately skip this.
  if (/timed out|never became ready/.test(message)) {
    message += `\n  ${stallDiagnosis(opt("--package", "com.amos.ai")).join("\n  ")}`;
  }
  console.error(`[device-ui-eval] ${message}`);
  process.exit(1);
}

// --- selftest (hoisted; the `--selftest` branch above uses it) ----------------
//
// The device-free half of this tool: the parsers, the decision table, and the argument parser. The
// captured strings are **real output** from the S5 (Android 14); the first two are the state that
// produced REQ-A366's "the app looks stuck" reading, so the case that must keep working is a replay
// of a real failure rather than a hand-written one.
function runSelfTest() {
  const cases = [];
  const check = (name, ok) => cases.push([name, ok]);
  const PKG = "com.amos.ai";

  const REAL_WINDOW_SHADE = [
    "  mCurrentFocus=Window{1fa0295 u0 NotificationShade}",
    "  mFocusedApp=ActivityRecord{42a6eff u0 com.amos.ai/.MainActivity t512}",
  ].join("\n");
  const REAL_ACTIVITY_SHADE = "    ResumedActivity: ActivityRecord{42a6eff u0 com.amos.ai/.MainActivity t512}";
  const ours = (title) => ({ kind: "window", title });
  const explained = (focus, extra = {}) =>
    explainUnready({ pkg: PKG, focus, focusedApp: null, resumed: null, ...extra }).join("\n");

  // Parsers. "could not tell" and "nothing has focus" must stay distinct readings.
  check("parseWindowFocus: the captured shade window", parseWindowFocus(REAL_WINDOW_SHADE).title === "NotificationShade");
  check("parseWindowFocus: kind=window for a real dump", parseWindowFocus(REAL_WINDOW_SHADE).kind === "window");
  check('parseWindowFocus: mCurrentFocus=null is a reading, not "unknown"', parseWindowFocus("  mCurrentFocus=null\n").kind === "none");
  check("parseWindowFocus: a dump without the line is unknown", parseWindowFocus("  mFocusedApp=ActivityRecord{}").kind === "unknown");
  check("parseWindowFocus: an untitled window does not invent a title", parseWindowFocus("mCurrentFocus=Window{abc u0}").title === null);
  check("parseWindowFocus: a component title survives", parseWindowFocus("mCurrentFocus=Window{abc u0 com.amos.ai/com.amos.ai.MainActivity}").title === "com.amos.ai/com.amos.ai.MainActivity");
  check("parseFocusedApp: the captured focused app", parseFocusedApp(REAL_WINDOW_SHADE) === "com.amos.ai/.MainActivity");
  check("parseFocusedApp: absent line ⇒ null (not a guess)", parseFocusedApp("  mCurrentFocus=Window{abc u0 NotificationShade}") === null);
  check("parseResumed: the captured resumed activity", parseResumed(REAL_ACTIVITY_SHADE) === "com.amos.ai/.MainActivity");
  check("parseResumed: absent line ⇒ null", parseResumed("  mResumedActivity: null") === null);

  // The **renderer** reading — the cause the shade was *not* (both strings captured on the S5).
  const REAL_LOGCAT_RENDERER = [
    "09-17 16:43:38.135  1422  2247 W ActivityManager: Unable to launch app com.amos.ai/10172 for service Intent { cmp=com.amos.ai/org.chromium.content.app.SandboxedProcessService0:0 }: process is bad",
    "09-17 16:43:38.147  1422  1851 W ActivityManager: Unable to launch app com.amos.ai/10172 for service Intent { cmp=com.amos.ai/org.chromium.content.app.SandboxedProcessService1:0 }: process is bad",
  ].join("\n");
  const REAL_PS_STUCK = "u0_a172      15031   702   32234096 228904 0                   0 S com.amos.ai";
  const PS_HEALTHY = "u0_a172      15100   702   32234096 228904 0                   0 S com.amos.ai:sandboxed_process0";
  const REAL_WINDOW_SELF = [
    "  mCurrentFocus=Window{e4f081e u0 com.amos.ai/com.amos.ai.MainActivity}",
    "  mFocusedApp=ActivityRecord{42a6eff u0 com.amos.ai/.MainActivity t512}",
  ].join("\n");
  const launchFailure = parseRendererLaunchFailure(REAL_LOGCAT_RENDERER, PKG);
  check("renderer: the captured \"process is bad\" line is found", typeof launchFailure === "string" && /process is bad$/.test(launchFailure));
  check("renderer: another app's bad process is not ours", parseRendererLaunchFailure("W ActivityManager: Unable to launch app com.other.app/123 for service Intent { cmp=com.other.app/org.chromium.content.app.SandboxedProcessService0:0 }: process is bad", PKG) === null);
  check("renderer: an ordinary start-up log is not a failure", parseRendererLaunchFailure("I ActivityManager: Start proc 15031:com.amos.ai/u0a172 for activity", PKG) === null);
  check('renderer: "Unable to launch app" without the verdict is not enough', parseRendererLaunchFailure("W ActivityManager: Unable to launch app com.amos.ai/10172 for service X", PKG) === null);
  check("ps: the captured stuck state has no sandboxed process", hasSandboxedProcess(REAL_PS_STUCK, PKG) === false);
  check("ps: a healthy renderer process is recognised", hasSandboxedProcess(PS_HEALTHY, PKG) === true);
  const REAL_PROC_DEAD = [
    "      - ConnectionRecord{8a3483e u0 CR DEAD com.amos.ai/org.chromium.content.app.SandboxedProcessService1:1:@10210f9 flags=0x80000001}",
    "      - ConnectionRecord{be7ee18 u0 CR DEAD com.amos.ai/org.chromium.content.app.SandboxedProcessService0:0:@5e09dfb flags=0x80000001}",
  ].join("\n");
  check("dead connection: the captured CR DEAD line is found", /CR DEAD com\.amos\.ai\/org\.chromium\.content\.app\.SandboxedProcessService/.test(parseDeadRendererConnection(REAL_PROC_DEAD, PKG) ?? ""));
  check("dead connection: a live connection is not a failure", parseDeadRendererConnection("      - ConnectionRecord{xyz u0 CR com.amos.ai/org.chromium.content.app.SandboxedProcessService0:0:@1 flags=0x1}", PKG) === null);
  check("dead connection: another package's dead renderer is not ours", parseDeadRendererConnection("      - ConnectionRecord{xyz u0 CR DEAD com.other.app/org.chromium.content.app.SandboxedProcessService0:0:@1 flags=0x1}", PKG) === null);
  const deadOnly = explainUnready({
    pkg: PKG,
    focus: parseWindowFocus(REAL_WINDOW_SELF),
    renderer: { launchFailure: null, deadConnection: parseDeadRendererConnection(REAL_PROC_DEAD, PKG), sandboxed: false },
  }).join("\n");
  check("dead connection alone ⇒ still names the renderer (no logcat window needed)", /the WebView \*\*renderer\*\* is not running/.test(deadOnly) && /CR DEAD/.test(deadOnly) && !/AMS refused to start/.test(deadOnly));
  const bothReadings = explainUnready({
    pkg: PKG,
    focus: parseWindowFocus(REAL_WINDOW_SELF),
    renderer: {
      launchFailure: parseRendererLaunchFailure(REAL_LOGCAT_RENDERER, PKG),
      deadConnection: parseDeadRendererConnection(REAL_PROC_DEAD, PKG),
      sandboxed: false,
    },
  }).join("\n");
  check("both renderer readings are shown when both exist", /AMS reports its renderer connections DEAD/.test(bothReadings) && /AMS refused to start the renderer/.test(bothReadings));
  check("the verdict line appears once even with both readings", (bothReadings.match(/\*\*renderer\*\* is not running/g) ?? []).length === 1);
  const dead = explainUnready({
    pkg: PKG,
    focus: parseWindowFocus(REAL_WINDOW_SELF),
    focusedApp: "com.amos.ai/.MainActivity",
    resumed: "com.amos.ai/.MainActivity",
    renderer: { launchFailure, sandboxed: false },
  }).join("\n");
  check("renderer failure ⇒ names the renderer, not the environment", /the WebView \*\*renderer\*\* is not running/.test(dead) && /process is bad/.test(dead) && !/collapse the shade/.test(dead));
  check("renderer failure ⇒ says the focus readings look healthy and cannot show it", /all of that looks healthy/.test(dead));
  check("renderer failure ⇒ gives the device-side next step", /reboot the phone/.test(dead));
  check("without the renderer reading, the shade case still blames the shade", /PAUSES/.test(explained(parseWindowFocus(REAL_WINDOW_SHADE), { renderer: { launchFailure: null, sandboxed: true } })));

  // Decision table — the fault the diagnosis exists for.
  const shade = explained(parseWindowFocus(REAL_WINDOW_SHADE), {
    focusedApp: "com.amos.ai/.MainActivity",
    resumed: "com.amos.ai/.MainActivity",
  });
  check("shade in front: names the window and the app's own state", /mCurrentFocus=Window\{… NotificationShade\}.*mFocusedApp=com\.amos\.ai\/\.MainActivity/s.test(shade));
  check("shade in front: says the WebView is PAUSED", /PAUSES/.test(shade));
  check("shade in front: says evaluate never returns", /never returns/.test(shade));
  check("shade in front: tells the user what to do", /collapse the shade/.test(shade));
  const other = explained(ours("com.android.settings/com.android.settings.Settings"));
  check("another app's window: blamed, without the shade wording", /is in front of com\.amos\.ai/.test(other) && !/notification shade/.test(other));

  // **Must-not-blame** — the negative controls. A diagnosis that always names one environment
  // state is worse than the symptom it replaced, so these three fail the moment the table starts
  // blaming the device for a stalled page it cannot explain.
  const own = explained(ours("com.amos.ai/com.amos.ai.MainActivity"));
  check("own window holds focus ⇒ must say NOT the reason", /NOT\*\* the reason/.test(own) && !/PAUSED/.test(own));
  const ime = explained(ours("InputMethod"));
  check("IME holds focus ⇒ must say NOT the reason", /NOT\*\* the reason/.test(ime) && !/PAUSED/.test(ime));
  check("no focus at all ⇒ screen off, not the shade", /no window holds focus/.test(explained({ kind: "none", title: null })));
  check('unreadable dump ⇒ "unknown", never "fine"', /device state is \*\*unknown\*\*/.test(explained({ kind: "unknown", title: null })));
  check("the last probe's own words are kept", /the last probe said: devtools evaluate timed out/.test(explained(parseWindowFocus(REAL_WINDOW_SHADE), { last: "devtools evaluate timed out" })));

  // Argument parsing: `--wait <ms>` must not become the expression (a silent wrong answer).
  check("expressionArg: --wait's value is not the expression", expressionArg(["--wait", "5000", "document.title"]) === "document.title");
  check("expressionArg: a leading expression still parses", expressionArg(["document.title", "--wait", "5000"]) === "document.title");
  check("expressionArg: --serial/--package values are skipped", expressionArg(["--serial", "YY000286", "--package", "com.amos.ai", "1+1"]) === "1+1");
  check("expressionArg: flags before an awaited expression", expressionArg(["--wait", "1000", "--await", "await window.__probe()"]) === "await window.__probe()");
  check("expressionArg: no positional ⇒ undefined (caller reports it)", expressionArg(["--list"]) === undefined);

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[device-ui-eval] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[device-ui-eval] selftest OK — ${cases.length} case(s), incl. must-not-blame negatives.`);
}

