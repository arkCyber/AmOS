#!/usr/bin/env node
/**
 * void-cmd-scan.mjs — "a `void` bridge command called without anyone reading its verdict".
 *
 * Why: `invoke()` in `src/lib/backend.ts` **never rejects**. When the host refuses a
 * command it records the reason in the *per-command* diagnosis and answers `null` — and
 * for a `void` command (`Result<(), _>` on the Rust side) `null` is also the **success**
 * value. So for these commands "it happened" and "we never reached the host" arrive at
 * the caller as the same value, and the only readable verdict is
 * `bridgeDiag("<command>").ok` (REQ-A296).
 *
 * Two shipped defects came from exactly this shape, both drawn on screen as fact:
 *   * F-SH-261 / REQ-A826 — `DeviceMicButton.svelte` turned its own always-on-mic
 *     indicator off in a `finally`, on a stop nobody had confirmed.
 *   * F-SH-263 / REQ-A830 — `MailApp.svelte`'s star / answered / read buttons wrote the
 *     intent into the reader and drew it, so a flag the mail service never accepted
 *     looked saved (and "mark unread" also removed its own retry button).
 *
 * The repo already has a gate for this family — `write-scan` ("a user's content written
 * without asking whether it landed") — but its subject is `writeStoreValue(<content
 * key>)`, i.e. the **local** store. State written to the **daemon** through a `void`
 * bridge command falls between the two, which is why both defects shipped green. This
 * gate is that missing half.
 *
 * REQ-A845 / F-SH-273 (the round that widened it): **this gate was one of those greens.**
 * Its window was narrower than the sentence above claims — the inventory came from
 * `backend.ts` alone and the predicate required the literal `invoke<null>(` — so four more
 * instances of the very shape it names shipped past it, and one of them (the two
 * `pushNotifications.ts` wrappers, written bare) was not in the inventory at all:
 *
 *   * F-SH-270 — `settings/PushSettings.svelte` erased the shell's only copy of the push
 *     notifications, and told the host page the list was empty, on a `push_clear_history`
 *     the device had refused.
 *   * F-SH-271 — `lib/lmk.ts::reconcileLegacySurfaces` answered `stale.length`, documented
 *     as 「the number of surfaces closed」, for `wm_close` calls whose verdict nobody read.
 *   * F-SH-272 — `svelte/AirPlayPanel.svelte`'s teardown guard read a flag that is always
 *     `false` by unmount, so the host's platform discovery was never stopped.
 *   * F-LK-027 — `lib/robot.ts::watchHeartbeats` (that round's frontend half) handed the
 *     console a live-looking cleanup for a heartbeat stream the host had refused to start.
 *
 * So the rule did not change; the **window** did, and the two rules that a window cannot
 * express without help were added: a **pin** by set equality (a floor cannot see one name
 * leave) and `MUST_SEE_SITES` (a count cannot say *which* sites were there).
 *
 * REQ-A1003 / F-SH-324 (the second widening): the window was *still* narrower than the
 * sentence above. `Promise<void | null>` over `invoke<void>(…)` declares the same thing as
 * the two singletons — the bridge answers `null` to a `void` command's success *and* to its
 * refusal — and five wrappers are written that way (`systemSetContext`, `systemClearContext`,
 * `telephonyEnd`, `telephonyAnswer`, `systemStoreSet`). None of them was in the inventory, so
 * `AiApp.svelte`'s detached-context button drew a refused `system_clear_context` as done: the
 * hint vanished while the host still held the context and `chat_agent` merged it into the next
 * request. The predicate now reads all three spellings, and the pin + `MUST_SEE_SITES` gained
 * the five names and three of their sites so this widening is witnessed in both directions.
 *
 * ## What it checks, per production file and per command
 *
 * Every call to a wrapper that is declared `Promise<null>` / `Promise<void>` /
 * `Promise<void | null>` over `invoke(…)` / `invoke<null>(…)` / `invoke<void>(…)` must
 * **bind a verdict read** for *that* command. Bound means one of:
 *
 *   (a) **literal** — the file calls `bridgeDiag("<command>")`.
 *   (b) **one-hop helper** — the file passes the literal `"<command>"` as argument *i*
 *       of a function `H` it defines, and `H`'s body reads `bridgeDiag(<H's parameter i>)`.
 *       (`StoreApp.svelte`'s `run(action, id, command)` is the shipped example: the
 *       verdict is read once, in the helper, and every caller passes its own literal.)
 *   (c) **allow-listed** — `scripts/void-cmd-allowlist.json` names the file+command with
 *       a `kind` whose reason says why an unverified outcome is acceptable there.
 *
 * **Comments are stripped before every extraction.** A doc comment that *quotes* the old
 * shape must not be readable as the answer, and a commented-out `bridgeDiag("…")` must not
 * count as a binding. The literal must sit inside a real `bridgeDiag(…)` **call** — mere
 * presence of the string is not a binding — and it must name the **same** command: a
 * `bridgeDiag("mail_set_seen")` does not answer for `mail_set_flagged`.
 *
 * Usage (from frontend-ts):
 *   node scripts/void-cmd-scan.mjs              # gate
 *   node scripts/void-cmd-scan.mjs --json       # machine-readable
 *   node scripts/void-cmd-scan.mjs --selftest   # pin the extractors
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src");
const BACKEND = join(SRC, "lib", "backend.ts");
const ALLOWLIST = join(root, "scripts", "void-cmd-allowlist.json");

/**
 * The inventory is a **pin**, not a floor (REQ-A845 / F-SH-273).
 *
 * `FLOORS = { wrappers: 9 }` could only catch a *total* extraction break: a floor asks "are
 * there at least N?" and the failure this gate exists for is the loss of **one** name — the
 * one that still has call sites. A single missing wrapper has no sites, so it cannot fail any
 * rule below, and 8 ≥ 9 would have been the only thing standing between that and a green run
 * (which is exactly how `push_set_badge` / `push_clear_history` were invisible: see
 * `voidWrappers`). So the pairs are pinned by **set equality**, and the floors are kept
 * deliberately *below* the shipped counts so that the pin — not the floor — carries a
 * one-name loss.
 */
export const PINNED_WRAPPERS = [
  "deviceMicStop=device_mic_stop",
  "mailSetFlagged=mail_set_flagged",
  "mailSetAnswered=mail_set_answered",
  "mailSetSeen=mail_set_seen",
  "mailDelete=mail_delete",
  "mailMove=mail_move",
  "storeUninstall=appstore_uninstall",
  "blocklistClear=blocklist_clear",
  "blocklistSetUnknown=blocklist_set_unknown",
  "setBadgeCount=push_set_badge",
  "stopDiscovery=airplay_stop_discovery",
  // REQ-A1003 / F-SH-324 — the `Promise<void | null>` over `invoke<void>(…)` spelling.
  "systemSetContext=system_set_context",
  "systemClearContext=system_clear_context",
  "telephonyEnd=telephony_end",
  "telephonyAnswer=telephony_answer",
  "systemStoreSet=store_set",
  // REQ-A1571 (podcast frontend) — two more `void` write commands. Both are already
  // **classified**: their only call sites read the per-command verdict
  // (`PodcastsApp.svelte`'s `doSetPlayed` / `doSetPosition` each guard on
  // `!bridgeDiag("podcast_set_played" | "podcast_set_position").ok`), which is what
  // `invoke`'s `null` cannot tell apart from success. They were unpinned only because
  // the wrappers landed in a round that did not extend this list.
  "podcastSetPlayed=podcast_set_played",
  "podcastSetPosition=podcast_set_position",
];

/**
 * Sites that must be found, so that "the window silently emptied" and "there was nothing to
 * find" cannot look the same. A floor cannot say *which* sites were there; these can. They
 * are the ones whose absence would be a hole in the very shape this gate was widened for
 * (a wrapper outside `backend.ts`, a bare `invoke(`, and a direct call to a fallible host
 * command), so each one is a load-bearing witness to an extractor that still works.
 */
export const MUST_SEE_SITES = [
  "src/svelte/DeviceMicButton.svelte::device_mic_stop",
  "src/lib/pushNotifications.ts::push_clear_history",
  "src/lib/robot.ts::link_watch_heartbeats",
  "src/svelte/AirPlayPanel.svelte::airplay_stop_discovery",
  // REQ-A1003 / F-SH-324 — witnesses to the `Promise<void | null>` over `invoke<void>(…)`
  // extractor. One bound site (`AiApp`'s detached-context clear), one unbound-but-classified
  // (`sendToAi`'s attach request), and one that is neither a `.svelte` nor `backend.ts`
  // (the store mirror) — so the new spelling is witnessed from three directions.
  "src/svelte/AiApp.svelte::system_clear_context",
  "src/svelte/appLinks.ts::system_set_context",
  "src/lib/amosStore.ts::store_set",
];

/** Kept strictly below the pinned counts, so a one-name loss is the pin's to catch. */
export const FLOORS = { wrappers: 6, sites: 8 };

/**
 * Replace comments with spaces (byte offsets and line numbers survive), never touching
 * text inside a string or template literal. Handles `//`, `/* *​/` and `<!-- -->`.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let quote = null; // "'", '"', "`"
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c2 === "//") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c2 === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i += 1) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (src.slice(i, i + 4) === "<!--") {
      const end = src.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      for (; i < stop; i += 1) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Index just past the delimiter that closes the one opened at `open`. */
export function matchDelim(src, open, opener, closer) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === opener) depth += 1;
    else if (c === closer) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Split a parameter list or an argument list on **top-level** commas. Returns the raw
 * text of each part; the caller decides whether a part is a name or a literal.
 */
export function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += inner[i + 1] ?? "";
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    // `=>` is an arrow, not a closing angle bracket. Counting its `>` as one drove the
    // depth negative and stopped every later comma from splitting — which silently
    // truncated `(action: () => Promise<unknown>, id: string, command: string)` to its
    // first parameter, i.e. it hid the very parameter that carries the command.
    if (c === "=" && inner[i + 1] === ">") {
      cur += "=>";
      i += 1;
      continue;
    }
    if ("([{<".includes(c)) depth += 1;
    else if (")]}>".includes(c)) depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "" || parts.length > 0) parts.push(cur);
  return parts.map((p) => p.trim());
}

/** The bare identifier a parameter declares, or null for a destructuring pattern. */
function paramName(decl) {
  const withoutType = decl.split(":")[0].trim().replace(/^\.\.\./, "");
  return /^[A-Za-z_$][\w$]*$/.test(withoutType) ? withoutType : null;
}

/**
 * Every declared `void` command wrapper in one source file, with its byte range.
 *
 * A wrapper is an exported function declared `Promise<null>` / `Promise<void>` whose body
 * calls `invoke` with a **literal** command name and **no verdict-carrying reply type**
 * — `invoke("cmd")` or `invoke<null>("cmd")`, but never `invoke<Something>("cmd")`.
 *
 * REQ-A845 / F-SH-270, F-SH-273: those two spellings declare exactly the same thing. The predicate
 * used to require `invoke<null>(`, so every bare spelling was silently not a wrapper — not
 * in the inventory, therefore no call sites, therefore unable to fail the scan. Both
 * `pushNotifications.ts` wrappers are written bare, which is how `PushSettings.svelte`'s
 * "clear push history" kept erasing the local list on a command the host had refused.
 * The quote style is whatever the file uses (`airplay.ts` writes `'airplay_stop_discovery'`).
 */
export function wrapperDefs(rawSrc) {
  const src = stripComments(rawSrc);
  const out = [];
  const re = /export\s+async\s+function\s+(\w+)\s*\(/g;
  const starts = [];
  let m;
  while ((m = re.exec(src)) !== null) starts.push({ name: m[1], at: m.index });
  for (let k = 0; k < starts.length; k += 1) {
    const limit = k + 1 < starts.length ? starts[k + 1].at : src.length;
    const head = src.slice(starts[k].at, limit);
    // The declared return type sits between the parameter list and the body brace.
    // `Promise<void | null>` (REQ-A1003 / F-SH-324) is the **same declaration** as the two
    // singletons: the bridge answers `null` to a `void` command's success *and* to its
    // refusal, and `void | null` spells out both ends of that one value without saying
    // which is which. Five wrappers use it (`systemSetContext`, `systemClearContext`,
    // `telephonyEnd`, `telephonyAnswer`, `systemStoreSet`) and every one of them was
    // invisible here — which is how `AiApp.svelte`'s detached-context button kept
    // drawing a refused `system_clear_context` as done. The `\s*\{` must follow the `>`
    // directly, so a *union of the promise and null* (`Promise<void> | null`, a
    // different type) is not read as a void command.
    const brace = /\)\s*:\s*Promise<\s*(?:null|void)(?:\s*\|\s*(?:null|void))?\s*>\s*\{/.exec(head);
    if (!brace) continue;
    const openBrace = starts[k].at + brace.index + brace[0].length - 1;
    const closeBrace = matchDelim(src, openBrace, "{", "}");
    // The range is the **body**, not "everything up to the next `export async function`".
    // The loose form ran to EOF for the last declaration in a file, so `directVoidSites`
    // excluded every later statement in that file — and the `invoke` search could read a
    // *different* function's command out of the tail. Both are the same bug: a window that
    // was never the function.
    const end = closeBrace === -1 ? limit : closeBrace;
    const call = /invoke(?:<null>|<void>)?\(\s*(["'])([^"']+)\1/.exec(src.slice(openBrace, end));
    if (call) out.push({ name: starts[k].name, command: call[2], start: starts[k].at, end });
  }
  return out;
}

/**
 * The `void` wrapper inventory, keyed by wrapper name (`null` for a file that declares
 * none). See [`wrapperDefs`] for what counts as a wrapper.
 */
export function voidWrappers(rawSrc) {
  const out = new Map();
  for (const d of wrapperDefs(rawSrc)) out.set(d.name, d.command);
  return out;
}

/**
 * Production call sites of the given wrappers: `[{ file, line, name, command }]`.
 *
 * The wrapper's **own declaration** is not a call site. `export async function deviceMicStop(
 * ): Promise<null> {` matches the bare-name pattern, and once the inventory is drawn from
 * every file (REQ-A845) `src/lib/backend.ts` itself is walked like any other file — so every
 * wrapper declared there reported itself as an unbound site. A definition is not a call:
 * nobody drew a claim on it, and a `bridgeDiag` read inside the wrapper would push the
 * caller's verdict one layer away from the caller. Matches inside a declaration's own byte
 * range are dropped.
 */
export function callSites(file, rawSrc, wrappers) {
  const src = stripComments(rawSrc);
  const defs = wrapperDefs(rawSrc);
  const found = [];
  for (const [name, command] of wrappers) {
    // `(?<![\w$.])` keeps a member call (`obj.mailSetSeen(…)`) out of the window: only the
    // bare imported wrapper is the thing whose verdict we are asking about.
    const re = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g");
    let m;
    while ((m = re.exec(src)) !== null) {
      if (defs.some((d) => d.name === name && d.start <= m.index && m.index < d.end)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      found.push({ file, line, name, command });
    }
  }
  return found;
}

/**
 * Direct call sites of a `void` bridge command — a statement whose result is **discarded**.
 *
 * REQ-A845 / F-SH-273 (the gate), F-LK-027 (the defect it was blind to): the wrapper inventory above only covers calls made *through* a
 * declared wrapper, and the class this gate names is not limited to those. `lib/robot.ts`
 * calls `link_watch_heartbeats` **directly**; discarding that answer handed the console a
 * live-looking cleanup for a stream the host had refused to start, and no rule here could
 * see it because the command never appeared in an inventory.
 *
 * Two shapes discard a reply, and both are matched:
 *   • `await invoke("cmd"…);` as a whole statement — the line must begin with the `await`
 *     keyword and end there. An `await invoke(…)` whose value is *used*
 *     (`parseRagStatus(await invoke("rag_status"))`) is a typed read, not a void site.
 *   • `void invoke("cmd"…)` anywhere — the `void` operator **is** the discard, so it means
 *     the same thing in expression position (`=> void invoke("csp_probe"…)`).
 *
 * A site inside an inventoried wrapper's own body is **not** a site. The wrapper's callers
 * are where a claim gets drawn, and `callSites` already answers those; reporting the
 * definition as well would demand a `bridgeDiag` read inside the wrapper and push every
 * caller's verdict one layer away from the caller (the reason the literal is kept at the
 * call site in the first place).
 */
export function directVoidSites(file, rawSrc, wrappers = new Map()) {
  const src = stripComments(rawSrc);
  const defs = wrapperDefs(rawSrc).filter(
    (d) => wrappers.has(d.name) && wrappers.get(d.name) === d.command,
  );
  const found = [];
  const re = /(?:\bvoid\s+|^[ \t]*await\s+)invoke(?:<null>|<void>)?\(\s*(["'])([a-z0-9_]+)\1[^\n]*?\)\s*;/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (defs.some((d) => d.start <= m.index && m.index < d.end)) continue;
    found.push({
      file,
      line: src.slice(0, m.index).split("\n").length,
      name: "direct",
      command: m[2],
    });
  }
  return found;
}

/**
 * Every function defined in `src` that has a **block body**, with its parameter names.
 * The parameter list is read with a balanced-paren scan, not `[^)]*` — a parameter
 * whose type contains parentheses (`action: () => Promise<unknown>`) would otherwise
 * truncate the list and silently drop the very parameter that carries the command.
 */
export function findDefs(src) {
  const defs = [];
  const starts = [
    /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
    // `async` is optional: a **synchronous** declaration is a definition like any other, and
    // requiring the keyword made every plain `function` invisible. `spaces.ts`'s one-hop
    // helper is written `function unitMutationOk(command: string): boolean {`, so
    // `bindsOneHopHelper` could not see it and reported four sites as unbound that are in
    // fact bound — a false positive whose only suggested remedy was an allow-list entry, i.e.
    // the gate's own hole would have been papered over by a reason.
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g,
  ];
  for (const re of starts) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const openParen = m.index + m[0].length - 1;
      const closeParen = matchDelim(src, openParen, "(", ")");
      if (closeParen === -1) continue;
      const params = splitTopLevel(src.slice(openParen + 1, closeParen - 1)).map(paramName);
      const braceRel = src.slice(closeParen).search(/\{/);
      if (braceRel === -1) continue;
      const openBrace = closeParen + braceRel;
      // Only a return-type annotation and/or `=>` may sit between the params and the
      // body brace. Anything else (`a + 1;`) means the `{` belongs to something else —
      // an expression-bodied arrow whose body is a later object literal, say.
      const between = src.slice(closeParen, openBrace);
      if (!/^\s*(?::[^{;]*)?\s*(?:=>\s*)?$/.test(between)) continue;
      const closeBrace = matchDelim(src, openBrace, "{", "}");
      if (closeBrace === -1) continue;
      // `at`/`bodyStart` are byte offsets so a *different* rule can ask "which function
      // does this line sit in?" (read-fold-scan.mjs). Additive: every consumer above
      // reads only `name` / `params` / `body`.
      defs.push({
        name: m[1],
        params,
        body: src.slice(openBrace, closeBrace),
        at: m.index,
        bodyStart: openBrace,
        bodyEnd: closeBrace,
      });
    }
  }
  return defs;
}

/**
 * Rule (a): the file calls `bridgeDiag("<command>")`. A bare mention of the string is not
 * a binding, and the command must match exactly.
 */
export function bindsLiteral(rawSrc, command) {
  const src = stripComments(rawSrc);
  const re = new RegExp(`bridgeDiag\\(\\s*"${command}"\\s*\\)`);
  return re.test(src);
}

/**
 * Rule (b): a **one-hop helper**. The file defines `H` whose parameter *i* is read as
 * `bridgeDiag(<that parameter>)`, and the file also calls `H(…)` with the literal
 * `"<command>"` in argument position *i*. Positional matching is what makes this a
 * binding rather than a coincidence: a `bridgeDiag(id)` reading a different parameter
 * does not answer for the command passed as `command`.
 */
export function bindsOneHopHelper(rawSrc, command) {
  const src = stripComments(rawSrc);
  for (const def of findDefs(src)) {
    // Which of H's parameters does H hand to bridgeDiag?
    for (let i = 0; i < def.params.length; i += 1) {
      const p = def.params[i];
      if (!p) continue;
      if (!new RegExp(`bridgeDiag\\(\\s*${p}\\s*\\)`).test(def.body)) continue;
      // …and is there a call H(…, "<command>", …) putting the literal at that position?
      const callRe = new RegExp(`(?<![\\w$.])${def.name}\\s*\\(`, "g");
      let cm;
      while ((cm = callRe.exec(src)) !== null) {
        const cargs = matchDelim(src, cm.index + cm[0].length - 1, "(", ")");
        if (cargs === -1) continue;
        const inner = src.slice(cm.index + cm[0].length, cargs - 1);
        const args = splitTopLevel(inner);
        if (args[i] === `"${command}"` || args[i] === `'${command}'`) return true;
      }
    }
  }
  return false;
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST)) return { kinds: {}, sites: [] };
  return JSON.parse(readFileSync(ALLOWLIST, "utf8"));
}

/**
 * Whether a `kind` that no site references has declared why it is still on file.
 *
 * `note` is this file's spelling (the kinds are objects); the `reason` prefix is
 * `write-allowlist.json`'s, where the kinds are plain strings and the retired one already
 * reads `RETIRED (REQ-A150, round 86). …`. Accepting both keeps the rule one sentence in
 * both files rather than two dialects of it.
 */
function declaresMemberless(spec) {
  if (spec && typeof spec === "object") {
    if (typeof spec.note === "string" && spec.note.trim() !== "") return true;
    return /^(RETIRED|UNUSED|KEPT)\b/.test(String(spec.reason ?? "").trim());
  }
  return /^(RETIRED|UNUSED|KEPT)\b/.test(String(spec ?? "").trim());
}

/**
 * An allow-list is a hole in a gate, so it has to carry its own argument: every site
 * must name a `kind`, every `kind` must exist and state a `reason`, and every **site**
 * must state its own `note`. A kind's `reason` is a general argument; the note is the one
 * that has to hold *at that call site* — the site-specific "where would a verdict go, and
 * what happens because it does not". Requiring both is what stops a kind from becoming a
 * category that swallows anything: a `kind` is one sentence for many sites, so on its own
 * it can always be read as fitting; the note cannot be written without saying why.
 *
 * Without this an entry with a typo'd or missing kind still silences the check — the site
 * just stops being examined, which is indistinguishable from a green run.
 *
 * The last clause is the same argument applied to the **other** direction: a `kind` that no
 * site references is a permission with no request behind it, and unlike a stale site nothing
 * reported it (the scan looks up kinds *for* sites, never the reverse). `self-correcting`
 * sat in this file memberless with no note while `perf-budget-allowlist.json`'s two memberless
 * kinds each carry one — the file's own "an allow-list has to argue its case" rule applied to
 * some entries and not others. So a memberless kind must declare itself: a non-empty `note`,
 * or a `reason` beginning `RETIRED` ∕ `UNUSED` ∕ `KEPT`.
 */
export function checkAllowlistShape(allowed) {
  const problems = [];
  const kinds = allowed?.kinds ?? {};
  const referenced = new Set(
    (allowed?.sites ?? []).map((s) => s?.kind).filter((k) => typeof k === "string"),
  );
  for (const [name, spec] of Object.entries(kinds)) {
    if (typeof spec?.reason !== "string" || spec.reason.trim() === "") {
      problems.push(`kind "${name}" has no reason`);
    }
    if (!referenced.has(name) && !declaresMemberless(spec)) {
      problems.push(
        `kind "${name}" is referenced by no site and does not say why it is kept ` +
          "(add a `note`, or begin its `reason` with RETIRED ∕ UNUSED ∕ KEPT)",
      );
    }
  }
  for (const site of allowed?.sites ?? []) {
    const key = `${site?.file ?? "?"}::${site?.command ?? "?"}`;
    if (typeof site?.file !== "string" || typeof site?.command !== "string") {
      problems.push(`site ${key} is missing file or command`);
      continue;
    }
    if (typeof site?.kind !== "string" || site.kind.trim() === "") {
      problems.push(`site ${key} names no kind`);
    } else if (!(site.kind in kinds)) {
      problems.push(`site ${key} names kind "${site.kind}", which is not defined`);
    }
    if (typeof site?.note !== "string" || site.note.trim() === "") {
      problems.push(`site ${key} has no note arguing its own case`);
    }
  }
  return problems;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(p, acc);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".svelte")) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * The pin comparison, in **both** directions — pure, so the selftest can pin the rule that a
 * one-name loss fails. A floor asks "are there at least N?"; the failure this gate exists for
 * is the loss of *one* name (the one with call sites), and set equality is the only rule that
 * can see it. `missing` = pinned but gone; `extra` = present but unpinned.
 */
export function pinDiff(got, want) {
  const g = [...got].sort();
  const w = [...want].sort();
  return { missing: w.filter((p) => !g.includes(p)), extra: g.filter((p) => !w.includes(p)) };
}

/**
 * Wrapper names declared over *different* commands in different files. The
 * name→command table is global, so such a pair would be resolved by directory-walk order —
 * the "answered against a key the site never wrote" hazard that hid 10 of 152 write sites in
 * `write-scan` (REQ-A838). Recorded, never silently resolved.
 */
export function wrapperCollisions(entries) {
  const seen = new Map();
  const out = [];
  for (const e of entries) {
    const prior = seen.get(e.name);
    if (prior && prior.command !== e.command) {
      out.push(`${e.name}: ${prior.command} (${prior.file}) vs ${e.command} (${e.file})`);
    }
    if (!prior) seen.set(e.name, e);
  }
  return out;
}

function analyse() {
  // REQ-A845: the inventory is built from **every** source file, not just `backend.ts`.
  // `src/lib/pushNotifications.ts` declares a `Promise<void>` command wrapper and it was
  // never a wrapper as far as this scan was concerned — so it had no call sites, and the
  // clear-history path could not fail the scan however it behaved.
  const files = walk(SRC);
  const entries = [];
  for (const p of files) {
    for (const d of wrapperDefs(readFileSync(p, "utf8"))) {
      entries.push({ name: d.name, command: d.command, file: relative(root, p) });
    }
  }
  const wrappers = new Map();
  for (const e of entries) {
    if (!wrappers.has(e.name)) wrappers.set(e.name, { command: e.command, file: e.file });
  }
  const collisions = wrapperCollisions(entries);
  const byName = new Map([...wrappers].map(([n, v]) => [n, v.command]));
  const sites = [];
  for (const p of files) {
    const rel = relative(root, p);
    const src = readFileSync(p, "utf8");
    sites.push(...callSites(rel, src, byName));
    // The direct half is only meaningful for the file's *own* commands: a call to a command
    // another module wraps is answered by that module's wrappers, and `callSites` covers it.
    sites.push(...directVoidSites(rel, src, voidWrappers(src)));
  }
  return { wrappers, sites, files, collisions };
}

export function runScan() {
  const { wrappers, sites, files, collisions } = analyse();
  const allowed = readAllowlist();
  const allowedKeys = new Set((allowed.sites ?? []).map((s) => `${s.file}::${s.command}`));

  const shape = checkAllowlistShape(allowed);
  if (shape.length > 0) {
    for (const p of shape) console.error(`[void-cmd-scan] FAIL — allow-list: ${p}`);
    console.error(
      "[void-cmd-scan] an allow-listed site must name a defined `kind`, and every kind must " +
        "carry a non-empty `reason` — otherwise the entry silences the check silently.",
    );
    process.exit(1);
  }

  // Two files declaring the same wrapper name over different commands: the name→command
  // table would then answer by directory-walk order, which is the "resolved against the
  // wrong key" hazard that made 10 of 152 write sites invisible in `write-scan`
  // (REQ-A838). Never pick one silently.
  if (collisions.length > 0) {
    for (const c of collisions) console.error(`[void-cmd-scan] FAIL — wrapper name collision: ${c}`);
    console.error(
      "[void-cmd-scan] a wrapper name must map to exactly one command across src/; rename one " +
        "side (or key the inventory per file) before trusting any binding below.",
    );
    process.exit(1);
  }

  // The pin, in **both** directions. A floor only asks "are there at least N?" — and the
  // failure this gate exists for is the loss of *one* name, the one with call sites. A lost
  // wrapper has no call sites, so it cannot fail any rule below; only set equality can say so.
  const got = [...wrappers].map(([n, v]) => `${n}=${v.command}`);
  const { missing, extra } = pinDiff(got, PINNED_WRAPPERS);
  if (missing.length > 0 || extra.length > 0) {
    for (const p of missing) {
      const [name, command] = p.split("=");
      console.error(
        `[void-cmd-scan] FAIL — pinned wrapper \`${name}\` (\`${command}\`) is no longer in the ` +
          "inventory. Either the extractor stopped seeing it (fix the extractor) or the wrapper " +
          "was removed (drop the pin deliberately, with the REQ id that justified it).",
      );
    }
    for (const p of extra) {
      const [name, command] = p.split("=");
      console.error(
        `[void-cmd-scan] FAIL — \`${name}\` (\`${command}\`) is a \`void\` wrapper that is not ` +
          "pinned. A newly-declared `void` command is exactly the shape that shipped two defects " +
          "unseen; classify it, then add it to PINNED_WRAPPERS.",
      );
    }
    process.exit(1);
  }

  if (wrappers.size < FLOORS.wrappers || sites.length < FLOORS.sites) {
    console.error(
      `[void-cmd-scan] FAIL — ${wrappers.size} wrapper(s) / ${sites.length} site(s) are below ` +
        `the floors (${FLOORS.wrappers}/${FLOORS.sites}). This should be unreachable while the ` +
        "pin above holds; if it fires, the floors and the pin disagree about what is being " +
        "counted — fix the extractor before trusting a green run.",
    );
    process.exit(1);
  }

  // One verdict per (file, command): every call to the same command in the same file is
  // answered by the same binding, so group before judging.
  const byFile = new Map();
  for (const s of sites) {
    if (!byFile.has(s.file)) byFile.set(s.file, new Map());
    byFile.get(s.file).set(s.command, s);
  }

  const unbound = [];
  for (const [file, commands] of byFile) {
    if (allowedKeys.has(`${file}::*`)) continue;
    // Comments are already stripped inside bindsLiteral / bindsOneHopHelper.
    for (const [command] of commands) {
      if (allowedKeys.has(`${file}::${command}`)) continue;
      const src = readFileSync(join(root, file), "utf8");
      if (bindsLiteral(src, command) || bindsOneHopHelper(src, command)) continue;
      unbound.push({ file, command });
    }
  }

  // "The window silently emptied" and "there was nothing to find" must not look the same.
  // Each entry below is a load-bearing witness to one extractor: a wrapper outside
  // `backend.ts`, a bare `invoke(`, a single-quoted literal, and a direct call to a
  // fallible host command. Absence means an extractor stopped working, not that the code
  // got safer — and the count-based floors above cannot tell those apart.
  const siteKeys = new Set();
  for (const [file, commands] of byFile) {
    for (const [command] of commands) siteKeys.add(`${file}::${command}`);
  }
  const unseen = MUST_SEE_SITES.filter((k) => !siteKeys.has(k));
  if (unseen.length > 0) {
    for (const k of unseen) {
      console.error(
        `[void-cmd-scan] FAIL — the scan no longer sees ${k}, which it must. That site is one ` +
          "of the shapes this gate was widened for (a `void` wrapper declared outside " +
          "`backend.ts`, a bare `invoke(`, a single-quoted literal, or a direct call to a " +
          "fallible host command); not seeing it means an extractor regressed, not that the " +
          "call went away.",
      );
    }
    process.exit(1);
  }

  const usedKeys = new Set();
  for (const [file, commands] of byFile) {
    for (const [command] of commands) {
      if (allowedKeys.has(`${file}::${command}`)) usedKeys.add(`${file}::${command}`);
    }
  }
  const stale = [...allowedKeys].filter((k) => k !== `${k.split("::")[0]}::*` && !usedKeys.has(k));

  // Every hole the gate is running with, reprinted with the argument that justified it. A
  // note nobody reads is not an argument; the scan prints them all so the hole is part of
  // the run's output, not a file nobody opens.
  for (const site of allowed.sites ?? []) {
    const key = `${site.file}::${site.command}`;
    if (!siteKeys.has(key)) continue;
    console.log(`[void-cmd-scan] allow-listed ${key} (${site.kind}) — ${site.note}`);
  }

  for (const u of unbound) {
    const site = byFile.get(u.file).get(u.command);
    console.error(
      `[void-cmd-scan] FAIL — ${u.file}:${site.line} calls \`${site.name}()\` ` +
        `(\`${u.command}\`) and the file never binds a verdict for that command. ` +
        "`invoke` never rejects and a `void` command's success value is `null`, so the " +
        'reply cannot tell "done" from "we never reached the host" — read ' +
        `\`bridgeDiag("${u.command}").ok\` (or pass the literal to a helper that does), ` +
        "or list the site in scripts/void-cmd-allowlist.json with a reason.",
    );
  }
  for (const k of stale) {
    const [file, command] = k.split("::");
    console.log(
      `[void-cmd-scan] allow-list: no call site for ${file} / ${command} — shrink it.`,
    );
  }

  console.log(
    `[void-cmd-scan] ${wrappers.size} \`void\` wrapper(s), ${sites.length} call site(s) in ` +
      `${byFile.size} file(s); ${usedKeys.size} allow-listed.`,
  );
  if (unbound.length === 0) {
    console.log("[void-cmd-scan] OK — every `void` bridge command is asked whether it landed.");
  } else {
    console.error(
      "\nA `void` bridge command has no usable return value: the verdict is the per-command\n" +
        "diagnosis (REQ-A296). Bind it, or classify the site with a reason.",
    );
  }
  process.exit(unbound.length === 0 ? 0 : 1);
}

export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const backend = [
    "export async function mailSetSeen(mailbox: string, id: string, seen: boolean): Promise<null> {",
    '  return invoke<null>("mail_set_seen", { mailbox, id, seen });',
    "}",
    "export async function blocklistClear(): Promise<void> {",
    '  await invoke<null>("blocklist_clear");',
    "}",
    "export async function storeSearch(q: string): Promise<AppManifest[] | null> {",
    '  return invoke<AppManifest[]>("appstore_search", { q });',
    "}",
    "// export async function fake(): Promise<void> {",
    '//   await invoke<null>("not_real");',
    "// }",
    "export async function mailRead(mailbox: string, id: string): Promise<MailMessage | null> {",
    '  return invoke<MailMessage | null>("mail_read", { mailbox, id });',
    "}",
  ].join("\n");
  const w = voidWrappers(backend);
  ok("void wrapper inventory: Promise<null> over invoke<null>", w.get("mailSetSeen") === "mail_set_seen");
  ok("void wrapper inventory: Promise<void> over invoke<null>", w.get("blocklistClear") === "blocklist_clear");
  ok("a value-returning wrapper is not in the inventory", !w.has("storeSearch"));
  ok("a commented-out wrapper is not in the inventory", !w.has("fake"));
  ok("a wrapper with a real return type is not in the inventory", !w.has("mailRead"));
  ok("inventory size is exactly the 2 real void wrappers", w.size === 2);

  const sites = callSites("svelte/X.svelte", "await mailSetSeen(mb, id, false);\nvoid mailSetSeen(a,b,c);", w);

  ok("every call of a void wrapper is a site", sites.length === 2);
  ok("the site carries its own command", sites[0].command === "mail_set_seen");
  ok("the site carries a line number", sites[0].line === 1 && sites[1].line === 2);
  ok(
    "a member call is not mistaken for a wrapper call",
    callSites("svelte/Y.svelte", "obj.mailSetSeen(mb, id, false);", w).length === 0,
  );

  // --- REQ-A845: the spellings the old predicate could not read -------------------------
  // The predicate used to require `invoke<null>(`, so a bare `invoke("cmd")` was not a
  // wrapper, and a wrapper nobody inventoried has no call sites and can never fail the scan.
  // Both `pushNotifications.ts` wrappers are written bare; `airplay.ts` uses single quotes.
  const bare = [
    "export async function setBadgeCount(count: number): Promise<void> {",
    '  await invoke("push_set_badge", { count });',
    "}",
  ].join("\n");
  ok("a bare `invoke(\"cmd\")` declares a void wrapper", voidWrappers(bare).get("setBadgeCount") === "push_set_badge");
  const single = [
    "export async function stopDiscovery(): Promise<void> {",
    "  await invoke('airplay_stop_discovery');",
    "}",
  ].join("\n");
  ok(
    "a single-quoted literal declares a void wrapper",
    voidWrappers(single).get("stopDiscovery") === "airplay_stop_discovery",
  );
  ok(
    "`invoke<Something>(\"cmd\")` is NOT a void wrapper (the command has a real reply)",
    !voidWrappers(
      [
        "export async function wmShow(label: string): Promise<void> {",
        "  await invoke<WmSnapshot>('wm_show', { label });",
        "}",
      ].join("\n"),
    ).has("wmShow"),
  );

  // --- REQ-A1003 / F-SH-324: the third spelling ----------------------------------------
  // `Promise<void | null>` over `invoke<void>(…)` declares the same thing as the two
  // singletons — the bridge answers `null` to a `void` command's success *and* its refusal
  // — and five wrappers are written that way. It was outside the predicate, so those five
  // (and `AiApp.svelte`'s refused detached-context clear) could not fail the scan.
  const union = [
    "export async function systemClearContext(targetWindow: string): Promise<void | null> {",
    '  return invoke<void>("system_clear_context", { targetWindow });',
    "}",
  ].join("\n");
  ok(
    "`Promise<void | null>` over `invoke<void>` declares a void wrapper",
    voidWrappers(union).get("systemClearContext") === "system_clear_context",
  );
  ok(
    "`Promise<null | void>` (reversed) declares the same wrapper",
    voidWrappers(
      [
        "export async function telephonyEnd(callId: string): Promise<null | void> {",
        '  return invoke<void>("telephony_end", { callId });',
        "}",
      ].join("\n"),
    ).get("telephonyEnd") === "telephony_end",
  );
  ok(
    "a *union of the promise and null* (`Promise<void> | null`) is NOT a void wrapper",
    !voidWrappers(
      [
        "export async function maybe(label: string): Promise<void> | null {",
        '  return invoke<void>("wm_show", { label });',
        "}",
      ].join("\n"),
    ).has("maybe"),
  );
  ok(
    "a discarded `await invoke<void>(\"cmd\");` is a direct site",
    directVoidSites("lib/x.ts", 'await invoke<void>("system_set_context", { targetWindow: "ai" });\n', new Map())
      .length === 1,
  );

  // The DECLARATION is not a call site. Once the inventory is drawn from every file, the
  // declaring file is walked too, and `export async function deviceMicStop(…` matches the
  // bare-name pattern — every wrapper in `backend.ts` reported itself as an unbound site.
  ok(
    "a wrapper's own declaration is not a call site",
    callSites("lib/backend.ts", bare, voidWrappers(bare)).length === 0,
  );
  ok(
    "a real call in the declaring file IS a call site",
    callSites("lib/backend.ts", `${bare}\nconst go = () => setBadgeCount(3);`, voidWrappers(bare))
      .length === 1,
  );

  // --- the direct half: a statement whose result is discarded ---------------------------
  const W = new Map([["blocklistClear", "blocklist_clear"]]);
  const defs = [
    "export async function blocklistClear(): Promise<void> {",
    '  await invoke<null>("blocklist_clear");',
    "}",
  ].join("\n");
  ok(
    "a discarded `await invoke(\"cmd\");` is a direct site",
    directVoidSites("lib/x.ts", 'await invoke<null>("dock_badge_set", { n: 1 });\n', new Map())
      .length === 1,
  );
  ok(
    "`void invoke(\"cmd\", …)` in expression position is a direct site",
    directVoidSites("shell-entry.ts", 'const p = (m: string) => void invoke("csp_probe", { m });\n', new Map())
      .length === 1,
  );
  ok(
    "a USED reply is not a direct site (a typed read, not a void call)",
    directVoidSites("lib/rag.ts", 'const s = parse(await invoke("rag_status", {}));\n', new Map())
      .length === 0,
  );
  ok(
    "a site inside an inventoried wrapper's own body is not a site",
    directVoidSites("lib/backend.ts", defs, W).length === 0,
  );
  ok(
    "…but the call that is NOT in a wrapper body still is",
    directVoidSites("lib/backend.ts", `${defs}\nawait invoke<null>("blocklist_clear");`, W).length === 1,
  );

  // --- the pin, both directions, and the collision rule ---------------------------------
  ok(
    "the pin holds when the inventory matches exactly (order-independent)",
    pinDiff(["b=two", "a=one"], ["a=one", "b=two"]).missing.length === 0 &&
      pinDiff(["b=two", "a=one"], ["a=one", "b=two"]).extra.length === 0,
  );
  ok(
    "a ONE-NAME LOSS is caught by the pin (a floor could not see it)",
    pinDiff(["a=one"], ["a=one", "b=two"]).missing.join() === "b=two",
  );
  ok(
    "a NEW unpinned wrapper is caught too",
    pinDiff(["a=one", "c=three"], ["a=one"]).extra.join() === "c=three",
  );
  ok(
    "the same name over the same command in two files is not a collision",
    wrapperCollisions([
      { name: "x", command: "c", file: "a.ts" },
      { name: "x", command: "c", file: "b.ts" },
    ]).length === 0,
  );
  ok(
    "the same name over DIFFERENT commands is a collision",
    wrapperCollisions([
      { name: "x", command: "c1", file: "a.ts" },
      { name: "x", command: "c2", file: "b.ts" },
    ]).length === 1,
  );

  // Rule (a)
  ok(
    "literal binding accepted",
    bindsLiteral('await mailSetSeen(m, i, false);\nif (bridgeDiag("mail_set_seen").ok) {}', "mail_set_seen"),
  );
  ok(
    "a literal naming a DIFFERENT command is not a binding",
    !bindsLiteral('await mailSetSeen(m, i, false);\nif (bridgeDiag("mail_set_flagged").ok) {}', "mail_set_seen"),
  );
  ok(
    "a bare mention of the command string is not a binding",
    !bindsLiteral('await mailSetSeen(m, i, false);\nconst c = "mail_set_seen";', "mail_set_seen"),
  );
  ok(
    "a COMMENTED-OUT bridgeDiag call is not a binding",
    !bindsLiteral('await mailSetSeen(m, i, false);\n// if (bridgeDiag("mail_set_seen").ok) {}', "mail_set_seen"),
  );
  ok(
    "a block-commented bridgeDiag call is not a binding",
    !bindsLiteral('await mailSetSeen(m, i, false);\n/* bridgeDiag("mail_set_seen") */', "mail_set_seen"),
  );
  ok(
    "a doc comment that QUOTES the call is not a binding",
    !bindsLiteral(
      '/* read `bridgeDiag("mail_set_seen").ok` for the verdict */\nawait mailSetSeen(m, i, false);',
      "mail_set_seen",
    ),
  );
  ok(
    "a doc comment quoting it does not hide a real call",
    bindsLiteral(
      '/* read `bridgeDiag("mail_set_seen").ok` */\nif (bridgeDiag("mail_set_seen").ok) {}',
      "mail_set_seen",
    ),
  );

  // Rule (b) — the shipped StoreApp.run shape
  const helper = [
    "const run = async (action: () => Promise<unknown>, id: string, command: string) => {",
    "  await action();",
    "  if (!bridgeDiag(command).ok) err = t('x');",
    "};",
    'const go = () => run(() => storeUninstall(app.id), app.id, "appstore_uninstall");',
  ].join("\n");
  ok("one-hop helper binds the literal it is handed", bindsOneHopHelper(helper, "appstore_uninstall"));
  ok(
    "the helper does NOT bind a command whose literal is never passed",
    !bindsOneHopHelper(helper, "appstore_install"),
  );
  ok(
    "positional matching: a helper that reads a DIFFERENT parameter is not a binding",
    !bindsOneHopHelper(
      [
        "const run = async (id: string, command: string) => {",
        "  if (!bridgeDiag(id).ok) err = 1;", // reads `id`, not `command`
        "};",
        'run(app.id, "appstore_uninstall");',
      ].join("\n"),
      "appstore_uninstall",
    ),
  );
  ok(
    "positional matching: the literal must sit in the read parameter's position",
    !bindsOneHopHelper(
      [
        "const run = async (id: string, command: string) => {",
        "  if (!bridgeDiag(command).ok) err = 1;",
        "};",
        'run("appstore_uninstall", app.id);', // literal is argument 0, not 1
      ].join("\n"),
      "appstore_uninstall",
    ),
  );
  ok(
    "an unrelated function reading bridgeDiag(param) does not bind an unrelated call",
    !bindsOneHopHelper(
      [
        "const check = async (name: string) => { bridgeDiag(name); };",
        'run(app.id, "appstore_uninstall");',
      ].join("\n"),
      "appstore_uninstall",
    ),
  );
  ok(
    "a helper binding ONE command does not bind the file's other commands",
    !bindsLiteral(helper, "mail_set_seen") && !bindsOneHopHelper(helper, "mail_set_seen"),
  );

  // The allow-list is a hole in the gate, so its own shape is checked: an entry that
  // merely *looks* classified (missing kind, or a kind nobody defined) must not silence
  // the scan, and "there is no entry" must stay valid.
  ok("no allow-list file at all is well-formed", checkAllowlistShape({ kinds: {}, sites: [] }).length === 0);
  ok(
    "a site whose kind is undefined is rejected",
    checkAllowlistShape({
      kinds: {},
      sites: [{ file: "a.svelte", command: "x", kind: "writer-instead", note: "because" }],
    }).length === 1,
  );
  ok(
    "a kind with an empty reason is rejected",
    checkAllowlistShape({ kinds: { k: { reason: "  ", note: "kept memberless in this fixture" } }, sites: [] })
      .length === 1,
  );
  ok(
    "a site with no kind at all is rejected",
    checkAllowlistShape({
      kinds: { k: { reason: "why", note: "kept memberless in this fixture" } },
      sites: [{ file: "a", command: "b", note: "because" }],
    }).length === 1,
  );
  // A kind's `reason` is one sentence shared by every site that names it, so on its own it
  // can always be read as fitting. The note is the site's own argument, and without it a
  // general reason becomes a category that swallows anything.
  ok(
    "a site with no note is rejected even when its kind is defined and reasoned",
    checkAllowlistShape({
      kinds: { k: { reason: "why" } },
      sites: [{ file: "a.svelte", command: "b", kind: "k" }],
    }).length === 1,
  );
  ok(
    "a site whose note is blank is rejected too",
    checkAllowlistShape({
      kinds: { k: { reason: "why" } },
      sites: [{ file: "a.svelte", command: "b", kind: "k", note: "   " }],
    }).length === 1,
  );
  ok(
    "a site naming a defined kind with a reason and its own note passes",
    checkAllowlistShape({
      kinds: { k: { reason: "why" } },
      sites: [{ file: "a.svelte", command: "b", kind: "k", note: "because" }],
    }).length === 0,
  );
  // The other direction: a kind no site names is a permission nobody asked for, and the
  // scan never looked at it. `self-correcting` sat in the shipped file that way.
  ok(
    "a memberless kind that explains nothing is rejected",
    checkAllowlistShape({ kinds: { k: { reason: "why" } }, sites: [] }).length === 1,
  );
  ok(
    "a memberless kind with a note passes",
    checkAllowlistShape({
      kinds: { k: { reason: "why", note: "declared with no members on purpose" } },
      sites: [],
    }).length === 0,
  );
  ok(
    "a memberless kind whose reason begins RETIRED passes",
    checkAllowlistShape({ kinds: { k: { reason: "RETIRED (REQ-A1, round N). …" } }, sites: [] }).length === 0,
  );
  ok(
    "a memberless kind whose reason begins UNUSED passes",
    checkAllowlistShape({ kinds: { k: { reason: "UNUSED — never had a member." } }, sites: [] }).length === 0,
  );
  ok(
    "a `RETIREDLY` prefix is not the RETIRED marker",
    checkAllowlistShape({ kinds: { k: { reason: "RETIREDLY…" } }, sites: [] }).length === 1,
  );
  ok(
    "the SHIPPED allow-list is well-formed (a typo in the real file must not be a green run)",
    checkAllowlistShape(readAllowlist()).length === 0,
  );

  let bad = 0;
  for (const [name, cond] of checks) {
    if (cond) console.log(`  [ok] ${name}`);
    else {
      console.error(`  [FAIL] ${name}`);
      bad += 1;
    }
  }
  if (bad === 0) console.log(`[void-cmd-scan] selftest OK — ${checks.length} case(s).`);
  else console.error(`[void-cmd-scan] selftest FAILED — ${bad}/${checks.length} case(s).`);
  process.exit(bad === 0 ? 0 : 1);
}

/**
 * True when this file is the process entry point, so the selftest/scan dispatch never
 * fires when another script imports the extractors. Matches on the basename, so a
 * symlinked invocation still runs (the `fileURLToPath === argv[1]` form silently no-ops).
 */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();
else if (IS_ENTRY) runScan();
