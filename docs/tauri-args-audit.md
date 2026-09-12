# Tauri argument audit — "the payload names an argument that does not exist"

## Why this exists

Three gates already watch the shell↔host boundary, and all three stayed green
while two features were dead:

| Gate | What it proves | What it cannot see |
| --- | --- | --- |
| `unwired-scan.mjs` | an export has a production call site | whether the call can succeed |
| `tauri-command-scan.mjs` | a registered command is asked for | whether the *arguments* match |
| `tsc` / unit tests | the TS types line up; the fake bridge returns what the test wants | the **wire key** — a fake bridge only sees the command *name* |

Tauri resolves each command argument by its **lowerCamelCase** name
(tauri-macros `ArgumentCase::Camel` is the default and this workspace never sets
`rename_all`), and `CommandItem::deserialize_json` is a plain
`payload.get(key)` (`tauri/src/ipc/command.rs`). Two failure modes follow, and
both were live in the tree:

* **a missing key for a required argument** → the command errors out
  (`missing required key …`) and the wrapper returns `null`;
* **a missing key for an `Option<_>` argument** → the macro's
  `deserialize_option` treats "absent" as `None` and the default is used —
  **silently**.

`scripts/tauri-args-scan.mjs` mechanizes the check. It is the third member of the
boundary-scan family (corpus = `crates/amos-tauri/src` **and**
`frontend-ts/src`, i.e. the two sides of one wire).

## What it checks

For every production `invoke("cmd", { … })` in `frontend-ts/src` (tests excluded —
they build fake bridges on purpose):

1. **every literal key of the payload is a real argument key** of `cmd`
   (a stray key is never read by anything: a typo or a stale spelling);
2. **every required (non-`Option`) argument key is present**;
3. the command name exists — declared `#[tauri::command]` **and** in
   `generate_handler![…]` (the mirror of `tauri-command-scan.mjs`).

`AppHandle` / `State<…>` / `Window` / `Webview(Window)` parameters are host
injected and never sent from JS.

### Honest boundary (a missed finding, never a false one)

Unverifiable calls are **skipped**, not guessed:

* a computed command name — `invoke(NAME)`;
* a payload built elsewhere — `invoke("x", opts)`;
* a spread or computed key inside the payload — `{ ...opts }`, `{ [k]: v }`;
* plugin commands (`plugin:event|listen`) — not `#[tauri::command]`s.

The scan also cannot see *type* mistakes (a string sent where the host wants a
number errors at runtime with the key present) or a wrapper that never calls
`invoke` at all (`unwired-scan.mjs`'s job). Today: **122 invocations checked, 6
unverifiable**.

## Findings from this audit (Round 46) — two live defects, both silent

### 1. `rag_query` — "ask my notes" never retrieved anything

`lib/rag.ts` sent `{ query, top_k }`. The Rust parameter is `top_k: u32`, so the
key Tauri looks up is **`topK`**; the payload therefore never contained it and
every call failed with `missing required key topK` *before* the gRPC request was
ever made. `invoke()` returns `null` on a rejected command, `parseRagQuery(null)`
returns `null`, and the UI showed its honest "notes search offline" state — so the
retrieval path was **dead while looking deliberate**. The unit tests could not see
it (they assert the command *name*), the DOM test for the AiApp grounding switch
asserts only that `rag_query` was called, and the command scan only sees the name.
The 2026-09-09 changelog entry records the intent that introduced it: *"`rag_query`
参数名对齐 proto `top_k`（`lib/rag.ts` 同步改 invoke key 为 `top_k`）"* — mirroring
the proto field name is exactly what Tauri's JS convention forbids.

**Fixed** to `topK`, pinned by two new `rag.test.ts` cases that read the payload
off a fake bridge (`toEqual({ query, topK })`, and `top_k` undefined), plus the
new gate.

### 2. `interpret_start` — the chosen languages were silently ignored

`lib/backend.ts` sent `{ source_lang, target_lang }` for
`interpret_start(source_lang: Option<String>, target_lang: Option<String>)`. Both
parameters are optional, so Tauri **accepted the call and passed `None`**: the
interpreter ran `auto → zh` no matter what the user had configured in
`InterpApp`'s prefs (which are read and passed at every start). No error, no log
— the failure mode a UI cannot show.

**Fixed** to `sourceLang`/`targetLang`, pinned by `backend.test.ts` (positive +
negative assertion on the old keys) and the gate.

## Running it

```sh
node scripts/tauri-args-scan.mjs                 # gate (exit 1 on any finding)
node scripts/tauri-args-scan.mjs --json          # machine-readable
node scripts/tauri-args-scan.mjs --selftest      # pin the extractors
```

It runs in `make lint` (hence CI), self-test first.

## Keeping it green

A finding is fixed by **sending the key the host actually declares** (the Rust
parameter in lowerCamelCase) or by renaming the parameter — never by relaxing the
gate. If a key must stay snake_case for a documented reason, the Rust side can
declare `#[tauri::command(rename_all = "snake_case")]`; then the scan derives the
snake_case key and stays correct.
