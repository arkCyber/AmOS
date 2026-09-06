/**
 * shell-entry.ts — OPTIONAL pure-Svelte top-level entry for local preview/acceptance
 * of `Shell.svelte` (Phase-3 ③). NOT wired into the production main (index.html still
 * mounts the React App, which hosts the Svelte screens). Open `shell.html` (dev or
 * the extra `shell` build input) to see the Svelte shell render standalone.
 */
import "./index.css";
import { mount } from "svelte";
import Shell from "./svelte/Shell.svelte";
import {
  enterEdit,
  lock,
  open,
  resetShellState,
} from "./svelte/shellState.svelte";

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

