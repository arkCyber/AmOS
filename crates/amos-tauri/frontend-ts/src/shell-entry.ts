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
function mountShell() {
  const root = document.getElementById("root") ?? (() => {
    const el = document.createElement("div");
    el.id = "root";
    document.body.appendChild(el);
    return el;
  })();
  root.innerHTML = "";
  resetShellState();
  try {
    const p = new URLSearchParams(location.search);
    const surface = p.get("surface");
    if (surface === "app") open(p.get("id") || "clock");
    else if (surface === "lock") lock();
    else if (surface === "edit") enterEdit();
  } catch {
    /* ignore; default home */
  }
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
}

void boot();

