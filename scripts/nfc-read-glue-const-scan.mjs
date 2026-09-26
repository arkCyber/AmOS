#!/usr/bin/env node
// "reading an NFC tag: one `null` carries four different answers, and the screen renders the
// fold as a fact about the tag" — `NfcGlue.readTagBytes()` used to be
//
//     @JvmStatic
//     fun readTagBytes(): String? {
//         val tag = lastTag ?: return null              // (a) no tag has been seen
//         return try {
//             val ndef = Ndef.get(tag)
//             if (ndef != null) {
//                 ndef.connect(); val msg = ndef.ndefMessage; ndef.close()
//                 msg?.toByteArray()?.joinToString("") { … }  // (b) `null` here = read fine,
//             } else { … }                                    //     tag has no NDEF payload
//         } catch (_: Exception) { null }                   // (c) the read threw
//     }
//
// and `crates/amos-tauri/src/ble.rs` added a fourth on its way out:
//
//     let result = android_jni::with_context(|_ctx, env| { … });
//     Ok(result.flatten())          // (d) unbound glue / JNI error / the host build
//
// `NfcApp.svelte` then had exactly one branch —
//
//     notice = { key: hex === null ? "nfc.readFailed" : "nfc.readOk", ok: hex !== null };
//
// — so (a)–(d) all printed **"读取失败：系统没有返回卡片字节"**, a sentence *about the tag*.
// The tag that was read perfectly well and simply has nothing on it was reported as a failed
// read; and the case where the question never reached the glue at all (no Activity bound the
// Context) was reported as the tag's own answer. The screen already carried the copy for the
// honest half — `{readHex === "" ? t("nfc.readEmpty") : readHex}` — which no producer could
// ever reach, because `readTagBytes()` returns `null`, never `""`.
//
// The second half of the same walk is **which tag was read**. The glue can only ever act on
// `lastTag`, one field overwritten by every discovery; the screen addresses a tag the user
// picked out of a list of up to 50. `nfc_read_bytes(tag_id)` logged its `tag_id` and ignored
// it, so the hex of whatever tag was last waved appeared inside the card of whichever tag the
// user had selected — under that tag's id and that tag's NDEF records, with nothing to say the
// two disagreed. A read that does not report the tag it read cannot be displayed per tag.
//
// Rules:
//   R0 floors      — the extractions found the shapes they look for, so "scanned nothing" is red.
//   R1 the fold    — the read member must not answer one nullable String. On that shape the
//                    scan names every distinct answer folded into it, including the dead
//                    `nfc.readEmpty` copy it makes unreachable.
//   R2 wire ⊆ Rust — the states the glue emits are `NfcReadState` variants (minus `unavailable`,
//                    which only this side can answer).
//   R3 TS = Rust   — `NfcReadStateWire` in `lib/nfc.ts` is exactly the Rust `NfcReadState`
//                    variants, so neither can grow a state the other has never heard of.
//   R4 one wording — every notice key `nfcReadNoticeKey` can return is a key present in **both**
//                    locale dictionaries, so a state cannot reach the screen with no sentence.
//   R5 which tag   — the glue's reply carries the id it read (`"id"`), the Rust result carries it
//                    (`tag_id`), and `lib/nfc.ts::nfcReadBelongsTo` is what the screen compares
//                    the user's selection against. The rule exists because the glue cannot be
//                    driven by an id: it reads `lastTag` or nothing.
//
// Written by source text: nothing here is compiled, installed, or on a device.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** R0's floors — the counts below which an extraction is treated as "found nothing". */
export const FLOORS = { calls: 4, states: 4, fields: 4 };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KT = "crates/amos-tauri/android-glue/com/amos/ai/glue/NfcGlue.kt";
const RUST = "crates/amos-tauri/src/ble.rs";
const TS = "crates/amos-tauri/frontend-ts/src/lib/nfc.ts";
const ZH = "crates/amos-tauri/frontend-ts/src/i18n/locales/zh.ts";
const EN = "crates/amos-tauri/frontend-ts/src/i18n/locales/en.ts";
const SCREEN = "crates/amos-tauri/frontend-ts/src/svelte/NfcApp.svelte";

/**
 * What each state the glue can emit must be worded as, and why that wording may not be
 * shared. This table is the **expectation**, not a mirror: R4 compares the keys
 * `nfcReadNoticeKey` actually returns against it, so a new state that quietly reuses
 * `failed`'s sentence is a finding.
 *
 * `nfc.readEmpty` is deliberately absent — it is the in-card rendering of a zero-length
 * payload ("（空）"), not a notice. It is the copy the shipped fold made dead, and it is
 * checked by R1's finding text rather than by this table.
 */
export const NOTICE_KEY = {
  bytes: "nfc.readOk",
  empty: "nfc.readNoPayload",
  "no-tag": "nfc.readNoTag",
  failed: "nfc.readFailed",
  unavailable: "nfc.readUnavailable",
};

/** The one key the identity branch returns, which is not a state of its own. */
export const OTHER_TAG_KEY = "nfc.readOtherTag";

/** The states Rust alone can produce: no device emits them, so the glue must not claim them. */
export const HOST_ONLY = "unavailable";

/**
 * `NfcGlue.kt` with its comments removed — because **the prose is not the code**.
 *
 * This file's own doc block quotes the shipped shape verbatim (`fun readTagBytes(): String?`,
 * `readReply("bytes", …)`) in order to explain what changed. Read raw, that prose answers every
 * question this scan asks: `ktReadReturnType` would return the *quoted* type rather than the
 * declared one, and `ktReadStates` would count the *quoted* calls toward the floor. Both
 * directions are silent failures — the extractor that reads prose reports a type that is not
 * there (so R1's shape test can never fire, which is exactly what a negative control caught:
 * reverting the real declaration to `String?` left R1 mute), and a floor padded by quoted calls
 * stops noticing a deleted one. Strip block and line comments first, then read.
 */
export function stripKtComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\s*\/\/.*$/, ""))
    .join("\n");
}

/** `@JvmStatic fun readTagBytes(): String?` — the shipped fold's return type. */
export function ktReadReturnType(src) {
  const m = stripKtComments(src).match(/fun\s+readTagBytes\s*\([^)]*\)\s*:\s*([^\s{]+)/);
  return m ? m[1] : null;
}

/**
 * The states the read can answer: the first argument of every `readReply("…", …)` call.
 *
 * Keying on the helper's name is deliberate — the four call sites are where the four
 * answers are *decided*, and a rename is caught by R0 (the floor) rather than by silence.
 */
export function ktReadStates(src) {
  const out = new Set();
  for (const m of stripKtComments(src).matchAll(/readReply\(\s*"([a-z-]+)"/g)) out.add(m[1]);
  return out;
}

/** The fields the reply object carries: every `put("…"` in `readReply`'s body. */
export function ktReplyFields(src) {
  const m = stripKtComments(src).match(/private\s+fun\s+readReply\s*\([\s\S]*?\n\s*\}/);
  if (!m) return new Set();
  const out = new Set();
  for (const f of m[0].matchAll(/\.put\(\s*"(\w+)"/g)) out.add(f[1]);
  return out;
}

/**
 * The **shipped** shape: `fun readTagBytes(): String?` with `?: return null` and a
 * `catch (_: Exception) { null }`. Returns the distinct answers folded into `null`, or
 * null when the file is already shape A, so the caller can tell "not this shape" from
 * "this shape with nothing folded in".
 */
export function ktNullFolds(src) {
  if (ktReadReturnType(src) !== "String?") return null;
  const body = stripKtComments(src).match(/fun\s+readTagBytes\s*\([^)]*\)[\s\S]*?\n\s{4}\}/);
  if (!body) return null;
  const folded = [];
  if (/\?:\s*return\s+null/.test(body[0])) folded.push("no tag has been seen at all");
  if (/catch\s*\([^)]*\)\s*\{\s*null\s*\}/.test(body[0]) || /catch\s*\([^)]*\)\s*\{[\s\S]{0,120}?\bnull\b\s*\}/.test(body[0]))
    folded.push("the read threw (the tag moved away, an I/O error)");
  if (/ndefMessage/.test(body[0]) && /\?\./.test(body[0]))
    folded.push("a tag that was read fine and holds no NDEF payload");
  return folded;
}

/** `#[serde(rename_all = "kebab-case")] pub enum NfcReadState { … }` → its wire spellings. */
export function rustReadStates(src) {
  const m = src.match(/pub\s+enum\s+NfcReadState\s*\{([\s\S]*?)\n\s*\}/);
  if (!m) return null;
  const out = new Set();
  for (const v of m[1].matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*,/gm)) out.add(kebab(v[1]));
  return out;
}

/** The `NfcReadStateWire` union in `lib/nfc.ts`. */
export function tsReadStates(src) {
  const m = src.match(/export\s+type\s+NfcReadStateWire\s*=([\s\S]*?);/);
  if (!m) return null;
  const out = new Set();
  for (const s of m[1].matchAll(/"([a-z-]+)"/g)) out.add(s[1]);
  return out;
}

/**
 * The notice keys `nfcReadNoticeKey` can return — read off the function, not off the table,
 * so R4 compares the two rather than restating one of them.
 */
export function tsNoticeKeys(src) {
  const m = src.match(/export\s+function\s+nfcReadNoticeKey\s*\([\s\S]*?\n\}/);
  if (!m) return null;
  const out = new Set();
  for (const s of m[0].matchAll(/"(nfc\.[A-Za-z0-9_]+)"/g)) out.add(s[1]);
  return out;
}

/** Which of the two locale dictionaries declares each key (both must). */
export function localeKeys(src) {
  const out = new Set();
  for (const m of src.matchAll(/"(nfc\.[A-Za-z0-9_]+)"\s*:/g)) out.add(m[1]);
  return out;
}

/** CamelCase → kebab-case, matching serde's `rename_all`. */
function kebab(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function scan(opts = {}) {
  const read = opts.read ?? ((p) => readFileSync(join(ROOT, p), "utf8"));
  const floors = opts.floors ?? FLOORS;
  const findings = [];

  const kt = read(KT);
  const rust = read(RUST);
  const ts = read(TS);
  const zh = read(ZH);
  const en = read(EN);
  const screen = read(SCREEN);

  const retType = ktReadReturnType(kt);
  const states = ktReadStates(kt);
  const fields = ktReplyFields(kt);
  const rustStates = rustReadStates(rust);
  const tsStates = tsReadStates(ts);
  const noticeKeys = tsNoticeKeys(ts);
  const zhKeys = localeKeys(zh);
  const enKeys = localeKeys(en);

  // ── R0: the extractions found their shapes ────────────────────────────────────
  if (!retType) {
    findings.push(
      `R0: no \`fun readTagBytes(...): T\` in ${KT} — the scan cannot judge what the read replies ` +
        `with; if the member moved, move this rule with it`,
    );
  }
  if (states.size < floors.calls) {
    findings.push(
      `R0: found ${states.size} \`readReply("…")\` call(s) in ${KT}, floor is ${floors.calls} — ` +
        `fewer than the number of answers the read is supposed to give`,
    );
  }
  if (fields.size < floors.fields) {
    findings.push(
      `R0: \`readReply\` in ${KT} carries ${fields.size} field(s), floor is ${floors.fields}`,
    );
  }
  if (rustStates === null) findings.push(`R0: no \`pub enum NfcReadState\` in ${RUST}`);
  if (tsStates === null) findings.push(`R0: no \`export type NfcReadStateWire\` in ${TS}`);
  if (noticeKeys === null) findings.push(`R0: no \`nfcReadNoticeKey\` in ${TS}`);

  // ── R1: the fold ──────────────────────────────────────────────────────────────
  const folded = ktNullFolds(kt);
  if (folded !== null) {
    findings.push(
      `R1: \`readTagBytes(): String?\` answers one \`null\` for ${folded.length} different thing(s): ` +
        folded.join("; ") +
        `. One value cannot be read back apart, so every caller invents the same answer for all ` +
        `of them — and the sentence it invents is about the tag`,
    );
    if (folded.some((f) => f.includes("no NDEF payload"))) {
      findings.push(
        `R1: because the \`null\` path above *is* how "the tag holds nothing" is reported, ` +
          `\`nfc.readEmpty\` in ${SCREEN} (\`readHex === "" ? t("nfc.readEmpty") : readHex\`) is ` +
          `**unreachable copy** — no producer of \`read_hex\` can ever yield the empty string`,
      );
    }
  }

  // ── R2: wire ⊆ Rust ───────────────────────────────────────────────────────────
  if (rustStates !== null) {
    for (const s of states) {
      if (s === HOST_ONLY) {
        findings.push(
          `R2: the glue emits "${s}", which is this side's own state — \`NfcReadState::Unavailable\` ` +
            `means "no device answered", so a device that answers with it makes the word a lie`,
        );
        continue;
      }
      if (!rustStates.has(s)) {
        findings.push(
          `R2: the glue emits "${s}", which is not a \`NfcReadState\` variant ` +
            `([${[...rustStates].join(", ")}]) — the fold would have no arm for it`,
        );
      }
    }
    // The other direction: a Rust state no device can produce (other than the host-only one)
    // is a screen branch nothing can reach.
    for (const s of rustStates) {
      if (s === HOST_ONLY) continue;
      if (!states.has(s)) {
        findings.push(
          `R2: NfcReadState has "${s}", which the glue can never emit — a branch no device ` +
            `can reach`,
        );
      }
    }
  }

  // ── R3: TS = Rust ─────────────────────────────────────────────────────────────
  if (rustStates !== null && tsStates !== null) {
    for (const s of rustStates) {
      if (!tsStates.has(s)) {
        findings.push(`R3: NfcReadStateWire has no "${s}" — Rust can send a state the frontend has no word for`);
      }
    }
    for (const s of tsStates) {
      if (!rustStates.has(s)) {
        findings.push(`R3: NfcReadStateWire has "${s}", which is not a NfcReadState variant`);
      }
    }
  }

  // ── R4: one wording per state, in both dictionaries ───────────────────────────
  if (noticeKeys !== null && tsStates !== null) {
    const expected = new Set(Object.values(NOTICE_KEY));
    for (const [state, key] of Object.entries(NOTICE_KEY)) {
      if (tsStates !== null && !tsStates.has(state)) continue; // R2/R3 already said so
      if (!noticeKeys.has(key)) {
        findings.push(
          `R4: state "${state}" has no notice — \`nfcReadNoticeKey\` should return "${key}" for it ` +
            `(the screen would fall through to whatever the last arm says)`,
        );
      }
    }
    for (const key of noticeKeys) {
      if (key === OTHER_TAG_KEY) continue;
      if (!expected.has(key)) {
        findings.push(
          `R4: \`nfcReadNoticeKey\` returns "${key}", which this scan has no state for — a new ` +
            `state must name its own sentence here rather than borrow another state's`,
        );
      }
    }
    for (const key of noticeKeys) {
      for (const [name, dict] of [
        ["zh.ts", zhKeys],
        ["en.ts", enKeys],
      ]) {
        if (!dict.has(key)) {
          findings.push(`R4: \`nfcReadNoticeKey\` can return "${key}", which ${name} does not define`);
        }
      }
    }
  }

  // ── R5: which tag was read ────────────────────────────────────────────────────
  if (fields.size >= floors.fields && !fields.has("id")) {
    findings.push(
      `R5: \`readReply\` in ${KT} does not carry the id of the tag it read — the screen shows the ` +
        `bytes inside whichever tag the user selected, so a read that does not say which tag it ` +
        `came from cannot be attributed to one`,
    );
  }
  if (rustStates !== null && !/pub\s+tag_id\s*:\s*Option<String>/.test(rust)) {
    findings.push(`R5: \`NfcReadResult\` in ${RUST} does not carry \`pub tag_id: Option<String>\``);
  }
  if (!/tag_id\??\s*:/.test(ts)) {
    findings.push(`R5: \`NfcReadOutcome\` in ${TS} does not carry \`tag_id\``);
  }
  if (!/export\s+function\s+nfcReadBelongsTo\s*\(/.test(ts)) {
    findings.push(
      `R5: ${TS} has no \`nfcReadBelongsTo(outcome, tagId)\` — the comparison between the tag the ` +
        `screen asked about and the tag the glue read has to live somewhere a test can pin it`,
    );
  } else if (!/tag_id\s*===/.test(ts)) {
    findings.push(`R5: \`nfcReadBelongsTo\` does not compare \`tag_id\` with the requested id`);
  }
  if (!/nfcReadBelongsTo\(/.test(screen)) {
    findings.push(
      `R5: ${SCREEN} never asks \`nfcReadBelongsTo\` — it renders the read under the selected ` +
        `tag regardless of which tag answered`,
    );
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
      "[nfc-read-glue-const-scan] OK — NfcGlue's read answer says which of the four things " +
        "happened and which tag it happened to.",
    );
  } else {
    console.error("[nfc-read-glue-const-scan] the NFC read answer cannot be read back apart:");
    for (const f of findings) console.error("  - " + f);
  }
  if (findings.length > 0) process.exitCode = 1;
}

/** The Rust side, shared by the selftest fixtures (kept minimal — the scan reads the real one). */
const RUST_OK = `
    #[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "kebab-case")]
    pub enum NfcReadState {
        Bytes,
        Empty,
        NoTag,
        Failed,
        Unavailable,
    }

    pub struct NfcReadResult {
        pub state: NfcReadState,
        pub tag_id: Option<String>,
        pub hex: Option<String>,
        pub detail: Option<String>,
    }
`;

/** The **fixed** glue: what this repository should contain after REQ-A781. */
const KT_OK = `
    @JvmStatic
    fun readTagBytes(): String {
        val tag = lastTag
            ?: return readReply("no-tag", null, null, null)
        val tagId = tag.id.joinToString("") { "%02x".format(it) }
        return try {
            val ndef = Ndef.get(tag)
            if (ndef == null) {
                readReply("bytes", tagId, tagId, null)
            } else {
                ndef.connect()
                val msg = ndef.ndefMessage
                ndef.close()
                val bytes = msg?.toByteArray()
                if (bytes == null) readReply("empty", tagId, null, null)
                else readReply("bytes", tagId, bytes.joinToString("") { "%02x".format(it) }, null)
            }
        } catch (e: Exception) {
            Log.w(TAG, "readTagBytes failed", e)
            readReply("failed", tagId, null, e.message ?: e.javaClass.simpleName)
        }
    }

    private fun readReply(state: String, id: String?, hex: String?, error: String?): String {
        return JSONObject()
            .put("state", state)
            .put("id", id ?: JSONObject.NULL)
            .put("hex", hex ?: JSONObject.NULL)
            .put("error", error ?: JSONObject.NULL)
            .toString()
    }
`;

/**
 * The **historical** glue, read out of `git show HEAD:` rather than imagined: one nullable
 * String, with three different reasons to be null inside it.
 */
const KT_NULL_SHAPE = `
    @JvmStatic
    fun readTagBytes(): String? {
        val tag = lastTag ?: return null
        return try {
            val ndef = Ndef.get(tag)
            if (ndef != null) {
                ndef.connect()
                val msg = ndef.ndefMessage
                ndef.close()
                msg?.toByteArray()?.joinToString("") { "%02x".format(it) }
            } else {
                tag.id.joinToString("") { "%02x".format(it) }
            }
        } catch (_: Exception) {
            null
        }
    }
`;

const TS_OK = `
export type NfcReadStateWire =
  | "bytes"
  | "empty"
  | "no-tag"
  | "failed"
  | "unavailable";

export interface NfcReadOutcome {
  state: NfcReadStateWire;
  tag_id?: string;
  hex?: string;
  detail?: string;
}

export function nfcReadBelongsTo(out: NfcReadOutcome | null, tagId: string): boolean {
  return (out?.state === "bytes" || out?.state === "empty") && out.tag_id === tagId;
}

export function nfcReadNoticeKey(out: NfcReadOutcome, requestedTagId: string): string {
  if (!nfcReadBelongsTo(out, requestedTagId) && (out.state === "bytes" || out.state === "empty")) {
    return "nfc.readOtherTag";
  }
  switch (out.state) {
    case "bytes":
      return "nfc.readOk";
    case "empty":
      return "nfc.readNoPayload";
    case "no-tag":
      return "nfc.readNoTag";
    case "failed":
      return "nfc.readFailed";
    default:
      return "nfc.readUnavailable";
  }
}
`;

/** Both dictionaries with every key R4 asks for. */
const KEYS_OK = `
  "nfc.readOk": "ok",
  "nfc.readEmpty": "(empty)",
  "nfc.readNoPayload": "no payload",
  "nfc.readNoTag": "no tag",
  "nfc.readFailed": "failed",
  "nfc.readUnavailable": "unavailable",
  "nfc.readOtherTag": "other tag",
`;

const SCREEN_OK = `
    readHex = nfcReadBelongsTo(read, selected.id) ? (read.hex ?? "") : null;
`;

function selftest() {
  const cases = [];
  const run = (o = {}) => {
    const files = {
      [KT]: o.kt ?? KT_OK,
      [RUST]: o.rust ?? RUST_OK,
      [TS]: o.ts ?? TS_OK,
      [ZH]: o.zh ?? KEYS_OK,
      [EN]: o.en ?? KEYS_OK,
      [SCREEN]: o.screen ?? SCREEN_OK,
    };
    return scan({ read: (p) => files[p] ?? "", floors: FLOORS });
  };

  // 1. The fixed tree is clean.
  {
    const f = run();
    cases.push(["the fixed glue passes", f.length === 0, f.join("; ")]);
  }
  // 2. **The defect this scan exists for**: the shipped nullable read is red, and the red
  //    names the three things folded into the one `null` plus the copy it makes dead.
  {
    const f = run({ kt: KT_NULL_SHAPE });
    cases.push([
      "the shipped `readTagBytes(): String?` is a finding naming every fold",
      f.some((x) => x.startsWith("R1") && x.includes("no NDEF payload")) &&
        f.some((x) => x.startsWith("R1") && x.includes("no tag has been seen")) &&
        f.some((x) => x.startsWith("R1") && x.includes("unreachable copy")),
      f.join("; ") || "no findings — the scan cannot see the defect it was written for",
    ]);
  }
  // 3. A reply that reports the tag under some other name is a finding even when every state
  //    is right and the field count is unchanged.
  {
    const kt = KT_OK.replace('.put("id", id ?: JSONObject.NULL)', '.put("tag", id ?: JSONObject.NULL)');
    const f = run({ kt });
    cases.push([
      "a reply that does not say which tag it read is a finding",
      f.some((x) => x.startsWith("R5") && x.includes("does not carry the id")),
      f.join("; "),
    ]);
  }
  // 3b. **Prose is not code.** `NfcGlue.kt`'s own doc block quotes the shipped shape
  //     (`fun readTagBytes(): String?`, `readReply("bytes", …)`) to explain what changed, and
  //     a scan that reads the file raw answers its questions from that quote: the declared
  //     return type is reported as the *quoted* one (so R1's shape test can never fire — the
  //     negative control that reverted the real declaration to `String?` left R1 mute) and the
  //     quoted call sites pad R0's floor. Both directions are checked here: a correct file
  //     that merely *mentions* the fold stays green, and the fold is still caught when the
  //     same prose sits above it.
  {
    const prose = `
/**
 * This used to be \`fun readTagBytes(): String?\`, and its single \`null\` was the answer
 * to \`readReply("no-tag", null, null, null)\` and \`readReply("empty", id, null, null)\`.
 */
`;
    const correct = run({ kt: prose + KT_OK });
    cases.push([
      "prose quoting the old shape does not redden the fixed file",
      correct.length === 0,
      correct.join("; ") || "",
    ]);
    const folded = run({ kt: prose + KT_NULL_SHAPE });
    cases.push([
      "the fold is still caught with the same prose above it",
      folded.some((x) => x.startsWith("R1") && x.includes("no NDEF payload")) &&
        folded.some((x) => x.startsWith("R1") && x.includes("no tag has been seen")),
      folded.join("; ") || "no findings — the scan read the prose instead of the code",
    ]);
  }
  // 4. A state the glue emits that Rust has never heard of is a finding.
  {
    const kt = KT_OK.replace('readReply("no-tag", null, null, null)', 'readReply("gone", null, null, null)');
    const f = run({ kt });
    cases.push([
      "a glue state Rust has no variant for is a finding",
      f.some((x) => x.startsWith("R2") && x.includes('"gone"')),
      f.join("; "),
    ]);
  }
  // 5. A Rust state no device can emit is a finding (a branch nothing can reach).
  {
    const rust = RUST_OK.replace("        Failed,\n", "");
    const f = run({ rust });
    cases.push([
      "a Rust state the glue cannot emit is a finding",
      f.some((x) => x.startsWith("R2") && x.includes('"failed"')),
      f.join("; "),
    ]);
  }
  // 6. The glue answering with Rust's host-only state makes the word a lie.
  {
    const kt = KT_OK.replace('readReply("no-tag", null, null, null)', 'readReply("unavailable", null, null, null)');
    const f = run({ kt });
    cases.push([
      "the glue emitting `unavailable` is a finding",
      f.some((x) => x.startsWith("R2") && x.includes("makes the word a lie")),
      f.join("; "),
    ]);
  }
  // 7. A state with no notice of its own is a finding (it would borrow another's sentence).
  {
    const ts = TS_OK.replace('    case "empty":\n      return "nfc.readNoPayload";\n', "");
    const f = run({ ts });
    cases.push([
      "a state whose notice key is missing is a finding",
      f.some((x) => x.startsWith("R4") && x.includes("nfc.readNoPayload")),
      f.join("; "),
    ]);
  }
  // 8. A notice key one dictionary forgot is a finding — the exact shape of the dead copy.
  {
    const zh = KEYS_OK.replace('  "nfc.readNoPayload": "no payload",\n', "");
    const f = run({ zh });
    cases.push([
      "a notice key missing from one locale is a finding",
      f.some((x) => x.startsWith("R4") && x.includes("zh.ts")),
      f.join("; "),
    ]);
  }
  // 9. A screen that never compares the ids is a finding.
  {
    const screen = "    notice = { key: hex === null ? \"nfc.readFailed\" : \"nfc.readOk\" };";
    const f = run({ screen });
    cases.push([
      "a screen that does not ask which tag answered is a finding",
      f.some((x) => x.startsWith("R5") && x.includes("never asks")),
      f.join("; "),
    ]);
  }
  // 10. `nfcReadBelongsTo` must compare, not merely exist.
  {
    const ts = TS_OK.replace("out.tag_id === tagId", "true");
    const f = run({ ts });
    cases.push([
      "`nfcReadBelongsTo` that does not compare is a finding",
      f.some((x) => x.startsWith("R5") && x.includes("does not compare")),
      f.join("; "),
    ]);
  }
  // 11. Read from the repository: the real files must satisfy the same rules the fixtures do.
  {
    const f = scan();
    cases.push([
      "the repository's own files pass",
      f.length === 0,
      f.join("; "),
    ]);
  }

  let failed = 0;
  for (const [name, ok, why] of cases) {
    if (ok) console.log(`  ok  ${name}`);
    else {
      failed += 1;
      console.error(`  FAIL ${name}${why ? " — " + why : ""}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} of ${cases.length} self-tests failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${cases.length} self-tests passed.`);
  }
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_MAIN) main();
