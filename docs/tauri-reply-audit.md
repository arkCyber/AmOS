# Tauri reply audit — "the shell reads a reply shape the command does not send"

## Why this exists

The boundary gates grew one wire direction at a time, and each new direction found
a defect the previous ones could not see:

| Gate | Direction | Found |
| --- | --- | --- |
| `unwired-scan.mjs` | is an export *called*? | `ClipboardAnnounce` unmounted, RAG run never invoked |
| `tauri-command-scan.mjs` | is a command *asked for*? | the shared-store write-through was dead |
| `tauri-args-scan.mjs` | can the call **succeed**? | `rag_query`'s `top_k`, `interpret_start`'s `source_lang` |
| **`tauri-reply-scan.mjs`** | is the **reply** what the shell thinks? | the SMS trash panel, dead on device |

Tauri serializes a command's return value with **serde's own rules** — nothing in
this workspace sets `rename_all = "camelCase"`, so a struct's fields keep their Rust
spelling, a `bool` stays a boolean and a `usize` a number. A shell type that says
otherwise compiles, type-checks and passes every test that uses a fake bridge, while
the real reply is `undefined`/`not a string`:

* `sms_trash_list` answers `Vec<TrashOut>` (`thread_id`, `message_id`, `ts_ms`,
  `trashed_ms`); `SmsTrashEntryOut` declared `threadId`/`messageId`/`tsMs`/
  `trashedMs` ⇒ blank rows, a keyed-`each` on `"undefined/undefined"`, and a restore
  that sent blank ids;
* `sms_trash_restore` answers `bool` and `sms_trash_purge` a `usize`, but the
  wrappers compared them to `"restored"`/`"purged"` ⇒ a successful restore/purge was
  reported as a **failure** and the list never refreshed;
* `interpret_start` answers `u64`, typed `string` ⇒ a type lie that would make any
  comparison written against the declared type silently never match.

## What it checks

Per `invoke<T>("cmd")` in production `frontend-ts/src`:

1. **value kind** — Rust `bool` ⇒ TS `boolean`, integer/float ⇒ `number`,
   `String`/`&str` ⇒ `string`, `Vec<T>` ⇒ `T[]`, `() `⇒ `void`/`undefined`;
2. **object fields** — every field the TS type declares must exist in the Rust
   struct/enum's serialized field set (the camelCase-vs-snake_case class);
3. a Rust field the shell never reads is **informational only** (the shell need not
   model every wire field).

`Result<T, E>` is unwrapped to its `Ok` type, `Option<T>`/`Vec<T>` recurse, and
`#[serde(rename_all = "camelCase")]` is honoured — so the gate follows the
generator's rules rather than a hard-coded convention.

## Honest boundary

Unverifiable pairs are **skipped, never guessed**: a union type alias, a generic
parameter, `unknown`/`any`, a mapped type, an inline type we cannot split, a serde
`Value` return, or a struct marked `#[serde(flatten)]` / `skip_serializing*` /
custom `Serialize`. Today: **59 replies checked, 50 skipped**.

## Findings from this audit (Round 47)

Three real defects, all in the SMS trash panel (REQ-A42) — a feature that was
"documented, typed and green" yet unusable on a device:

1. the camelCase row fields above (blank panel, restore with blank ids);
2. `sms_trash_restore` compared a bool to `"restored"`;
3. `sms_trash_purge` compared a number to `"purged"`.

And one contract that the docs promised but the **bridge** never produced:
`docs/sms.md` §13 documents `sms_trash_add` as a **three-state outcome**
(`{trashed:true}` / `{trashed:false, reason}` / `{trashed:false, not_found:true}`) and
the screen renders exactly those three, but the command returned a bare `TrashOut`
with "not found" as an error **string**. The bridge was completed to match the
documented contract (`TrashAddOut` + `TrashReject`), so a stale list and a refused
trash are now distinguishable — and a refusal is an *outcome*, not an error.

Why it survived: the trash panel had **no DOM test at all**, and the Rust tests stop
at the pure core (`trash_message`), never at the serialized command contract. Both
gaps are closed (`messages.svelte.test.ts` +3; `sms::tests` +2 wire-shape tests).

## The shared view is a lexical question, not a character question (REQ-A851)

`stripTestRegions` / `stripComments` are not private to this gate: **five** gates take
their "production part" from them (`tauri-reply-scan`, `tauri-command-scan`,
`rust-recursion-scan`, `hot-loop-scan`, `tauri-event-scan`). Until this round both were
built out of regular expressions that read *characters*, while what they are asked for is
a *Rust lexical* answer. Three independent faces, each measured over the workspace's 615
`.rs` files against a stay-out-of-the-repo reconstruction of the pre-fix module
(`/tmp/negctl12/old-reply-scan.mjs`):

1. **"Is this a test region?" asked with `\btest\b`.** `#[cfg(not(test))]` is
   *production* — deleting it removed `static ALLOWED_ROOT` and `pub fn
   ensure_allowed_root` (`crates/amos-tauri/src/host_fs.rs:225`, `:245`) from the view
   that the reply checks reason about; `#[cfg(any(target_os = "linux", test))]` and
   `#[cfg(any(test, feature = "test-helpers"))]` are unknown, not test-only; and a
   *sentence* or a string literal spelling `#[cfg(test)]` (a doc comment naming the
   attribute) was read as a real attribute.
2. **The item-end bracket walk did not know about literals.** A test in
   `crates/amos-mail/src/live/imap.rs:724` writes wire strings whose parentheses are
   unbalanced (`… BODY[HEADER.FIELDS (FROM SUBJECT)] {` is +2, `"{}}"` −2, `")"` −1), so
   the walk believed it was back at depth 0 after 128 lines and left **570 lines** of
   test code inside the "production" view; unbalanced brackets in a doc comment in
   `crates/amos-ai/src/server.rs` ended the walk after 40708 of 75374 characters.
3. **`stripComments` fired inside string literals, and *deleted*.** `a/*c*/b` became
   `ab` — two identifiers welded into one. 1225 `//` sequences live inside literals
   across 193 files; one block comment in `crates/amos-link-cli/src/lib.rs` swallowed
   373709 characters.

Measured blast radius: the two views differ on **124** files (702386 characters).
**10 production names in 5 files** were missing from the old view (`host_fs.rs`,
`host_battery.rs`, `screenshot.rs`, `sms.rs`, `mdm/db.rs`); **52 test names in `src/`**
(`server.rs` 31, `imap.rs`, `webman_download_tests.rs` 21 — its `#[test]` sits *outside*
the test module) were visible as production.

The fix is `maskProse` (offset-preserving: blanks comment spans *including* their
delimiters and literal interiors, so a caller can walk the masked view and splice the
original), a tri-valued `cfgWithoutTest` predicate (`test` is known false in the
production view; an item is removed only when the predicate evaluates **F**), and
`findTestGate`, which finds the first removing gate **or** a test-harness attribute on
the masked view. Every one of the three faces can only *remove* matches, so the residual
error is a false red, never a false green.

Honest boundary: **no verdict changed.** All five consumer gates and their selftests are
green before and after. What was wrong is the gate's own claim about how much code it
read — the expensive kind of failure. Four other gates still cut at the first
`#[cfg(test)]` (`blocking-in-async-scan`, `lock-across-await-scan`, `unsafe-scan`,
`fmea-gen`), and six other `stripComments` copies exist elsewhere in `scripts/`, two of
which (`jni-contract-scan`, `jni-boolean-scan`) are already token-aware.

## Running it

```sh
node scripts/tauri-reply-scan.mjs                 # gate (exit 1 on any finding)
node scripts/tauri-reply-scan.mjs --json          # machine-readable
node scripts/tauri-reply-scan.mjs --selftest      # pin the extractors (126 assertions)
```

It runs in `make lint` (hence CI), self-test first. Negative control: renaming a
single `thread_id` field to `threadId` in `backend.ts` makes the gate fail and name
the exact struct and its real field list; restoring it makes it pass.
