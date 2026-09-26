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
 * Four checks:
 *
 *   1. **emitted ⇒ consumed** — every event name the host emits (a literal, a
 *      `pub const …_EVENT`, or a free `emit(<literal-or-const>, payload)` helper call)
 *      must appear in a production `subscribe(...)` / `listen(...)` call, or be
 *      allow-listed in `scripts/tauri-event-allowlist.json` **with a reason**;
 *   2. **consumed ⇒ emitted** — a screen subscribing to an event no Rust code emits
 *      can never fire (the mirror defect);
 *   3. **payload fields** — for the events whose payload is a plain Rust **struct**
 *      and whose wire shape a TypeScript type mirrors, every field the TS type
 *      declares must exist in that struct (the same class as `tauri-reply-scan`,
 *      one direction over). The event→shape link cannot be inferred statically, so
 *      it is an explicit, reviewed table below — a **recorded decision**, not a
 *      guess.
 *   4. **the table is a census** (REQ-A521) — *every* emitted event must be classified
 *      in that table or allow-listed with a reason; each row declares `object` /
 *      `unit` / `scalar` / `opaque`+reason, so "we did not look at this payload" is a
 *      sentence someone had to write rather than an absence. Measured 2026-09-19: the
 *      table held **7 rows for 20 emitted events** and nothing said so — three of the
 *      missing ones (`ai-card-received`, `ai-token-received`, `ai-session-complete`)
 *      are read by a live screen, and `docs/tauri-event-audit.md` claimed the card
 *      payload was "checked by its own unit tests" while **no test names it**. An
 *      unclassified event, a row for an event nobody emits, and a stale allow-list
 *      entry (formerly a printed note) all fail.
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
  // REQ-A530: the `#[cfg(test)]`-stripping lived here alone; it now lives with the other shared
  // extractors so the four scans that need "the production part of a file" cannot drift apart.
  stripTestRegions,
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
/**
 * How an emitted event's payload is accounted for (REQ-A521). **Every** emitted event must
 * appear here or in `scripts/tauri-event-allowlist.json` — the table is a *census*, not a list of
 * the pairs someone happened to write down.
 *
 * Measured 2026-09-19: 20 events emitted, 7 classified, 3 allow-listed, **10 with no
 * classification at all** — three of them (`ai-token-received`, `ai-card-received`,
 * `ai-session-complete`) read by a live screen (`AiApp`), and one (`ai-card-received`) a pair of
 * plain field sets that this scan could have compared all along. Kinds:
 *
 *   * `object` — `rust` and `ts` are plain field sets; they are compared field by field.
 *   * `unit`   — the payload is `()` (serializes to `null`): there is nothing to compare.
 *   * `scalar` — one JSON scalar (a bare string): no field contract to compare, and none to break.
 *   * `opaque` — a payload this scan cannot read, **with a `reason`**: a tuple, an internally
 *                tagged enum (`#[serde(tag = "kind")]`) that TS reads imperatively, or a
 *                `serde_json::json!` assembled by the Android glue. `rust`/`ts` still name what it
 *                is, so the next reader knows where to look.
 */
export const EVENT_PAYLOADS = [
  { event: "telephony-event", payload: "object", rust: "TelephonyCallPayload", ts: "TelephonyCall", tsFile: "lib/backend.ts" },
  { event: "lmk-surface", payload: "object", rust: "LmkSurfacePayload", ts: "LmkSurfacePayload", tsFile: "lib/lmk.ts" },
  { event: "sensor-data", payload: "object", rust: "SensorHostEvent", ts: "SensorDataEvent", tsFile: "lib/sensorEvents.ts" },
  { event: "telemetry-spy-hit", payload: "object", rust: "SpyHitPayload", ts: "SpyHitPayload", tsFile: "lib/telemetrySpy.ts" },
  { event: "clipboard-changed", payload: "object", rust: "ClipboardNotice", ts: "ClipboardNotice", tsFile: "lib/clipboard.ts" },
  { event: "host-fs-event", payload: "object", rust: "FsWatchEvent", ts: "FsWatchEvent", tsFile: "lib/hostFs.ts" },
  { event: "layout-changed", payload: "object", rust: "LayoutSnapshot", ts: "LayoutSnapshot", tsFile: "lib/wm.ts" },
  // REQ-A717: the window *list* (as opposed to the layout) is pushed on every model change so
  // the Dock's running dots and the shell's focused-window chords stop waiting for a 5 s poll.
  { event: "wm-changed", payload: "object", rust: "WmSnapshot", ts: "WmWindowsSnapshot", tsFile: "lib/wm.ts" },
  { event: "store-updated", payload: "object", rust: "StoreUpdated", ts: "<inline>", tsFile: "svelte/store.ts" },
  // REQ-A521: the AI card pair was unchecked while two live readers (`cardOf` / `AiApp`) read
  // exactly these fields. `CardPayload` (Rust) and `AiCard` (the TS wire view in `lib/stream.ts`)
  // are both plain field sets, so this is a checkable pair, not an opaque one.
  { event: "ai-card-received", payload: "object", rust: "CardPayload", ts: "AiCard", tsFile: "lib/stream.ts" },
  { event: "ai-token-received", payload: "scalar", rust: "e.token: String", ts: "tokenOf (lib/stream.ts)", tsFile: "lib/stream.ts" },
  { event: "ai-chat-complete", payload: "unit", rust: "()", ts: "AiApp ignores the payload", tsFile: "svelte/AiApp.svelte" },
  { event: "menu-event", payload: "scalar", rust: "id: String", ts: "the menu id string", tsFile: "lib/backend.ts" },
  { event: "webman-download-progress", payload: "object", rust: "DownloadProgress", ts: "DownloadProgressEvent", tsFile: "lib/webmanDownloads.ts" },
  { event: "link-heartbeat", payload: "object", rust: "LinkHeartbeatOut", ts: "LinkHeartbeat", tsFile: "lib/robot.ts" },
  {
    event: "ai-session-complete",
    payload: "opaque",
    reason:
      "Rust emits a 2-tuple `(sid, full)` — Tauri serializes it as a JSON **array**, not an object, " +
      "so there are no field names to compare. The TS side documents the wire shape where it parses " +
      "it by index (`sessionMetaOf`: `[sessionId, fullText]`), which is the closest thing to a contract " +
      "this pair can have; a rename on either side cannot silently break it, a **reorder** can.",
    rust: "(String, String)",
    ts: "sessionMetaOf (lib/stream.ts)",
    tsFile: "lib/stream.ts",
  },
  {
    event: "interpret-output",
    payload: "opaque",
    reason:
      "Internally tagged enum (`interpret.rs`: `#[serde(tag = \"kind\", rename_all = \"snake_case\")]` — " +
      "`segment_final` / `state_changed` / `language_detected` / `tts_request`). TS has **no** union " +
      "type for it: `InterpApp` and `lib/interp.ts` branch on `kind` imperatively, so there is nothing " +
      "declared to compare the variants against.",
    rust: "InterpretEventPayload",
    ts: "kind branches in InterpApp / lib/interp.ts",
    tsFile: "lib/interp.ts",
  },
  {
    event: "assistant-voice-event",
    payload: "opaque",
    reason:
      "Same shape as `interpret-output`: internally tagged enum (`assistant_voice.rs`, " +
      "`#[serde(tag = \"kind\", rename_all = \"snake_case\")]`) read imperatively in `AiApp`; no TS " +
      "union alias exists to compare variants against.",
    rust: "VoiceEvent (assistant_voice.rs)",
    ts: "kind branches in svelte/AiApp.svelte",
    tsFile: "svelte/AiApp.svelte",
  },
  {
    event: "sms-received",
    payload: "opaque",
    reason:
      "Rust sends `SmsIncomingOut { address }` but the only subscriber (`MessagesApp`) ignores the " +
      "payload by design and re-reads the inbox, and **no TS type declares the shape** — so neither " +
      "side has a wire view to compare. If a screen ever reads the address, add the TS type and " +
      "switch this row to `object`.",
    rust: "SmsIncomingOut",
    ts: "(none — the reader re-reads the inbox)",
    tsFile: "lib/backend.ts",
  },
  {
    event: "ble-value-changed",
    payload: "opaque",
    reason:
      "The payload is assembled in the Android glue as `serde_json::json!({ \"event\": … })` " +
      "(`jni_glue.rs`), and its reader (`lib/ble.ts`) is a module `unwired-allowlist.json` records as " +
      "unreachable. Both frames (value + the `uuid`-less status frame) share one channel, which is why " +
      "the shape is a hand-built object rather than a struct this scan can resolve.",
    rust: "json!({ event, uuid, value })",
    ts: "bleOnValueChanged (lib/ble.ts)",
    tsFile: "lib/ble.ts",
  },
  {
    event: "nfc-tag-discovered",
    payload: "opaque",
    reason:
      "Payload assembled in the Android glue (`jni_glue.rs` → `emit(\"nfc-tag-discovered\", payload)`) " +
      "and read by `lib/nfc.ts`, an unreachable module. Nothing on the Rust side names a struct, so " +
      "there is no wire view to compare.",
    rust: "(glue-assembled JSON)",
    ts: "lib/nfc.ts reader",
    tsFile: "lib/nfc.ts",
  },
];


const PAYLOAD_KINDS = new Set(["object", "unit", "scalar", "opaque"]);

/**
 * REQ-A521: the payload table is a **census** — these are the ways it can be wrong.
 *
 * Pure, so the selftest can pin each case. Measured 2026-09-19 (before this check): 20 events
 * emitted, 7 classified — the other 13 were simply absent, and nothing said so.
 */
export function payloadCensusProblems(entries) {
  const problems = [];
  const seen = new Set();
  for (const e of entries) {
    if (typeof e.event !== "string" || e.event === "") {
      problems.push(`a row has no event name: ${JSON.stringify(e).slice(0, 80)}`);
      continue;
    }
    if (seen.has(e.event)) problems.push(`duplicate row for '${e.event}'`);
    seen.add(e.event);
    if (!PAYLOAD_KINDS.has(e.payload)) {
      problems.push(`'${e.event}' has no payload kind (want ${[...PAYLOAD_KINDS].join(" / ")})`);
    }
    // An `opaque` row is the only place this scan admits it cannot compare two sides — the reason
    // is what stops "opaque" from becoming the quiet way to skip a check.
    if (e.payload === "opaque" && (typeof e.reason !== "string" || e.reason.length < 40)) {
      problems.push(`'${e.event}' is opaque without a usable reason`);
    }
    for (const key of ["rust", "ts", "tsFile"]) {
      if (typeof e[key] !== "string" || e[key] === "") {
        problems.push(`'${e.event}' is missing \`${key}\``);
      }
    }
  }
  return problems;
}

/** Emitted events that are neither in the table nor explicitly allow-listed (REQ-A521). */
export function unclassifiedEvents(emittedNames, entries, allowListed = new Set()) {
  const known = new Set(entries.map((e) => e.event));
  return [...emittedNames].filter((n) => !known.has(n) && !allowListed.has(n)).sort();
}

/** Table rows whose event is no longer emitted (anti-rot, REQ-A521). */
export function stalePayloadRows(entries, emittedNames) {
  const emitted = new Set(emittedNames);
  return entries.map((e) => e.event).filter((n) => !emitted.has(n)).sort();
}

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

// `stripTestRegions` (and its REQ-A231 history) now lives in `tauri-reply-scan.mjs` — imported
// above — so all four scans that need "the production part of a file" share one implementation
// (REQ-A530). The assertions in the selftest below still pin its behaviour.

/**
 * Blank the **contents** of every string / template literal, preserving byte offsets (REQ-A843).
 *
 * Why (measured 2026-09-21): `parseSubscribers`' site regex was `\b(?:subscribe|listen)\s*<?[^>(]*>?\(…`
 * — the gap between the keyword and `(` was **unbounded** (anything but `>`). In
 * `crates/amos-tauri/frontend-ts/src/lib/backend.ts` a *log string* spells the word:
 *
 *     noteDiag(channel, { ok: false, kind: "listen-failed", command: channel, detail: err });
 *     amosWarn("backend", `listen(${channel}) failed`, err);
 *
 * The match started inside `"listen-failed"`, jumped the statement boundary and captured
 * **`"backend"`** as an event name. The scan then reported `FAIL — a screen subscribes to
 * `backend` but no Rust code emits it` — a **false red** produced entirely by prose, and the
 * allow-list could not excuse it (no such event exists to excuse). A second phantom, `listenEvent(`
 * → `subscribe(internals)`, came from the same regex having no **right** boundary either.
 *
 * Masking is the fix that cannot hide a real site: it only *removes* occurrences, so an imperfect
 * mask yields a **false red**, never a false green (the direction argument F-DEV-066 was closed
 * with). Names are read back from the unmasked text at `m.indices[1]`, so a legitimate
 * `subscribe("store-updated", h)` still yields its literal.
 *
 * Deliberate limits, all on the false-red side: an unterminated quote is masked to end-of-line
 * only; a `'` used as an apostrophe in Svelte markup blanks the rest of that line.
 */
export function maskLiterals(src) {
  const out = src.split("");
  walkLiterals(src, 0, src.length, out);
  return out.join("");
}

function blankChars(out, from, to) {
  if (!out) return;
  for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
}

function walkLiterals(src, from, to, out) {
  for (let i = from; i < to; ) {
    const c = src[i];
    if (c === '"' || c === "'") i = skipQuoted(src, i, to, out);
    else if (c === "`") i = skipTemplate(src, i, to, out);
    else i++;
  }
}

/** Opening quote is kept, contents blanked; stops at the closing quote, or at a newline when
 *  unterminated (so one stray quote cannot mask the rest of the file). */
function skipQuoted(src, i, to, out) {
  const q = src[i];
  for (i++; i < to; ) {
    if (src[i] === "\\") {
      blankChars(out, i, Math.min(i + 2, to));
      i += 2;
      continue;
    }
    if (src[i] === "\n") return i;
    if (src[i] === q) return i + 1;
    blankChars(out, i, i + 1);
    i++;
  }
  return i;
}

/** `` `…` `` with `${…}` escaped: the interpolation is **code** and is walked as such. */
function skipTemplate(src, i, to, out) {
  for (i++; i < to; ) {
    if (src[i] === "\\") {
      blankChars(out, i, Math.min(i + 2, to));
      i += 2;
      continue;
    }
    if (src[i] === "`") return i + 1;
    if (src[i] === "$" && src[i + 1] === "{") {
      const close = matchingBrace(src, i + 1, to);
      const end = close === -1 ? to : close;
      walkLiterals(src, i + 2, end, out);
      if (close === -1) return to;
      i = close + 1;
      continue;
    }
    blankChars(out, i, i + 1);
    i++;
  }
  return i;
}

/** Index of the `}` closing the `{` at `open`, literal-aware. -1 when unbalanced. */
function matchingBrace(src, open, to) {
  let depth = 0;
  for (let i = open; i < to; i++) {
    const c = src[i];
    if (c === '"' || c === "'") i = skipQuoted(src, i, to, null) - 1;
    else if (c === "`") i = skipTemplate(src, i, to, null) - 1;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Event names the host **emits**: a quoted literal or a `*_EVENT` constant (local
 * or from the workspace-wide `consts` table, with or without a module path such as
 * `sensor_host::SENSOR_DATA_EVENT`).
 */
export function parseEmitters(src, consts = new Map()) {
  const prod = stripTestRegions(stripComments(src));
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
  // A **free** `emit("name", payload)` call — `jni_glue.rs` emits through a module-local helper
  // (REQ-A412). The receiver form above only sees `x.emit(…)`, so an event emitted through such a
  // helper was reported as "no Rust code emits it" even though the emit is real: the *shape* was
  // unrecognised, not the event absent.
  for (const m of prod.matchAll(/(?<![\w.])emit\s*\(\s*"([^"]+)"\s*,/g)) {
    out.push({ name: m[1], unresolved: false });
  }
  // The same free helper, but with a **declared constant** instead of a literal
  // (`emit(crate::ble::BLE_VALUE_EVENT, …)`, REQ-A628's "one spelling point"). The literal-only
  // rule above went blind the moment the emitters started routing through their `*_EVENT`
  // constants, so a live event read as "no Rust code emits it" — and, symmetrically, a *removed*
  // emitter would have read as live. Resolve through the table when the last path segment is a
  // known `*_EVENT`; an identifier the table cannot resolve is still **left alone** (never counted,
  // never flagged) so an unrelated function named `emit(NAME, …)` adds no noise.
  for (const m of prod.matchAll(/(?<![\w.])emit\s*\(\s*([A-Za-z_][\w:]*)\s*,/g)) {
    const last = m[1].split("::").pop();
    if (table.has(last)) out.push({ name: table.get(last), unresolved: false });
  }
  return out;
}

/**
 * A `subscribe(...)` / `listen(...)` **call site**. Three properties matter and each one was
 * missing before REQ-A843:
 *
 *   * the right boundary `(?![A-Za-z0-9_$])` — without it the keyword matched as a *prefix*
 *     (`listenEvent(internals, …)` was read as a `listen` site, with `internals` as the name);
 *   * the gap to `(` is **bounded** — a type argument may nest one level (`<Record<string, unknown>>`)
 *     but may not cross a parenthesis, so the match cannot jump a statement boundary;
 *   * it is matched against **literal-masked** text (see `maskLiterals`), so the word appearing
 *     inside a log string is not a site at all.
 *
 * The name is read back from the *unmasked* text via the `d` flag's `indices`, because masking
 * blanks exactly the literal whose value is the event name.
 */
export const SUBSCRIBE_SITE_RE =
  /(?<![\w$])(?:subscribe|listen)(?![A-Za-z0-9_$])\s*(?:<(?:[^<>()]|<[^<>]*>)*>\s*)?\(\s*([A-Za-z_]\w*|"[^"]*")\s*,/dg;

/**
 * Event names the shell **subscribes** to: a quoted literal or a `*_EVENT`
 * constant (local or workspace-wide via `consts`). Tauri `subscribe`/`listen` only
 * — a DOM `window.addEventListener` is a different channel and is reported
 * separately (`dom: true`).
 */
export function parseSubscribers(src, consts = new Map()) {
  const clean = stripComments(src);
  const masked = maskLiterals(clean);
  const table = new Map([...collectEventConsts(clean), ...consts]);
  const out = [];
  for (const m of masked.matchAll(SUBSCRIBE_SITE_RE)) {
    // The name comes from `clean`, not from `masked`: a quoted literal's *value* is exactly
    // what masking removes, and an identifier is unmasked either way.
    const raw = clean.slice(...m.indices[1]);
    if (raw.startsWith('"')) {
      out.push({ name: raw.slice(1, -1), unresolved: false });
      continue;
    }
    if (table.has(raw)) out.push({ name: table.get(raw), unresolved: false });
    else out.push({ name: raw, unresolved: true });
  }
  for (const m of masked.matchAll(/window\.addEventListener\(\s*("[^"]*")/dg)) {
    out.push({ name: clean.slice(...m.indices[1]).slice(1, -1), unresolved: false, dom: true });
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

  // REQ-A231: a `#[cfg(test)]` helper **above** production code must not blind the
  // scan. The old cut-at-first-`#[cfg(test)]` did exactly that and reported a live
  // event (`layout-changed`) as never emitted.
  const withMidFileSeam = [
    'pub const LAYOUT_EVENT: &str = "layout-changed";',
    "fn emit_layout(app: &AppHandle) { let _ = app.emit(LAYOUT_EVENT, snap); }",
    "#[cfg(test)]",
    "fn seam() { let _ = (); }",
    "fn later(app: &AppHandle) { let _ = app.emit(\"clipboard-changed\", notice); }",
  ].join("\n");
  const seamNames = parseEmitters(withMidFileSeam).map((e) => e.name);
  ok("a mid-file cfg(test) item does not hide the emit above it", seamNames.includes("layout-changed"));
  ok("…nor the emit below it", seamNames.includes("clipboard-changed"));
  const seamConsts = collectEventConsts(stripTestRegions(withMidFileSeam));
  ok("a mid-file cfg(test) item does not hide a later const", seamConsts.get("LAYOUT_EVENT") === "layout-changed");
  ok(
    "a cfg(test) item is removed, not truncated",
    stripTestRegions("fn a() {}\n#[cfg(test)]\nfn t() {}\nfn b() {}").includes("fn b()"),
  );
  ok(
    "a cfg(test) module with nested braces ends at its own closing brace",
    stripTestRegions('fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() { let x = (1, 2); }\n}\nfn b() {}').includes("fn b()"),
  );
  ok(
    "a cfg(test) const with brackets is removed whole",
    !stripTestRegions("fn a() {}\n#[cfg(test)]\nconst T: [u8; 2] = [1, 2];\nfn b() {}").includes("[u8; 2]"),
  );

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

  // --- REQ-A843: the site extractor must read a *call*, not a word -----------------------
  // Each fixture below is the verbatim shape that made the old regex report a phantom event
  // (or hide a real one). The negative control is the same assertion list run against the
  // pre-fix `parseSubscribers` (index revision), which fails the first five.
  const subNamesOf = (src) => parseSubscribers(src).map((s) => s.name);
  const siteCount = (src) => parseSubscribers(src).length;

  // The measured defect (backend.ts): the word lives in a log *string*, and the old unbounded
  // gap jumped the statement boundary to capture the next call's first argument.
  const backendShape = [
    'noteDiag(channel, { ok: false, kind: "listen-failed", command: channel });',
    'amosWarn("backend", `listen(${channel}) failed`, err);',
  ].join("\n");
  ok("a `listen` inside a log string is not a site", siteCount(backendShape) === 0);
  ok("…and no event named after the log tag is invented", !subNamesOf(backendShape).includes("backend"));

  // The right boundary: `listenEvent(`, `listeners.set(`, `subscribeSensorData,` all matched as a
  // *prefix* of the keyword (measured: 8 such sites in the tree, `listeners.set(x,` being the
  // largest group).
  ok("`listenEvent(` is not a `listen` site", siteCount('listen: (c, h) => listenEvent(internals, invoke, c, h),') === 0);
  ok("`listeners.set(` is not a `listen` site", siteCount('listeners.set(type, new Set());') === 0);
  // The left boundary: dropping it made `bleUnsubscribe(serviceUuid, …)` match as `subscribe(`.
  ok("`bleUnsubscribe(` is not a `subscribe` site", siteCount('if (useTauri) return bleUnsubscribe(serviceUuid, characteristicUuid);') === 0);
  ok("`subscribeStoreTiles,` in an import is not a site", siteCount('import { subscribeStoreTiles, notifyStoreTilesChanged } from "../lib/store";') === 0);

  // Masking is the mechanism the regex *cannot* replace: a genuine call shape inside a string is
  // syntactically indistinguishable from a call, so only blanking the literal removes it. Pinned
  // two-sided: the masked arm sees nothing, the unmasked arm sees `sensor-data`.
  const callInString = 'const help = "use listen(channel, handler) to subscribe";';
  // The invariant the index read-back rests on: masking changes *contents*, never offsets.
  ok("masking preserves every byte offset", maskLiterals(callInString).length === callInString.length);
  ok("masking touches only literal interiors and keeps interpolations",
    maskLiterals('subscribe("e", h);').startsWith('subscribe("') &&
    maskLiterals('const t = `x${1}`;').startsWith("const t = ` ") &&
    maskLiterals('const t = `x${1}`;').endsWith("${1}`;"));
  ok("a call shape inside a string literal is not a site", siteCount(callInString) === 0);
  ok("…while the same text *without* masking does match (masking is load-bearing)",
    [...maskLiterals(stripComments(callInString)).matchAll(SUBSCRIBE_SITE_RE)].length === 0 &&
    [...stripComments(callInString).matchAll(SUBSCRIBE_SITE_RE)].length === 1);

  // …and masking must not blind real code three ways: an interpolated template literal, an
  // unterminated quote (mask to end-of-line, not end-of-file), and an apostrophe in Svelte markup.
  ok("a call inside a template interpolation is still a site",
    subNamesOf('const s = `x${subscribe("in-template", h)}`;').includes("in-template"));
  ok("an unterminated quote does not mask the rest of the file",
    subNamesOf('const a = "oops;\nsubscribe("after-unterminated", h);').includes("after-unterminated"));
  ok("an apostrophe in markup masks one line at most",
    subNamesOf("It's fine\nsubscribe(\"after-apostrophe\", h);").includes("after-apostrophe"));
  // …nor should it resurrect what `stripComments` already removed.
  ok("a `subscribe(` inside a block comment is still not a site",
    siteCount('/* subscribe("commented-out", h); */') === 0);

  // A type argument may nest one level and must still be seen (the tree has no such site today —
  // measured: 0 matches for `subscribe<` — so this fixture is the only control that reaches the
  // branch; `/tmp` control run: the pre-fix regex also passes this one).
  ok("a generic type argument does not hide the site",
    subNamesOf('subscribe<{ kind: string; value: unknown }>("computed-changed", h);').includes("computed-changed") &&
    subNamesOf('subscribe<Record<string, unknown>>("nested-generic", h);').includes("nested-generic"));
  // A bare *signature* (`listen: (channel, handler) => …` in a type literal, propsBus.ts's
  // `subscribe: Readable<T>["subscribe"] = (run, …)`) is not a call.
  ok("a `listen:` signature is not a site", siteCount('listen: (channel, handler) => f(channel, handler),') === 0);

  // REQ-A412: a *free* `emit("…", payload)` helper (jni_glue.rs's local `emit`) is an emitter too;
  // without this shape the scan called two live Android events dead. REQ-A628 then routed those
  // emits through their declared `*_EVENT` constants, so the same helper is now called with an
  // identifier, not a literal — the scan must resolve it (or it goes blind again, calling a live
  // event dead AND a removed emitter live).
  const freeEmits = parseEmitters(
    [
      'fn emit(name: &str, payload: serde_json::Value) { /* … */ }',
      'const NFC_TAG_EVENT: &str = "nfc-tag-discovered";',
      'fn f() {',
      '    emit("clipboard-changed", payload);',
      '    emit(crate::ble::BLE_VALUE_EVENT, payload);',
      '    emit(NFC_TAG_EVENT, payload);',
      '    emit(COMPUTED_NAME, payload);',
      '    self.emit("sensor-data", ev);',
      '}',
    ].join("\n"),
    new Map([["BLE_VALUE_EVENT", "ble-value-changed"]]),
  );
  ok(
    "a free `emit(\"…\")` call counts as an emitter (jni_glue.rs's helper)",
    freeEmits.some((e) => e.name === "clipboard-changed" && !e.unresolved),
  );
  ok(
    "a free `emit(<qualified const>, …)` resolves through the table",
    freeEmits.some((e) => e.name === "ble-value-changed" && !e.unresolved),
  );
  ok(
    "a free `emit(<local const>, …)` resolves through the file's own consts",
    freeEmits.some((e) => e.name === "nfc-tag-discovered" && !e.unresolved),
  );
  ok(
    "a free emit whose first argument is an unresolvable name is left alone",
    !freeEmits.some((e) => e.unresolved || e.name === "COMPUTED_NAME"),
  );
  ok(
    "the receiver form still works alongside it (no double-counting)",
    freeEmits.filter((e) => e.name === "sensor-data").length === 1,
  );

  ok(
    "the payload table only names plain-struct shapes",
    EVENT_PAYLOADS.every((e) => typeof e.event === "string" && typeof e.rust === "string" && typeof e.ts === "string"),
  );

  // --- REQ-A521: the census ---------------------------------------------------
  ok(
    "payloadCensusProblems accepts the live table",
    payloadCensusProblems(EVENT_PAYLOADS).length === 0,
  );
  const good = { event: "x", payload: "object", rust: "R", ts: "T", tsFile: "lib/x.ts" };
  ok(
    "payloadCensusProblems catches a row with no kind",
    payloadCensusProblems([{ ...good, payload: undefined }]).some((p) => p.includes("no payload kind")),
  );
  ok(
    "payloadCensusProblems catches an opaque row without a reason",
    payloadCensusProblems([{ ...good, payload: "opaque" }]).some((p) => p.includes("opaque without a usable reason")),
  );
  ok(
    "payloadCensusProblems accepts an opaque row with a real reason",
    payloadCensusProblems([{ ...good, payload: "opaque", reason: "x".repeat(60) }]).length === 0,
  );
  ok(
    "payloadCensusProblems catches a duplicate row",
    payloadCensusProblems([good, good]).some((p) => p.includes("duplicate row")),
  );
  ok(
    "payloadCensusProblems catches a missing side",
    payloadCensusProblems([{ ...good, ts: "" }]).some((p) => p.includes("missing `ts`")),
  );
  ok(
    "unclassifiedEvents names an emitted event the table forgot",
    JSON.stringify(unclassifiedEvents(["a", "b"], [good])) === JSON.stringify(["a", "b"]),
  );
  ok(
    "unclassifiedEvents honours the allow-list",
    unclassifiedEvents(["a", "b"], [good], new Set(["a"])).length === 1,
  );
  ok(
    "unclassifiedEvents is quiet when the table covers everything",
    unclassifiedEvents(["x"], [good]).length === 0,
  );
  ok(
    "stalePayloadRows names a row for an event nobody emits",
    JSON.stringify(stalePayloadRows([good], ["other"])) === JSON.stringify(["x"]),
  );
  ok(
    "the live census covers every emitted event or an allow-list entry",
    unclassifiedEvents(
      EVENT_PAYLOADS.map((e) => e.event).concat(["biometric-result"]),
      EVENT_PAYLOADS,
      new Set(["biometric-result"]),
    ).length === 0,
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
    for (const [k, v] of collectEventConsts(stripTestRegions(src))) rustConsts.set(k, v);
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
  let payloadsClassifiedOnly = 0;
  for (const entry of EVENT_PAYLOADS) {
    // REQ-A521: only `object` rows are two field sets to compare. `unit`/`scalar` have no fields,
    // and `opaque` rows are the table's *admissions* — running the comparison on them would report
    // a "missing shape" for every one of them (the reason they are opaque is that one side is not a
    // type at all).
    if (entry.payload !== "object") {
      payloadsClassifiedOnly += 1;
      continue;
    }
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

  // REQ-A521: the census itself — a table that silently stops covering the emitted set is the
  // defect this round measured (7 of 20). Each of these is a failure, not a note.
  const censusProblems = payloadCensusProblems(EVENT_PAYLOADS);
  const unclassified = unclassifiedEvents(emittedNames, EVENT_PAYLOADS, new Set(allowByName.keys()));
  const staleRows = stalePayloadRows(EVENT_PAYLOADS, emittedNames);

  const failures =
    unconsumed.length +
    neverEmitted.length +
    payloadFindings.length +
    censusProblems.length +
    unclassified.length +
    staleRows.length +
    // the allow-list's own anti-rot (REQ-A521: it used to be a printed note)
    allow.filter((a) => tauriSubscribed.has(a.name) || !emittedNames.has(a.name)).length;

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          emitted: [...emittedNames].sort(),
          subscribed: [...tauriSubscribed].sort(),
          unconsumed,
          neverEmitted,
          payloadsChecked,
          payloadsClassifiedOnly,
          payloadFindings,
          censusProblems,
          unclassified,
          staleRows,
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
        `${payloadsChecked} payload shape(s) checked + ${payloadsClassifiedOnly} classified ` +
        `(unit/scalar/opaque); ${allowByName.size} allow-listed.`,
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
    for (const p of censusProblems) {
      console.error(`[tauri-event-scan] FAIL — payload table: ${p}`);
    }
    for (const n of unclassified) {
      console.error(
        `[tauri-event-scan] FAIL — \`${n}\` is emitted but the payload table does not classify it ` +
          `(object / unit / scalar / opaque+reason) and no allow-list entry excuses it`,
      );
    }
    for (const n of staleRows) {
      console.error(
        `[tauri-event-scan] FAIL — the payload table has a row for \`${n}\`, which is no longer emitted ` +
          `(remove it, or fix the emitter)`,
      );
    }
    const stale = allow
      .filter((a) => tauriSubscribed.has(a.name) || !emittedNames.has(a.name))
      .map((a) => `${a.name} (${tauriSubscribed.has(a.name) ? "now consumed" : "no longer emitted"})`);
    if (stale.length > 0) {
      // REQ-A521: a **failure**, like `tauri-command-scan`'s allow-lists (REQ-A518) and unlike the
      // note this used to be: "shrink it with a reason" printed as information is how accurate
      // records get deleted as housekeeping.
      console.error(
        `[tauri-event-scan] FAIL — ${stale.length} allow-list entr(y/ies) no longer name a hole: ${stale.join(", ")}`,
      );
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

