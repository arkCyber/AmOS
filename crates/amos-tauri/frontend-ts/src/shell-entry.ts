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
import {
  enterEdit,
  lock,
  open,
  resetShellState,
} from "./svelte/shellState.svelte";

// Apply persisted theme/locale to the document before first paint (the Svelte
// host is the one true host; theme/locale cores are in src/lib + svelte).
bootOsChrome();

const root = document.getElementById("root") ?? (() => {
  const el = document.createElement("div");
  el.id = "root";
  document.body.appendChild(el);
  return el;
})();

root.innerHTML = "";
resetShellState();

// Optional URL-driven surface for headless/visual acceptance of the Shell
// decision tree:  /shell.html            → home
//                   /shell.html?surface=app&id=phone → app(phone)
//                   /shell.html?surface=lock         → lock
//                   /shell.html?surface=edit         → edit
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

