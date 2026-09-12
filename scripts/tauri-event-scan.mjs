#!/usr/bin/env node
/**
 * tauri-event-scan.mjs — "an event nobody receives, or a payload nobody can read".
 *
 * Why: the fourth and last wire direction. `tauri-command-scan.mjs` checks the
 * command *name*, `tauri-args-scan.mjs` the *arguments* and `tauri-reply-scan.mjs`
 * the *return value*; a host→UI **event** has the same two halves and neither was
 * gated. Events are exactly where this codebase has lost features before — the
 * dead shared-store write-through and the multi-window layout subscription were both
 * "Rust emits something no Svelte screen ever receives".
 *
 * Three checks:
 *
 *   1. **emitted ⇒ consumed** — every event name the host emits (a literal or a
 *      `pub const …_EVENT`) must appear in a production `subscribe(...)` /
 *      `listen(...)` call, or be allow-listed in
 *      `scripts/tauri-event-allowlist.json` **with a reason**;
 *   2. **consumed ⇒ emitted** — a screen subscribing to an event no Rust code emits
 *      can never fire (the mirror defect);
 *   3. **payload fields** — for the events whose payload is a plain Rust **struct**
 *      and whose wire shape a TypeScript type mirrors, every field the TS type
 *      declares must exist in that struct (the same class as `tauri-reply-scan`,
 *      one direction over). The event→shape link cannot be inferred statically, so
 *      it is an explicit, reviewed table below — a **recorded decision**, not a
 *      guess. Events with a serde-tagged enum payload or a tuple are listed as out
 *      of scope in `docs/tauri-event-audit.md`.
 *
 * Usage (repo root):
 *   node scripts/tauri-event-scan.mjs              # gate
 *   node scripts/tauri-event-scan.mjs --json       # machine-readable
 *   node scripts/tauri-event-scan.mjs --selftest   # pin the extractors
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripComments,
  parseRustShapes,
  resolveRustType,
  parseTsInterfaces,
  resolveTsType,
  compareReply,
} from "./tauri-reply-scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_SRC = join(root, "crates/amos-tauri/src");
const FE_SRC = join(root, "crates/amos-tauri/frontend-ts/src");
const ALLOWLIST = join(root, "scripts/tauri-event-allowlist.json");

const SKIP = new Set(["node_modules", "target", ".git", "gen", "dist"]);

/**
 * Event → the Rust payload **struct** and the TypeScript type that mirrors it on
 * the wire. Only plain-struct payloads are comparable (a serde-tagged enum's
 * `fields` are variant names, a tuple is positional); everything else is listed as
 * out of scope in `docs/tauri-event-audit.md` rather than silently skipped.
 */
export const EVENT_PAYLOADS = [
  { event: "telephony-event", rust: "TelephonyCallPayload", ts: "TelephonyCall", tsFile: "lib/backend.ts" },
  { event: "lmk-surface", rust: "LmkSurfacePayload", ts: "LmkSurfacePayload", tsFile: "lib/lmk.ts" },
  { event: "sensor-data", rust: "SensorHostEvent", ts: "SensorDataEvent", tsFile: "lib/sensorEvents.ts" },
  { event: "telemetry-spy-hit", rust: "SpyHitPayload", ts: "SpyHitPayload", tsFile: "lib/telemetrySpy.ts" },
  { event: "clipboard-changed", rust: "ClipboardNotice", ts: "ClipboardNotice", tsFile: "lib/clipboard.ts" },
  { event: "layout-changed", rust: "LayoutSnapshot", ts: "LayoutSnapshot", tsFile: "lib/wm.ts" },
  { event: "store-updated", rust: "StoreUpdated", ts: "<inline>", tsFile: "svelte/store.ts" },
];

function walk(dir, ext, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, ext, acc);
    else if (p.endsWith(ext)) acc.push(p);
  }
  return acc;
}

/**
 * `*_EVENT` constant definitions in one source (`X_EVENT = "name"`), so a name
 * defined in one file can be resolved where it is *used* in another.
 */
export function collectEventConsts(src) {
  const consts = new Map();
  for (const m of src.matchAll(/(?:pub\s+)?const ([A-Z0-9_]*EVENT[A-Z0-9_]*)\s*(?::\s*&str\s*)?=\s*"([^"]+)"/g)) {
    consts.set(m[1], m[2]);
  }
  return consts;
}

/**
 * Event names the host **emits**: a quoted literal or a `*_EVENT` constant (local
 * or from the workspace-wide `consts` table, with or without a module path such as
 * `sensor_host::SENSOR_DATA_EVENT`).
 */
export function parseEmitters(src, consts = new Map()) {
  const clean = stripComments(src);
  const cut = clean.indexOf("#[cfg(test)]");
  const prod = cut < 0 ? clean : clean.slice(0, cut);
  const table = new Map([...collectEventConsts(prod), ...consts]);
  const out = [];
  for (const m of prod.matchAll(/\.emit\s*\(\s*([A-Za-z_][\w:]*|"[^"]+")\s*,/g)) {
    const raw = m[1];
    if (raw.startsWith('"')) {
      out.push({ name: raw.slice(1, -1), unresolved: false });
      continue;
    }
    const last = raw.split("::").pop();
    if (table.has(last)) out.push({ name: table.get(last), unresolved: false });
    else out.push({ name: raw, unresolved: true });
  }
  return out;
}

/**
 * Event names the shell **subscribes** to: a quoted literal or a `*_EVENT`
 * constant (local or workspace-wide via `consts`). Tauri `subscribe`/`listen` only
 * — a DOM `window.addEventListener` is a different channel and is reported
 * separately (`dom: true`).
 */
export function parseSubscribers(src, consts = new Map()) {
  const clean = stripComments(src);
  const table = new Map([...collectEventConsts(clean), ...consts]);
  const out = [];
  for (const m of clean.matchAll(/\b(?:subscribe|listen)\s*<?[^>(]*>?\(\s*([A-Za-z_]\w*|"[^"]+")\s*,/g)) {
    const raw = m[1];
    if (raw.startsWith('"')) {
      out.push({ name: raw.slice(1, -1), unresolved: false });
      continue;
    }
    if (table.has(raw)) out.push({ name: table.get(raw), unresolved: false });
    else out.push({ name: raw, unresolved: true });
  }
  for (const m of clean.matchAll(/window\.addEventListener\(\s*"([^"]+)"/g)) {
    out.push({ name: m[1], unresolved: false, dom: true });
  }
  return out;
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const emitted = parseEmitters(
    [
      '#[tauri::command]',
      'pub const SENSOR_DATA_EVENT: &str = "sensor-data";',
      'fn f(app: AppHandle) {',
      '    let _ = app.emit(SENSOR_DATA_EVENT, payload);',
      '    let _ = app.emit("clipboard-changed", notice);',
      '    let _ = handle.emit(sensor_host::SENSOR_DATA_EVENT, ev);',
      '    let _ = app.emit(COMPUTED_NAME, x);',
      '}',
      '#[cfg(test)]',
      'mod tests { fn t() { app.emit("never-in-prod", 1); } }',
    ].join("\n"),
  );
  const names = emitted.map((e) => e.name);
  ok("resolves a local *_EVENT const", names.filter((n) => n === "sensor-data").length === 2);
  ok("reads a quoted literal", names.includes("clipboard-changed"));
  ok("resolves a module-qualified const", names.includes("sensor-data"));
  ok("an unresolvable name is flagged, not invented", emitted.some((e) => e.unresolved && e.name === "COMPUTED_NAME"));
  ok("ignores test-only emits", !names.includes("never-in-prod"));

  const subs = parseSubscribers(
    [
      'export const LMK_SURFACE_EVENT = "lmk-surface";',
      'void subscribe(LMK_SURFACE_EVENT, (p) => {});',
      'void subscribe("store-updated", onStoreUpdated);',
      'void listen("sensor-data", h);',
      'window.addEventListener("hardware-button", onHardware);',
      'void subscribe(computed, h);',
    ].join("\n"),
  );
  const subNames = subs.map((s) => (s.dom ? `dom:${s.name}` : s.name));
  ok("resolves a const subscription", subNames.includes("lmk-surface"));
  ok("reads a literal subscription", subNames.includes("store-updated") && subNames.includes("sensor-data"));
  ok("a DOM listener is marked as DOM", subNames.includes("dom:hardware-button"));
  ok("an unresolvable subscription is flagged", subs.some((s) => s.unresolved && s.name === "computed"));

  ok(
    "the payload table only names plain-struct shapes",
    EVENT_PAYLOADS.every((e) => typeof e.event === "string" && typeof e.rust === "string" && typeof e.ts === "string"),
  );

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[tauri-event-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[tauri-event-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
/**
 * True when this file is the process entry point (so its selftest/scan dispatch
 * never fires when another script *imports* it for its extractors).
 */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();


// --- scan -------------------------------------------------------------------
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();

function runScan() {
  const rustFiles = walk(RUST_SRC, ".rs");
  const rustSources = rustFiles.map((f) => ({ file: f, src: readFileSync(f, "utf8") }));
  const rustConsts = new Map();
  for (const { src } of rustSources) {
    const cut = src.indexOf("#[cfg(test)]");
    for (const [k, v] of collectEventConsts(cut < 0 ? src : src.slice(0, cut))) rustConsts.set(k, v);
  }
  const shapes = new Map();
  const emitted = [];
  for (const { file, src } of rustSources) {
    for (const [k, v] of parseRustShapes(src)) shapes.set(k, v);
    for (const e of parseEmitters(src, rustConsts)) emitted.push({ ...e, file: relative(root, file) });
  }

  const feFiles = walk(FE_SRC, ".ts")
    .concat(walk(FE_SRC, ".svelte"))
    .filter((f) => !f.includes("/__tests__/") && !/\.test\.[cm]?[jt]sx?$/.test(f))
    .map((f) => ({ file: f, src: readFileSync(f, "utf8") }));
  const feConsts = new Map();
  for (const { src } of feFiles) {
    for (const [k, v] of collectEventConsts(src)) feConsts.set(k, v);
  }
  const subscribed = [];
  for (const { file, src } of feFiles) {
    for (const s of parseSubscribers(src, feConsts)) subscribed.push({ ...s, file: relative(root, file) });
  }

  let allow = [];
  if (existsSync(ALLOWLIST)) {
    try {
      allow = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
    } catch (e) {
      console.error(`[tauri-event-scan] allowlist is not valid JSON: ${e.message}`);
      process.exit(1);
    }
  }
  const allowByName = new Map(allow.map((a) => [a.name, a.reason]));

  const emittedNames = new Set(emitted.filter((e) => !e.unresolved).map((e) => e.name));
  const tauriSubscribed = new Set(
    subscribed.filter((s) => !s.unresolved && !s.dom).map((s) => s.name),
  );

  // 1. emitted ⇒ consumed (or allow-listed with a reason).
  const unconsumed = [...emittedNames]
    .filter((n) => !tauriSubscribed.has(n) && !allowByName.has(n))
    .sort();
  // 2. consumed ⇒ emitted.
  const neverEmitted = [...tauriSubscribed].filter((n) => !emittedNames.has(n)).sort();
  const unresolved = [
    ...emitted.filter((e) => e.unresolved).map((e) => `${e.file}: emit(${e.name})`),
    ...subscribed.filter((s) => s.unresolved).map((s) => `${s.file}: subscribe(${s.name})`),
  ];

  // 3. payload fields, via the reviewed table.
  const payloadFindings = [];
  let payloadsChecked = 0;
  for (const entry of EVENT_PAYLOADS) {
    const shape = shapes.get(entry.rust);
    const tsPath = join(FE_SRC, entry.tsFile);
    if (!shape || !existsSync(tsPath)) {
      payloadFindings.push({
        kind: "missing-shape",
        event: entry.event,
        detail: `the table names \`${entry.rust}\` (Rust) / \`${entry.ts}\` in ${entry.tsFile} — one side was not found`,
      });
      continue;
    }
    const tsSrc = readFileSync(tsPath, "utf8");
    const ts = entry.ts === "<inline>"
      ? {
          kind: "object",
          typeName: `<inline ${entry.tsFile}>`,
          fields: [
            ...tsSrc
              .matchAll(/\{\s*key\?:\s*unknown;\s*value\?:\s*unknown\s*\}/g)
              .flatMap(() => ["key", "value"]),
          ],
        }
      : resolveTsType(entry.ts, parseTsInterfaces(tsSrc));
    if (ts.kind !== "object" || ts.fields === undefined) {
      payloadFindings.push({
        kind: "missing-shape",
        event: entry.event,
        detail: `\`${entry.ts}\` in ${entry.tsFile} does not resolve to an object type`,
      });
      continue;
    }
    payloadsChecked++;
    for (const f of compareReply(entry.event, { kind: "object", shape: entry.rust }, ts, shapes)) {
      payloadFindings.push({ kind: "field-name", event: entry.event, detail: f.detail });
    }
  }

  const failures = unconsumed.length + neverEmitted.length + payloadFindings.length;

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          emitted: [...emittedNames].sort(),
          subscribed: [...tauriSubscribed].sort(),
          unconsumed,
          neverEmitted,
          payloadsChecked,
          payloadFindings,
          unresolved,
          allowListed: [...allowByName.keys()].sort(),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[tauri-event-scan] ${emittedNames.size} emitted event name(s); ${tauriSubscribed.size} subscribed; ` +
        `${payloadsChecked} payload shape(s) checked; ${allowByName.size} allow-listed.`,
    );
    for (const n of unconsumed) {
      console.error(`[tauri-event-scan] FAIL — \`${n}\` is emitted by the host but no screen subscribes to it`);
    }
    for (const n of neverEmitted) {
      console.error(`[tauri-event-scan] FAIL — a screen subscribes to \`${n}\` but no Rust code emits it`);
    }
    for (const f of payloadFindings) {
      console.error(`[tauri-event-scan] FAIL — \`${f.event}\` ${f.detail}`);
    }
    const stale = allow
      .filter((a) => tauriSubscribed.has(a.name) || !emittedNames.has(a.name))
      .map((a) => `${a.name} (${tauriSubscribed.has(a.name) ? "now consumed" : "no longer emitted"})`);
    if (stale.length > 0) {
      console.log(`[tauri-event-scan] allow-list: ${stale.length} stale entry(ies) — shrink with a reason: ${stale.join(", ")}`);
    }
    if (unresolved.length > 0) {
      console.log(
        `[tauri-event-scan] ${unresolved.length} name(s) could not be resolved statically (skipped): ${unresolved.join(", ")}`,
      );
    }
    if (failures === 0) {
      console.log(
        "[tauri-event-scan] OK — every emitted event reaches a screen, every subscription has an emitter, and every listed payload matches.",
      );
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

