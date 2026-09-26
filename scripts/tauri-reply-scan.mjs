#!/usr/bin/env node
/**
 * tauri-reply-scan.mjs — "the reply the shell reads cannot be the reply the
 * command sends".
 *
 * Why: `tauri-command-scan.mjs` checks the command *name* and `tauri-args-scan.mjs`
 * the *arguments*. Nothing checked the **return value**, and the SMS trash panel
 * was dead on device because of it (Round 47):
 *
 *   * `sms_trash_list` returns `Vec<TrashOut>` (`thread_id`, `message_id`,
 *     `ts_ms`, `trashed_ms`), but the shell declared `SmsTrashEntryOut` with
 *     camelCase fields — every read was `undefined` (blank rows, a `each` keyed on
 *     `"undefined/undefined"`, restore sending blank ids).
 *   * `sms_trash_restore` returns a **bool** and `sms_trash_purge` a **usize**, yet
 *     both wrappers compared the value to a string (`=== "restored"`), so a
 *     successful restore/purge was reported as a failure.
 *
 * Tauri serializes a command's return value with **serde's own rules** (this
 * workspace sets no `rename_all = "camelCase"` anywhere), so the wire shape is the
 * Rust struct/enum/scalar as written. This gate compares, per `invoke<T>("cmd")`:
 *
 *   1. **scalar kinds** — Rust `bool` ⇒ TS `boolean`, numeric ⇒ `number`,
 *      `String`/`&str` ⇒ `string`, `Vec<T>` ⇒ `T[]`, `Option<T>` ⇒ `T | null`;
 *   2. **object fields** — every field the TS type declares must exist in the Rust
 *      struct/enum's serialized field set (the camelCase-vs-snake_case class);
 *   3. a Rust field the shell never reads is reported as **informational** only
 *      (the shell need not model every wire field).
 *
 *
 * …and a **field's own type is never read, on either side**: item 1's kind comparison happens at
 * the reply's own level (and at an array element's, by recursion), while item 2's two sides are
 * **name lists** — `parseRustShapes` keeps `fields: string[]`, so the host's field types are not
 * parsed at all. Measured 2026-09-22 (control on `print_document`'s pair, REQ-A869's round):
 * declaring an **absent field** reddens this gate (`windo` — absent from the reply's
 * `PrintRequest`), and changing a field's **kind** (`window: number` against the host's
 * `window: String`) leaves it green. That is the documented shape of item 2, not a hole in it —
 * but nothing else in the repo catches the second case either (`tsc` accepts the hand-written
 * generic), so it is stated here rather than left to be inferred from item 1's wording.
 * Honest boundary: only *statically nameable* pairs are checked — the invoke
 * generic must be a local interface/type name or an inline object type, and the
 * Rust return type must resolve (`Result<T, E>`/`Option<T>`/`Vec<T>` unwrapped to a
 * local struct or a known scalar). A union alias, `unknown`, a generic parameter, a
 * struct with `#[serde(flatten)]`/`skip_serializing`, or a serde-`Value` return is
 * **skipped, never guessed** — a missed finding is quieter than a false CI failure.
 *
 * …and REQ-A532 closed three more of those skips, measured on this tree (`117 checked /
 * 99 skipped` → **`167 / 49`**):
 *
 *   * **the repo's own aliases** — `AmosResult<T>` and `AppStoreResult<T>` are how the command
 *     surface returns; `parseRustAliases` expands them (`type X<T> = Result<T, E>;`), and a
 *     crate-defined `Result`/`Option`/`Vec`/… is **never** honoured (`STD_GENERICS`), because
 *     honouring one collapsed `checked` 141 → 23 in the first attempt: every plain
 *     `Result<WmSnapshot, String>` was rewritten as `std::result::Result<…>`, which this resolver
 *     does not model;
 *   * **the unit side** — TS `null` is the unit wire value, so `Result<(), String>` ↔ `null` is a
 *     comparable pair instead of "unverifiable";
 *   * **shapes from other workspace members** — `EmailSummary` lives in `amos-mail`, `AppManifest`
 *     in `amos-appstore`; they are used under two guards (the tauri crate's own declaration wins a
 *     name collision, and a name declared more than once elsewhere is dropped) because adding them
 *     unguarded is what produced that same 141 → 23 collapse.
 *
 * What is left is **the shell's own gap, and it is named** rather than counted: the largest
 * remaining category is `invoke<unknown>(…)` — commands the UI reads without declaring a reply type
 * (31 of them today, printed by the scan).
 *
 * …and REQ-A555 closed that entire category (**measured on this tree: 0 untyped reads left, and the
 * report prints no such line at all**). The 31 sites now name the host's real reply — the 10 `wm_*`
 * window commands answer `Result<WmSnapshot, String>` and the shell reads `WmWindowsSnapshot`,
 * `devcare_*` reads the view types that already mirrored them, `nativeApps` got wire types for
 * `wine::WineApp` / `linux_apps::LinuxApp`, … — and three of the values were **not** news at the
 * call sites (a `null` check is still the honest "did it land"), they were news *to this scan*.
 * Two defects in the scan itself came out of the same round, both of which had been hiding pairs:
 *
 *   * a **field's own `#[serde(…)]`** made its whole shape `opaque`. 17 shapes were in that state
 *     (`AppManifest`, `CareReport`, `SensorHostSnapshot`, `FsRead`, `NfcWriteResult`, `AppStatus`,
 *     `BundleImportResult`, `WindowState`, …) — none of them unmodellable. `readFieldPart` now reads
 *     the attribute group instead of giving up on it: `rename` is the wire name, `skip*` drops the
 *     item, `default`/`skip_serializing_if` are name-neutral, and `flatten`/`with`/`into`/`untagged`
 *     *plus every key the reader does not model* fail closed. Negative control: restoring the old
 *     "any attribute ⇒ opaque" rule drops the report from `219 checked / 9 skipped` to
 *     **`210 / 18`**;
 *   * `stripComments` called `replace` on the block-comment pattern **without a replacement
 *     argument**, so every `/* … *\/` became the text `undefined` — and the field behind such a
 *     comment was silently dropped from a TS body (`ReportView`'s `assessed`; a TS type could even
 *     parse with **no fields at all**). Negative control: with the missing argument restored,
 *     renaming `ReportView.assessed` produces **no finding**; with it fixed, exactly one.
 *
 * A reply type declared in **another module** is resolved too (`tsScopeFor` follows a file's relative
 * imports and `export … from` re-exports, depth-limited, local declaration wins) — the same blind spot
 * REQ-A532 closed for a shape declared in another crate.
 *
 * …and REQ-A558 closed the six that were left for a *comparison* this scan did not have, plus one
 * defect the same round uncovered in itself (**`219 / 9` → `227 checked / 2 skipped`**):
 *
 *   * a TS union of **object literals** (`type BleReadResult = { ok: true; bytes: number[] } |
 *     { ok: false; error: string }`) against the host's **one** flat struct
 *     (`BleReadResult { ok, bytes, error }`). Each member is a narrowing view, so the judgement is
 *     per member: every field it declares must exist on the wire (`bytesRead` would not);
 *   * a TS **discriminant-literal** union (`type RustPermissionStatus = "notdetermined" | …`)
 *     against an **externally tagged** enum: the sets of literals must match in both directions —
 *     REQ-A467's shape one tagging style over;
 *   * a Rust **`#[serde(untagged)]`** enum now records **each variant's field set**, because the
 *     wire carries exactly one of them: a union member must fit a *single* variant, not merely the
 *     union of all fields (that is what makes `sms_trash_add`'s three-state contract checkable);
 *   * the parser read an external enum's **Rust** variant names instead of their wire spellings, so
 *     `rename_all = "lowercase"` (`PermissionStatus`) and a variant `rename` (`AppStatus`) produced
 *     two *false* failures the moment the literals were compared — the shape now records the wire
 *     name (control M6);
 *   * `parseRustShapes` looked for "the next `{` in the file" rather than the declaration's own
 *     body, so `pub struct SubscriptionId(pub u64);` inherited the ***Subscriber*** struct's fields
 *     and `invoke<number>("clipboard_subscribe")` — correct on both sides — was reported as a
 *     failure. A tuple struct is now read as its **inner type's** shape (a newtype struct serializes
 *     as its inner value), and a unit/two-field tuple stays unverifiable (controls M5/M7).
 *
 * Still out of scope on purpose (skipped, never guessed) — after REQ-A558 that is **two** pairs:
 *   * `HashMap<String, String>` ↔ `Record<string, string>` (`store_snapshot`): a map's type
 *     parameters are not this resolver's vocabulary;
 *   * a `#[serde(flatten)]` member (`devcare::CleanReply`, 1 pair) — inlining another struct's
 *     fields is a resolver feature, not a parser tweak;
 *   * an **inline** union in the generic itself (`invoke<{kind:"a"} | {kind:"b"}>(…)`) and an
 *     `interface` whose *field* is a union (e.g. `pushNotifications.ts`'s
 *     `kind: "ok" | "permissiondenied" | …`) — both need the union readers above to be applied to
 *     something other than a named alias, which nothing in this tree asks for today;
 *   * a TS type reached through `import * as ns`, a default import, or `export * from` (neither is
 *     followed: the local name of a namespace member is not what the generic spells);
 *   * a call whose command name is a **variable** (`TopbarMainMenu.svelte`'s
 *     `invoke<WmWindowsSnapshot>(command, …)`) — the extractor matches a literal name after the
 *     generic, so that site is invisible to this gate in **both** directions (typed, not checked).
 *
 * …and REQ-A469 closed the first of those skips. A **tagged union alias**
 * (`type X = | { kind: "a" }; | …`) is now read (`parseTsTaggedUnions`) and its discriminant
 * literals are compared with the Rust enum's wire tags (`variantTag`, which applies `rename_all`
 * to the *variant* name — the field renamer above would have returned the Rust spelling and
 * missed it). Two extractor defects were found while wiring that up, both measured on this tree:
 *
 *   * `parseInvokeGenerics` required a **double-quoted** command name, so
 *     `invoke<AirPlayResult>('airplay_connect')` — all **9** typed invokes in `lib/airplay.ts`,
 *     i.e. the entire AirPlay reply surface — was invisible to this scan. Fixing the quotes moved
 *     the report from `107 checked / 93 skipped` to `116 / 93`. `AirPlayResult`'s discriminant
 *     mismatch (REQ-A467) survived *because* of this: the pair was never even seen.
 *   * `parseRustShapes` never recorded the tag **value**, so even a parsed pair had nothing to
 *     compare a declared literal against.
 *
 * …and these have been out of scope since REQ-A469, for the same reason (skipped, never guessed):
 *   * a union alias whose members use **different tag fields**, or whose tag is not a string
 *     literal, or that has a single member (that is an object alias — `parseTsInterfaces` reads it);
 *   * a Rust enum this scan cannot read (opaque, externally tagged, or a tagged **newtype** variant);
 *   * `tauri-event-scan.mjs` reuses these extractors but does **not** pass the union map, so event
 *     payload unions stay unverifiable there. Measured 2026-09-19 (REQ-A469): `interpret-output`
 *     emits `state_changed` / `language_detected` / `tts_request` and `InterpApp` handles none of
 *     them. `tts_request` is never emitted by the served host (`SessionConfig::one_way` leaves
 *     `tts_enabled` false) and the other two are informational — registered, **not** gated.
 *
 * Usage (repo root):
 *   node scripts/tauri-reply-scan.mjs              # gate
 *   node scripts/tauri-reply-scan.mjs --json       # machine-readable
 *   node scripts/tauri-reply-scan.mjs --selftest   # pin the extractors
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_SRC = join(root, "crates/amos-tauri/src");
/** REQ-A532: the whole workspace, for reply types defined outside the tauri crate. */
const CRATES_DIR = join(root, "crates");
const FE_SRC = join(root, "crates/amos-tauri/frontend-ts/src");

const SKIP = new Set(["node_modules", "target", ".git", "gen", "dist"]);

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
 * The token-aware view the comment/test helpers below share (REQ-A851).
 *
 * Both of them used to decide "where does a comment start?" and "where does this item end?" by
 * matching **characters**. Neither knew the difference between code and a string literal, and Rust
 * source is full of literals that *look* like the thing being matched:
 *
 *   * `"https://api.anthropic.com/v1/messages"` — the `//` of a URL. `stripComments` blanked from
 *     there to end-of-line, so every token on the rest of that line left the comment-free view.
 *     Measured 2026-09-21: 1 225 such `//` in 193 files.
 *   * an MQTT topic pattern, ubiquitous in the `amos-link` crates: the literal opens with `"/*`, and
 *     the character right after that `/*` is a `/` — which is exactly what closes a block comment.
 *     So the comment never closed and `stripComments` blanked the rest of the **file** (373 709
 *     chars in `link-cli/src/lib.rs`; `appstore/src/pwa.rs` alone has 101 such sites).
 *   * `` /// a `#[cfg(test)]` helper `` — attribute prose. `stripTestRegions` read that spelling as
 *     a real attribute and deleted from inside a doc comment to the next depth-0 `}`, taking
 *     `amos-tauri/src/host_fs.rs`'s `pub fn ensure_allowed_root` with it.
 *   * a test that reads its own source: `SRC.find("#[cfg(test)]")`.
 *
 * `maskProse` blanks comment spans **including their delimiters** and string-literal **interiors**
 * (the quotes stay, so a consumer matching `"name"` still sees its quotes) and touches nothing
 * else. Offsets and newlines are preserved exactly, so a caller may walk the masked text for
 * structure and then splice the **original** with the offsets it found. `strings: false` keeps
 * literal interiors verbatim — that is what `stripComments` needs, since its callers match on
 * string contents.
 *
 * Rust's `'` is both a char literal and a lifetime: `'a` must not open a literal, or the masker
 * blanks the file after the first generic bound; `'"'` must, or the scan desyncs on it and the rest
 * of the file reads as string interior. (The first draft of this function got both wrong in
 * opposite directions, and the errors cancelled — only the corpus caught it.)
 */
export function maskProse(src, { strings = true } = {}) {
  const chars = [...src];
  const blank = (a, b) => { for (let i = Math.max(0, a); i < b && i < chars.length; i++) if (chars[i] !== "\n") chars[i] = " "; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { let j = i; while (j < src.length && src[j] !== "\n") j++; blank(i, j); i = j; continue; }
    if (c === "/" && src[i + 1] === "*") { const close = src.indexOf("*/", i + 2); const end = close === -1 ? src.length : close + 2; blank(i, end); i = end; continue; }
    if (c === "'") {
      if (src[i + 2] === "'") { blank(i + 1, i + 2); i += 3; continue; }               // 'x' / '"'
      if (src[i + 1] === "\\") { const k = src.indexOf("'", i + 2); if (k !== -1 && k - i <= 4) { blank(i + 1, k); i = k + 1; continue; } }
      i++; continue;                                                                    // a lifetime
    }
    const raw = (c === "r" && /^r#*"/.test(src.slice(i, i + 6))) || (c === "b" && /^br#*"/.test(src.slice(i, i + 7)));
    if (c === '"' || raw) {
      const q = raw ? src.indexOf('"', i) : i;
      // `r##"` has **two** hashes (`q - i - 1`), `br##"` two as well (`q - i - 2`). Getting this
      // wrong by one makes the masker hunt for a delimiter that never comes and blank to EOF.
      const hashes = raw ? q - i - (c === "b" ? 2 : 1) : -1;
      let end;
      if (raw) { const at = src.indexOf('"' + "#".repeat(hashes), q + 1); end = at === -1 ? src.length : at + 1 + hashes; }
      else { let j = i + 1; for (; j < src.length; j++) { if (src[j] === "\\") { j++; continue; } if (src[j] === '"') break; } end = j + 1; }
      if (strings) blank(q + 1, raw ? end - hashes - 1 : end - 1);
      i = end; continue;
    }
    i++;
  }
  return chars.join("");
}

/** Strip `//…` and block comments. */
/**
 * Strip block and line comments from a source file, replacing them with **whitespace**.
 *
 * The replacement string was missing — the block-comment `replace` was called with just a pattern
 * (no second argument), which substitutes the text `"undefined"`. A block comment inside a body
 * therefore became a token of its own (REQ-A555, measured 2026-09-20): in `ReportView`,
 * `assessed: string[];` sat behind a block comment and parsed as `undefined assessed: string[];`,
 * so the field after **every** such comment was dropped from the declared set — fewer fields
 * compared, i.e. a quieter gate. (In Rust the same injection turned the whole shape `opaque`.)
 * Both directions are the wrong kind: they hide a mismatch instead of reporting a false one.
 *
 * A space rather than nothing, because both languages treat a comment as whitespace — deleting it
 * outright can weld two identifiers into one token the compiler would never see.
 *
 * **The two `replace` calls were the remaining half of the same defect (REQ-A851).** They matched
 * the delimiters anywhere, including inside a string literal, so `"https://…"` lost the rest of its
 * line and a topic literal opening `"/*` lost the rest of its file — always in the *quieter* direction, since
 * blanked text can only remove findings. The scan is now the shared token-aware one; string
 * interiors are left alone because callers match on them (`invoke("name")`, `generate_handler!`).
 *
 * One extractor already knew: `tauri-command-scan.mjs`'s `parseInvokedNames` refuses to call this
 * function at all — "`stripComments` 会把 `"http://…"` 里的 `//` 当成行注释的起点…那是漏报的方向",
 * measured then as `TopbarAppleMenu.svelte`'s `wm_open` falling in the swallowed class. It traded a
 * *visible* false positive for a silent false negative at that one call site. With the stripper
 * fixed the trade is unnecessary, but the extractor is left as it is: it is now over-inclusive in a
 * way its own doc comment explains, and narrowing it would need its own measurement.
 */
export function stripComments(src) {
  return maskProse(src, { strings: false });
}

/**
 * A cfg predicate's value in the **production** view: `test` is off, every other cfg
 * (target_os, feature, …) is unknown. `T` = present without tests, `F` = absent without tests,
 * `U` = depends on something we do not model.
 *
 * `stripTestRegions` used to ask a *word* question — `/#\[cfg\([^\]]*\btest\b[^\]]*\)\]/` — which
 * answers yes for three things that are not test gates (measured 2026-09-21, 20 sites):
 *
 *   * `#[cfg(not(test))]` (9 sites in `host_fs.rs`) — **the production half**. `not(test)` is how a
 *     file spells "this is what a device runs"; the old regex stripped it, i.e. inverted polarity.
 *   * `#[cfg(any(target_os = "linux", test))]` / `any(feature = "android", test)` (8 sites) — code
 *     that ships on Linux / Android.
 *   * `#[cfg(any(test, feature = "test-helpers"))]` (3 sites) — a real feature gate.
 *
 * Anything but `F` keeps the item: a predicate we cannot evaluate must never delete code, because
 * deleting is the quiet direction.
 */
export function cfgWithoutTest(pred) {
  const toks = [];
  const re = /([A-Za-z_]\w*)\s*=\s*("[^"]*"|'[^']*')|([A-Za-z_]\w*)|(\()|(\))|,/g;
  let m;
  while ((m = re.exec(pred))) toks.push(m[1] ? { k: "kv" } : m[3] ? { k: "id", name: m[3] } : m[4] ? { k: "(" } : m[5] ? { k: ")" } : { k: "," });
  let i = 0;
  const not3 = (v) => (v === "T" ? "F" : v === "F" ? "T" : "U");
  function prim() {
    const t = toks[i];
    if (!t) return "U";
    if (t.k === "(") { i++; const v = prim(); if (toks[i]?.k === ")") i++; return v; }
    if (t.k === "kv") { i++; return "U"; }
    if (t.k === "id") {
      i++;
      const name = t.name;
      if (!["all", "any", "not"].includes(name) || toks[i]?.k !== "(") return name === "test" ? "F" : "U";
      i++;
      const vals = [];
      for (;;) { vals.push(prim()); if (toks[i]?.k === ",") { i++; continue; } break; }
      while (toks[i] && toks[i].k !== ")") i++;
      if (toks[i]?.k === ")") i++;
      if (name === "not") return not3(vals[0]);
      if (name === "all") return vals.includes("F") ? "F" : vals.every((v) => v === "T") ? "T" : "U";
      return vals.includes("T") ? "T" : vals.every((v) => v === "F") ? "F" : "U";
    }
    i++; return "U";
  }
  return prim();
}

/**
 * The item-level attributes that mean "this item exists only under the test harness": `#[test]` and
 * its path-qualified forms (`#[tokio::test]`). `#[cfg(…)]` is handled separately, by predicate.
 *
 * A test item **outside** a `#[cfg(test)] mod` is normal Rust and the corpus has it: after
 * `amos-link-cli/src/lib.rs`'s test module closes at line 4797, a `#[test] fn` sits at the file's
 * top level (line 4800). The old stripper removed it only by accident — its walk ran to EOF there —
 * so a rule that models `#[cfg(test)]` and stops leaves it behind: 3 `src/` files, 23 items
 * (`webman_download_tests.rs` accounts for 21).
 *
 * The set is `test` bare or path-qualified because that is what the corpus uses: measured
 * 2026-09-21, `tokio::test` 672 and `#[test]` in the hundreds, while `async_std::test`, `rstest`,
 * `test_case`, `proptest` and `quickcheck` are all **0**. `serial_test`'s `#[serial]` (29) always
 * travels with a `#[test]`, so it needs no case of its own. A new harness becomes a one-line
 * addition here — with its own measurement, not a guess.
 */
const TEST_HARNESS_ATTR = /^#\[(?:[A-Za-z_]\w*::)*test\b/;

/**
 * The first test-gating attribute in a **masked** source: a `#[cfg(…)]` whose predicate is `F`
 * without `test`, or a test-harness attribute. Bracket-depth scan rather than a regex, so nesting
 * (`all(any(…), not(…))`, `#[tokio::test(flavor = "multi_thread")]`) is not a limit.
 */
function findTestGate(masked) {
  for (let i = 0; i + 2 < masked.length; i++) {
    if (masked[i] !== "#" || masked[i + 1] !== "[") continue;
    let depth = 0, j = i + 1, end = -1;
    for (; j < masked.length; j++) {
      const c = masked[j];
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) return null;
    const attr = masked.slice(i, end + 1);
    if (TEST_HARNESS_ATTR.test(attr)) return { index: i, len: end + 1 - i };
    if (attr.startsWith("#[cfg(")) {
      const close = attr.lastIndexOf(")");
      if (cfgWithoutTest(masked.slice(i + 6, i + close)) === "F") return { index: i, len: end + 1 - i };
    }
  }
  return null;
}

export function matchBracket(src, open, lifetimes = false) {
  const pairs = { "(": ")", "{": "}", "[": "]", "<": ">" };
  const close = pairs[src[open]];
  if (!close) return -1;
  const opener = src[open];
  let depth = 0;
  let quote = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "`") quote = c;
    else if (c === "'") {
      const isLifetime = lifetimes && /[A-Za-z_]/.test(src[i + 1] ?? "") && src[i + 2] !== "'";
      if (!isLifetime) quote = "'";
    } else if (c === opener) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split `a, b` (or `a; b` in a TS interface) on top-level separators. */
export function splitTopLevel(src) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of src) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if ((ch === "," || ch === ";") && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * serde keys on a **field or variant** that do not change its wire name (REQ-A555).
 *
 * `skip_serializing_if` and `default` only mean the field *may be absent* — which a TS type that
 * declares it already tolerates, and a TS type that omits it is fine too (Rust fields the shell
 * never reads are informational). So these stay ordinary fields rather than poisoning the shape.
 */
const SERDE_NAME_NEUTRAL = new Set([
  "default",
  "skip_serializing_if",
  "skip_deserializing",
  "alias",
  "borrow",
  "bound",
  "getter",
  "deserialize_with",
  "crate",
  "other",
]);

/** serde keys meaning the item is **never** on the wire (so it is not part of the reply). */
const SERDE_DROP_KEYS = new Set(["skip", "skip_serializing"]);

/**
 * Split one field/variant part into its **leading attributes** and the declaration itself.
 *
 * `null` when an attribute is unbalanced — the caller fails closed. Attributes are matched with
 * `matchBracket`, so a `]` inside a string literal cannot end one early.
 */
export function splitAttrs(part) {
  const attrs = [];
  let i = 0;
  for (;;) {
    while (i < part.length && /\s/.test(part[i])) i += 1;
    if (part[i] !== "#" || part[i + 1] !== "[") break;
    const close = matchBracket(part, i + 1);
    if (close < 0) return null;
    attrs.push(part.slice(i, close + 1));
    i = close + 1;
  }
  return { attrs, decl: part.slice(i) };
}

/**
 * Interpret the leading attributes of a **field or variant** (REQ-A555).
 *
 * Why this exists: `#[serde(rename = "type")] pub kind: …` used to make the whole struct (or enum)
 * `opaque`, because the field-declaration regex could not match a part that starts with `#`. That
 * one blind spot took **17** shapes out of the wire audit on 2026-09-20 — `AppManifest`,
 * `CareReport`, `SensorHostSnapshot`, `FsRead`, `NfcWriteResult`, `AppStatus`,
 * `BundleImportResult`, `WindowState`, … all perfectly readable shapes, none of them compared.
 *
 * The rules are the repo's usual fail-closed ones:
 *   * `rename = "X"` — the **serialized** name (a field's or a variant's; both are wire strings).
 *     A rename we cannot read as a string literal ⇒ opaque, never guessed;
 *   * `skip` / `skip_serializing` ⇒ the item is not on the wire ⇒ `drop`;
 *   * the neutral keys above ⇒ no effect;
 *   * `flatten` / `with` / `serialize_with` / `into` / `untagged` / `transparent`, and **any key
 *     this reader does not model** ⇒ `opaque`;
 *   * a non-serde attribute (`#[cfg(…)]`, `#[allow(…)]`, `#[doc = …]`) is not about serde at all.
 */
export function readItemAttrs(attrs) {
  const out = { rename: "", drop: false, opaque: false };
  for (const attr of attrs) {
    const m = /^#\[\s*serde\s*\(([\s\S]*)\)\s*\]$/.exec(attr.trim());
    if (!m) continue;
    for (const item of splitTopLevel(m[1])) {
      const key = item.split("=")[0].trim();
      if (key === "") continue;
      if (key === "rename") {
        const v = /^rename\s*=\s*"([^"]*)"/.exec(item.trim());
        if (v) out.rename = v[1];
        else out.opaque = true;
        continue;
      }
      if (SERDE_DROP_KEYS.has(key)) {
        out.drop = true;
        continue;
      }
      if (SERDE_NAME_NEUTRAL.has(key)) continue;
      out.opaque = true;
    }
  }
  return out;
}

/**
 * One field declaration → `{ name, rename, drop, opaque }` (`name` is the Rust spelling).
 *
 * Shared by struct bodies and tagged-variant bodies, which differ only in the rename *rule* they
 * apply afterwards (`rename_all` vs `rename_all_fields`).
 */
export function readFieldPart(part) {
  const split = splitAttrs(part);
  if (split === null) return { name: "", rename: "", drop: false, opaque: true };
  const a = readItemAttrs(split.attrs);
  if (a.opaque) return { name: "", rename: "", drop: false, opaque: true };
  const fm = /^\s*(?:pub(?:\([^)]*\))?\s+)?([a-z_]\w*)\s*:/.exec(split.decl);
  if (!fm) {
    // A part that is not a field declaration and yet talks about fields (`x: T` with an
    // unmodelled form) is unreadable, not empty.
    const looksLikeField = split.decl.trim() !== "" && split.decl.includes(":");
    return { name: "", rename: "", drop: a.drop, opaque: looksLikeField };
  }
  return { name: fm[1], rename: a.rename, drop: a.drop, opaque: false };
}

/**
 * Rust structs/enums with their **serialized** field names:
 * `Map<name, { fields: string[], opaque: boolean }>`. `opaque` marks a type whose
 * field set we cannot trust (`#[serde(flatten)]`, a `skip_serializing*` on the **container**,
 * custom `Serialize`, `serde_json::Value`) — those are never compared.
 */
export function parseRustShapes(src) {
  const clean = stripComments(src);
  const out = new Map();
  const re = /#\[derive\([^)]*Serialize[^)]*\)\]\s*((?:#\[[^\]]*\]\s*)*)pub\s+(struct|enum)\s+([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(clean))) {
    const attrs = m[1];
    const kind = m[2];
    const name = m[3];
    // The declaration's **own** body — not "the next `{` in the file" (REQ-A558). A
    // `pub struct SubscriptionId(pub u64);` used to pick up whatever braced item followed it,
    // which invented a field list out of an **unrelated type** (`Subscriber`'s) and turned a
    // correct `invoke<number>("clipboard_subscribe")` into a failure. Measured 2026-09-20.
    let p = re.lastIndex;
    while (/\s/.test(clean[p] ?? "")) p += 1;
    if (clean[p] === "<") {
      const g = matchBracket(clean, p);
      if (g < 0) continue;
      p = g + 1;
      while (/\s/.test(clean[p] ?? "")) p += 1;
    }
    let tupleTypes = null;
    if (clean[p] === "(") {
      const tp = matchBracket(clean, p);
      if (tp < 0) continue;
      tupleTypes = splitTopLevel(clean.slice(p + 1, tp))
        .map((s) => s.trim().replace(/^pub(?:\([^)]*\))?\s+/, ""))
        .filter(Boolean);
      p = tp + 1;
      while (/\s/.test(clean[p] ?? "")) p += 1;
      if (clean[p] !== ";") continue; // a tuple struct ends right there
      // A **tuple struct**'s wire shape is its inner type's, not an object (REQ-A558):
      // `pub struct SubscriptionId(pub u64);` serializes as a bare number, and a fieldless or
      // multi-field tuple as an array this resolver does not model. `resolveRustType` follows it.
      out.set(name, {
        fields: [],
        opaque: false,
        tag: "",
        wireTags: [],
        enum: false,
        variants: [],
        untagged: false,
        tuple: tupleTypes,
      });
      continue;
    } else if (clean[p] !== "{") {
      continue; // a unit struct (`struct X;`) — nothing to model
    }
    const brace = p;
    const close = matchBracket(clean, brace);
    if (close < 0) continue;
    const body = clean.slice(brace + 1, close);
    const renameAll = /rename_all\s*=\s*"([A-Za-z_]+)"/.exec(attrs)?.[1] ?? "";
    // **Internally tagged** enums (`#[serde(tag = "kind")]`) do not use serde's default
    // external tagging at all: the tag becomes a field of the payload and each variant's
    // own fields sit beside it. Without this, a consumer that declares `{ kind, reason }`
    // — which is exactly what the wire carries — is reported as declaring a field "absent
    // from the reply" (REQ-A387: `push_notifications.rs::PushResult` +
    // `pushNotifications.ts::PushResult`; measured 2 false positives).
    const tagName = /(?:^|[(,])\s*tag\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ?? "";
    const renameAllFields = /rename_all_fields\s*=\s*"([A-Za-z_]+)"/.exec(attrs)?.[1] ?? "";
    /**
     * `#[serde(untagged)]` on an enum (REQ-A558): the wire carries **one of the variants' own
     * field sets**, with no discriminant at all. That is a modelled shape rather than an opaque
     * one — `variants` records each variant's field list, which is what a TS union of object
     * literals is checked against (each member must fit exactly one variant, because the payload IS
     * one variant). Only struct variants qualify: a unit variant is not serializable by serde and a
     * tuple variant's payload is its inner value, so both fail closed.
     */
    const untagged = kind === "enum" && /(?:^|[(,])\s*untagged|^untagged/.test(attrs);
    // Container-level attributes only (REQ-A555). A field's own `#[serde(…)]` is read by
    // `readFieldPart` below — testing `attrs + body` here is what made any attributed field
    // poison its whole shape.
    let opaque = /flatten|untagged|transparent|skip_serializing|serde\(into|with\s*=|serialize_with/.test(
      attrs,
    );
    // …except an `untagged` **enum**, which the branch below reads properly (REQ-A558). A
    // container-level `flatten`/`with`/`into` on that same enum still means opaque.
    if (untagged) {
      opaque = /flatten|transparent|skip_serializing|serde\(into|with\s*=|serialize_with/.test(attrs);
    }
    const fields = [];
    /** Wire tag values of a `#[serde(tag = "…")]` enum's variants (`variantTag`). */
    const wireTags = [];
    /** Per-variant field lists of an `#[serde(untagged)]` enum (REQ-A558). */
    const variants = [];
    const renameOf = (field) => {
      if (!renameAll) return field;
      if (renameAll === "camelCase") {
        return field.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      }
      return field; // snake_case / lowercase: the Rust spelling
    };
    const renameFieldOf = (field) => {
      if (renameAllFields !== "camelCase") return field;
      return field.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    };
    if (kind === "struct") {
      for (const part of splitTopLevel(body)) {
        if (part.trim() === "") continue;
        const f = readFieldPart(part);
        if (f.opaque) {
          opaque = true;
          continue;
        }
        if (f.name === "" || f.drop) continue;
        fields.push(f.rename || renameOf(f.name));
      }
    } else if (untagged) {
      // `#[serde(untagged)]` (REQ-A558): the payload is **one variant's own fields**, so `variants`
      // is the shape a TS union of object literals is compared against (member ⊆ exactly one
      // variant). `fields` stays the union of every variant's fields, which is what a plain TS
      // object type is compared against.
      for (const part of splitTopLevel(body)) {
        if (part.trim() === "") continue;
        const split = splitAttrs(part);
        const a = split === null ? { rename: "", drop: false, opaque: true } : readItemAttrs(split.attrs);
        const decl = split === null ? "" : split.decl;
        if (a.opaque) {
          opaque = true;
          continue;
        }
        const vm = /^\s*([A-Z]\w*)\s*([({]?)/.exec(decl);
        if (!vm) {
          if (decl.trim() !== "") opaque = true;
          continue;
        }
        if (vm[2] !== "{") {
          // A unit variant is not serializable by serde and a tuple variant's payload is its inner
          // value — neither is an object this scan can claim to know.
          opaque = true;
          continue;
        }
        const open = decl.indexOf("{");
        const close = decl.lastIndexOf("}");
        if (open < 0 || close < open) {
          opaque = true;
          continue;
        }
        const variantFields = [];
        for (const inner of splitTopLevel(decl.slice(open + 1, close))) {
          if (inner.trim() === "") continue;
          const f = readFieldPart(inner);
          if (f.opaque) {
            opaque = true;
            continue;
          }
          if (f.name === "" || f.drop) continue;
          const named = f.rename || renameFieldOf(f.name);
          variantFields.push(named);
          if (!fields.includes(named)) fields.push(named);
        }
        variants.push(variantFields);
      }
    } else if (tagName) {
      // Tagged enum: `{"<tag>": "<variant>", <this variant's fields…>}` per variant, so the
      // union of what the wire can carry is the tag plus every variant's own field names.
      // `wireTags` records the **tag value** of each variant, which is what a TS union alias
      // declares and must match (REQ-A467).
      fields.push(tagName);
      for (const part of splitTopLevel(body)) {
        if (part.trim() === "") continue;
        const split = splitAttrs(part);
        const a = split === null ? { rename: "", drop: false, opaque: true } : readItemAttrs(split.attrs);
        const decl = split === null ? "" : split.decl;
        if (a.opaque) {
          opaque = true;
          continue;
        }
        const vm = /^\s*([A-Z]\w*)\s*([({]?)/.exec(decl);
        if (!vm) {
          if (decl.trim() !== "") opaque = true;
          continue;
        }
        if (vm[2] === "(") {
          // A tagged newtype/tuple variant is not representable on the wire (serde rejects
          // it at runtime) — do not guess a field name **or a tag** for it.
          opaque = true;
          continue;
        }
        // A variant's own `#[serde(rename = "…")]` **is** the wire tag (REQ-A555) — the same
        // rule `variantTag` applies to `rename_all`, one level more explicit.
        if (!a.drop) wireTags.push(a.rename || variantTag(vm[1], renameAll));
        if (vm[2] !== "{") continue; // unit variant: the tag is the whole payload
        const open = decl.indexOf("{");
        const close = decl.lastIndexOf("}");
        if (open < 0 || close < open) {
          opaque = true;
          continue;
        }
        for (const inner of splitTopLevel(decl.slice(open + 1, close))) {
          if (inner.trim() === "") continue;
          const f = readFieldPart(inner);
          if (f.opaque) {
            opaque = true;
            continue;
          }
          if (f.name === "" || f.drop) continue;
          const renamed = f.rename || renameFieldOf(f.name);
          if (!fields.includes(renamed)) fields.push(renamed);
        }
      }
    } else {
      // Enum variants: serde's default external tagging serializes a unit variant as
      // a bare string and a struct/tuple variant as `{"Variant": …}`.
      //
      // The names recorded here are the **wire** names, not the Rust spellings (REQ-A558): serde
      // applies `rename_all` (and a variant's own `rename`) to variant names too, so a shape that
      // said `Home` for a `rename_all = "lowercase"` enum would make a TS type declaring the real
      // `"home"` look wrong — and a TS type declaring `Home` look right. `wireTags` gets the same
      // list, which is what a TS string-literal union is compared against.
      for (const part of splitTopLevel(body)) {
        if (part.trim() === "") continue;
        const split = splitAttrs(part);
        const a = split === null ? { rename: "", drop: false, opaque: true } : readItemAttrs(split.attrs);
        const decl = split === null ? "" : split.decl;
        if (a.opaque) {
          opaque = true;
          continue;
        }
        const vm = /^\s*([A-Z]\w*)\s*[({]?/.exec(decl);
        if (vm) {
          if (a.drop) continue;
          const wire = a.rename || variantTag(vm[1], renameAll);
          fields.push(wire);
          wireTags.push(wire);
        } else if (decl.trim() !== "") opaque = true;
      }
    }
    out.set(name, {
        fields,
        opaque,
        tag: tagName,
        wireTags,
        enum: kind === "enum",
        variants,
        untagged,
      });
  }
  return out;
}

/**
 * Rust command return types: `Map<command, typeText>` (`Result<T, E>` unwrapped).
 */
export function parseReturns(src) {
  const clean = stripComments(src);
  const out = new Map();
  const re = /#\[tauri::command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const name = m[1];
    const open = re.lastIndex - 1;
    const close = matchBracket(clean, open, true);
    if (close < 0) continue;
    const arrow = clean.slice(close + 1).match(/^\s*->\s*([^{]+?)\s*\{/);
    out.set(name, arrow ? arrow[1].trim() : "()");
  }
  return out;
}



/**
 * TS object shapes: `Map<name, string[] fields>` for both `interface X { … }` and
 * `type X = { … }` (camelCase or snake_case as written — the point is to compare
 * them with the wire). A union/mapped/generic alias is not an object shape and is
 * left out here.
 *
 * The union case now has its own reader — `parseTsTaggedUnions` — so a
 * `type X = | { kind: "a" } | …` alias is compared by its **discriminants** instead of
 * being dropped (REQ-A469 closing the skip REQ-A467 measured). What is left outside both
 * readers (an *inline* union, a single-member object alias here, a union whose tag is not a
 * string literal) is listed in the header's "Still out of scope" paragraph.
 */
export function parseTsInterfaces(src) {
  const clean = stripComments(src);
  const out = new Map();
  const re = /(?:export\s+)?(?:interface\s+([A-Za-z_]\w*)\s*|type\s+([A-Za-z_]\w*)\s*=\s*)\{/g;
  let m;
  while ((m = re.exec(clean))) {
    const name = m[1] ?? m[2];
    const close = matchBracket(clean, re.lastIndex - 1);
    if (close < 0) continue;
    const fields = [];
    for (const part of splitTopLevel(clean.slice(re.lastIndex, close))) {
      const fm = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(part);
      if (fm) fields.push(fm[1]);
    }
    out.set(name, fields);
    re.lastIndex = close;
  }
  return out;
}

/**
 * A Rust enum **variant** name under a `#[serde(rename_all = "…")]` rule — the string the wire
 * actually carries (`TurnDone` → `"turn_done"`, `PermissionDenied` + `lowercase` →
 * `"permissiondenied"`).
 *
 * This is deliberately *not* the field renamer above: serde applies `rename_all` to variant names
 * too, and for `snake_case`/`lowercase` the field renamer returns the Rust spelling unchanged —
 * which is exactly how `AirPlayResult` came to declare `permission_denied` while the wire carried
 * `"permissiondenied"` (REQ-A467). Unknown/absent rules mean serde's default: the name as written.
 */
export function variantTag(name, renameAll) {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  switch (renameAll) {
    case "lowercase":
      return name.toLowerCase();
    case "UPPERCASE":
      return name.toUpperCase();
    case "camelCase":
      return name.charAt(0).toLowerCase() + name.slice(1);
    case "PascalCase":
      return name;
    case "snake_case":
      return snake.toLowerCase();
    case "SCREAMING_SNAKE_CASE":
      return snake.toUpperCase();
    case "kebab-case":
      return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    case "SCREAMING-KEBAB-CASE":
      return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toUpperCase();
    default:
      return name;
  }
}

/**
 * TS **tagged union aliases**: `Map<typeName, { tag, tags }>` for
 * `type X = | { kind: "a"; … } | { kind: "b" } | …;`.
 *
 * Only flat unions of object literals, each carrying one **string-literal** tag field, are read;
 * the same tag field on every member. Anything else (inline unions in a property, `interface`
 * members with a `kind` field, a union that mixes shapes, a template-literal tag, an enum member)
 * is left out — unverifiable rather than guessed. The tag's *value* is what a serde internally
 * tagged enum puts on the wire, so this is what makes `compareReply` able to check it.
 */
export function parseTsTaggedUnions(src) {
  const clean = stripComments(src);
  const out = new Map();
  const re = /(?:export\s+)?type\s+([A-Za-z_]\w*)\s*=\s*/g;
  let m;
  while ((m = re.exec(clean))) {
    const name = m[1];
    const start = re.lastIndex;

    // The alias body ends at the first top-level `;`.
    let depth = 0;
    let end = -1;
    for (let i = start; i < clean.length; i += 1) {
      const ch = clean[i];
      if (ch === "{" || ch === "(" || ch === "[") depth += 1;
      else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
      else if (ch === ";" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    re.lastIndex = end;

    // Walk the body: object literals separated by `|`/whitespace. Anything else ⇒ not a flat union.
    const members = [];
    let ok = true;
    for (let i = start; i < end; i += 1) {
      const c = clean[i];
      if (c === "{") {
        const close = matchBracket(clean, i);
        if (close < 0 || close > end) {
          ok = false;
          break;
        }
        members.push(clean.slice(i, close + 1));
        i = close;
        continue;
      }
      if (/[\s|,;]/.test(c)) continue;
      ok = false;
      break;
    }
    if (!ok || members.length < 2) continue; // a *union*: one member is an object alias (see parseTsInterfaces)

    const tags = [];
    let tag = "";
    for (const member of members) {
      // Either quote style: this codebase writes both (`kind: 'ok'` in `airplay.ts`,
      // `kind: "text"` in `clipboard.ts`), and the i18n scanner learned the same lesson.
      const lm = /^\{\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*(["'])([A-Za-z0-9_.-]*)\2/.exec(
        member,
      );
      if (!lm) {
        ok = false;
        break;
      }
      if (tag !== "" && tag !== lm[1]) {
        ok = false; // a union whose members use different tag fields is not comparable
        break;
      }
      tag = lm[1];
      tags.push(lm[3]);
    }
    if (ok && tag !== "" && tags.length > 0) out.set(name, { tag, tags });
  }
  return out;
}

/**
 * Walk a `type X = …` alias body: `[{ objects: ["{…}", …], literals: ["a", …], ok }]`.
 *
 * A body qualifies only when it is a flat union — object literals, string literals and `|`/`,`/
 * whitespace, nothing else. A nested-generic member, a mapped type, a call, an unreadable string
 * ⇒ `ok: false` (the caller then records nothing rather than guessing). Shared by the three union
 * readers so "what counts as a union member" has one owner.
 */
export function walkUnionBody(body) {
  const objects = [];
  const literals = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "{") {
      const close = matchBracket(body, i);
      if (close < 0) return { ok: false, objects: [], literals: [] };
      objects.push(body.slice(i, close + 1));
      i = close;
      continue;
    }
    if (c === '"' || c === "'") {
      const lm = /^(["'])([A-Za-z0-9_.-]*)\1/.exec(body.slice(i));
      if (!lm) return { ok: false, objects: [], literals: [] };
      literals.push(lm[2]);
      i += lm[0].length - 1;
      continue;
    }
    if (/[\s|,;]/.test(c)) continue;
    return { ok: false, objects: [], literals: [] };
  }
  return { ok: true, objects, literals };
}

/** The `type X = …` aliases of a source, as `{ name, body }` pairs (body ends at a top-level `;`). */
function aliasBodies(clean) {
  const out = [];
  const re = /(?:export\s+)?type\s+([A-Za-z_]\w*)\s*=\s*/g;
  let m;
  while ((m = re.exec(clean))) {
    const start = re.lastIndex;
    let depth = 0;
    let end = -1;
    for (let i = start; i < clean.length; i += 1) {
      const ch = clean[i];
      if (ch === "{" || ch === "(" || ch === "[") depth += 1;
      else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
      else if (ch === ";" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    re.lastIndex = end;
    out.push({ name: m[1], body: clean.slice(start, end) });
  }
  return out;
}

/** The top-level field names of one `{ … }` literal. */
function objectFields(literal) {
  const close = matchBracket(literal, 0);
  if (close < 0) return null;
  const fields = [];
  for (const part of splitTopLevel(literal.slice(1, close))) {
    if (part.trim() === "") continue;
    const fm = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(part);
    if (!fm) return null; // an index signature / a method / anything we do not model
    fields.push(fm[1]);
  }
  return fields;
}

/**
 * TS unions of **object literals**: `Map<name, { members: string[][] }>` where each member is its
 * declared field names.
 *
 * This is the shape a Kotlin/Java bridge reply takes when one command answers "ok with a value" or
 * "not ok with a reason" — `type BleReadResult = { ok: true; bytes: number[] } | { ok: false;
 * error: string }` against Rust's **one** flat `BleReadResult { ok, bytes, error }` (REQ-A558).
 * The judgement is a **subset** rule per member (every field a member declares must exist on the
 * wire): a member that reads a field the host never sends is exactly the defect this gate is for,
 * while omitting a field is the normal narrowing a union member does. A member we cannot read
 * (index signature, method, spread) disqualifies the whole alias.
 *
 * A union whose members share a **string-literal** tag is `parseTsTaggedUnions`' business instead —
 * that comparison is stricter (it checks the discriminant literals), so it must win where it
 * applies. This reader deliberately records such aliases too; `resolveTsType` gives the tagged
 * reading precedence.
 */
export function parseTsObjectUnions(src) {
  const clean = stripComments(src);
  const out = new Map();
  for (const { name, body } of aliasBodies(clean)) {
    const { ok, objects, literals } = walkUnionBody(body);
    if (!ok || literals.length > 0 || objects.length < 2) continue;
    const members = [];
    for (const o of objects) {
      const fields = objectFields(o);
      if (fields === null) {
        members.length = 0;
        break;
      }
      members.push(fields);
    }
    if (members.length >= 2) out.set(name, { members });
  }
  return out;
}

/**
 * TS **discriminant-literal** unions: `Map<name, string[]>` of the literals a union declares.
 *
 * Two forms, both of them serde's **external** tagging on the wire:
 *   * a plain string-literal union — `type RustPermissionStatus = "notdetermined" | "denied" | …`
 *     for `#[serde(rename_all = "lowercase")] enum PermissionStatus`;
 *   * a mix of string literals and **single-key** object literals, where the key *is* the
 *     discriminant — `type AppStatus = "Available" | { installed: { version: string } } | …` for
 *     `enum AppStatus { Available, #[serde(rename = "installed")] Installed { version } }`.
 *
 * Only aliases where **every** object member has exactly one key are read (a multi-key member is
 * not a discriminant), and only string literals are collected (a numeric or boolean discriminant
 * is a different comparison, which this scan does not model). This is the REQ-A467 class: a
 * literal the wire can never send is a branch that can never run.
 */
export function parseTsLiteralUnions(src) {
  const clean = stripComments(src);
  const out = new Map();
  for (const { name, body } of aliasBodies(clean)) {
    const { ok, objects, literals } = walkUnionBody(body);
    if (!ok || literals.length === 0) continue;
    const keys = [];
    let usable = true;
    for (const o of objects) {
      const fields = objectFields(o);
      if (fields === null || fields.length !== 1) {
        usable = false;
        break;
      }
      keys.push(fields[0]);
    }
    if (!usable) continue;
    const all = [...literals, ...keys];
    if (all.length >= 2) out.set(name, all);
  }
  return out;
}

/**
 * The `{ X, type Y as Z }` specifiers of one `import`/`export … from` clause.
 *
 * A specifier we cannot read as a plain identifier (a namespace, a default import, anything
 * exotic) is **dropped**, never guessed.
 */
function importSpecifiers(text) {
  const out = [];
  for (const raw of text.split(",")) {
    const s = raw.trim().replace(/^type\s+/, "");
    if (s === "") continue;
    const [imported, local] = s.split(/\s+as\s+/).map((x) => x.trim());
    if (/^[A-Za-z_$][\w$]*$/.test(imported) && /^[A-Za-z_$][\w$]*$/.test(local ?? imported)) {
      out.push({ imported, local: local ?? imported });
    }
  }
  return out;
}

/**
 * A FE module's links to other modules: what it **imports** and what it **re-exports**.
 *
 * `import * as ns` and a default import are not read (a namespace member's type name is not the
 * local name the invoke generic would spell), and `export * from` is not followed either — both
 * stay unresolved, which the scan reports as unverifiable rather than guessing.
 */
export function parseTsImportScope(src) {
  const clean = stripComments(src);
  const imports = [];
  const reexports = [];
  let m;
  const impRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  while ((m = impRe.exec(clean))) imports.push({ names: importSpecifiers(m[1]), spec: m[2] });
  const reRe = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  while ((m = reRe.exec(clean))) reexports.push({ names: importSpecifiers(m[1]), spec: m[2] });
  return { imports, reexports };
}

/**
 * The TS type tables a file's `invoke<T>` generics can name: its **own** declarations plus the
 * ones it imports from other modules of this tree (REQ-A555).
 *
 * Why: the tables used to be per file, so `invoke<WmWindowsSnapshot>("wm_open")` in
 * `lib/shortcuts.ts` — a type declared in `lib/wm.ts` — was reported unverifiable even though both
 * sides were fully readable. That is the same blind spot REQ-A532 closed on the Rust side (a reply
 * shape declared in another crate), and it gets the same guards:
 *
 *   * the file's **own** declaration of a name wins (a local shadow is the local meaning);
 *   * only **relative** specifiers are followed, and only into files this scan has parsed — a
 *     package import is not our source;
 *   * `export … from` chains are followed too (`lib/lmk.ts` re-exports `wm`'s types, and a caller
 *     importing from there must still resolve them), depth-limited so a cycle cannot spin;
 *   * a name the target module does not actually declare contributes nothing.
 */
export function tsScopeFor(file, cache, depth = 0) {
  const mod = cache.get(file);
  if (!mod) return { interfaces: new Map(), unions: new Map(), objectUnions: new Map(), literalUnions: new Map() };
  if (mod.scope) return mod.scope;
  const interfaces = new Map(mod.interfaces);
  const unions = new Map(mod.unions);
  const objectUnions = new Map(mod.objectUnions);
  const literalUnions = new Map(mod.literalUnions);
  if (depth < 4) {
    for (const link of [...mod.imports, ...mod.reexports]) {
      if (!link.spec.startsWith(".")) continue;
      const target = resolveModule(link.spec, dirname(file), cache);
      if (!target) continue;
      const t = tsScopeFor(target, cache, depth + 1);
      for (const { imported, local } of link.names) {
        if (interfaces.has(local) || unions.has(local) || objectUnions.has(local) || literalUnions.has(local)) {
          continue; // the local declaration wins
        }
        if (t.interfaces.has(imported)) interfaces.set(local, t.interfaces.get(imported));
        else if (t.unions.has(imported)) unions.set(local, t.unions.get(imported));
        else if (t.objectUnions.has(imported)) objectUnions.set(local, t.objectUnions.get(imported));
        else if (t.literalUnions.has(imported)) literalUnions.set(local, t.literalUnions.get(imported));
      }
    }
  }
  mod.scope = { interfaces, unions, objectUnions, literalUnions };
  return mod.scope;
}

/** A relative specifier → the parsed file it points at, or `null` (never a guess). */
export function resolveModule(spec, dir, cache) {
  const base = join(dir, spec);
  for (const cand of [`${base}.ts`, `${base}.svelte`, join(base, "index.ts")]) {
    if (cache.has(cand)) return cand;
  }
  return null;
}

/**
 * `invoke<T>("cmd")` call sites: `[{ typeText, command }]` (T may be inline). */
export function parseInvokeGenerics(src) {
  const clean = stripComments(src);
  const out = [];
  const re = /\binvoke\s*</g;
  let m;
  while ((m = re.exec(clean))) {
    const open = re.lastIndex - 1;
    const close = matchBracket(clean, open);
    if (close < 0) continue;
    const typeText = clean.slice(open + 1, close).trim();
    // **Either quote style**: this codebase writes both, and requiring `"` made every typed
    // invoke in `lib/airplay.ts` (9 of them, the whole AirPlay reply surface) invisible to this
    // scan — which is how `AirPlayResult`'s discriminant mismatch survived (REQ-A467).
    const after = clean.slice(close + 1).match(/^\s*\(\s*(["'])([a-z0-9_]+)\1/);
    if (after) out.push({ typeText, command: after[2] });
    re.lastIndex = close;
  }
  return out;
}

const SCALAR = {
  bool: "boolean",
  String: "string",
  "&str": "string",
  str: "string",
  i8: "number",
  i16: "number",
  i32: "number",
  i64: "number",
  isize: "number",
  u8: "number",
  u16: "number",
  u32: "number",
  u64: "number",
  usize: "number",
  f32: "number",
  f64: "number",
  "()": "null",
};

/** Peek past `Result<…>`/`Option<…>`: returns the inner text, or null. */
export function unwrapGeneric(typeText, name) {
  const t = typeText.trim();
  if (!t.startsWith(name + "<")) return null;
  const close = matchBracket(t, name.length);
  if (close < 0) return null;
  const inner = t.slice(name.length + 1, close);
  return t.slice(close + 1).trim() === "" ? inner : null;
}

/**
 * Resolve a Rust type to `{ kind, inner?, shape? }` where `kind` is
 * `boolean | number | string | array | null | object | unknown`.
 */
/** Standard-library generics this resolver already models — a user alias must never shadow them. */
const STD_GENERICS = new Set([
  "Result",
  "Option",
  "Vec",
  "Box",
  "Cow",
  "Pin",
  "HashMap",
  "HashSet",
  "BTreeMap",
  "Rc",
  "Arc",
]);

/**
 * Rust **type aliases** declared in the source (`type AmosResult<T> = Result<T, AmosError>;`).
 *
 * REQ-A532: the command surface returns the repo's own aliases — `AmosResult<T>` for the
 * `amos-tauri` commands and `AppStoreResult<T>` for the store's. Without this table every such
 * reply resolved to `unknown`, so the pair was reported as unverifiable even though both sides
 * were plain types (measured 2026-09-19: 11 of the 75 skips were exactly this).
 */
export function parseRustAliases(src) {
  const clean = stripComments(src);
  const out = new Map();
  const re = /\btype\s+([A-Za-z_]\w*)\s*(?:<([^>]*)>)?\s*=\s*([^;]+);/g;
  for (const m of clean.matchAll(re)) {
    // **Never** expand a standard-library name: a crate that writes its own
    // `type Result<T> = std::result::Result<T, Error>;` would otherwise hijack every plain
    // `Result<…>` reply in the scan (measured: `checked` fell 141 → 23 when that alias was honoured,
    // because `Result<WmSnapshot, String>` expanded to `std::result::Result<…>`, which this resolver
    // does not model).
    if (STD_GENERICS.has(m[1])) continue;
    const params = (m[2] ?? "")
      .split(",")
      .map((p) => p.split(":")[0].trim()) // drop bounds (`<T: Clone>`)
      .filter((p) => /^[A-Za-z_]\w*$/.test(p));
    out.set(m[1], { params, target: m[3].trim() });
  }
  return out;
}

/**
 * Which shapes from the rest of the workspace may be used (REQ-A532).
 *
 * Pure, so the selftest can pin both guards: the tauri crate's own declaration of a name **wins**, and
 * a name declared more than once elsewhere is dropped (the wire's meaning cannot be guessed). The
 * first version added every workspace shape and dropped `checked` from 141 to 23.
 */
export function selectCrossCrateShapes(localShapes, workspaceShapes, workspaceCounts) {
  const out = new Map();
  for (const [name, shape] of workspaceShapes) {
    if (localShapes.has(name)) continue;
    if ((workspaceCounts.get(name) ?? 0) !== 1) continue;
    out.set(name, shape);
  }
  return out;
}

/** Resolve a Rust type text to `{ kind, shape? }`; `null` kind = the unit type `()`. */
export function resolveRustType(typeText, shapes, aliases = new Map(), depth = 0) {
  let t = typeText.trim();
  // A **local alias** is expanded first (REQ-A532): `AmosResult<T>` → `Result<T, AmosError>`.
  // Depth-limited so a self-referential alias cannot spin.
  const head = /^([A-Za-z_]\w*)\s*(?:<([\s\S]*)>)?$/.exec(t);
  if (head && aliases.has(head[1]) && depth < 8) {
    const { params, target } = aliases.get(head[1]);
    const args = head[2] === undefined ? [] : splitTopLevel(head[2]);
    let expanded = target;
    params.forEach((p, i) => {
      expanded = expanded.replace(new RegExp(`\\b${p}\\b`, "g"), (args[i] ?? "").trim());
    });
    return resolveRustType(expanded, shapes, aliases, depth + 1);
  }
  const fromResult = unwrapGeneric(t, "Result");
  // `Result<T, E>` → the **Ok** type (the first top-level segment).
  if (fromResult !== null) t = splitTopLevel(fromResult)[0].trim();
  const opt = unwrapGeneric(t, "Option");
  if (opt !== null) t = opt;
  const vec = unwrapGeneric(t, "Vec");
  if (vec !== null) {
    const inner = resolveRustType(vec, shapes);
    return inner.kind === "unknown" ? { kind: "unknown" } : { kind: "array", inner };
  }
  if (SCALAR[t]) return { kind: SCALAR[t] };
  if (t.includes("<")) return { kind: "unknown" }; // HashMap/tuple/… we do not model
  // A **path** is reduced to its last segment (`amos_appstore::PwaManifest` → `PwaManifest`,
  // `std::string::String` → `String`): the shape table is keyed by the bare name a `pub struct`
  // declaration carries, so the final segment is exactly what to look up. A path used to fall
  // through to `unknown`, which recorded a perfectly readable reply as unverifiable — measured on
  // `appstore::pwa_open_remote`'s `AppStoreResult<amos_appstore::PwaManifest>` (REQ-A560).
  if (t.includes("::")) {
    const leaf = t.slice(t.lastIndexOf("::") + 2).trim();
    return leaf === "" ? { kind: "unknown" } : resolveRustType(leaf, shapes, aliases, depth);
  }
  if (/^[A-Za-z_]\w*$/.test(t)) {
    const shape = shapes.get(t);
    if (!shape || shape.opaque) return { kind: "unknown" };
    if (shape.tuple) {
      // A tuple struct takes its inner type's wire shape (REQ-A558): one field ⇒ that shape, none
      // or several ⇒ not modelled (a heterogeneous array is not a type this resolver reads).
      if (shape.tuple.length !== 1 || depth >= 8) return { kind: "unknown" };
      return resolveRustType(shape.tuple[0], shapes, aliases, depth + 1);
    }
    return { kind: "object", shape: t };
  }
  return { kind: "unknown" };
}

/** Resolve a TS type text to `{ kind, fields?, typeName? }` the same way. */
export function resolveTsType(typeText, interfaces, unions = new Map(), extra = {}) {
  let t = typeText.trim();
  while (t.endsWith("| null") || t.endsWith("| undefined")) {
    t = t.slice(0, t.lastIndexOf("|")).trim();
  }
  if (/^(void|undefined|null)$/.test(t)) return { kind: "null" };
  if (t === "boolean") return { kind: "boolean" };
  if (t === "number") return { kind: "number" };
  if (t === "string") return { kind: "string" };
  if (/^(unknown|any)$/.test(t)) return { kind: "unknown" };
  const arr = /^([A-Za-z_]\w*)\[\]$/.exec(t) ?? /^Array<([A-Za-z_]\w*)>$/.exec(t);
  if (arr) {
    const inner = resolveTsType(arr[1], interfaces);
    return inner.kind === "unknown" ? { kind: "unknown" } : { kind: "array", inner };
  }
  if (t.startsWith("{")) {
    const close = matchBracket(t, 0);
    if (close < 0) return { kind: "unknown" };
    const fields = [];
    for (const part of splitTopLevel(t.slice(1, close))) {
      const fm = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(part);
      if (fm) fields.push(fm[1]);
      else if (part.trim() !== "") return { kind: "unknown" };
    }
    return { kind: "object", fields, typeName: "<inline>" };
  }
  if (/^[A-Za-z_]\w*$/.test(t)) {
    const fields = interfaces.get(t);
    if (fields) return { kind: "object", fields, typeName: t };
    // A **tagged union alias** is a readable shape now (REQ-A467): `{kind: "…"} | …` carries the
    // discriminants the wire must send, so it is compared instead of being skipped. It wins over
    // the object-union reading below, which is the weaker judgement (REQ-A558).
    const union = unions.get(t);
    if (union) return { kind: "tagged-union", tag: union.tag, tags: union.tags, typeName: t };
    const objUnion = extra.objectUnions?.get(t);
    if (objUnion) return { kind: "object-union", members: objUnion.members, typeName: t };
    const literals = extra.literalUnions?.get(t);
    if (literals) return { kind: "literal-union", literals, typeName: t };
    return { kind: "unknown" };
  }
  return { kind: "unknown" }; // generics, mapped types — out of scope
}

/** Compare one resolved pair (pure). Empty when they agree or are unverifiable. */
export function compareReply(command, rust, ts, rustShapes) {
  if (rust.kind === "unknown" || ts.kind === "unknown") return [];

  // REQ-A467's class: a **tagged union alias** (`invoke<AirPlayResult>("airplay_connect")` with
  // `type AirPlayResult = | { kind: "ok" } | { kind: "permission_denied"; reason: string } | …`)
  // declares the discriminants the shell expects. A literal the wire can never send is a branch
  // that can never run — which is how `AirPlayResult` shipped `permission_denied` while serde
  // sent `"permissiondenied"` for as long as it existed. Only compared when **both** sides are
  // internally tagged with the *same* tag field; anything else is left alone.
  if (ts.kind === "tagged-union") {
    const shape = rustShapes.get(rust.shape);
    if (!shape || shape.opaque || !shape.tag || shape.tag !== ts.tag) return [];
    const wire = new Set(shape.wireTags ?? []);
    const declared = new Set(ts.tags);
    const neverEmitted = ts.tags.filter((t) => !wire.has(t)).sort();
    const unhandled = [...wire].filter((t) => !declared.has(t)).sort();
    if (neverEmitted.length === 0 && unhandled.length === 0) return [];
    const parts = [];
    if (neverEmitted.length > 0) {
      parts.push(
        `declares ${neverEmitted.map((t) => `\`"${t}"\``).join(", ")}, which the command never sends`,
      );
    }
    if (unhandled.length > 0) {
      parts.push(`does not handle ${unhandled.map((t) => `\`"${t}"\``).join(", ")}`);
    }
    return [
      {
        kind: "tag-literal",
        command,
        detail:
          `\`${ts.typeName}\` ${parts.join("; ")} — \`${rust.shape}\` serializes ` +
          `${[...wire].map((t) => `\`"${t}"\``).join(", ") || "no tagged variant"}`,
      },
    ];
  }

  // REQ-A558: a TS union of **object literals** (`{ ok: true; bytes: number[] } | { ok: false;
  // error: string }`) against the host's single flat struct. Each member is a *narrowing* view of
  // the same wire object, so the judgement is per member: every field it declares must exist on the
  // wire. Reading a field the host never sends is the defect; omitting one is how a member is
  // written. (Nothing is claimed about the member's *values*, which is why this is the weaker
  // reading than the tagged-union one — see `resolveTsType`'s ordering.)
  //
  // Handled **before** the kind comparison below: these are TS-side *wrappers* around an object
  // wire shape, so `kind` deliberately does not match the Rust side's.
  if (ts.kind === "object-union") {
    if (rust.kind !== "object") return [];
    const shape = rustShapes.get(rust.shape);
    if (!shape || shape.opaque) return [];
    // An `#[serde(untagged)]` enum sends **one of its variants**, so a member must fit exactly one
    // of them — not merely the union of all their fields (REQ-A558). This is what makes the
    // three-state `sms_trash_add` contract checkable: a member reading `{ trashed, reason }` is
    // right because *Refused* sends exactly that, while `{ trashed, verdict }` is not, even though
    // `verdict` might exist on some other variant of a different enum.
    const variantSets = shape.untagged && shape.variants?.length ? shape.variants : null;
    const known = new Set(shape.fields);
    const fitsOneVariant = (member) => variantSets.some((v) => member.every((f) => v.includes(f)));
    const stray = [
      ...new Set(
        ts.members.flatMap((m) => (variantSets && fitsOneVariant(m) ? [] : m.filter((f) => !known.has(f)))),
      ),
    ].sort();
    const unfittable = variantSets ? ts.members.filter((m) => !fitsOneVariant(m)) : [];
    if (stray.length === 0 && unfittable.length === 0) return [];
    const detail = variantSets
      ? `\`${ts.typeName}\` has a member declaring ${unfittable
          .map((m) => `{${m.join(", ")}}`)
          .join(", ")} — no variant of \`${rust.shape}\` serializes that field set ` +
        `(the variants send: ${variantSets.map((v) => `{${v.join(", ")}}`).join(", ")})`
      : `\`${ts.typeName}\` declares ${stray.map((f) => `\`${f}\``).join(", ")} — absent from the reply's ` +
        `\`${rust.shape}\` (which serializes: ${shape.fields.join(", ") || "no fields"})`;
    return [{ kind: "field-name", command, detail }];
  }

  // REQ-A558: a TS **discriminant-literal** union against a Rust **externally tagged** enum. The
  // wire carries one of the enum's variant names — or, with `rename_all` / a variant `rename`, one
  // of their renamed spellings — so the sets must match. This is REQ-A467's shape one tagging style
  // over: a literal the command never sends is a branch that can never run, and a wire value the
  // shell does not handle is a state it will render as undefined.
  if (ts.kind === "literal-union") {
    const shape = rustShapes.get(rust.shape);
    // Only an **external** enum can be read this way: a `tag`ed one puts a field on the wire
    // (`{"kind": …}`) rather than a bare discriminant, and a struct's field names are not literals.
    if (!shape || shape.opaque || !shape.enum || shape.tag) return [];
    const wire = new Set(shape.wireTags ?? []);
    if (wire.size === 0) return [];
    const declared = new Set(ts.literals);
    const neverSent = ts.literals.filter((t) => !wire.has(t)).sort();
    const unhandled = [...wire].filter((t) => !declared.has(t)).sort();
    if (neverSent.length === 0 && unhandled.length === 0) return [];
    const parts = [];
    if (neverSent.length > 0) {
      parts.push(`declares ${neverSent.map((t) => `\`"${t}"\``).join(", ")}, which the command never sends`);
    }
    if (unhandled.length > 0) {
      parts.push(`does not handle ${unhandled.map((t) => `\`"${t}"\``).join(", ")}`);
    }
    return [
      {
        kind: "tag-literal",
        command,
        detail:
          `\`${ts.typeName}\` ${parts.join("; ")} — \`${rust.shape}\` serializes ` +
          `${[...wire].map((t) => `\`"${t}"\``).join(", ")}`,
      },
    ];
  }

  if (rust.kind !== ts.kind) {
    return [
      {
        kind: "value-kind",
        command,
        detail: `the shell reads the reply as ${ts.kind} (${ts.typeName ?? "scalar"}), the command returns ${rust.kind}`,
      },
    ];
  }
  if (rust.kind === "array") return compareReply(command, rust.inner, ts.inner, rustShapes);
  if (rust.kind !== "object") return [];
  const shape = rustShapes.get(rust.shape);
  if (!shape) return [];
  const known = new Set(shape.fields);
  const stray = ts.fields.filter((f) => !known.has(f));
  if (stray.length === 0) return [];
  return [
    {
      kind: "field-name",
      command,
      detail:
        `\`${ts.typeName}\` declares ${stray.map((f) => `\`${f}\``).join(", ")} — absent from the reply's ` +
        `\`${rust.shape}\` (which serializes: ${shape.fields.join(", ") || "no fields"})`,
    },
  ];
}

// --- selftest ---------------------------------------------------------------
export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, cond]);

  const shapes = parseRustShapes(
    [
      "#[derive(Clone, Debug, PartialEq, Serialize)]",
      "pub struct TrashOut {",
      "    pub thread_id: String,",
      "    pub message_id: String,",
      "    pub ts_ms: i64,",
      "    pub trashed_ms: i64,",
      "}",
      "#[derive(Serialize)]",
      '#[serde(rename_all = "camelCase")]',
      "pub struct Camel { pub display_name: String }",
      "#[derive(Serialize)]",
      "#[serde(flatten)]",
      "pub struct Flattened { pub a: String }",
      "#[derive(Serialize)]",
      '#[serde(tag = "kind", rename_all = "lowercase")]',
      "pub enum Tagged { Ok, Failed { reason: String } }",
      "#[derive(Serialize)]",
      "pub enum External { Ok, Gone { id: u32 } }",
    ].join("\n"),
  );
  ok("parses snake_case struct fields", shapes.get("TrashOut").fields.join(",") === "thread_id,message_id,ts_ms,trashed_ms");
  ok("honours serde rename_all = camelCase", shapes.get("Camel").fields[0] === "displayName");
  ok("a flattened struct is opaque, never compared", shapes.get("Flattened").opaque === true);
  // REQ-A387: an internally tagged enum's payload is the tag **plus** the variant's fields
  // (`{"kind":"failed","reason":"…"}`), so a TS type declaring `{kind, reason}` is right.
  ok(
    "internally tagged enum = tag + variant fields",
    shapes.get("Tagged").fields.join(",") === "kind,reason",
  );
  ok("externally tagged enum still yields variant names", shapes.get("External").fields.join(",") === "Ok,Gone");

  // REQ-A555: a field's (or variant's) own `#[serde(…)]` is read instead of poisoning the whole
  // shape. Measured on this tree that attribute-blindness had taken **17** shapes out of the
  // audit (`AppManifest`, `CareReport`, `SensorHostSnapshot`, `FsRead`, `AppStatus`, …).
  const attributed = parseRustShapes(
    [
      "#[derive(Clone, Serialize)]",
      "pub struct Attributed {",
      '    #[serde(rename = "type")]',
      "    pub kind: String,",
      '    #[serde(default, skip_serializing_if = "Option::is_none")]',
      "    pub opt: Option<String>,",
      "    #[serde(skip_serializing)]",
      "    pub never_sent: String,",
      "    #[cfg(feature = \"android\")]",
      "    pub gated: bool,",
      '    #[serde(with = "wire")]',
      "    pub custom: String,",
      "}",
      "#[derive(Serialize)]",
      '#[serde(rename_all = "lowercase")]',
      "pub enum Variants {",
      '    #[serde(rename = "ai_assistant")]',
      "    AiAssistant,",
      "    Home,",
      "}",
      "#[derive(Serialize)]",
      "#[serde(untagged)]",
      "pub enum Untagged { A { a: u8 }, B { b: u8 } }",
      "#[derive(Serialize)]",
      "#[serde(untagged)]",
      "pub enum UntaggedUnit { A, B { b: u8 } }",
      "#[derive(Serialize)]",
      "pub struct SkippedField { pub a: String }",
      "#[derive(Serialize)]",
      "pub struct Newtype(pub u64);",
    ].join("\n"),
  );
  const attr = attributed.get("Attributed");
  ok("a renamed field carries its wire name", attr.fields.includes("type"));
  ok("a `default`/`skip_serializing_if` field stays a field", attr.fields.includes("opt"));
  ok("a `skip_serializing` field is not on the wire", !attr.fields.includes("never_sent"));
  ok("a non-serde attribute is not about the wire", attr.fields.includes("gated"));
  ok(
    "an unmodelled serde key fails closed (the whole shape is opaque)",
    attr.opaque === true && !attr.fields.includes("custom"),
  );
  ok(
    "a variant's `rename` is the wire tag, and `rename_all` reaches variant names too",
    attributed.get("Variants").fields.join(",") === "ai_assistant,home",
  );
  // REQ-A558: an `untagged` enum's payload is **one variant's own fields**, which is checkable —
  // but only when every variant is a struct variant (a unit variant is not serializable by serde
  // and a tuple variant's payload is its inner value).
  ok(
    "an untagged enum records each variant's field set",
    attributed.get("Untagged").opaque === false &&
      JSON.stringify(attributed.get("Untagged").variants) === JSON.stringify([["a"], ["b"]]) &&
      attributed.get("Untagged").fields.join(",") === "a,b",
  );
  ok(
    "an untagged enum with a unit variant fails closed",
    attributed.get("UntaggedUnit").opaque === true,
  );

  // REQ-A558: a tuple struct takes its **inner type's** wire shape. The old parser looked for "the
  // next `{` in the file", so `pub struct Newtype(pub u64);` picked up whatever braced item
  // followed it — measured on `clipboard.rs`, where `SubscriptionId(u64)` inherited `Subscriber`'s
  // fields and a correct `invoke<number>("clipboard_subscribe")` was reported as a failure.
  ok(
    "a tuple struct records its inner types, not the next struct's fields",
    JSON.stringify(attributed.get("Newtype").tuple) === JSON.stringify(["u64"]) &&
      attributed.get("Newtype").fields.length === 0,
  );
  ok("a newtype struct resolves to its inner kind", resolveRustType("Newtype", attributed).kind === "number");
  // …and the attribute reader is what decides those, so pin its parts.
  // REQ-A558: the two union readings, and the comparison they enable.
  const unionSrc = [
    "export type ObjUnion = { ok: true; bytes: number[] } | { ok: false; error: string };",
    'export type LitUnion = "notdetermined" | "denied" | "authorized";',
    'export type MixedUnion = "Available" | { installed: { version: string } } | { updatable: { installed: string } };',
    "export type MixedBad = \"a\" | { x: string; y: string };",
    "export type ObjBad = { a: string } | { b: string } | { [k: string]: string };",
    "export type ObjMethod = { a: string } | { go: (x: string) => void };",
  ].join("\n");
  const objUnions = parseTsObjectUnions(unionSrc);
  const litUnions = parseTsLiteralUnions(unionSrc);
  ok("reads an object-literal union", JSON.stringify(objUnions.get("ObjUnion")?.members) === JSON.stringify([["ok", "bytes"], ["ok", "error"]]));
  ok("reads a string-literal union", litUnions.get("LitUnion")?.join(",") === "notdetermined,denied,authorized");
  ok(
    "reads a mixed literal/one-key union (serde's external tagging)",
    litUnions.get("MixedUnion")?.join(",") === "Available,installed,updatable",
  );
  ok("a multi-key member is not treated as a discriminant", !litUnions.has("MixedBad"));
  ok("an unreadable object member (index signature) disqualifies the alias", !objUnions.has("ObjBad"));
  ok(
    "a method-typed property still contributes its name (the gate only speaks about names)",
    JSON.stringify(objUnions.get("ObjMethod")?.members) === JSON.stringify([["a"], ["go"]]),
  );
  ok("an object union is not a literal union", !litUnions.has("ObjUnion"));

  const unionShapes = parseRustShapes(
    [
      "#[derive(Serialize)]",
      "pub struct ObjUnion { pub ok: bool, pub bytes: Option<Vec<u8>>, pub error: Option<String> }",
      "#[derive(Serialize)]",
      '#[serde(rename_all = "lowercase")]',
      "pub enum LitUnion { NotDetermined, Denied, Authorized }",
      "#[derive(Serialize)]",
      "pub enum MixedUnion { Available, #[serde(rename = \"installed\")] Installed { version: String }, #[serde(rename = \"updatable\")] Updatable { installed: String, latest: String } }",
      "#[derive(Serialize)]",
      "#[serde(untagged)]",
      "pub enum States { A { trashed: bool }, B { trashed: bool, reason: String } }",
    ].join("\n"),
  );
  const tsObj = (t) => resolveTsType(t, new Map(), new Map(), { objectUnions: objUnions, literalUnions: litUnions });
  ok(
    "an object union that reads only real fields passes",
    compareReply("c", resolveRustType("ObjUnion", unionShapes), tsObj("ObjUnion"), unionShapes).length === 0,
  );
  ok(
    "a literal union matches the enum's wire tags",
    compareReply("c", resolveRustType("LitUnion", unionShapes), tsObj("LitUnion"), unionShapes).length === 0,
  );
  ok(
    "a literal union matching an external enum's renamed variants passes",
    compareReply("c", resolveRustType("MixedUnion", unionShapes), tsObj("MixedUnion"), unionShapes).length === 0,
  );
  const litMiss = compareReply(
    "c",
    resolveRustType("LitUnion", unionShapes),
    resolveTsType("LitUnion", new Map(), new Map(), {
      literalUnions: new Map([["LitUnion", ["notdetermined", "denied", "authorized", "revoked"]]]),
    }),
    unionShapes,
  );
  ok(
    "a literal the wire never sends is a finding",
    litMiss.length === 1 && litMiss[0].detail.includes("revoked"),
  );
  const objMiss = compareReply(
    "c",
    resolveRustType("ObjUnion", unionShapes),
    resolveTsType("ObjUnion", new Map(), new Map(), {
      objectUnions: new Map([["ObjUnion", { members: [["ok", "bytesRead"]] }]]),
    }),
    unionShapes,
  );
  ok(
    "an object-union member reading an absent field is a finding",
    objMiss.length === 1 && objMiss[0].detail.includes("bytesRead"),
  );
  const states = resolveRustType("States", unionShapes);
  const statesOk = compareReply(
    "c",
    states,
    resolveTsType("S", new Map(), new Map(), {
      objectUnions: new Map([["S", { members: [["trashed"], ["trashed", "reason"]] }]]),
    }),
    unionShapes,
  );
  const statesBad = compareReply(
    "c",
    states,
    resolveTsType("S", new Map(), new Map(), {
      objectUnions: new Map([["S", { members: [["trashed", "reason"]] }]]),
    }),
    unionShapes,
  );
  const statesNeither = compareReply(
    "c",
    states,
    resolveTsType("S", new Map(), new Map(), {
      objectUnions: new Map([["S", { members: [["trashed", "verdict"]] }]]),
    }),
    unionShapes,
  );
  ok("an untagged payload is one of its variants", statesOk.length === 0);
  ok("a member equal to a variant is accepted", statesBad.length === 0);
  ok(
    "a member no single variant can send is a finding",
    statesNeither.length === 1 && statesNeither[0].detail.includes("no variant"),
  );
  // REQ-A560: a **path** in a return type is reduced to its last segment. Measured on the reply this
  // round wired: `AppStoreResult<amos_appstore::PwaManifest>` — both sides were readable and the pair
  // was still recorded unverifiable, because a path fell through to `unknown`.
  ok(
    "a path in a return type resolves through its last segment",
    resolveRustType("amos_appstore::ObjUnion", unionShapes).kind === "object" &&
      resolveRustType("std::string::String", unionShapes).kind === "string" &&
      resolveRustType("amos_appstore::NoSuchType", unionShapes).kind === "unknown",
  );
  ok(
    "a path inside a generic resolves too",
    resolveRustType("Vec<amos_appstore::ObjUnion>", unionShapes).kind === "array" &&
      resolveRustType("Option<crate::model::ObjUnion>", unionShapes).kind === "object",
  );

  ok("splitAttrs separates attributes from the declaration", splitAttrs('#[serde(rename = "a")] pub a: u8').decl.trim() === "pub a: u8");
  ok("splitAttrs gives up on an unbalanced attribute", splitAttrs("#[serde(rename = \"a\" pub a: u8") === null);
  ok("a non-serde attribute is ignored", readItemAttrs(['#[allow(dead_code)]']).opaque === false);
  ok("an unmodelled serde key is opaque", readItemAttrs(['#[serde(serialize_with = "f")]']).opaque === true);
  ok("a keyword rename is opaque, never guessed", readItemAttrs(["#[serde(rename = SNAKE)]"]).opaque === true);
  ok("skip means dropped", readItemAttrs(["#[serde(skip)]"]).drop === true);

  // REQ-A555: a reply type declared in **another module** is resolved through the file's imports
  // (the same blind spot REQ-A532 closed for a shape declared in another crate).
  const scopeCache = new Map([
    [
      "/src/a.ts",
      {
        interfaces: new Map(),
        unions: new Map(),
        imports: [{ names: [{ imported: "Reply", local: "Reply" }], spec: "./b" }],
        reexports: [],
      },
    ],
    [
      "/src/b.ts",
      {
        interfaces: new Map([["Reply", ["focused", "windows"]]]),
        unions: new Map(),
        imports: [],
        reexports: [],
      },
    ],
    [
      "/src/c.ts",
      {
        interfaces: new Map(),
        unions: new Map(),
        imports: [],
        reexports: [{ names: [{ imported: "Reply", local: "Reply" }], spec: "./b" }],
      },
    ],
    [
      "/src/d.ts",
      {
        interfaces: new Map(),
        unions: new Map(),
        imports: [{ names: [{ imported: "Reply", local: "Local" }], spec: "./b" }],
        reexports: [],
      },
    ],
  ]);
  ok(
    "an imported TS reply type resolves",
    tsScopeFor("/src/a.ts", scopeCache).interfaces.get("Reply")?.join(",") === "focused,windows",
  );
  ok(
    "a re-exported TS reply type resolves too",
    tsScopeFor("/src/c.ts", scopeCache).interfaces.has("Reply"),
  );
  ok(
    "an aliased import resolves under its local name",
    tsScopeFor("/src/d.ts", scopeCache).interfaces.has("Local"),
  );
  ok(
    "a name no module declares stays unresolved",
    !tsScopeFor("/src/a.ts", scopeCache).interfaces.has("Nope"),
  );
  const importScope = parseTsImportScope(
    [
      'import { a, type B as C } from "./x";',
      'import type { D } from "./y";',
      'export type { E } from "./z";',
      'import * as ns from "./w";',
      'import q from "pkg";',
    ].join("\n"),
  );
  ok("reads a named import", importScope.imports[0].names.map((n) => n.local).join(",") === "a,C");
  ok("reads a type-only import", importScope.imports[1].names[0].imported === "D");
  ok("reads a re-export", importScope.reexports[0].names[0].imported === "E");
  ok(
    "a namespace/default import is not guessed",
    importScope.imports.length === 2,
  );

  const returns = parseReturns(
    [
      "#[tauri::command]",
      "pub fn sms_trash_purge() -> usize {",
      "    0",
      "}",
      "#[tauri::command]",
      "pub async fn sms_trash_list() -> Vec<TrashOut> {",
      "    Vec::new()",
      "}",
      "#[tauri::command]",
      "pub async fn sms_status(state: State<'_, SmsBridge>) -> SmsStatusOut {",
      "    todo!()",
      "}",
    ].join("\n"),
  );
  ok("reads a scalar return", returns.get("sms_trash_purge") === "usize");
  ok("reads a Vec return", returns.get("sms_trash_list") === "Vec<TrashOut>");
  ok("reads a struct return past an injected State", returns.get("sms_status") === "SmsStatusOut");

  const ifaces = parseTsInterfaces(
    [
      "export interface SmsTrashEntryOut {",
      "  thread_id: string;",
      "  message_id: string;",
      "}",
      "interface Bad { threadId: string }",
    ].join("\n"),
  );
  ok("parses TS interface fields", ifaces.get("SmsTrashEntryOut").join(",") === "thread_id,message_id");
  ok("parses a private interface too", ifaces.get("Bad").join(",") === "threadId");

  const generics = parseInvokeGenerics(
    [
      'invoke<SmsTrashEntryOut[]>("sms_trash_list");',
      'invoke<number>("sms_trash_purge");',
      'invoke<{ due: string[] }>("scheduler_alarm_poll", { nowMs });',
      "invoke(cmd, {});",
    ].join("\n"),
  );
  ok("reads an array generic", generics.find((g) => g.command === "sms_trash_list")?.typeText === "SmsTrashEntryOut[]");
  ok("reads an inline object generic", generics.find((g) => g.command === "scheduler_alarm_poll")?.typeText === "{ due: string[] }");
  ok("ignores an untyped invoke", !generics.some((g) => g.typeText === "cmd"));

  const r = (t) => resolveRustType(t, shapes);
  ok("Result<T, E> unwraps to T", resolveRustType("Result<Vec<TrashOut>, String>", shapes).kind === "array");
  ok("Option<T> unwraps", resolveRustType("Option<u64>", shapes).kind === "number");
  ok("bool → boolean", r("bool").kind === "boolean");
  ok("usize/u64 → number", r("usize").kind === "number" && r("u64").kind === "number");
  ok("String → string", r("String").kind === "string");
  ok("a known struct → object", r("TrashOut").kind === "object");
  ok("() → null", r("()").kind === "null");
  ok("an unknown name → unknown", r("HashMap<String, u32>").kind === "unknown");
  ok("a flattened struct → unknown", r("Flattened").kind === "unknown");

  const ts = (t) => resolveTsType(t, ifaces);
  ok("TS boolean → boolean", ts("boolean").kind === "boolean");
  ok("TS number → number", ts("number").kind === "number");
  ok("TS string → string", ts("string").kind === "string");
  ok("TS array of a known interface", ts("SmsTrashEntryOut[]").kind === "array");
  ok("TS union alias → unknown", ts("SmsTrashAddResult").kind === "unknown");
  ok("TS | null is unwrapped", ts("TelephonyCall | null").kind === "unknown" && ts("number | null").kind === "number");

  // The two real defects this gate was built from, as pure negative controls.
  const trashList = compareReply(
    "sms_trash_list",
    resolveRustType("Vec<TrashOut>", shapes),
    resolveTsType("SmsTrashEntryOut[]", ifaces),
    shapes,
  );
  ok("a snake_case TS type agrees with the same-named Rust fields", trashList.length === 0);
  const camelIfaces = parseTsInterfaces("export interface Entry { threadId: string; messageId: string }");
  const camelFinding = compareReply(
    "sms_trash_list",
    resolveRustType("Vec<TrashOut>", shapes),
    resolveTsType("Entry[]", camelIfaces),
    shapes,
  );
  ok(
    "a camelCase TS type is a finding (the Round-47 defect)",
    camelFinding.length === 1 && camelFinding[0].kind === "field-name" && camelFinding[0].detail.includes("threadId"),
  );
  const kindFinding = compareReply(
    "sms_trash_restore",
    resolveRustType("bool", shapes),
    resolveTsType("string", ifaces),
    shapes,
  );
  ok(
    "reading a bool reply as string is a finding (the other Round-47 defect)",
    kindFinding.length === 1 && kindFinding[0].kind === "value-kind",
  );
  ok(
    "an unverifiable pair is skipped, not guessed",
    compareReply("x", resolveRustType("serde_json::Value", shapes), resolveTsType("unknown", ifaces), shapes).length === 0,
  );

  // --- REQ-A532: aliases, the unit side, and cross-crate shapes ---------------
  const aliases = parseRustAliases(
    [
      "/// doc",
      "pub type AmosResult<T> = Result<T, AmosError>;",
      "type Pair<A, B> = (A, B);",
      "type Local = WmSnapshot;",
      // A crate-defined `Result` must **not** shadow the std one.
      "type Result<T> = std::result::Result<T, MyError>;",
      "type CloneOf<T: Clone> = Option<T>;",
    ].join("\n"),
  );
  ok("parseRustAliases reads a generic alias", aliases.get("AmosResult")?.target === "Result<T, AmosError>");
  ok("parseRustAliases keeps the parameter list", aliases.get("Pair")?.params.join(",") === "A,B");
  ok("parseRustAliases drops a bound from an alias parameter", aliases.get("CloneOf")?.params.join(",") === "T");
  ok("parseRustAliases reads a bare alias", aliases.get("Local")?.target === "WmSnapshot");
  ok("parseRustAliases never shadows a std generic", !aliases.has("Result"));
  ok(
    "an aliased command return resolves through the alias",
    resolveRustType("AmosResult<TrashOut>", shapes, aliases).kind === "object",
  );
  ok(
    "an alias to the unit type resolves to the unit",
    resolveRustType("AmosResult<()>", shapes, aliases).kind === "null",
  );
  ok("a self-referential alias stops (depth-limited)", resolveRustType("Local", shapes, new Map([["Local", { params: [], target: "Local" }]])).kind === "unknown");
  ok("TS `null` is the unit wire value", resolveTsType("null", ifaces).kind === "null");
  ok(
    "a unit reply read as null is consistent",
    compareReply("x", { kind: "null" }, resolveTsType("null", ifaces), shapes).length === 0,
  );
  const localShapes = new Map([["Shared", { fields: ["a"] }]]);
  const wsShapes = new Map([
    ["Shared", { fields: ["b"] }],
    ["Unique", { fields: ["c"] }],
    ["Twice", { fields: ["d"] }],
  ]);
  const picked = selectCrossCrateShapes(localShapes, wsShapes, new Map([["Shared", 1], ["Unique", 1], ["Twice", 2]]));
  ok("the tauri crate's own declaration wins a name collision", !picked.has("Shared"));
  ok("a uniquely-declared workspace shape is used", picked.get("Unique")?.fields[0] === "c");
  ok("a name declared twice elsewhere is not guessed", !picked.has("Twice"));

  // REQ-A467: the tagged-union alias rule (and the two extractor fixes it depends on).
  ok(
    "variantTag: lowercase drops the word boundary",
    variantTag("PermissionDenied", "lowercase") === "permissiondenied",
  );
  ok("variantTag: snake_case inserts one", variantTag("TurnDone", "snake_case") === "turn_done");
  ok("variantTag: a single word is unchanged", variantTag("Uris", "snake_case") === "uris");
  ok("variantTag: camelCase lowers the first letter", variantTag("AppleTv", "camelCase") === "appleTv");
  ok("variantTag: no rule ⇒ the Rust spelling", variantTag("Ok", "") === "Ok");

  const unions = parseTsTaggedUnions(
    [
      "export type AirPlayResult =",
      "  | { kind: 'ok' }",
      "  | { kind: 'permission_denied'; reason: string }",
      '  | { kind: "device_not_found" };',
      "type NotAUnion = { kind: 'x' };",
      "interface Inline { kind: 'a' | 'b' }",
    ].join("\n"),
  );
  ok(
    "reads a tagged union alias (both quote styles)",
    unions.get("AirPlayResult")?.tags.join(",") === "ok,permission_denied,device_not_found",
  );
  ok("the tag is the field every member shares", unions.get("AirPlayResult")?.tag === "kind");
  ok("a single object alias is not a union", !unions.has("NotAUnion"));
  ok("a property union is not an alias", !unions.has("Inline"));

  ok(
    "a single-quoted invoke is a call site too (they used to be invisible)",
    parseInvokeGenerics("const r = await invoke<AirPlayResult>('airplay_connect', { deviceId });")[0]
      ?.command === "airplay_connect",
  );
  ok(
    "the generic text is read from either quote style",
    parseInvokeGenerics('await invoke<SmsTrashEntryOut[]>("sms_trash_list");')[0]?.typeText ===
      "SmsTrashEntryOut[]",
  );

  const taggedShapes = parseRustShapes(
    [
      "#[derive(Serialize)]",
      '#[serde(tag = "kind", rename_all = "snake_case")]',
      "pub enum R { Ok, PermissionDenied { reason: String }, NotFound }",
    ].join("\n"),
  );
  const unionFinding = compareReply(
    "airplay_connect",
    resolveRustType("R", taggedShapes),
    resolveTsType("AirPlayResult", new Map(), unions),
    taggedShapes,
  );
  ok(
    "a discriminant the wire never sends is a finding (the REQ-A467 defect)",
    unionFinding.length === 1 &&
      unionFinding[0].kind === "tag-literal" &&
      unionFinding[0].detail.includes("device_not_found") &&
      unionFinding[0].detail.includes("not_found"),
  );
  const unionOk = compareReply(
    "airplay_connect",
    resolveRustType("R", taggedShapes),
    resolveTsType(
      "AirPlayResult",
      new Map(),
      parseTsTaggedUnions(
        "type AirPlayResult = | { kind: 'ok' } | { kind: 'permission_denied'; reason: string } | { kind: 'not_found' };",
      ),
    ),
    taggedShapes,
  );
  ok("matching discriminants are not a finding", unionOk.length === 0);
  // …and the historical shape itself: a `lowercase` enum vs the snake_case literals it shipped.
  const lowerShapes = parseRustShapes(
    [
      "#[derive(Serialize)]",
      '#[serde(tag = "kind", rename_all = "lowercase")]',
      "pub enum Lower { Ok, PermissionDenied { reason: String }, DeviceNotFound }",
    ].join("\n"),
  );
  const lowerFinding = compareReply(
    "airplay_connect",
    resolveRustType("Lower", lowerShapes),
    resolveTsType("AirPlayResult", new Map(), unions),
    lowerShapes,
  );
  ok(
    "`lowercase` on the wire vs snake_case literals is a finding",
    lowerFinding.length === 1 &&
      lowerFinding[0].detail.includes("permission_denied") &&
      lowerFinding[0].detail.includes("permissiondenied"),
  );
  ok(
    "a tagged union against a non-tagged shape is skipped, not guessed",
    compareReply(
      "x",
      resolveRustType("TrashOut", shapes),
      resolveTsType("AirPlayResult", new Map(), unions),
      shapes,
    ).length === 0,
  );

  // REQ-A555: the block-comment `replace` had no replacement argument, so every `/* … */`
  // became the text `undefined` — and the field behind such a comment was dropped from the
  // declared set (a quieter gate, not a false one). Pinned in both directions.
  // The blanking preserves offsets, so a comment of n chars becomes n spaces rather than one — the
  // assertion pins the property (whitespace, never the text `undefined`, never a weld) not the count.
  ok("a block comment is whitespace, not `undefined`",
    /^a\s+b$/.test(stripComments("a/*c*/b").trim()) && !stripComments("a/*c*/b").includes("undefined"));
  ok(
    "a line comment is whitespace too",
    stripComments("a // c\nb").includes("b") && !stripComments("a // c\nb").includes("undefined"),
  );
  const commented = parseTsInterfaces(
    ["interface WithComments {", "  a: string;", "  /** why */", "  b: number;", "}"].join("\n"),
  );
  ok(
    "a field behind a block comment is still declared",
    commented.get("WithComments").join(",") === "a,b",
  );
  const rustComment = parseRustShapes(
    ["#[derive(Serialize)]", "pub struct Commented {", "    /* why */", "    pub a: String,", "}"].join("\n"),
  );
  ok(
    "a Rust block comment does not poison the shape",
    rustComment.get("Commented").opaque === false &&
      rustComment.get("Commented").fields.join(",") === "a",
  );

  // --- REQ-A851: the comment/test helpers are token questions ---------------------
  // `stripComments`: a `//` inside a string literal is not a comment (the `"https://…"` class),
  // and a `/*` inside one does not open a block comment (the `"/*/topic/*"` class). Two-sided: the
  // same text with the delimiters in *code* must still be stripped.
  {
    const url = 'let u = "https://api.example/v1"; let after = 1;';
    ok("a `//` inside a string literal does not swallow the rest of the line",
      stripComments(url).includes("let after = 1") && stripComments(url).includes('"https'));
    ok("…while a real `//` on that line still is a comment",
      !stripComments('let a = 1; // let after = 1;').includes("let after"));
    // The fixture needs three things to reach the branch: a `/*` inside a string, a **later** `*/`
    // (a regex cannot match an unterminated block comment, so a `/*` alone is harmless), and real
    // code between them. That third part is the loss — measured in the link crates' topic patterns.
    const topic = 'let p = "/*sensor"; let after = 2; /* real comment */ let tail = 3;';
    ok("a `/*` inside a string literal does not swallow the code before the next real `*/`",
      stripComments(topic).includes("let after = 2"));
    ok("…while a real `/*` still is a block comment",
      !stripComments("/* let after = 2; */ code();").includes("let after") &&
      stripComments("/* x */ code();").includes("code"));
  }
  // The masker must not desync on Rust's two uses of `'`, nor on raw strings.
  ok("a lifetime does not open a literal",
    stripTestRegions("fn f<'a>(x: &'a str) {}\n#[cfg(test)]\nfn t() {}\nfn g() {}").includes("fn g()"));
  ok("a `'\"'` char literal does not desync the masker",
    stripTestRegions('fn f() { let q = \'"\'; }\n#[cfg(test)]\nfn t() {}\nfn g() {}').includes("fn g()"));
  ok("a raw string containing `\"` does not end the item early",
    stripTestRegions('fn a() {}\n#[cfg(test)]\nmod tests { const S: &str = r##"a " b } c"##; }\nfn b() {}') ===
      "fn a() {}\n\nfn b() {}");
  // Which items are test gates: `test` off, everything else unknown.
  ok("`#[cfg(not(test))]` is production, not a test gate",
    stripTestRegions("fn a() {}\n#[cfg(not(test))]\nfn prod_only() {}\n#[cfg(test)]\nfn t() {}\nfn b() {}")
      .includes("fn prod_only"));
  ok("`any(target_os = \"linux\", test)` is production on Linux",
    stripTestRegions('fn a() {}\n#[cfg(any(target_os = "linux", test))]\nfn linux_only() {}\nfn b() {}')
      .includes("fn linux_only"));
  ok("`feature = \"test-helpers\"` names a feature, not the test cfg",
    stripTestRegions('fn a() {}\n#[cfg(feature = "test-helpers")]\nfn helper() {}\nfn b() {}')
      .includes("fn helper"));
  ok("`all(test, feature = \"x\")` cannot exist without tests, so it goes",
    !stripTestRegions('fn a() {}\n#[cfg(all(test, feature = "x"))]\nfn t_only() {}\nfn b() {}')
      .includes("fn t_only"));
  ok("a nested predicate is evaluated, not read off the first parens",
    !stripTestRegions('fn a() {}\n#[cfg(all(not(target_os = "macos"), test))]\nfn t2() {}\nfn b() {}')
      .includes("fn t2"));
  ok("…and an unmodelled predicate is kept, not stripped (the quiet direction)",
    stripTestRegions('fn a() {}\n#[cfg(any(not(target_os = "macos"), test))]\nfn maybe() {}\nfn b() {}')
      .includes("fn maybe") &&
    stripTestRegions('fn a() {}\n#[cfg(all(any(test, feature = "y"), not(target_os = "macos")))]\nfn deep() {}\nfn b() {}')
      .includes("fn deep"));
  // Attribute prose and self-reading tests are not attributes.
  ok("an attribute spelled in a doc comment is not an attribute",
    stripTestRegions("fn a() {}\n/// see `#[cfg(test)]` helper\npub fn prod() {}\nfn b() {}")
      .includes("pub fn prod"));
  ok("an attribute spelled inside a string literal is not an attribute",
    stripTestRegions('fn a() {}\nfn f() { let s = SRC.find("#[cfg(test)]"); }\nfn b() {}')
      .includes('SRC.find("#[cfg(test)]")'));  // the old walk cut this line in half
  // The walk: a bracket written inside a test's own string does not end the module early. The
  // fixture must be **net-imbalanced** — the imap.rs shape, where each canned reply closes one more
  // level than it opens — or old and new agree and the assertion pins nothing.
  ok("a net-imbalanced literal does not leave test code in the production view",
    !stripTestRegions('fn a() {}\n#[cfg(test)]\nmod tests { let w = "}}"; let t = test_only(); }\nfn b() {}')
      .includes("test_only"));
  // Two-sided control for the whole function: real test items still go.
  ok("a real `#[cfg(test)] mod tests` item is still removed",
    !stripTestRegions("fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() { let x = (1, 2); }\n}\nfn b() {}")
      .includes("fn t()"));
  // A test item that is NOT inside a `#[cfg(test)] mod` (link-cli/src/lib.rs:4800's shape), and
  // the over-reach controls: attributes that merely *mention* test must not delete the item.
  ok("a top-level `#[test] fn` outside any test module is removed",
    !stripTestRegions("fn a() {}\n/// doc\n#[test]\nfn t() { assert!(true); }\nfn b() {}").includes("fn t()") &&
    stripTestRegions("fn a() {}\n/// doc\n#[test]\nfn t() { assert!(true); }\nfn b() {}").includes("fn b()"));
  ok("a path-qualified harness attribute is removed too",
    !stripTestRegions('fn a() {}\n#[tokio::test(flavor = "multi_thread")]\nasync fn t() {}\nfn b() {}')
      .includes("async fn t"));
  ok("`cfg_attr(test, …)` is an attribute *for* tests, not a test gate",
    stripTestRegions("fn a() {}\n#[cfg_attr(test, derive(Debug))]\nfn prod() {}\nfn b() {}")
      .includes("fn prod"));
  ok("an ordinary attribute does not delete its item",
    stripTestRegions("fn a() {}\n#[derive(Debug, Clone)]\nstruct S;\nfn b() {}").includes("struct S"));

  let failed = 0;
  for (const [name, cond] of checks) {
    if (!cond) {
      console.error(`[tauri-reply-scan] selftest FAIL: ${name}`);
      failed++;
    }
  }
  console.log(`[tauri-reply-scan] selftest: ${checks.length} assertion(s), ${failed} failure(s).`);
  process.exit(failed === 0 ? 0 : 1);
}
/**
 * True when this file is the process entry point. Guards the selftest/scan
 * dispatch so another script may `import` the extractors without side effects
 * (see `scripts/tauri-event-scan.mjs`, which reuses them).
 */
export function invokedDirectly(url, argv1) {
  return argv1 !== undefined && url.endsWith(argv1.split("/").pop());
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
if (IS_ENTRY && process.argv.includes("--selftest")) runSelftest();




/**
 * Remove every `#[cfg(test)]` item so a scan sees the **production** part of a file (REQ-A530).
 *
 * This lived only in `tauri-event-scan.mjs` (which learned it in REQ-A231), while three other
 * instruments kept truncating the source at the **first** `#[cfg(test)]` — `tauri-reply-scan.mjs`
 * (its own production cut), `tauri-command-scan.mjs` (`productionPart`, for "is Rust itself calling
 * this command?"), `rust-recursion-scan.mjs` and `hot-loop-scan.mjs`. Measured 2026-09-19: a small
 * `#[cfg(test)]` helper at `wm.rs:816` sits **above** 1 400 lines of production code (including the
 * whole window-manager command surface — `WmSnapshot` at 2233, `wm_open` at 2612), so all four
 * scans silently stopped reading `wm.rs` there. That is why a live command's reply counted as
 * "unverifiable" instead of being compared, and why the recursion/hot-loop counts could understate
 * their own baselines.
 *
 * Removing the items (bracket-balanced, so `fn`/`mod`/`impl`/`struct` bodies all end correctly)
 * keeps production visible no matter where a test seam lives, while test-only code stays out.
 *
 * **Which items, and where they end, are both token questions (REQ-A851).** As written the two
 * halves were character questions, and each was wrong in a way the corpus shows:
 *
 *   * *Which*: `\btest\b` inside the attribute — see `cfgWithoutTest` for the 20 sites that answer
 *     yes to a question whose answer is no (9 of them `not(test)`), and `maskProse` for the 6
 *     spellings that are prose or a literal, not an attribute.
 *   * *Where*: the walk counted brackets in comments and literals. `amos-mail/src/live/imap.rs`
 *     writes an IMAP reply as text — `"* 1 FETCH (FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM SUBJECT)] {"`
 *     (net +2), then `"{}}\r\n"` (−2), then `")\r\n"` (−1) — so the counter lost one level per test
 *     and returned to zero 128 lines into a 700-line module: **570 lines of test code stayed in the
 *     "production" view**, where every consumer scan reads them as production. In
 *     `amos-ai/src/server.rs` doc comments (`… (bundled_model`, `… \`is_deployment_unconfigured\`).`)
 *     did the same: the walk ended after 40 708 of 75 374 chars.
 *
 * Both halves now run over `maskProse(out)`: brackets and attribute spellings inside comments or
 * literals are whitespace there, so the walk's *own* rule is unchanged while its input is the
 * token-level one. Offsets and newlines are preserved, so the splice still cuts the original text.
 * Masking can only ever *remove* matches and the corrected walk can only end at the true item end,
 * so neither half can newly delete production code.
 */
export function stripTestRegions(src) {
  let out = src;
  for (;;) {
    const masked = maskProse(out);
    const gate = findTestGate(masked);
    if (!gate) return out;
    // Walk to the item's end: the item is over at a `;` outside every bracket, or when the block it
    // opened comes back to zero depth.
    const stack = [];
    let sawBlock = false;
    let end = -1;
    for (let i = gate.index + gate.len; i < masked.length; i++) {
      const c = masked[i];
      if (c === "(" || c === "[" || c === "{") {
        if (c === "{") sawBlock = true;
        stack.push(c);
        continue;
      }
      if (c === ")" || c === "]" || c === "}") {
        stack.pop();
        if (sawBlock && stack.length === 0) {
          end = i + 1;
          break;
        }
        continue;
      }
      if (c === ";" && stack.length === 0) {
        end = i + 1;
        break;
      }
    }
    out = out.slice(0, gate.index) + out.slice(end < 0 ? out.length : end);
    if (end < 0) return out;
  }
}

/** A source file's production part: `#[cfg(test)]` items removed, comments **kept** (REQ-A530). */
export function productionSource(src) {
  return stripTestRegions(src);
}

// --- scan -------------------------------------------------------------------
if (IS_ENTRY && !process.argv.includes("--selftest")) runScan();

function runScan() {
  const rustFiles = walk(RUST_SRC, ".rs");
  const shapes = new Map();
  const returns = new Map();
  const aliases = new Map();
  for (const f of rustFiles) {
    const src = readFileSync(f, "utf8");
    const prod = productionSource(src);
    for (const [k, v] of parseRustShapes(prod)) shapes.set(k, v);
    for (const [k, v] of parseReturns(prod)) returns.set(k, v);
    // REQ-A532: aliases are declared next to their users (`error.rs` carries `AmosResult`), so the
    // tauri crate's own aliases must be read here as well.
    for (const [k, v] of parseRustAliases(prod)) if (!aliases.has(k)) aliases.set(k, v);
  }

  /**
   * REQ-A532 — reply types defined **outside** `crates/amos-tauri/src` (`EmailSummary` lives in
   * `amos-mail/src/model.rs`, `AppManifest` in `amos-appstore/src/model.rs`), which this scan used to
   * report as unverifiable.
   *
   * Added under two guards, because the first attempt dropped `checked` from 141 to 23: (1) the
   * tauri crate's own declaration **wins** any name collision (the reply is built there), and (2) a
   * name that appears more than once in the rest of the workspace is dropped — this scan cannot tell
   * which declaration the wire means, and guessing produced exactly that collapse.
   */
  const workspaceShapes = new Map(); // name -> shape (rest of the workspace)
  const workspaceCount = new Map(); // name -> how many declarations
  const workspaceAliases = new Map();
  for (const f of walk(CRATES_DIR, ".rs")) {
    if (rustFiles.includes(f)) continue;
    const prod = productionSource(readFileSync(f, "utf8"));
    for (const [k, v] of parseRustShapes(prod)) {
      workspaceCount.set(k, (workspaceCount.get(k) ?? 0) + 1);
      if (!workspaceShapes.has(k)) workspaceShapes.set(k, v);
    }
    for (const [k, v] of parseRustAliases(prod)) if (!workspaceAliases.has(k)) workspaceAliases.set(k, v);
  }
  const crossCrateShapes = selectCrossCrateShapes(shapes, workspaceShapes, workspaceCount);
  for (const [k, v] of crossCrateShapes) shapes.set(k, v);
  for (const [k, v] of workspaceAliases) if (!aliases.has(k)) aliases.set(k, v);

  const feFiles = walk(FE_SRC, ".ts")
    .concat(walk(FE_SRC, ".svelte"))
    .filter((f) => !f.includes("/__tests__/") && !/\.test\.[cm]?[jt]sx?$/.test(f));

  /**
   * Every FE module's declared TS types + its import/re-export links (REQ-A555), so an
   * `invoke<T>` generic can name a type that lives in another module (`lib/wm.ts` declaring
   * `WmWindowsSnapshot`, used from `lib/shortcuts.ts`). Built once, then a file's scope is
   * `tsScopeFor(file, …)`.
   */
  const tsModules = new Map();
  for (const f of feFiles) {
    const src = readFileSync(f, "utf8");
    tsModules.set(f, {
      interfaces: parseTsInterfaces(src),
      unions: parseTsTaggedUnions(src),
      objectUnions: parseTsObjectUnions(src),
      literalUnions: parseTsLiteralUnions(src),
      ...parseTsImportScope(src),
    });
  }

  const findings = [];
  let checked = 0;
  let skipped = 0;
  /**
   * REQ-A530: *why* a typed reply was skipped, grouped.
   *
   * The scan has always printed `117 checked / 99 unverifiable` — a number that says how big the
   * blind spot is, never **what it is made of**, so "can this blind spot be shrunk?" could only be
   * answered by re-implementing the resolver in a scratch script (which is how this counter was
   * written, and the first two attempts got the reason distribution wrong). The categories are
   * printed with the report and included in `--json`, because a blind spot whose shape is unknown
   * is read as "probably fine".
   */
  const skips = new Map();
  const noteSkip = (why) => skips.set(why, (skips.get(why) ?? 0) + 1);
  const untypedReads = [];
  for (const f of feFiles) {
    const src = readFileSync(f, "utf8");
    // The file's own declarations **plus** what it imports (REQ-A555): a reply type is often
    // declared next to the command it belongs to and named from elsewhere.
    const { interfaces, unions, objectUnions, literalUnions } = tsScopeFor(f, tsModules);
    for (const call of parseInvokeGenerics(src)) {
      const returnType = returns.get(call.command);
      if (!returnType) {
        skipped++;
        noteSkip(`no parsed return type for \`${call.command}\``);
        continue;
      }
      const rust = resolveRustType(returnType, shapes, aliases);
      const ts = resolveTsType(call.typeText, interfaces, unions, { objectUnions, literalUnions });
      if (rust.kind === "unknown" || ts.kind === "unknown") {
        skipped++;
        // The largest remaining category is not a parser limit: the shell itself declares no reply
        // type (`invoke<unknown>("wm_open")`), so there is nothing on the frontend to compare the
        // host's shape against. Named per command so the list is actionable (REQ-A532).
        if (ts.kind === "unknown" && call.typeText.trim() === "unknown") {
          untypedReads.push(call.command);
          noteSkip(`the shell reads \`${call.command}\`'s reply as \`unknown\` (no TS type declared)`);
          continue;
        }
        noteSkip(
          `unreadable pair (rust=${rust.kind}, ts=${ts.kind}): \`${String(returnType).slice(0, 40)}\` ↔ \`${call.typeText.slice(0, 40)}\``,
        );
        continue;
      }
      checked++;
      for (const finding of compareReply(call.command, rust, ts, shapes)) {
        findings.push({ file: relative(root, f), ...finding });
      }
    }
  }

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          shapes: shapes.size,
          commandsWithReturns: returns.size,
          repliesChecked: checked,
          repliesSkipped: skipped,
          skips: [...skips.entries()].sort((a, b) => b[1] - a[1]).map(([why, n]) => ({ why, n })),
          untypedReads: [...new Set(untypedReads)].sort(),
          findings,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[tauri-reply-scan] ${returns.size} command(s) with a return type; ${shapes.size} serializable shape(s); ` +
        `${checked} typed reply(ies) checked, ${skipped} unverifiable (skipped).`,
    );
    const untyped = [...new Set(untypedReads)].sort();
    if (untyped.length > 0) {
      // Named, not counted: this category is the shell's own gap (no TS type declared), not a
      // parser limit, so the list is the work item rather than a number to shrug at (REQ-A532).
      console.log(
        `[tauri-reply-scan] ${untyped.length} of them are reads typed \`unknown\` in the shell ` +
          `(no reply type declared): ${untyped.join(", ")}`,
      );
    }
    for (const f of findings) {
      console.error(`[tauri-reply-scan] FAIL — ${f.file}: \`${f.command}\` ${f.detail}`);
    }
    if (findings.length > 0) {
      console.error(
        "\nFix by reading what the command actually returns: Tauri serializes the reply\n" +
          "with serde's own rules (a struct's fields keep their Rust spelling unless the\n" +
          "struct sets `rename_all`; a `bool`/`usize` is a boolean/number, never a string).",
      );
    } else {
      console.log(
        "[tauri-reply-scan] OK — every statically readable reply type matches the command's return shape.",
      );
    }
  }

  process.exit(findings.length === 0 ? 0 : 1);
}
