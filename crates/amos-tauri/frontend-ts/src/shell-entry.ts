/**
 * shell-entry.ts — the **pure-Svelte** System UI entry: `index.html` mounts
 * `Shell.svelte`. React is fully removed from the runtime graph (see
 * docs/react-subtraction-plan.md). `shell.html` is the same Svelte shell behind a
 * second build input for headless/visual acceptance.
 */
import "./index.css";
import { mount } from "svelte";
import Shell from "./svelte/Shell.svelte";
import { bootOsChrome } from "./svelte/osBoot";
import { hydrateFromSystemStore } from "./lib/amosStore";
import { installUiFailureObserver } from "./lib/uiFailures";
import { invoke } from "./lib/backend";
import { appIdFromHash } from "./lib/windowRoute";
import { installEarlySystemKeys } from "./lib/earlySystemKeys";
import { trackEditableFocus } from "./lib/editKeys";
import {
  enterEdit,
  lock,
  open,
  resetShellState,
} from "./svelte/shellState.svelte";

// Mount the Svelte shell into `#root`, honouring an optional URL-driven surface
// for headless/visual acceptance:
//   /shell.html                      → home
//   /shell.html?surface=app&id=phone → app(phone)
//   /shell.html?surface=lock         → lock
//   /shell.html?surface=edit         → edit
//   /index.html#window=notes         → app(notes)   (a real app window/split pane)
function mountShell() {
  const root = document.getElementById("root") ?? (() => {
    const el = document.createElement("div");
    el.id = "root";
    document.body.appendChild(el);
    return el;
  })();
  root.innerHTML = "";
  resetShellState();
  // The app this window addresses — the host's `#window=<label>` fragment. Read here so the
  // early key listener below and the surface decision cannot disagree about it.
  const ownApp = appIdFromHash(location.hash);
  try {
    const p = new URLSearchParams(location.search);
    const surface = p.get("surface");
    if (surface === "app") open(p.get("id") || "clock");
    else if (surface === "lock") lock();
    else if (surface === "edit") enterEdit();
    // An app window the host opened for a specific app (`#window=<label>`) — the
    // `?surface=` overrides above win, because they are the headless-acceptance
    // path and a real window never carries both.
    else if (ownApp) open(ownApp);
  } catch {
    /* ignore; default home */
  }
  // REQ-A431: the listener is installed at the top of `boot()` — before the hydration await,
  // which is the part of startup that can take seconds under load. Nothing else is needed
  // here: the same instance stands down when the mounted shell takes the chords over.
  mount(Shell, { target: root });
}

/**
 * Boot the shell.
 *
 * First **hydrate the shared (Rust-owned) store into localStorage** — the settings
 * / notifications / home layout the OS persists live in the Rust `SharedStore`, so
 * a fresh webview must pull them in *before* any runes store reads localStorage
 * (otherwise the first paint shows defaults). This is the port of the old React
 * host's boot `hydrateFromSystemStore`. It is a no-op outside Tauri, and a failed
 * or absent snapshot must never block the shell — so it is best-effort.
 */
async function boot() {
  // TEMP PROBE (REQ-A171): forward CSP violations + two boot markers to the host,
  // which prints them to stderr. A CSP violation is otherwise only visible in the
  // WebView console — nothing outside the window can read it, so the shell's own
  // policy could not be verified without a human watching devtools.
  const cspProbe = (msg: string) => void invoke("csp_probe", { report: msg });
  document.addEventListener("securitypolicyviolation", (e) => {
    const ev = e as SecurityPolicyViolationEvent;
    cspProbe(
      `VIOLATION ${ev.violatedDirective} blocked ${ev.blockedURI || "(inline)"} at ${ev.sourceFile}:${ev.lineNumber}`,
    );
  });
  cspProbe("boot-reached");

  // REQ-A431: own the system chords from the **first statement** — before the store
  // hydration RPC below, which is an await and can take seconds under load (measured: with a
  // busy machine, a ⌘W pressed 3 s after opening a window still landed before the shell was
  // up). The listener needs nothing but the URL fragment and localStorage, and it stands down
  // the moment a component that owns the chords mounts (`handOverSystemKeys`).
  installEarlySystemKeys(appIdFromHash(location.hash));

  // REQ-A439: remember the field the user is editing. AppKit's first responder survives a menu
  // being opened; the DOM's `activeElement` does not — so without this, Edit ▸ Select All (a menu
  // activation by definition) finds nothing to select. One listener for the whole page.
  trackEditableFocus();

  // Install the failure observer **first**: everything below runs through async callbacks
  // (the store hydration, the app watchers), and a throw in one of them used to leave no
  // trace at all (REQ-A151). It only observes — it does not swallow the event.
  installUiFailureObserver();
  try {
    await hydrateFromSystemStore();
  } catch {
    /* boot anyway with whatever is already in localStorage */
  }
  // Apply persisted theme/locale to the document before first paint.
  bootOsChrome();
  mountShell();
  cspProbe("shell-mounted");
}

void boot();

