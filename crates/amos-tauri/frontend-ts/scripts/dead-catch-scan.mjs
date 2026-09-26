#!/usr/bin/env node
/**
 * dead-catch-scan.mjs — "is a `try`/`catch` around a bridge command a catch that can never run?"
 *
 * Why: `invoke()` in `src/lib/backend.ts` **catches every bridge rejection** and answers `null`
 * (REQ-A296). So any wrapper that delegates to it in one hop — `telephonyDial`, `termResize`,
 * `registerNativeAlarm`, and 104 more — resolves on *every* path, and a `try`/`catch` around a
 * call to one is not error handling. It cannot run.
 *
 * That is worse than no `catch`, because it reads like error handling to a reviewer while the
 * only signal the host actually sends — the `null` — goes unread. Two shipped defects have this
 * exact shape, and in both the catch is what made them look handled:
 *
 *   * **F-ALM-004 / REQ-A875** — `svelte/osAlarmArm.ts` dropped an id from its own `armed` set
 *     *before* awaiting `cancelNativeAlarm`, inside a `try`. The `try` said "this may fail"; the
 *     `catch` said "and we handle it"; and neither was true, so a cancellation the device did
 *     not carry out was forgotten permanently and a turned-off alarm kept ringing from the
 *     native scheduler. The host's `device.state` — the field that says the OS let go — was
 *     never read on that path.
 *   * **the dial path in `svelte/ContactsApp.svelte`** — `try { await telephonyDial(num);
 *     recordOutgoing(...) } catch { status = t("contacts.offline") }`. `telephonyDial` answers
 *     `null` on a refusal rather than rejecting, so the catch is dead and the call log records
 *     a call the device never placed. The sibling implementation, `lib/phone.ts::placeOutgoingCall`,
 *     reads the same verdict and gets it right.
 *
 * ## The rule, and where it is drawn
 *
 * A site is a `try { … } catch …` whose try body:
 *
 *   1. calls at least one wrapper that is a **one-hop delegation** to `invoke`/`subscribe` in a
 *      `backend.ts` module (that wrapper cannot reject), and
 *   2. contains **nothing else that can throw on its own** — no `throw`, no `JSON.parse`, no
 *      `new X`, and no browser storage or DOM call.
 *
 * Rule 2 is what keeps this a census rather than a smoke alarm, and it is the round's own
 * measured correction: `themeCore.writeStored` and `locale.setLocale` wrap
 * `localStorage.setItem` — which really does throw (quota, blocked third-party storage) — around
 * a fire-and-forget `void systemStoreSet(...)`. They were reported as defects by the first
 * version of this rule, and the only honest allow-list note for them would have been "the
 * detector is wrong": a *false* reason, the worst kind of green. The browser-storage words in
 * `THROWS_ON_ITS_OWN` are there because of them.
 *
 * Comments and string literals are **masked** before anything is matched (length-preserving, so
 * line numbers survive), because a doc comment that quotes the shape — this file's own header
 * does — is otherwise read as an instance of it.
 *
 * ## The four sites this gate found, and what happened to each
 *
 * The first run reported **4** sites. All four were resolved *in the code*, and the allow-list is
 * **empty** — deliberately, because the one honest note available for each would have been a
 * claim about the *detector* ("this catch is fine"), not about the call:
 *
 *   * `svelte/osAlarmArm.ts` (×2, both loops) — the id was dropped before the await; the verdict
 *     is now the only thing that makes it forgettable. See above.
 *   * `svelte/ContactsApp.svelte` — the dial path. See above.
 *   * `lib/alarmCore.ts::syncDueAlarmAlerts` — a **second** copy of native registration, two
 *     lines after a `writeStoreValue(ALARM_KEY, …)` that already dispatches the store event the
 *     watcher reconciles on. Deleted, not patched: registering belongs to `osAlarmArm`, which
 *     reads the host's verdict, so there is now one owner instead of two (F-SH-005's shape).
 *   * `svelte/TerminalApp.svelte` — `lastSize` was assigned *before* the `termResize` that
 *     confirms it. `lastSize` is only the dedup key, so a refused resize was remembered as
 *     applied and the next measurement of that same grid was swallowed. Now assigned on the
 *     reply, and the module says so.
 *
 * One site left the census without an allow-list entry for a different reason, and it is worth
 * naming because it is *not* a fix: `svelte/StreamVoiceButton.svelte`'s teardown `catch` is dead
 * (and its `.catch()` too), but the call is genuinely verdict-free — `assistant_voice_stop`
 * (`crates/amos-tauri/src/assistant_voice.rs:368`) returns `Ok(())` unconditionally and
 * `VoiceSession::stop` discards even the mpsc send's result. Removing the dead handlers and
 * stating the host-side reason is all this site needed; there is no behaviour to test.
 *
 * ## Honest limits
 *
 *   * The extractors are textual, not a type checker. Rule 2 is a closed list of the ways a try
 *     body throws *in this codebase*; a call to something else that throws (a local helper with
 *     its own `throw`) is caught only when that name is not in the wrapper inventory, which is
 *     why the inventory is built from one-hop delegations **only** and never widened by
 *     transitivity (`alarmCore`, `shortcuts` and `writeStoreValue` all appeared in a
 *     transitive first draft, attributed a body by directory-walk order — a wrong answer that
 *     looked like a bigger census).
 *   * A try body that both calls a wrapper **and** does something fallible the list does not
 *     name is not reported. Missing a site is the deliberate cost of not crying wolf.
 *   * It judges `catch`es, not outcomes: a site may be a genuine fire-and-forget whose verdict
 *     nobody needs. Those belong in the allow-list with a note that says why, one note per site.
 *
 * Usage:
 *   node scripts/dead-catch-scan.mjs            # census, exit 1 on an unacknowledged site
 *   node scripts/dead-catch-scan.mjs --json
 *   node scripts/dead-catch-scan.mjs --selftest
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "scripts/dead-catch-allowlist.json";

/** A definition of a delegating wrapper, in either of the two shapes the repo uses. */
const FN_DEF = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/g;
const ARROW_DEF = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)[^=]*=>\s*/g;

/** The call that makes a wrapper a *bridge* wrapper — and the reason it cannot reject. */
const BRIDGE_CALL = /\binvoke\s*[<(]|\bsubscribe\s*\(/;

/**
 * Ways a `try` body throws on its own, making the `catch` live and the site not this class.
 *
 * Closed on purpose (see "Honest limits"). The storage/DOM words are load-bearing: without them
 * the two `localStorage.setItem` wrappers are reported, and the reason for them would be a lie.
 */
const THROWS_ON_ITS_OWN =
  /\bthrow\b|\bJSON\.parse\b|\.json\(\)|\bnew\s+[A-Z]|localStorage|sessionStorage|navigator\.|document\.|structuredClone|\bURL\(/;

/**
 * Blank out comments (and, when `strings` is set, string-literal **contents** too).
 *
 * Length-preserving — every replaced character becomes a space and newlines are kept — so the
 * line of anything found in the mask still points at the original text.
 *
 * There are two masks because the two jobs disagree about strings. The structural scan wants
 * them gone: a doc comment (or a string) that *quotes* `try { await telephonyDial(x) } catch`
 * must not read as an instance, and this file's own header quotes exactly that shape. But
 * **import parsing needs the strings**: `from "../lib/backend"` is the whole name of the module
 * a wrapper comes from, and blanking it made every import vanish — which silently emptied the
 * site list and turned the first seven assertions of the selftest red at once.
 */
export function maskComments(text, strings = false) {
  const chars = text.split("");
  let i = 0;
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (chars[k] !== "\n") chars[k] = " ";
  };
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === "/" && c2 === "/") {
      const end = text.indexOf("\n", i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
    } else if (c === "/" && c2 === "*") {
      const end = text.indexOf("*/", i + 2);
      blank(i, end < 0 ? n : end + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === c) break;
        j++;
      }
      if (strings) blank(i + 1, Math.min(j, n - 1));
      i = j + 1;
    } else i++;
  }
  return chars.join("");
}

/** Comments and string contents both blanked — for every structural decision. */
export function mask(text) {
  return maskComments(text, true);
}

/**
 * End of an arrow function's **concise** body (no braces), so a wrapper written as
 * `export const f = async (x) => invoke<T>("c", { x });` is read as a body at all.
 *
 * Without this the brace search found the `{` of the argument object literal and took `{ x }`
 * for the body — which contains no `invoke`, so every concise arrow wrapper left the inventory.
 */
function conciseBodyEnd(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth <= 0 && (c === ";" || c === "\n")) return i;
  }
  return src.length;
}

/** Index just past the `)` / `}` closing the one at `open`, or -1 when unbalanced. */
function closeOf(text, open, openCh, closeCh) {
  let d = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === openCh) d++;
    else if (text[i] === closeCh) { d--; if (d === 0) return i + 1; }
  }
  return -1;
}

/**
 * Exported wrappers in a **backend module** that resolve on every path: their body calls
 * `invoke`/`subscribe` and has no `try` and no `throw` of its own.
 *
 * One hop only. `body` is taken by brace-matching the declaration's own opening brace, so a name
 * is never paired with a neighbouring function's body (attributing a body by proximity is how a
 * first draft produced 65 sites, most of them about other functions entirely).
 */
export function delegatingWrappers(text, isBackendModule) {
  const out = new Map();
  if (!isBackendModule) return out;
  const src = mask(text);
  for (const [re, isArrow] of [[FN_DEF, false], [ARROW_DEF, true]]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const at = m.index + m[0].length - 1;
      const brace = src.indexOf("{", at);
      let body;
      if (isArrow && !/^\s*\{/.test(src.slice(at))) {
        body = src.slice(at, conciseBodyEnd(src, at)); // `=> invoke(...);`
      } else {
        if (brace < 0) continue;
        const end = closeOf(src, brace, "{", "}");
        if (end < 0) continue;
        body = src.slice(brace, end);
      }
      if (!BRIDGE_CALL.test(body)) continue;
      if (/\btry\b|\bthrow\b/.test(body)) continue;
      out.set(m[1], { line: src.slice(0, m.index).split("\n").length });
    }
  }
  return out;
}

/**
 * The `try`/`catch` sites in one file that call a cannot-reject wrapper and nothing else
 * fallible. `delegating` is the backend module's inventory (names only); a file may only be
 * judged against wrappers it actually **imports**, so a local function that happens to share a
 * name is not mistaken for the bridge one.
 */
export function deadCatches(text, delegating, isBackendModule = false) {
  if (isBackendModule) return [];
  const raw = text;
  const src = mask(text);
  const imported = new Set();
  // Imports are read from the **comments-only** mask: the module path is a string, and the
  // structural mask blanks string contents (see `maskComments`).
  for (const im of maskComments(text).matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*backend["']/g)) {
    for (const part of im[1].split(",")) {
      const name = (part.split(/\s+as\s+/).pop() ?? "").trim();
      if (delegating.has(name)) imported.add(name);
    }
  }
  if (imported.size === 0) return [];

  const sites = [];
  const re = /\btry\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const brace = src.indexOf("{", m.index);
    const end = closeOf(src, brace, "{", "}");
    if (end < 0) continue;
    if (!/^\s*catch\b/.test(src.slice(end))) continue; // try/finally only — nothing claims to handle
    const body = src.slice(brace, end);
    if (THROWS_ON_ITS_OWN.test(body)) continue;
    const callees = [...body.matchAll(/\b(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)].map((x) => x[1]);
    const hit = [...new Set(callees.filter((c) => imported.has(c)))];
    if (hit.length === 0) continue;
    const line = src.slice(0, m.index).split("\n").length;
    sites.push({ file: "", line, callees: hit, text: (raw.split("\n")[line - 1] ?? "").trim().slice(0, 96) });
  }
  return sites;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "gen", "__tests__"].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

function loadBaseline() {
  const path = join(ROOT, BASELINE);
  if (!existsSync(path)) return { sites: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`GATE FAILED: ${BASELINE} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

function scan() {
  const files = walk(join(ROOT, "src")).map((f) => relative(ROOT, f));
  const isBackend = (rel) => /(^|\/)backend\.ts$/.test(rel);
  const wording = new Map();
  for (const rel of files) {
    if (!isBackend(rel)) continue;
    for (const [name, info] of delegatingWrappers(readFileSync(join(ROOT, rel), "utf8"), true)) {
      wording.set(name, { rel, ...info });
    }
  }
  const found = [];
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const site of deadCatches(text, wording, isBackend(rel))) found.push({ ...site, file: rel });
  }
  found.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

  const notes = new Map((loadBaseline().sites ?? []).map((s) => [`${s.file}:${s.line}`, s.note]));
  const unacknowledged = [];
  for (const site of found) {
    const note = notes.get(`${site.file}:${site.line}`);
    if (typeof note === "string" && note.trim() !== "") site.state = "acknowledged";
    else {
      site.state = note === undefined ? "not-in-baseline" : "no-note";
      unacknowledged.push(site);
    }
  }
  const foundKeys = new Set(found.map((s) => `${s.file}:${s.line}`));
  const rotten = [...notes.keys()].filter((k) => !foundKeys.has(k));
  return { wrappers: wording.size, files: files.length, found, unacknowledged, rotten };
}

function report() {
  const { wrappers, files, found, unacknowledged, rotten } = scan();
  console.log(
    `dead-catch-scan: ${files} frontend files, ${wrappers} cannot-reject wrapper(s), ` +
      `${found.length} try/catch site(s) that cannot fire`,
  );
  for (const site of found) {
    console.log(`  ${site.file}:${site.line}  ${site.state === "acknowledged" ? "[acknowledged]" : "[UNACKNOWLEDGED]"}`);
    console.log(`      calls: ${site.callees.join(", ")}`);
  }
  if (rotten.length > 0) {
    console.error(`\nGATE FAILED: ${rotten.length} allow-list entr(y/ies) no longer match a site.`);
    for (const k of rotten) console.error(`    ${k}`);
    console.error(`  fix: delete the stale entr(y/ies) from ${BASELINE}.`);
    process.exit(1);
  }
  if (unacknowledged.length > 0) {
    console.error(
      `\nGATE FAILED: ${unacknowledged.length} site(s) where a \`catch\` cannot run and the call's\n` +
        `verdict is the only signal the bridge sends.`,
    );
    for (const site of unacknowledged) {
      console.error(
        `    ${site.file}:${site.line}  ` +
          (site.state === "no-note" ? "(entry has no non-empty `note`)" : "(not in the allow-list)"),
      );
    }
    console.error(
      `  fix one of two ways, both of which require reading the site:\n` +
        `    • read the verdict (` + "`if (!reply)`" + `) and drop the \`try\` — the callee cannot\n` +
        `      reject, so the refusal arrives as \`null\`, not as a throw;\n` +
        `    • or record it in ${BASELINE} with a \`note\` saying what the fire-and-forget call\n` +
        `      is for and why no verdict is needed *there*. One note per site.`,
    );
    process.exit(1);
  }
  console.log("dead-catch-scan: OK — every site is acknowledged.");
}

function selftest() {
  let failures = 0;
  const ok = (name, cond) => {
    if (cond) console.log(`  ok   ${name}`);
    else {
      failures++;
      console.error(`  FAIL ${name}`);
    }
  };

  // A backend module in the shape `lib/backend.ts` uses for its wrappers.
  const backend = [
    'export async function telephonyDial(n: string): Promise<X | null> {',
    '  return invoke<X>("telephony_dial", { n });',
    "}",
    'export async function safeRead(): Promise<X | null> {',
    "  try { return invoke<X>(`a`); } catch { return null; }",
    "}",
    'export async function makingOne(): Promise<X | null> {',
    '  throw new Error("no");',
    "}",
    'export const arrowDial = async (n: string) => invoke<X>("d", { n });',
    'export async function listens(c: string) { return subscribe(c, () => {}); }',
  ].join("\n");
  const inv = delegatingWrappers(backend, true);
  const names = [...inv.keys()];
  ok("inventory: a one-hop invoke wrapper is in it", names.includes("telephonyDial"));
  ok("inventory: an arrow-const wrapper is in it", names.includes("arrowDial"));
  ok("inventory: a subscribe wrapper is in it", names.includes("listens"));
  ok("inventory: a wrapper with its own try is NOT (it can reject)", !names.includes("safeRead"));
  ok("inventory: a wrapper that throws is NOT", !names.includes("makingOne"));
  ok("inventory: a non-backend module has none", delegatingWrappers(backend, false).size === 0);
  // The per-file scope: `probe` is only judged when it is imported from a backend module.
  ok(
    "an unimported same-named function is not treated as the bridge one",
    deadCatches("try { await telephonyDial(1); } catch { }", inv).length === 0,
  );

  const head = 'import { telephonyDial, arrowDial } from "../lib/backend";\n';
  const site = head + "try {\n  await telephonyDial(num);\n} catch {\n  /* offline */\n}";
  ok("fires on a try/catch around a cannot-reject wrapper", deadCatches(site, inv).length === 1);
  ok("reports the try's line", deadCatches(site, inv)[0]?.line === 2);
  ok("names the callee", deadCatches(site, inv)[0]?.callees.includes("telephonyDial") === true);

  // --- and NOT on everything else --------------------------------------------------
  ok(
    "a try/finally with no catch is not a site",
    deadCatches(head + "try { await telephonyDial(1); } finally { x(); }", inv).length === 0,
  );
  ok(
    "a try body that throws on its own is not a site",
    deadCatches(head + 'try { if (!x) throw new Error("a"); await telephonyDial(1); } catch { }', inv).length === 0,
  );
  ok(
    "a try body with JSON.parse is not a site",
    deadCatches(head + "try { JSON.parse(s); await telephonyDial(1); } catch { }", inv).length === 0,
  );
  ok(
    "a try body with `new X` is not a site",
    deadCatches(head + "try { const d = new Date(); await telephonyDial(1); } catch { }", inv).length === 0,
  );
  // The two-sided correction this round made: `themeCore.writeStored` / `locale.setLocale` wrap
  // `localStorage.setItem` (which really does throw) around a `void systemStoreSet(...)`.
  ok(
    "a try body with localStorage is not a site (the false positive this rule was corrected for)",
    deadCatches(head + "try { localStorage.setItem(k, v); await telephonyDial(1); } catch { }", inv).length === 0,
  );
  ok(
    "a try body with document. is not a site",
    deadCatches(head + "try { document.title = x; await telephonyDial(1); } catch { }", inv).length === 0,
  );
  ok(
    "a try body calling only a non-delegating local is not a site",
    deadCatches(head + "try { await localHelper(x); } catch { }", inv).length === 0,
  );
  // The dangerous direction: the same text inside a comment or a string.
  ok(
    "a site quoted inside a comment is not a site",
    deadCatches(head + "// try { await telephonyDial(x); } catch { }", inv).length === 0,
  );
  ok(
    "a site quoted inside a string is not a site",
    deadCatches(head + 'const s = "try { await telephonyDial(x); } catch { }";', inv).length === 0,
  );
  ok(
    "masking preserves line numbers",
    deadCatches(head + "// one\n// two\ntry { await telephonyDial(x); } catch { }", inv)[0]?.line === 4,
  );
  ok(
    "an arrow-const wrapper is reachable",
    deadCatches(head + "try { await arrowDial(n); } catch { }", inv).length === 1,
  );
  ok(
    "two delegating callees in one try is one site naming both",
    (() => {
      const r = deadCatches(head + "try { await telephonyDial(a); await arrowDial(b); } catch { }", inv);
      return r.length === 1 && r[0].callees.length === 2;
    })(),
  );

  if (failures > 0) {
    console.error(`\ndead-catch-scan --selftest: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\ndead-catch-scan --selftest: OK");
}

if (process.argv.includes("--selftest")) selftest();
else if (process.argv.includes("--json")) console.log(JSON.stringify(scan(), null, 2));
else report();
