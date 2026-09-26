#!/usr/bin/env node
// "a Kotlin glue constant that claims to mirror a Rust protocol limit has drifted" —
// `SmsGlue.kt` declares its caps "mirroring crates/amos-sms/src/wire.rs (protocol
// contract)", but three of the five live in `validate.rs`, and the folder-type tag map
// is a third copy of `folder.rs`. No gate reads any of it: the two halves drift in
// silence. This binds every declared constant and the wire-name → `MESSAGE_TYPE_*` map
// to the Rust authority (by source text, so nothing must be compiled or on a device).
//
// The failure this prevents is not cosmetic. The caps are a **two-sided** contract: the
// glue emits at most `MAX_THREADS`/`MAX_MESSAGES`, and Rust *rejects* (not truncates) any
// reply that exceeds its own cap. So one side moving above the other's value — a dev
// bumping the glue's `MAX_THREADS` to match a busier inbox, or Rust lowering its cap —
// makes Rust throw the whole snapshot away: the on-device SMS inbox goes blank with a
// protocol error. Moving the glue below Rust's cap under-reports threads just as quietly.
// `MAX_TEXT_CHARS`/address bounds are the send path; Rust gates first, so there the drift
// shows as an honest (if confusing) rejection instead.
//
// Rule R1: the five caps in `SmsGlue.kt` equal their Rust authority's value, both named
// (`MAX_THREADS`↔`wire.rs`, `MAX_MESSAGES`↔`wire.rs`, `MAX_TEXT_CHARS`/`MAX_ADDRESS_DIGITS`/
// `MIN_ADDRESS_DIGITS`↔`validate.rs`).
// Rule R2: `SmsGlue.kt`'s `TYPE_*` tags and its wire-name → tag map agree with
// `folder.rs`'s `android_type()` and `wire()` (so a renamed folder or a moved
// `MESSAGE_TYPE_*` number is caught on the host, not on a phone).
//
// **REQ-A815 / F-DEV-101 — why R2 reads `from_wire`, not just `wire`.** `typeOf(folder)`
// takes the *string the frontend sends*, so the set it mirrors is `from_wire`'s **accepted
// names**, not `wire()`'s one canonical name per variant. Driving R2 from `wire()` alone made
// the check **one-directional**: it asked "does every Rust variant have a Kotlin arm?" and
// never "is every Kotlin arm a name Rust accepts?". Measured on the shipped tree, four
// perturbations all stayed green — Kotlin dropping its `"drafts"` alias, Kotlin accepting an
// invented `"outbox"`, and Rust's `from_wire` dropping `"drafts"` — while each makes the two
// sides disagree about a string the frontend really sends (device: resolves to Draft; Rust:
// an honest error, or vice versa). R2 is therefore a **three-way** binding over the acceptance
// set: every accepted Rust name has an arm, every arm is an accepted Rust name, and the arm's
// `TYPE_*` value equals `android_type()`'s number. The R0 floor counts the acceptance set,
// because a floor over `wire()`'s three canonical names is blind to exactly the aliases that
// were unbound.
//
// Rule R0: floors — at least 5 caps, 3 folder tags and 3 accepted names must be found, so
// "scanned nothing" can never read as green.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FLOORS = { caps: 5, folderTags: 3, wireNames: 3, acceptedNames: 3 };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KT = "crates/amos-tauri/android-glue/com/amos/ai/glue/SmsGlue.kt";
const WIRE = "crates/amos-sms/src/wire.rs";
const VALIDATE = "crates/amos-sms/src/validate.rs";
const FOLDER = "crates/amos-sms/src/folder.rs";

/**
 * Strip Kotlin comments — `/* … *\/` blocks, whole `//`/`*`/`/**` lines, and trailing `//`.
 *
 * Every extractor below reads **prose** as readily as code, and these files carry doc
 * comments written precisely to *quote* the shapes being checked ("the caps are …",
 * `"draft", "drafts" -> TYPE_DRAFT`). Without this, one reworded doc block is an "answer"
 * to all of them — the file's own comment about the old value shadows the real one and the
 * gate goes quiet on exactly the drift it exists to catch (the F-DEV-096/098 family; here
 * the hazard is **latent** — measured, no comment in the three authorities quotes a const or
 * an arm today — but the extractors must not depend on that staying true).
 */
export function stripKtComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\s*\/\/.*$/, ""))
    .join("\n");
}

/**
 * Delete `/* … *\/` spans, but only where the opening `/*` is **code**.
 *
 * The shipped form was `src.replace(/\/\*[\s\S]*?\*\//g, "")`, which cannot tell a comment from a
 * `/*` that is merely *written* inside a string literal. A topic pattern like `"amos/dog1/**"`
 * therefore opened a block that ran to the next `*\/` anywhere later in the file — measured, whole
 * `pub fn`s deleted: `crates/amos-link/src/node.rs` came out 669 → 283 lines and
 * `crates/amos-link/src/robot_hal.rs` 3488 → 963, with the `#[cfg(test)]` assertions at
 * `node.rs:460/565` and the `pub fn spawn_federation` at `node.rs:345` gone (REQ-A832, F-DEV-104).
 *
 * This walks the source instead, tracking plain strings, `\` escapes, raw strings (`r#"…"#`) and
 * char literals, and pairs each **code** `/*` with the next `*\/` — non-greedy, no nesting, an
 * unterminated `/*` left alone: exactly the pairing the regex had, so the only thing that changes
 * is *which* `/*` opens a block. A `.svelte`/`.ts` corpus is still only understood in the
 * char-literal form of `'…'`; the residue there is an over-strip, which can only *remove*
 * occurrences — the safe direction everywhere this is used (a name that must resolve, a constant
 * that must be present, a reference that must exist).
 */
function dropBlockComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const raw = /^r(#*)"/.exec(src.slice(i, i + 12));
    if (raw) {
      const close = '"' + raw[1];
      const end = src.indexOf(close, i + raw[0].length);
      const stop = end === -1 ? n : end + close.length;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      const stop = Math.min(j + 1, n);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "'") {
      const m = /^'(\\.|[^\\'])'/.exec(src.slice(i, i + 6));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      // A `/*` written inside a `//` comment is inert in Rust — `/// Topic::pattern("amos/*/x")`
      // is prose, not a block opener. Copied verbatim here; the whole-line filter below still
      // drops it. (The shipped regex opened a block on it too, with the same deletions.)
      const eol = src.indexOf("\n", i);
      const stop = eol === -1 ? n : eol;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) {
        out += src.slice(i);
        i = n;
        continue;
      }
      i = end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Strip Rust comments — `/* … *\/`, whole `//`/`///`/`//!` lines, and trailing `//`.
 *
 * The trailing form is cut only when the `//` is **outside a string literal** (tracked by
 * per-line quote parity, honouring `\` escapes), so a URL inside a literal survives. A line
 * whose parity is already muddled by a raw string (`r#"…"#`) is left alone — the safe
 * direction: an unstripped trailing comment can only make a finding *more* likely, never
 * hide one.
 */
export function stripRustComments(src) {
  const blocks = dropBlockComments(src);
  return blocks
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => {
      let inStr = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inStr) {
          if (c === "\\") i++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** `private const val NAME = <int>` → Map(NAME → value). Underscores allowed. */
export function ktConsts(src) {
  const out = new Map();
  const re = /\bconst\s+val\s+([A-Z][A-Z0-9_]*)\s*=\s*(-?[0-9][0-9_]*)\b/g;
  for (const m of stripKtComments(src).matchAll(re)) out.set(m[1], Number(m[2].replace(/_/g, "")));
  return out;
}

/** `pub const NAME: <ty> = <int>;` → value or null. */
export function rustConst(src, name) {
  const re = new RegExp(
    `\\bpub\\s+const\\s+${name}\\s*:\\s*\\w+\\s*=\\s*(-?[0-9][0-9_]*)\\b`,
  );
  const m = stripRustComments(src).match(re);
  return m ? Number(m[1].replace(/_/g, "")) : null;
}

/**
 * `SmsGlue.typeOf` arms: `"inbox" -> TYPE_INBOX,` (possibly `"draft", "drafts" -> TYPE_DRAFT,`)
 * → Map(wireName → constName).
 */
export function ktTypeOf(src) {
  const stripped = stripKtComments(src);
  const start = stripped.indexOf("fun typeOf(");
  if (start < 0) return new Map();
  const body = stripped.slice(start);
  const out = new Map();
  const re = /((?:"[a-z]+"\s*,?\s*)+)->\s*([A-Z][A-Z0-9_]*)/g;
  for (const m of body.matchAll(re)) {
    const tag = m[2];
    for (const w of m[1].matchAll(/"([a-z]+)"/g)) out.set(w[1], tag);
  }
  return out;
}

/**
 * `fn wire`: `SmsFolder::Inbox => "inbox",` → Map(variant → wireName) (first arm per variant).
 *
 * This is the **canonical** name per variant — what the glue *emits*. What the glue
 * *accepts* is [`rustAcceptedNames`]; R2 needs that one.
 */
export function rustWireNames(src) {
  const stripped = stripRustComments(src);
  const fn = stripped.indexOf("pub fn wire(");
  if (fn < 0) return new Map();
  const to = stripped.indexOf("pub fn from_wire", fn);
  const body = stripped.slice(fn, to < 0 ? undefined : to);
  const out = new Map();
  const re = /SmsFolder::(\w+)\s*=>\s*"([a-z]+)"/g;
  for (const m of body.matchAll(re)) if (!out.has(m[1])) out.set(m[1], m[2]);
  return out;
}

/**
 * `fn from_wire`: `"draft" | "drafts" => Ok(SmsFolder::Draft),` → Map(wireName → variant).
 *
 * The **acceptance set** — every string the Rust side resolves to a folder, including
 * aliases. This is the set `SmsGlue.typeOf` mirrors, so it is what R2 must compare against.
 */
export function rustAcceptedNames(src) {
  const stripped = stripRustComments(src);
  const fn = stripped.indexOf("pub fn from_wire(");
  if (fn < 0) return new Map();
  const body = stripped.slice(fn);
  const out = new Map();
  const re = /((?:"[a-z]+"\s*\|\s*)*"[a-z]+")\s*=>\s*Ok\(SmsFolder::(\w+)\)/g;
  for (const m of body.matchAll(re)) {
    for (const w of m[1].matchAll(/"([a-z]+)"/g)) out.set(w[1], m[2]);
  }
  return out;
}

/** `fn android_type`: `SmsFolder::Inbox => 1,` → Map(variant → number). */
export function rustAndroidTypes(src) {
  const stripped = stripRustComments(src);
  const fn = stripped.indexOf("pub fn android_type(");
  if (fn < 0) return new Map();
  const end = stripped.indexOf("\n    }", fn);
  const body = stripped.slice(fn, end < 0 ? undefined : end + 1);
  const out = new Map();
  const re = /SmsFolder::(\w+)\s*=>\s*([0-9]+)/g;
  for (const m of body.matchAll(re)) out.set(m[1], Number(m[2]));
  return out;
}

export function scan({ read = (p) => readFileSync(join(ROOT, p), "utf8"), floors = FLOORS } = {}) {
  const kt = read(KT);
  const wire = read(WIRE);
  const validate = read(VALIDATE);
  const folder = read(FOLDER);
  const findings = [];

  // R0 — floors (never let "found nothing" read as green).
  const caps = ktConsts(kt);
  const typeOf = ktTypeOf(kt);
  const wireNames = rustWireNames(folder);
  const accepted = rustAcceptedNames(folder);
  if (caps.size < floors.caps) {
    findings.push(`R0: found ${caps.size} Kotlin const(s); floor is ${floors.caps}`);
  }
  if (typeOf.size < floors.wireNames) {
    findings.push(`R0: found ${typeOf.size} wire-name → tag arm(s); floor is ${floors.wireNames}`);
  }
  if (wireNames.size < floors.folderTags) {
    findings.push(`R0: found ${wireNames.size} Rust folder variant(s); floor is ${floors.folderTags}`);
  }
  // The floor that used to be missing: the **acceptance set** is the one R2 compares against,
  // so counting only `wire()`'s canonical names left the floor blind to every alias.
  if (accepted.size < floors.acceptedNames) {
    findings.push(
      `R0: found ${accepted.size} Rust accepted name(s); floor is ${floors.acceptedNames}`,
    );
  }

  // R1 — the five caps equal their Rust authority.
  const capChecks = [
    ["MAX_THREADS", rustConst(wire, "MAX_THREADS"), "wire.rs"],
    ["MAX_MESSAGES", rustConst(wire, "MAX_MESSAGES"), "wire.rs"],
    ["MAX_TEXT_CHARS", rustConst(validate, "MAX_TEXT_CHARS"), "validate.rs"],
    ["MAX_ADDRESS_DIGITS", rustConst(validate, "MAX_ADDRESS_DIGITS"), "validate.rs"],
    ["MIN_ADDRESS_DIGITS", rustConst(validate, "MIN_ADDRESS_DIGITS"), "validate.rs"],
  ];
  for (const [name, expected, where] of capChecks) {
    if (expected === null) {
      findings.push(`R1: ${where} has no \`pub const ${name}\` to mirror`);
      continue;
    }
    if (!caps.has(name)) {
      findings.push(`R1: SmsGlue.kt does not define ${name} (${where} = ${expected})`);
      continue;
    }
    if (caps.get(name) !== expected) {
      findings.push(
        `R1: SmsGlue.kt ${name} = ${caps.get(name)} but ${where} says ${expected}`,
      );
    }
  }

  // R2 — folder tags: the Kotlin wire-name → TYPE_* map equals folder.rs's from_wire()/android_type().
  const types = rustAndroidTypes(folder);

  // (a) Rust-internal: `wire()` emits only names `from_wire()` accepts. Cheap, and it is the
  //     assumption the old one-directional check silently rested on.
  for (const [variant, wireName] of wireNames) {
    if (!accepted.has(wireName)) {
      findings.push(
        `R2: folder.rs wire() emits "${wireName}" for ${variant} but from_wire() does not accept it`,
      );
    }
  }

  // (b) Rust → Kotlin: every name Rust accepts — aliases included — has an arm, with the
  //     tag `android_type()` implies for that variant. This is the direction that used to
  //     cover only the canonical name.
  for (const [wireName, variant] of accepted) {
    const expected = types.get(variant);
    if (expected === undefined) {
      findings.push(`R2: folder.rs android_type() has no arm for ${variant}`);
      continue;
    }
    const tag = typeOf.get(wireName);
    if (tag === undefined) {
      findings.push(`R2: SmsGlue.kt typeOf() has no arm for wire name "${wireName}"`);
      continue;
    }
    const got = caps.get(tag);
    if (got !== expected) {
      findings.push(
        `R2: wire "${wireName}" -> ${tag} = ${got} but folder.rs android_type(${variant}) = ${expected}`,
      );
    }
  }

  // (c) Kotlin → Rust: every arm names a string Rust accepts. Without this, the Kotlin side
  //     could accept a folder name Rust has never heard of — the device resolves it, Rust
  //     rejects it — and the gate stayed green (the F-DEV-101 gap, measured).
  for (const wireName of typeOf.keys()) {
    if (!accepted.has(wireName)) {
      findings.push(
        `R2: SmsGlue.kt typeOf() accepts "${wireName}", which folder.rs from_wire() rejects`,
      );
    }
  }

  return findings;
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const findings = scan();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(
      "[sms-glue-const-scan] OK — SmsGlue.kt caps + folder tags match their Rust authority.",
    );
  } else {
    console.error("[sms-glue-const-scan] the Kotlin glue and its Rust authority disagree:");
    for (const f of findings) console.error("  - " + f);
  }
  if (findings.length > 0) process.exitCode = 1;
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_MAIN) main();

function selftest() {
  const cases = [];
  const ktOk = `
    private const val MAX_THREADS = 500
    private const val MAX_MESSAGES = 1000
    private const val MAX_TEXT_CHARS = 1600
    private const val MAX_ADDRESS_DIGITS = 20
    private const val MIN_ADDRESS_DIGITS = 3
    private const val TYPE_INBOX = 1
    private const val TYPE_SENT = 2
    private const val TYPE_DRAFT = 3
    private fun typeOf(folder: String): Int? = when (folder.trim().lowercase()) {
        "inbox" -> TYPE_INBOX
        "sent" -> TYPE_SENT
        "draft", "drafts" -> TYPE_DRAFT
        else -> null
    }
  `;
  const wireOk = `
    pub const MAX_PAYLOAD_BYTES: usize = 4 << 20;
    pub const MAX_THREADS: usize = 500;
    pub const MAX_MESSAGES: usize = 1000;
  `;
  const validateOk = `
    pub const MAX_TEXT_CHARS: usize = 1600;
    pub const MAX_ADDRESS_DIGITS: usize = 20;
    pub const MIN_ADDRESS_DIGITS: usize = 3;
  `;
  const folderOk = `
    pub fn wire(self) -> &'static str {
        match self {
            SmsFolder::Inbox => "inbox",
            SmsFolder::Sent => "sent",
            SmsFolder::Draft => "draft",
        }
    }
    pub fn from_wire(name: &str) -> Result<Self, SmsError> {
        match name.trim().to_ascii_lowercase().as_str() {
            "inbox" => Ok(SmsFolder::Inbox),
            "sent" => Ok(SmsFolder::Sent),
            "draft" | "drafts" => Ok(SmsFolder::Draft),
            other => Err(SmsError::Invalid(other.to_string())),
        }
    }
    pub fn android_type(self) -> u32 {
        match self {
            SmsFolder::Inbox => 1,
            SmsFolder::Sent => 2,
            SmsFolder::Draft => 3,
        }
    }
  `;
  const read = (p) =>
    ({ [KT]: ktOk, [WIRE]: wireOk, [VALIDATE]: validateOk, [FOLDER]: folderOk })[p];
  const t = (name, cond) => cases.push([name, cond]);

  t("clean trio has no findings", scan({ read }).length === 0);

  const cap = (kt, name, val) =>
    scan({ read: (p) => (p === KT ? kt : read(p)) }).some((f) =>
      f.startsWith(`R1: SmsGlue.kt ${name} = ${val}`),
    );
  t(
    "a bumped MAX_THREADS is R1",
    cap(ktOk.replace("MAX_THREADS = 500", "MAX_THREADS = 600"), "MAX_THREADS", 600),
  );
  t(
    "a bumped MAX_TEXT_CHARS is R1",
    cap(ktOk.replace("MAX_TEXT_CHARS = 1600", "MAX_TEXT_CHARS = 1700"), "MAX_TEXT_CHARS", 1700),
  );
  t(
    "a lowered MIN_ADDRESS_DIGITS is R1",
    cap(ktOk.replace("MIN_ADDRESS_DIGITS = 3", "MIN_ADDRESS_DIGITS = 4"), "MIN_ADDRESS_DIGITS", 4),
  );
  t(
    "a missing Kotlin cap is R1",
    scan({ read: (p) => (p === KT ? ktOk.replace(/.*MAX_MESSAGES.*\n/, "") : read(p)) }).some((f) =>
      f.startsWith("R1: SmsGlue.kt does not define MAX_MESSAGES"),
    ),
  );

  const r2 = (folder, needle) =>
    scan({ read: (p) => (p === FOLDER ? folder : read(p)) }).some((f) => f.includes(needle));
  t(
    "a moved MESSAGE_TYPE number is R2",
    r2(folderOk.replace("SmsFolder::Draft => 3", "SmsFolder::Draft => 4"), "android_type(Draft) = 4"),
  );
  const r2kt = (kt, needle) =>
    scan({ read: (p) => (p === KT ? kt : read(p)) }).some((f) => f.includes(needle));
  t(
    "a renamed Kotlin folder is R2",
    r2kt(ktOk.replace(/"sent" -> TYPE_SENT/, '"sentmsg" -> TYPE_SENT'), 'no arm for wire name "sent"'),
  );
  t(
    "a wrong Kotlin folder tag is R2",
    r2kt(ktOk.replace('"sent" -> TYPE_SENT', '"sent" -> TYPE_DRAFT'), "wire \"sent\" -> TYPE_DRAFT = 3"),
  );

  t(
    "floors fire when the scan finds nothing",
    scan({
      read: () => "",
    }).some((f) => f.startsWith("R0:")),
  );
  t(
    "the acceptance-set floor fires on its own (canonical names alone are not enough)",
    scan({
      read: (p) => (p === FOLDER ? folderOk.replace(/pub fn from_wire[\s\S]*?\n    \}/, "") : read(p)),
    }).some((f) => f.startsWith("R0: found 0 Rust accepted name(s)")),
  );

  // ── REQ-A815 / F-DEV-101: R2 must bind the **acceptance set** in both directions. ──
  // Before the fix all four of these were green: the loop ran over `wire()`'s three
  // canonical names, so an alias on either side was invisible.
  t(
    "a Kotlin arm Rust does not accept is R2",
    r2kt(ktOk.replace('"draft", "drafts" -> TYPE_DRAFT', '"draft", "outbox" -> TYPE_DRAFT'),
      'typeOf() accepts "outbox"'),
  );
  t(
    "a Rust alias the Kotlin side dropped is R2",
    r2kt(ktOk.replace('"draft", "drafts" -> TYPE_DRAFT', '"draft" -> TYPE_DRAFT'),
      'no arm for wire name "drafts"'),
  );
  t(
    "a Kotlin-only alias is R2 even when every canonical name still resolves",
    r2kt(ktOk.replace('"draft", "drafts" -> TYPE_DRAFT', '"draft" -> TYPE_DRAFT, "drafts" -> TYPE_DRAFT')
      // the canonical names are all still present; only the alias set differs in spelling
      .replace('"drafts" -> TYPE_DRAFT', '"draftz" -> TYPE_DRAFT'),
      'typeOf() accepts "draftz"'),
  );
  t(
    "a wire() name from_wire() rejects is R2 (the Rust-internal arm)",
    r2(folderOk.replace('SmsFolder::Draft => "draft"', 'SmsFolder::Draft => "trash"'),
      'from_wire() does not accept it'),
  );
  t(
    "Rust dropping an alias the Kotlin side still maps is R2",
    r2(folderOk.replace('"draft" | "drafts" => Ok', '"draft" => Ok'),
      'typeOf() accepts "drafts"'),
  );

  // ── Comment-stripping, two-sided (the F-DEV-098 shape; latent here, so it is pinned). ──
  const KT_OLD_ARMS_COMMENT = `
    // Historical shape, kept for the migration note:
    //   "sent" -> TYPE_SENT
    //   "draft", "drafts" -> TYPE_DRAFT
  `;
  t(
    "a comment quoting the old arms does not redden a correct Kotlin file",
    scan({ read: (p) => (p === KT ? ktOk + KT_OLD_ARMS_COMMENT : read(p)) }).length === 0,
  );
  t(
    "…and the same comment above a regressed arm is still caught",
    r2kt(ktOk.replace('"sent" -> TYPE_SENT', '"sentmsg" -> TYPE_SENT') + KT_OLD_ARMS_COMMENT,
      'no arm for wire name "sent"'),
  );
  t(
    "…and that regressed arm is red with no comment above it",
    r2kt(ktOk.replace('"sent" -> TYPE_SENT', '"sentmsg" -> TYPE_SENT'),
      'no arm for wire name "sent"'),
  );
  t(
    "a doc comment quoting the correct const does not hide a regressed Rust const",
    scan({
      read: (p) =>
        p === WIRE
          ? `/// Mirrors the glue: pub const MAX_THREADS: usize = 500;\n` +
            wireOk.replace("MAX_THREADS: usize = 500", "MAX_THREADS: usize = 800")
          : read(p),
    }).some((f) => f.startsWith("R1: SmsGlue.kt MAX_THREADS = 500 but wire.rs says 800")),
  );
  t(
    "a Rust const that does not exist is R1",
    scan({ read: (p) => (p === VALIDATE ? "" : read(p)) }).some((f) =>
      f.startsWith("R1: validate.rs has no `pub const MAX_TEXT_CHARS`"),
    ),
  );

  let ok = true;
  for (const [name, cond] of cases) {
    console.log(`  [${cond ? "ok" : "FAIL"}] ${name}`);
    if (!cond) ok = false;
  }
  console.log(`[sms-glue-const-scan] selftest ${ok ? "OK" : "FAILED"} — ${cases.length} case(s).`);
  if (!ok) process.exitCode = 1;
}
